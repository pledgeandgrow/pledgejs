/**
 * pledge docs — Auto-generate Plugin API documentation from TypeScript source.
 *
 * Goal #228: Parses TypeScript source files in the project and generates
 * markdown API documentation for exported interfaces, types, functions,
 * and classes. Focuses on plugin API surface but documents all exports.
 */

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { PledgeConfig } from 'pledgestack-shared';

interface DocEntry {
  name: string;
  kind: 'interface' | 'type' | 'function' | 'class' | 'enum' | 'const';
  description?: string;
  signature: string;
  members?: DocMember[];
  sourceFile: string;
  sourceLine: number;
}

interface DocMember {
  name: string;
  type: string;
  optional: boolean;
  description?: string;
}

/**
 * Parses a TypeScript source file and extracts exported declarations.
 */
async function parseSourceFile(filePath: string, rootDir: string): Promise<DocEntry[]> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  const entries: DocEntry[] = [];
  const lines = content.split('\n');
  const relPath = relative(rootDir, filePath).replace(/\\/g, '/');

  // Extract interfaces
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Exported interfaces
    const ifaceMatch = line.match(/^export\s+interface\s+(\w+)/);
    if (ifaceMatch) {
      const name = ifaceMatch[1];
      const members = extractInterfaceMembers(lines, i);
      const description = extractJSDoc(lines, i);
      entries.push({
        name,
        kind: 'interface',
        description,
        signature: `interface ${name}`,
        members,
        sourceFile: relPath,
        sourceLine: i + 1,
      });
      continue;
    }

    // Exported types
    const typeMatch = line.match(/^export\s+type\s+(\w+)/);
    if (typeMatch) {
      const name = typeMatch[1];
      const description = extractJSDoc(lines, i);
      const signature = extractTypeSignature(lines, i);
      entries.push({
        name,
        kind: 'type',
        description,
        signature,
        sourceFile: relPath,
        sourceLine: i + 1,
      });
      continue;
    }

    // Exported functions
    const fnMatch = line.match(/^export\s+(?:async\s+)?function\s+(\w+)/);
    if (fnMatch) {
      const name = fnMatch[1];
      const description = extractJSDoc(lines, i);
      const signature = extractFunctionSignature(lines, i);
      entries.push({
        name,
        kind: 'function',
        description,
        signature,
        sourceFile: relPath,
        sourceLine: i + 1,
      });
      continue;
    }

    // Exported classes
    const clsMatch = line.match(/^export\s+class\s+(\w+)/);
    if (clsMatch) {
      const name = clsMatch[1];
      const description = extractJSDoc(lines, i);
      const signature = `class ${name}`;
      entries.push({
        name,
        kind: 'class',
        description,
        signature,
        sourceFile: relPath,
        sourceLine: i + 1,
      });
      continue;
    }

    // Exported enums
    const enumMatch = line.match(/^export\s+enum\s+(\w+)/);
    if (enumMatch) {
      const name = enumMatch[1];
      const description = extractJSDoc(lines, i);
      entries.push({
        name,
        kind: 'enum',
        description,
        signature: `enum ${name}`,
        sourceFile: relPath,
        sourceLine: i + 1,
      });
      continue;
    }

    // Exported consts
    const constMatch = line.match(/^export\s+const\s+(\w+)/);
    if (constMatch) {
      const name = constMatch[1];
      const description = extractJSDoc(lines, i);
      const signature = line.trim();
      entries.push({
        name,
        kind: 'const',
        description,
        signature,
        sourceFile: relPath,
        sourceLine: i + 1,
      });
      continue;
    }
  }

  return entries;
}

/**
 * Extracts interface members (properties) from source lines.
 */
function extractInterfaceMembers(lines: string[], startIdx: number): DocMember[] {
  const members: DocMember[] = [];
  let braceDepth = 0;
  let started = false;

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('{')) {
      braceDepth += (line.match(/{/g) ?? []).length;
      started = true;
    }
    if (line.includes('}')) {
      braceDepth -= (line.match(/}/g) ?? []).length;
      if (started && braceDepth <= 0) break;
    }

    // Match property declarations: name?: type; or name: type;
    const propMatch = line.match(/^\s*(\w+)\??:\s*(.+?);?\s*$/);
    if (propMatch && started && braceDepth > 0) {
      const name = propMatch[1];
      const type = propMatch[2].trim().replace(/;$/, '');
      const optional = line.includes(`${name}?:`);
      const doc = extractInlineDoc(lines, i);
      members.push({ name, type, optional, description: doc });
    }
  }

  return members;
}

