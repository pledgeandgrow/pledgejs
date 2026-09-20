import { join, dirname, basename, extname, resolve, relative, isAbsolute, resolve as resolvePath } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import {
  loadPSXModule,
  transformPSX,
  detectCratesFromImports,
  generateModuleCargoToml,
  ensureRootCargoToml,
  serializeSourceMap,
  rustLibName,
} from 'pledgestack-core';
import type { RustBuildFn } from 'pledgestack-core';
import { generateRustFallback, BoundedLRUMap, MAX_TRANSFORM_CACHE_ENTRIES } from 'pledgestack-shared';
import type {
  BundlerAdapter,
  BuildResult,
  DevServerHandle,
  DevServerOptions,
  TransformOptions,
  TransformResult,
} from 'pledgestack-shared';
import type { PledgeConfig } from 'pledgestack-shared';

const TRANSFORM_CACHE = new BoundedLRUMap<string, string>(MAX_TRANSFORM_CACHE_ENTRIES);

/**
 * Rollup bundler adapter for PledgeStack.
 *
 * Uses Rollup for production builds with esbuild for TS/TSX transforms.
 * Dev server uses a lightweight HTTP server with esbuild on-the-fly transforms.
 *
 * ## Usage in pledge.config.ts
 * ```typescript
 * import { defineConfig } from 'pledgestack-shared';
 *
 * export default defineConfig({
 *   bundler: 'rollup',
 * });
 * ```
 *
 * Requires `rollup` to be installed: `npm install rollup`
 */
