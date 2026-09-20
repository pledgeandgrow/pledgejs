/**
 * PSX Rust formatting — runs `rustfmt` on Rust blocks inside .psx/.ps files.
 *
 * Goal #220: `pledge fmt` runs `cargo fmt` on all .ps/.psx Rust blocks,
 * ensuring consistent formatting across the project.
 *
 * For .ps files (pure Rust), the entire file is formatted.
 * For .psx files, each <rust> block is extracted, formatted, and replaced.
 */

import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, extname, relative } from 'node:path';

/**
 * Format a Rust source string using rustfmt.
 * Returns the formatted source, or the original if rustfmt is not available.
 */
export async function formatRustSource(
  source: string,
  options?: { edition?: string; configFile?: string },
): Promise<{ formatted: string; changed: boolean }> {
  const edition = options?.edition ?? '2021';

  // Format the code itself and put the surrounding whitespace back afterwards.
  // rustfmt drops leading/trailing blank space, so comparing its output with a
  // block that starts with the newline after `<rust>` (or a file that ends
  // with a newline) reported "changed" for every already-formatted input.
  const leading = source.match(/^\s*/)?.[0] ?? '';
  const body = source.slice(leading.length);
  const trailing = body.match(/\s*$/)?.[0] ?? '';
  const code = body.slice(0, body.length - trailing.length);
  if (!code) return { formatted: source, changed: false };

  return new Promise((resolve) => {
    // `rustfmt` is the standalone formatter (no `fmt` subcommand — that is
    // `cargo fmt`; passing it made rustfmt treat "fmt" as an input file and
    // fail, so nothing was ever formatted). With no file it reads stdin.
    // Keep the file's own line endings: rustfmt's default ("native") rewrote LF
    // sources with CRLF on Windows, changing every line.
    const newlineStyle = source.includes('\r\n') ? 'Windows' : 'Unix';
    const args = ['--emit', 'stdout', '--edition', edition, '--config', `newline_style=${newlineStyle}`];
    if (options?.configFile) {
      args.push('--config-path', options.configFile);
    }

    const child = spawn('rustfmt', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

    child.on('error', () => {
      // rustfmt not installed — return original
      resolve({ formatted: source, changed: false });
    });

    child.on('close', (exitCode) => {
      if (exitCode === 0 && stdout.trim()) {
        const formatted = leading + stdout.replace(/\s+$/, '') + trailing;
        resolve({ formatted, changed: formatted !== source });
      } else {
        // Formatting failed — return original
        resolve({ formatted: source, changed: false });
      }
    });

    child.stdin.write(code);
    child.stdin.end();
  });
}

/**
 * Formats a .ps file (pure Rust) by running rustfmt on the entire content.
 */
export async function formatPsFile(
  filePath: string,
  options?: { edition?: string; configFile?: string; check?: boolean },
): Promise<{ changed: boolean }> {
  const source = await readFile(filePath, 'utf-8');
  const { formatted, changed } = await formatRustSource(source, options);

  // `check` only reports; it must never modify the file.
  if (changed && !options?.check) {
    await writeFile(filePath, formatted, 'utf-8');
  }

  return { changed };
}

/**
 * Formats a .psx file by extracting each <rust> block, running rustfmt on it,
 * and replacing the original block with the formatted version.
 *
 * Non-Rust (TSX) content is left untouched.
 */
export async function formatPsxFile(
  filePath: string,
  options?: { edition?: string; configFile?: string; check?: boolean },
): Promise<{ changed: boolean; blocksFormatted: number }> {
  const source = await readFile(filePath, 'utf-8');
  let changed = false;
  let blocksFormatted = 0;

  // Match <rust>...</rust> blocks (non-greedy)
  const blockRegex = /<rust>([\s\S]*?)<\/rust>/g;
  let result = source;
  let match: RegExpExecArray | null;

  // Collect all matches first, then replace from end to start to preserve indices
  const matches: { index: number; fullMatch: string; rustSource: string }[] = [];

  while ((match = blockRegex.exec(source)) !== null) {
    matches.push({
      index: match.index,
      fullMatch: match[0],
      rustSource: match[1],
    });
  }

  // Process from end to start
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    const { formatted, changed: blockChanged } = await formatRustSource(m.rustSource, options);

    if (blockChanged) {
      result =
        result.slice(0, m.index) +
        `<rust>${formatted}</rust>` +
        result.slice(m.index + m.fullMatch.length);
      changed = true;
      blocksFormatted++;
    }
  }

  if (changed && !options?.check) {
    await writeFile(filePath, result, 'utf-8');
  }

  return { changed, blocksFormatted };
}

/**
 * Result of formatting a single file.
 */
export interface FmtResult {
  file: string;
  changed: boolean;
  blocksFormatted?: number;
  error?: string;
}

/**
 * Formats all .psx and .ps files in a directory tree.
 * Recursively finds files and formats each one.
 *
 * @param rootDir Root directory to search in
 * @param options Formatting options
 * @returns Array of results for each file processed
 */
export async function formatDirectory(
  rootDir: string,
  options?: { edition?: string; configFile?: string; check?: boolean },
): Promise<FmtResult[]> {
  const { readdir } = await import('node:fs/promises');
  const results: FmtResult[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      // Skip hidden dirs, node_modules, .pledge, .pledge-cache, target
      if (entry.isDirectory()) {
        if (
          entry.name.startsWith('.') ||
          entry.name === 'node_modules' ||
          entry.name === 'target'
        ) continue;
        await walk(fullPath);
        continue;
      }

      const ext = extname(entry.name);
      if (ext !== '.psx' && ext !== '.ps') continue;

      const relPath = relative(rootDir, fullPath);
      try {
        if (ext === '.ps') {
          const result = await formatPsFile(fullPath, options);
          results.push({
            file: relPath,
            changed: result.changed,
          });
        } else {
          const result = await formatPsxFile(fullPath, options);
          results.push({
            file: relPath,
            changed: result.changed,
            blocksFormatted: result.blocksFormatted,
          });
        }
      } catch (err) {
        results.push({
          file: relPath,
          changed: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  await walk(rootDir);
  return results;
}

/**
 * Checks if any .psx/.ps files need formatting without modifying them.
 * Returns files that would be changed by `pledge fmt`.
 *
 * Useful for CI enforcement — exit with non-zero if any files need formatting.
 */
export async function checkFormatting(
  rootDir: string,
  options?: { edition?: string; configFile?: string },
): Promise<FmtResult[]> {
  const results = await formatDirectory(rootDir, { ...options, check: true });
  return results.filter((r) => r.changed);
}