/**
 * Extracts JSDoc comment preceding a line.
 */
function extractJSDoc(lines: string[], idx: number): string | undefined {
  // Look backwards for /** ... */
  const comments: string[] = [];
  for (let i = idx - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === '') break;
    if (line.endsWith('*/')) {
      // Collect lines until /**
      for (let j = i; j >= 0; j--) {
        const l = lines[j].trim();
        comments.unshift(l);
        if (l.startsWith('/**')) break;
      }
      break;
    }
    // Single-line comment
    if (line.startsWith('//')) {
      comments.unshift(line);
      break;
    }
    if (!line.startsWith('*') && !line.startsWith('/*')) break;
  }

  if (comments.length === 0) return undefined;
  return comments
    .join(' ')
    .replace(/\/\*\*?/g, '')
    .replace(/\*\//g, '')
    .replace(/^\s*\*\s?/g, '')
    .replace(/^\s*\/\//g, '')
    .trim();
}

/**
 * Extracts inline JSDoc for a property line.
 */
function extractInlineDoc(lines: string[], idx: number): string | undefined {
  // Check for /** comment on same line or above */
  const line = lines[idx];
  const inlineMatch = line.match(/\/\*\*\s*(.+?)\s*\*\/\s*$/);
  if (inlineMatch) return inlineMatch[1];

  return extractJSDoc(lines, idx);
}

/**
 * Extracts a type alias signature.
 */
function extractTypeSignature(lines: string[], startIdx: number): string {
  let sig = lines[startIdx].trim();
  if (sig.includes(';') || (sig.includes('=') && sig.includes('}'))) return sig;

  // Multi-line type
  for (let i = startIdx + 1; i < lines.length && i < startIdx + 10; i++) {
    sig += ' ' + lines[i].trim();
    if (lines[i].includes(';')) break;
  }
  return sig.replace(/\s+/g, ' ').replace(/;$/, '');
}

/**
 * Extracts a function signature.
 */
function extractFunctionSignature(lines: string[], startIdx: number): string {
  let sig = lines[startIdx].trim();
  if (sig.includes('{')) {
    return sig.split('{')[0].trim() + ' { ... }';
  }
  // Multi-line signature
  for (let i = startIdx + 1; i < lines.length && i < startIdx + 5; i++) {
    sig += ' ' + lines[i].trim();
    if (lines[i].includes('{') || lines[i].includes(';')) break;
  }
  return sig.replace(/\s+/g, ' ').replace(/\{.*/, '{ ... }');
}

/**
 * Walks a directory and collects all TypeScript source files.
 */
async function collectSourceFiles(dir: string, files: string[] = []): Promise<string[]> {
  if (!existsSync(dir)) return files;

  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.pledge' || entry.name === 'dist') continue;
      await collectSourceFiles(fullPath, files);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Groups doc entries by source file.
 */
function groupByFile(entries: DocEntry[]): Map<string, DocEntry[]> {
  const grouped = new Map<string, DocEntry[]>();
  for (const entry of entries) {
    const file = entry.sourceFile;
    if (!grouped.has(file)) grouped.set(file, []);
    grouped.get(file)!.push(entry);
  }
  return grouped;
}

/**
 * Generates markdown documentation from parsed entries.
 */
function generateMarkdown(files: Map<string, DocEntry[]>, _rootDir: string): string {
  const lines: string[] = [];

  lines.push('# PledgeStack Plugin API\n');
  lines.push('> Auto-generated from TypeScript source. Do not edit manually.\n');
  lines.push(`Generated: ${new Date().toISOString()}\n`);

  // Table of contents
  lines.push('## Table of Contents\n');
  for (const [file, entries] of files) {
    const module = file.replace(/\.(ts|tsx)$/, '').replace(/\//g, '/');
    lines.push(`- [${module}](#${file.replace(/[^a-z0-9]/gi, '-').toLowerCase()})`);
    for (const entry of entries) {
      lines.push(`  - [\`${entry.name}\`](#${entry.name.toLowerCase()})`);
    }
  }
  lines.push('');

  // Plugin API reference
  lines.push('## Plugin Hooks\n');
  lines.push('PledgeStack plugins implement the `PledgePlugin` interface with optional hooks:\n');
  lines.push('| Hook | Called When | Returns | |');
  lines.push('|------|------------|---------|-|');
  lines.push('| `configResolved` | During config resolution | `PledgeConfig \\| void` | |');
  lines.push('| `buildStart` | Build starts | `void` | |');
  lines.push('| `buildEnd` | Build completes | `void` | |');
  lines.push('| `configureServer` | Dev server setup | `void` | |');
  lines.push('| `renderStart` | Before page render | `void` | |');
  lines.push('| `renderEnd` | After render, before response | `string` (HTML) | |');
  lines.push('| `routeMatch` | Route matched | `PluginRouteContext \\| void` | |');
  lines.push('| `transformHtml` | HTML transformation | `string` (HTML) | |');
  lines.push('| `transformClientBundle` | Client bundle transform | `string` (code) | |');
  lines.push('| `fetchIntercept` | fetch() interception | `Response \\| null` | |');
  lines.push('');

  // Documentation per file
  for (const [file, entries] of files) {
    lines.push(`## ${file}\n`);

    for (const entry of entries) {
      lines.push(`### \`${entry.name}\`\n`);
      lines.push(`**Kind:** ${entry.kind}  `);
      lines.push(`**Source:** [${entry.sourceFile}:${entry.sourceLine}](${entry.sourceFile}#L${entry.sourceLine})\n`);

      if (entry.description) {
        lines.push(`${entry.description}\n`);
      }

      lines.push('```typescript');
      lines.push(entry.signature);
      lines.push('```\n');

      if (entry.members && entry.members.length > 0) {
        lines.push('| Property | Type | Optional | Description |');
        lines.push('|----------|------|----------|-------------|');
        for (const m of entry.members) {
          lines.push(`| \`${m.name}\` | \`${m.type}\` | ${m.optional ? 'Yes' : 'No'} | ${m.description ?? ''} |`);
        }
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

/**
 * Runs the docs generation command.
 */
export async function docsCommand(config: PledgeConfig, opts: { output?: string } = {}): Promise<void> {
  const srcDirs = [
    join(config.rootDir, 'packages', 'shared', 'src'),
    join(config.rootDir, 'packages', 'core', 'src'),
    join(config.rootDir, 'packages', 'cli', 'src'),
    join(config.rootDir, 'packages', 'server', 'src'),
    join(config.rootDir, 'packages', 'client', 'src'),
    join(config.rootDir, 'packages', 'overlay', 'src'),
  ];

  // Also check if this is a user project (not the monorepo)
  const userSrc = join(config.rootDir, 'src');
  if (existsSync(userSrc)) srcDirs.push(userSrc);
  const userApp = join(config.rootDir, config.appDir);
  if (existsSync(userApp)) srcDirs.push(userApp);

  console.log('\n  PledgeStack — Generating API documentation...\n');

  const allEntries: DocEntry[] = [];

  for (const srcDir of srcDirs) {
    if (!existsSync(srcDir)) continue;
    console.log(`  → Scanning ${relative(config.rootDir, srcDir) || srcDir}...`);
    const files = await collectSourceFiles(srcDir);
    for (const file of files) {
      const entries = await parseSourceFile(file, config.rootDir);
      allEntries.push(...entries);
    }
  }

  if (allEntries.length === 0) {
    console.log('  ⚠ No exported declarations found.');
    console.log('    Scanned: ' + srcDirs.filter((d) => existsSync(d)).map((d) => relative(config.rootDir, d)).join(', '));
    console.log('    `pledge docs` documents TypeScript source exports — run it from a');
    console.log('    project with a src/ or app/ directory, or from the PledgeStack monorepo.\n');
    return;
  }

  console.log(`  ✓ Found ${allEntries.length} exported declarations\n`);

  const grouped = groupByFile(allEntries);
  const markdown = generateMarkdown(grouped, config.rootDir);

  const outPath = opts.output ?? join(config.rootDir, 'docs', 'api', 'PLUGIN_API.md');
  await mkdir(join(outPath, '..'), { recursive: true });
  await writeFile(outPath, markdown, 'utf-8');

  console.log(`  ✓ Documentation written to ${relative(config.rootDir, outPath) || outPath}\n`);

  // Also generate a JSON version for programmatic use
  const jsonPath = outPath.replace(/\.md$/, '.json');
  await writeFile(jsonPath, JSON.stringify({ generated: new Date().toISOString(), entries: allEntries }, null, 2), 'utf-8');
  console.log(`  ✓ JSON reference written to ${relative(config.rootDir, jsonPath) || jsonPath}\n`);
}
