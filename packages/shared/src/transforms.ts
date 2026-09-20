import { join, dirname, basename, extname, relative } from 'node:path';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

export const PLEDGEPACK_DEFAULT_PORT = 3001;

/**
 * A bounded LRU map. JS Map iteration follows insertion order, so we evict
 * the oldest entries from the front when the size exceeds `maxEntries`.
 *
 * Used by transform caches across all bundler adapters and the server's
 * transform pipeline. The dev-mode cache keys include `Date.now()` (one
 * entry per transform), so without bounding, long dev sessions leak
 * memory and disk files in `.pledge-cache/`.
 */
export class BoundedLRUMap<K, V> {
  private map = new Map<K, V>();
  readonly maxEntries: number;

  constructor(maxEntries: number) {
    this.maxEntries = maxEntries;
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, value);
    this.enforceLimit();
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }

  values(): IterableIterator<V> {
    return this.map.values();
  }

  entries(): IterableIterator<[K, V]> {
    return this.map.entries();
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.map[Symbol.iterator]();
  }

  private enforceLimit(): void {
    if (this.map.size <= this.maxEntries) return;
    const toEvict = this.map.size - this.maxEntries;
    let count = 0;
    for (const key of this.map.keys()) {
      if (count >= toEvict) break;
      this.map.delete(key);
      count++;
    }
  }
}

/** Default cap for transform caches — 1000 entries is ~enough for a large project. */
export const MAX_TRANSFORM_CACHE_ENTRIES = 1000;

/**
 * Fetches the Oxc-transformed module from PledgePack's Rust dev server.
 *
 * PledgePack's dev server (axum) handles:
 *   - TSX/TS → JS via Oxc (Rust-based, faster than esbuild)
 *   - JSX automatic runtime (react)
 *   - CSS transforms via Lightning CSS
 *   - CJS → ESM interop for node_modules
 *   - Import rewriting for bare specifiers
 *
 * @param sourcePath  Absolute path to the source file.
 * @param port        Port the PledgePack dev server is listening on.
 * @param rootDir     Project root (for computing the relative path). Defaults to cwd.
 * @param hostname     Hostname the dev server was started with. Defaults to 'localhost'.
 *                     Must match the `--host` value — if the server binds to 0.0.0.0 or
 *                     a LAN IP, fetching via 'localhost' will fail.
 */
export async function fetchFromPledgepack(
  sourcePath: string,
  port: number,
  rootDir?: string,
  hostname?: string,
): Promise<string> {
  const projectRoot = rootDir ?? process.cwd();
  const host = hostname ?? 'localhost';
  const relPath = relative(projectRoot, sourcePath).replace(/\\/g, '/');

  // Encode per segment: a file named "my page#1.tsx" would otherwise have its
  // "#..." parsed as a URL fragment and fetch the wrong module.
  const url = `http://${host}:${port}/${relPath.split('/').map(encodeURIComponent).join('/')}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`PledgePack transform failed for ${relPath}: ${response.status} ${response.statusText}`);
  }

  return await response.text();
}

/**
 * Fallback local transform using esbuild.
 * Used when PledgePack dev server is not available (e.g., production build without pledgepackPort).
 */
export async function transformLocally(sourcePath: string, ext: string): Promise<string> {
  const sourceCode = await readFile(sourcePath, 'utf-8');

  if (ext === '.mjs') {
    return sourceCode;
  }

  const { transform } = await import('esbuild');
  const loader = ext === '.tsx' ? 'tsx' : ext === '.jsx' ? 'jsx' : 'ts';
  const result = await transform(sourceCode, {
    loader,
    target: 'es2022',
    format: 'esm',
    sourcemap: 'inline',
    jsx: 'automatic',
    jsxImportSource: 'react',
    define: {
      'process.env.NODE_ENV': '"production"',
    },
  });
  return result.code;
}

/**
 * Transforms TSX code locally using esbuild (for PSX files when PledgePack is unavailable).
 */
export async function transformTsxLocally(tsxCode: string, isDev: boolean): Promise<string> {
  const { transform } = await import('esbuild');
  const result = await transform(tsxCode, {
    loader: 'tsx',
    target: 'es2022',
    format: 'esm',
    sourcemap: 'inline',
    jsx: 'automatic',
    jsxImportSource: 'react',
    define: {
      'process.env.NODE_ENV': isDev ? '"development"' : '"production"',
    },
  });
  return result.code;
}

/**
 * Generates a fallback JS stub when Rust compilation is not available.
 * Throws clear errors when rust.* functions are called.
 */
export function generateRustFallback(moduleName: string): string {
  return `/**
 * Fallback stub for ${moduleName}.psx — Rust addon not compiled.
 * Install Rust toolchain (cargo) to enable native Rust execution.
 */
const notCompiled = (name) => () => {
  throw new Error(
    '[PledgeStack] rust.' + name + '() is not available — Rust addon not compiled.\\n' +
    'Install Rust toolchain: https://rustup.rs\\n' +
    'Then restart the dev server.'
  );
};

export const rust = new Proxy({}, {
  get: (_, prop) => notCompiled(String(prop)),
});
`;
}

/**
 * Clears the transform cache directory.
 */
export async function clearTransformCacheDir(dir: string): Promise<void> {
  const cacheDir = join(dir, '.pledge-cache');
  try {
    await rm(cacheDir, { recursive: true, force: true });
  } catch {
    // Ignore errors
  }
}

/**
 * Writes transformed code to the cache directory and returns a file:// URL.
 */
export async function writeTransformedCode(
  sourcePath: string,
  transformedCode: string,
  isDev: boolean,
  cache?: Map<string, string>,
): Promise<string> {
  const ext = extname(sourcePath);
  const hash = createHash('sha256').update(sourcePath).digest('hex').slice(0, 12);
  const cacheDir = join(dirname(sourcePath), '.pledge-cache');
  await mkdir(cacheDir, { recursive: true });

  if (isDev) {
    const devOutPath = join(cacheDir, basename(sourcePath, ext) + `.${Date.now()}.js`);
    await writeFile(devOutPath, transformedCode, 'utf-8');
    const fileUrl = pathToFileURL(devOutPath).href;
    if (cache) cache.set(`${sourcePath}:${Date.now()}`, fileUrl);
    return fileUrl;
  }

  const outFileName = basename(sourcePath, ext) + `.${hash}.js`;
  const outPath = join(cacheDir, outFileName);
  await writeFile(outPath, transformedCode, 'utf-8');
  const fileUrl = pathToFileURL(outPath).href;
  if (cache) cache.set(sourcePath, fileUrl);
  return fileUrl;
}
