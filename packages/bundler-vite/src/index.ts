import { join, dirname, basename, extname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import {
  transformPSX,
  detectCratesFromImports,
  generateModuleCargoToml,
  ensureRootCargoToml,
  serializeSourceMap,
} from 'pledgestack-core';
import { generateRustFallback } from 'pledgestack-shared';
import type {
  BundlerAdapter,
  BuildResult,
  DevServerHandle,
  DevServerOptions,
  TransformOptions,
  TransformResult,
} from 'pledgestack-shared';
import type { PledgeConfig } from 'pledgestack-shared';

const TRANSFORM_CACHE = new Map<string, string>();

/**
 * Vite bundler adapter for PledgeStack.
 *
 * Uses Vite's dev server for development (with HMR) and Vite's build
 * (Rollup under the hood) for production. PSX/PS files are handled by
 * a custom Vite plugin that delegates to PledgeStack's transform pipeline.
 *
 * ## Usage in pledge.config.ts
 * ```typescript
 * import { defineConfig } from 'pledgestack-shared';
 *
 * export default defineConfig({
 *   bundler: 'vite',
 * });
 * ```
 *
 * Requires `vite` to be installed: `npm install vite`
 */
export const viteAdapter: BundlerAdapter = {
  name: 'vite',

  async build(config: PledgeConfig): Promise<BuildResult> {
    const start = Date.now();
    try {
      const { build: viteBuild } = await import('vite');
      const outDir = join(config.rootDir, config.outDir);

      // Build server bundle
      await viteBuild({
        root: config.rootDir,
        mode: 'production',
        build: {
          outDir: join(outDir, 'server'),
          ssr: true,
          rollupOptions: {
            input: collectServerEntries(config),
            output: {
              format: 'esm',
              entryFileNames: '[name].js',
            },
          },
          target: 'es2022',
          minify: 'esbuild',
          sourcemap: false,
        },
        resolve: {
          alias: buildAliasMap(config),
        },
        plugins: [pledgeStackVitePlugin(config)],
        logLevel: 'warn',
      });

      // Build client bundle (if not SSG-only)
      if (config.output !== 'export') {
        await viteBuild({
          root: config.rootDir,
          mode: 'production',
          build: {
            outDir: join(outDir, 'client'),
            ssr: false,
            rollupOptions: {
              output: {
                format: 'esm',
                entryFileNames: 'assets/[name].[hash].js',
                chunkFileNames: 'assets/[name].[hash].js',
                assetFileNames: 'assets/[name].[hash][extname]',
              },
            },
            target: 'es2022',
            minify: 'esbuild',
            sourcemap: false,
          },
          resolve: {
            alias: buildAliasMap(config),
          },
          plugins: [pledgeStackVitePlugin(config)],
          logLevel: 'warn',
        });
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
    const { createServer } = await import('vite');
    const port = options.bundlerPort ?? 3001;
    const hostname = options.hostname ?? 'localhost';

    const server = await createServer({
      root: config.rootDir,
      mode: 'development',
      server: {
        port,
        host: hostname,
        hmr: true,
      },
      resolve: {
        alias: buildAliasMap(config),
      },
      plugins: [pledgeStackVitePlugin(config)],
      logLevel: 'info',
    });

    await server.listen();

    return {
      port,
      hostname,
      async stop() {
        await server.close();
      },
      reload(modulePath: string) {
        const mod = server.moduleGraph.getModuleById(modulePath);
        if (mod) {
          server.moduleGraph.invalidateModule(mod);
          server.ws.send({ type: 'full-reload' });
        }
      },
      reloadAll() {
        server.ws.send({ type: 'full-reload' });
      },
    };
  },

  async transformFile(
    sourcePath: string,
    options: TransformOptions,
  ): Promise<TransformResult> {
    const ext = extname(sourcePath);

    // Handle .psx and .ps files via PledgeStack's transform pipeline
    if (ext === '.psx' || ext === '.ps') {
      const fileUrl = await transformPSXFile(sourcePath, options, ext === '.ps' ? 'ps' : 'psx');
      return { fileUrl };
    }

    if (ext !== '.ts' && ext !== '.tsx' && ext !== '.jsx' && ext !== '.mjs') {
      return { fileUrl: pathToFileURL(sourcePath).href };
    }

    // In dev mode, Vite handles transforms via its dev server.
    // For production, use esbuild as a fast local fallback.
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
    const relativePath = withoutExt.replace(join(config.rootDir, config.appDir), '');
    const productionPath = join(config.rootDir, config.outDir, 'server', `${relativePath}.js`);

    if (existsSync(productionPath)) return productionPath;
    return sourcePath;
  },
};

// ── Vite Plugin ──────────────────────────────────────────────────────

/**
 * Custom Vite plugin that handles PledgeStack-specific file types:
 * - .psx / .ps files (Rust + TSX hybrid)
 * - Route resolution
 * - PSX → JS transform via PledgeStack's pipeline
 */
function pledgeStackVitePlugin(_config: PledgeConfig) {
  return {
    name: 'pledgestack',
    enforce: 'pre' as const,

    resolveId(source: string, importer?: string) {
      // Resolve .psx and .ps imports
      if (source.endsWith('.psx') || source.endsWith('.ps')) {
        if (importer) {
          return resolve(dirname(importer), source);
        }
        return source;
      }
      return null;
    },

    async load(id: string) {
      // Transform .psx and .ps files
      if (id.endsWith('.psx') || id.endsWith('.ps')) {
        const format = id.endsWith('.ps') ? 'ps' : 'psx';
        const source = await readFile(id, 'utf-8');
        const moduleName = basename(id, extname(id));

        const result = transformPSX(source, {
          moduleName,
          compileRust: true,
          addonPath: `./${moduleName}.node`,
          format,
        });

        // For .ps files (pure Rust), return the NAPI wrapper
        if (format === 'ps') {
          return result.napiWrapper ?? generateRustFallback(moduleName);
        }

        // For .psx files, return the TSX portion — Vite/esbuild handles JSX
        return result.tsx;
      }
      return null;
    },

    configureServer(server: unknown) {
      // Hook into Vite's dev server for HMR of PSX files
      const viteServer = server as {
        ws: { send: (msg: unknown) => void };
        watcher: { on: (event: string, cb: (path: string) => void) => void };
      };

      viteServer.watcher.on('change', (path: string) => {
        if (path.endsWith('.psx') || path.endsWith('.ps')) {
          viteServer.ws.send({ type: 'full-reload' });
        }
      });
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function buildAliasMap(config: PledgeConfig): Record<string, string> {
  const alias: Record<string, string> = {};
  if (config.alias) {
    for (const [key, value] of Object.entries(config.alias)) {
      // Convert glob-style aliases (* wildcard) to Vite's path resolution
      const cleanKey = key.replace(/\/\*$/, '');
      const cleanValue = value.replace(/\/\*$/, '');
      alias[cleanKey] = join(config.rootDir, cleanValue);
    }
  }
  return alias;
}

function collectServerEntries(config: PledgeConfig): Record<string, string> {
  const appDir = join(config.rootDir, config.appDir);
  const entries: Record<string, string> = {};

  if (existsSync(appDir)) {
    // Use the app directory as a single entry point.
    // Vite + the PledgeStack plugin will resolve individual route modules.
    entries['app'] = appDir;
  }

  // Also check for a custom server entry
  const serverEntry = join(config.rootDir, 'server.ts');
  if (existsSync(serverEntry)) {
    entries['server'] = serverEntry;
  }

  return entries;
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

  // Compile Rust addon if needed
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

  // Transform TSX via esbuild
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
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`cargo exited with ${code}`));
      });
    });

    const targetDir = join(sharedTargetDir, isDev ? 'debug' : 'release');
    const libName = `pledge_${moduleName}`;
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

export default viteAdapter;