export const rollupAdapter: BundlerAdapter = {
  name: 'rollup',

  async build(config: PledgeConfig): Promise<BuildResult> {
    const start = Date.now();
    try {
      const { rollup } = await import('rollup');
      const outDir = join(config.rootDir, config.outDir);

      // Collect all route files as entry points
      const appDir = join(config.rootDir, config.appDir);
      const routeFiles = await collectRouteFiles(appDir);

      // Build server bundle
      const serverOutDir = join(outDir, 'server');
      await mkdir(serverOutDir, { recursive: true });

      for (const routeFile of routeFiles) {
        const relPath = relativePath(appDir, routeFile);
        const ext = extname(routeFile);
        const outName = relPath.slice(0, -ext.length) + '.js';

        const bundle = await rollup({
          input: routeFile,
          plugins: [
            pledgeStackRollupPlugin(config),
            (await import('@rollup/plugin-node-resolve')).default({
              extensions: ['.js', '.ts', '.tsx', '.jsx', '.psx', '.ps'],
            }),
            (await import('@rollup/plugin-commonjs')).default(),
          ],
          external: ['react', 'react-dom', 'react/jsx-runtime', 'pledgestack-core', 'pledgestack-shared', 'pledgestack-server'],
        });

        await bundle.write({
          file: join(serverOutDir, outName),
          format: 'esm',
          sourcemap: false,
        });
        await bundle.close();
      }

      // Build client bundle
      if (config.output !== 'export') {
        const clientOutDir = join(outDir, 'client');
        await mkdir(clientOutDir, { recursive: true });

        for (const routeFile of routeFiles) {
          const relPath = relativePath(appDir, routeFile);
          const ext = extname(routeFile);
          const outName = relPath.slice(0, -ext.length) + '.js';

          const bundle = await rollup({
            input: routeFile,
            plugins: [
              pledgeStackRollupPlugin(config),
              (await import('@rollup/plugin-node-resolve')).default({
                browser: true,
                extensions: ['.js', '.ts', '.tsx', '.jsx', '.psx', '.ps'],
              }),
              (await import('@rollup/plugin-commonjs')).default(),
            ],
            external: ['react', 'react-dom', 'react/jsx-runtime'],
          });

          await bundle.write({
            file: join(clientOutDir, outName),
            format: 'esm',
            sourcemap: false,
          });
          await bundle.close();
        }
      }

      return {
        outDir,
        success: true,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        outDir: join(config.rootDir, config.outDir),
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  },

  async startDevServer(
    config: PledgeConfig,
    options: DevServerOptions,
  ): Promise<DevServerHandle> {
    const { createServer } = await import('node:http');
    const port = options.bundlerPort ?? 3001;
    const hostname = options.hostname ?? 'localhost';

    const server = createServer(async (req, res) => {
      const cwd = resolvePath(config.rootDir);
      // Resolve within cwd and reject path traversal (`GET /../../secrets.ts`).
      let filePath: string;
      try {
        filePath = join(cwd, decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, ''));
      } catch {
        res.writeHead(400); res.end('Bad request'); return;
      }
      const rel = relative(cwd, filePath);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        res.writeHead(403); res.end('Forbidden'); return;
      }

      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      try {
        const { fileUrl } = await rollupAdapter.transformFile(filePath, {
          isDev: true,
          cargoConfig: config.cargo,
        });
        const code = isFallbackScript(filePath)
          ? await readFile(new URL(fileUrl), 'utf-8')
          : await readFile(new URL(fileUrl));
        res.writeHead(200, { 'Content-Type': fallbackContentType(filePath) });
        res.end(code);
      } catch (err) {
        res.writeHead(500);
        res.end(err instanceof Error ? err.message : String(err));
      }
    });

    await new Promise<void>((resolve) => server.listen(port, hostname, resolve));

    return {
      port,
      hostname,
      async stop() {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      },
    };
  },

  async transformFile(
    sourcePath: string,
    options: TransformOptions,
  ): Promise<TransformResult> {
    const ext = extname(sourcePath);

    if (ext === '.psx' || ext === '.ps') {
      const fileUrl = await transformPSXFile(sourcePath, options, ext === '.ps' ? 'ps' : 'psx');
      return { fileUrl };
    }

    if (ext !== '.ts' && ext !== '.tsx' && ext !== '.jsx' && ext !== '.mjs') {
      return { fileUrl: pathToFileURL(sourcePath).href };
    }

    const cacheKey = options.isDev ? `${sourcePath}:${Date.now()}` : sourcePath;
    const cached = TRANSFORM_CACHE.get(cacheKey);
    if (cached) return { fileUrl: cached, cached: true };

    const { transform } = await import('esbuild');
    const loader = ext === '.tsx' ? 'tsx' : ext === '.jsx' ? 'jsx' : 'ts';
    const sourceCode = await readFile(sourcePath, 'utf-8');
    const result = await transform(sourceCode, {
      loader,
      target: 'es2022',
      format: 'esm',
      sourcemap: 'inline',
      jsx: 'automatic',
      jsxImportSource: 'react',
      define: {
        'process.env.NODE_ENV': options.isDev ? '"development"' : '"production"',
      },
    });

    const hash = createHash('sha256').update(sourcePath).digest('hex').slice(0, 12);
    const cacheDir = join(dirname(sourcePath), '.pledge-cache');
    const outFileName = basename(sourcePath, ext) + `.${hash}.js`;
    const outPath = join(cacheDir, outFileName);

    await mkdir(cacheDir, { recursive: true });
    await writeFile(outPath, result.code, 'utf-8');

    const fileUrl = pathToFileURL(outPath).href;
    TRANSFORM_CACHE.set(cacheKey, fileUrl);
    return { fileUrl };
  },

  resolveProductionPath(sourcePath: string, config: PledgeConfig): string {
    const ext = extname(sourcePath);
    const withoutExt = sourcePath.slice(0, -ext.length);
    const relPath = withoutExt.replace(join(config.rootDir, config.appDir), '');
    const productionPath = join(config.rootDir, config.outDir, 'server', `${relPath}.js`);

    if (existsSync(productionPath)) return productionPath;
    return sourcePath;
  },
};

// ── Rollup Plugin ────────────────────────────────────────────────────

export function pledgeStackRollupPlugin(config: PledgeConfig, opts: { build?: RustBuildFn } = {}) {
  return {
    name: 'pledgestack',

    async resolveId(
      this: { resolve: (source: string, importer?: string, options?: { skipSelf?: boolean }) => Promise<{ id: string } | null> },
      source: string,
      importer?: string,
    ) {
      if (source.endsWith('.psx') || source.endsWith('.ps')) {
        if (importer) return resolve(dirname(importer), source);
        return source;
      }

      // Resolve aliases
      if (config.alias) {
        for (const [key, value] of Object.entries(config.alias)) {
          const cleanKey = key.replace(/\/\*$/, '');
          if (source.startsWith(cleanKey + '/')) {
            const subPath = source.slice(cleanKey.length);
            const cleanValue = value.replace(/\/\*$/, '');
            const target = join(config.rootDir, cleanValue, subPath);
            // The aliased target usually has no extension ('@/lib/x' -> lib/x);
            // returning it as-is makes Rollup try to load a file that does not
            // exist. Hand it back to the resolver chain (node-resolve probes the
            // configured extensions) and only fall back to the raw path.
            const resolved = await this.resolve(target, importer, { skipSelf: true });
            return resolved?.id ?? target;
          }
        }
      }
      return null;
    },

    async load(id: string) {
      if (id.endsWith('.psx') || id.endsWith('.ps')) {
        // Compile the Rust addon, write the NAPI wrapper (or fallback stub)
        // and return the module source. Rollup builds are production builds.
        return loadPSXModule(id, {
          isDev: false,
          projectRoot: config.rootDir,
          cargoConfig: config.cargo,
          build: opts.build,
        });
      }

      // Transform TS/TSX via esbuild
      const ext = extname(id);
      if (ext === '.ts' || ext === '.tsx' || ext === '.jsx') {
        const { transform } = await import('esbuild');
        const sourceCode = await readFile(id, 'utf-8');
        const loader = ext === '.tsx' ? 'tsx' : ext === '.jsx' ? 'jsx' : 'ts';
        const result = await transform(sourceCode, {
          loader,
          target: 'es2022',
          format: 'esm',
          sourcemap: 'inline',
          jsx: 'automatic',
          jsxImportSource: 'react',
          define: { 'process.env.NODE_ENV': '"production"' },
        });
        return result.code;
      }

      return null;
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

async function collectRouteFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  if (!existsSync(dir)) return files;

  async function walk(d: string) {
    const entries = await readdir(d, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        await walk(fullPath);
      } else if (
        entry.name.endsWith('.ts') ||
        entry.name.endsWith('.tsx') ||
        entry.name.endsWith('.jsx') ||
        entry.name.endsWith('.psx') ||
        entry.name.endsWith('.ps')
      ) {
        files.push(fullPath);
      }
    }
  }

  await walk(dir);
  return files;
}

function relativePath(from: string, to: string): string {
  const rel = to.replace(from, '').replace(/^\//, '');
  return rel;
}

async function transformPSXFile(
  sourcePath: string,
  options: TransformOptions,
  format: 'psx' | 'ps',
): Promise<string> {
  const ext = format === 'ps' ? '.ps' : '.psx';
  const source = await readFile(sourcePath, 'utf-8');
  const moduleName = basename(sourcePath, ext);
  const cacheDir = join(dirname(sourcePath), '.pledge-cache');
  await mkdir(cacheDir, { recursive: true });

  const result = transformPSX(source, {
    moduleName,
    compileRust: true,
    addonPath: `./${moduleName}.node`,
    // The wrapper is written next to the emitted module as <name>.napi.js.
    wrapperImportPath: `./${moduleName}.napi.js`,
    format,
  });

  if (result.types) {
    await writeFile(join(cacheDir, `${moduleName}.d.ts`), result.types, 'utf-8');
  }

  if (result.sourceMap && result.sourceMap.length > 0) {
    await writeFile(
      join(cacheDir, `${moduleName}.psx.map.json`),
      serializeSourceMap(result.sourceMap, moduleName),
      'utf-8',
    );
  }

  let addonReady = false;
  if (result.needsRustCompile && result.rustSource) {
    const rustDir = join(cacheDir, 'rust', moduleName);
    await mkdir(rustDir, { recursive: true });
    await writeFile(join(rustDir, 'lib.rs'), result.rustSource, 'utf-8');

    const projectRoot = process.cwd();
    await ensureRootCargoToml(projectRoot, options.cargoConfig?.dev, options.cargoConfig?.release);

    const detectedCrates = detectCratesFromImports(result.parse.allImports);
    const moduleCargoToml = generateModuleCargoToml(moduleName, detectedCrates);
    await writeFile(join(rustDir, 'Cargo.toml'), moduleCargoToml, 'utf-8');

    addonReady = await compileRustAddon(rustDir, moduleName, cacheDir, options.isDev, options.cargoConfig);
  }

  if (result.napiWrapper) {
    const wrapperPath = join(cacheDir, `${moduleName}.napi.js`);
    if (addonReady) {
      await writeFile(wrapperPath, result.napiWrapper, 'utf-8');
    } else {
      await writeFile(wrapperPath, generateRustFallback(moduleName), 'utf-8');
    }
  }

  if (format === 'ps') {
    const wrapperPath = join(cacheDir, `${moduleName}.napi.js`);
    const fileUrl = pathToFileURL(wrapperPath).href;
    const cacheKey = options.isDev ? `${sourcePath}:${Date.now()}` : sourcePath;
    TRANSFORM_CACHE.set(cacheKey, fileUrl);
    return fileUrl;
  }

  const { transform } = await import('esbuild');
  const transformResult = await transform(result.tsx, {
    loader: 'tsx',
    target: 'es2022',
    format: 'esm',
    sourcemap: 'inline',
    jsx: 'automatic',
    jsxImportSource: 'react',
    define: {
      'process.env.NODE_ENV': options.isDev ? '"development"' : '"production"',
    },
  });

  const hash = createHash('sha256').update(sourcePath).digest('hex').slice(0, 12);
  const outFileName = `${moduleName}.${hash}.js`;
  const outPath = join(cacheDir, outFileName);
  await writeFile(outPath, transformResult.code, 'utf-8');

  const fileUrl = pathToFileURL(outPath).href;
  const cacheKey = options.isDev ? `${sourcePath}:${Date.now()}` : sourcePath;
  TRANSFORM_CACHE.set(cacheKey, fileUrl);
  return fileUrl;
}

async function compileRustAddon(
  rustDir: string,
  moduleName: string,
  cacheDir: string,
  isDev: boolean,
  cargoConfig?: PledgeConfig['cargo'],
): Promise<boolean> {
  const { spawn } = await import('node:child_process');

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('cargo', ['--version'], { stdio: 'ignore' });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`cargo exited with ${code}`));
      });
    });
  } catch {
    return false;
  }

  const projectRoot = process.cwd();
  const sharedTargetDir = cargoConfig?.targetDir ?? join(projectRoot, 'target');
  const addonPath = join(cacheDir, `${moduleName}.node`);
  const hashFile = join(cacheDir, `${moduleName}.node.hash`);
  const currentHash = createHash('sha256')
    .update(await readFile(join(rustDir, 'lib.rs'), 'utf-8'))
    .digest('hex');

  if (existsSync(addonPath) && existsSync(hashFile)) {
    const savedHash = await readFile(hashFile, 'utf-8');
    if (savedHash === currentHash) return true;
  }

  const profile = isDev ? 'dev' : 'release';
  const cargoEnv: Record<string, string> = {
    ...process.env,
    CARGO_TARGET_DIR: sharedTargetDir,
  };

  if (cargoConfig?.sccache !== false) {
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('sccache', ['--version'], { stdio: 'ignore' });
        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error('sccache not found'));
        });
      });
      cargoEnv.RUSTC_WRAPPER = 'sccache';
    } catch {
      // sccache not installed
    }
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('cargo', ['build', '--profile', profile], {
        cwd: rustDir,
        stdio: 'pipe',
        timeout: cargoConfig?.timeout ?? (isDev ? 30000 : 120000),
        env: cargoEnv,
      });
      // Always drain the pipes: cargo blocks once an unread pipe fills (~64KB),
      // which turned a noisy build into a hang until the timeout. Keep stderr
      // so a failed build says why instead of silently falling back.
      let stderr = '';
      child.stdout?.resume();
      child.stderr?.on('data', (data: Buffer) => {
        if (stderr.length < 64 * 1024) stderr += data.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else {
          console.error(`[pledgestack] Rust compilation failed for ${moduleName}:\n${stderr}`);
          reject(new Error(`cargo exited with ${code}`));
        }
      });
    });

    const targetDir = join(sharedTargetDir, isDev ? 'debug' : 'release');
    const libName = rustLibName(moduleName);
    const candidates = [
      join(targetDir, `lib${libName}.so`),
      join(targetDir, `lib${libName}.dylib`),
      join(targetDir, `${libName}.dll`),
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        const { copyFile } = await import('node:fs/promises');
        await copyFile(candidate, addonPath);
        await writeFile(hashFile, currentHash, 'utf-8');
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export default rollupAdapter;

const FALLBACK_SCRIPT_EXTS = new Set(['.ts', '.tsx', '.jsx', '.mjs', '.js', '.cjs', '.psx', '.ps']);
const FALLBACK_CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/** Whether the dev-server fallback serves this file as (transformed) JavaScript. */
export function isFallbackScript(filePath: string): boolean {
  return FALLBACK_SCRIPT_EXTS.has(extname(filePath).toLowerCase());
}

/** Content-Type for a file served by the dev-server fallback, chosen by extension. */
export function fallbackContentType(filePath: string): string {
  if (isFallbackScript(filePath)) return 'application/javascript; charset=utf-8';
  return FALLBACK_CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}
