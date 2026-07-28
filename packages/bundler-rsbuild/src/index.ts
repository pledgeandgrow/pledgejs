import { join, dirname, basename, extname } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
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
 * Rsbuild bundler adapter for PledgeStack.
 *
 * Rsbuild is a high-performance build tool powered by Rspack (Rust-based
 * webpack-compatible bundler). This adapter uses Rsbuild's programmatic API
 * for both development (with HMR) and production builds.
 *
 * ## Usage in pledge.config.ts
 * ```typescript
 * import { defineConfig } from 'pledgestack-shared';
 *
 * export default defineConfig({
 *   bundler: 'rsbuild',
 * });
 * ```
 *
 * Requires `@rsbuild/core` to be installed: `pnpm add @rsbuild/core`
 *
 * PSX/PS files are handled by a custom Rsbuild plugin that delegates to
 * PledgeStack's transform pipeline. TS/TSX files are handled by Rsbuild's
 * built-in SWC compiler.
 */
export const rsbuildAdapter: BundlerAdapter = {
  name: 'rsbuild',

  async build(config: PledgeConfig): Promise<BuildResult> {
    const start = Date.now();
    try {
      const outDir = join(config.rootDir, config.outDir);
      const appDir = join(config.rootDir, config.appDir);
      const routeFiles = await collectRouteFiles(appDir);

      // Try Rsbuild native build
      const rsbuild = await tryLoadRsbuild();
      if (rsbuild) {
        const entry: Record<string, string> = {};
        for (const routeFile of routeFiles) {
          const relPath = routeFile.replace(appDir, '').replace(/^\//, '').replace(/\.(ts|tsx|jsx|psx|ps)$/, '');
          entry[relPath] = routeFile;
        }

        const { createRsbuild } = rsbuild;
        const rsbuildInstance = await createRsbuild({
          cwd: config.rootDir,
          entry,
          output: {
            distPath: { root: outDir },
            filename: { js: '[name].js' },
          },
          tools: {
            rspack: {
              resolve: {
                alias: buildAliasMap(config),
              },
            },
          },
          plugins: [
            {
              name: 'pledgestack-psx',
              setup(api: RsbuildPluginApi) {
                api.transform({ resource: /\.(psx|ps)$/ }, async ({ code, resourcePath }) => {
                  const result = transformPSX(code, {
                    moduleName: basename(resourcePath, extname(resourcePath)),
                    compileRust: true,
                    addonPath: `./${basename(resourcePath, extname(resourcePath))}.node`,
                    format: resourcePath.endsWith('.ps') ? 'ps' : 'psx',
                  });
                  return { code: result.tsx ?? result.napiWrapper ?? '' };
                });
              },
            },
          ],
        });

        await rsbuildInstance.build();

        return {
          outDir,
          success: true,
          durationMs: Date.now() - start,
        };
      }

      // Fallback: esbuild-based bundling
      const serverOutDir = join(outDir, 'server');
      await mkdir(serverOutDir, { recursive: true });

      for (const routeFile of routeFiles) {
        const { fileUrl } = await rsbuildAdapter.transformFile(routeFile, {
          isDev: false,
          cargoConfig: config.cargo,
        });

        const relPath = routeFile.replace(appDir, '').replace(/^\//, '');
        const ext = extname(routeFile);
        const outName = relPath.slice(0, -ext.length) + '.js';
        const outPath = join(serverOutDir, outName);

        await mkdir(dirname(outPath), { recursive: true });
        const code = await readFile(new URL(fileUrl), 'utf-8');
        await writeFile(outPath, code, 'utf-8');
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
    const port = options.bundlerPort ?? 3001;
    const hostname = options.hostname ?? 'localhost';

    // Try Rsbuild native dev server
    const rsbuild = await tryLoadRsbuild();
    if (rsbuild) {
      const appDir = join(config.rootDir, config.appDir);
      const routeFiles = await collectRouteFiles(appDir);
      const entry: Record<string, string> = {};
      for (const routeFile of routeFiles) {
        const relPath = routeFile.replace(appDir, '').replace(/^\//, '').replace(/\.(ts|tsx|jsx|psx|ps)$/, '');
        entry[relPath] = routeFile;
      }

      const { createRsbuild } = rsbuild;
      const rsbuildInstance = await createRsbuild({
        cwd: config.rootDir,
        entry,
        server: {
          port,
          host: hostname,
          hmr: true,
        },
        tools: {
          rspack: {
            resolve: {
              alias: buildAliasMap(config),
            },
          },
        },
      });

      const result = await rsbuildInstance.startDevServer();

      return {
        port: result.port ?? port,
        hostname,
        async stop() {
          await rsbuildInstance.close();
        },
        reloadAll() {
          rsbuildInstance.devServer?.ws?.send({ type: 'reload' });
        },
      };
    }

    // Fallback: lightweight HTTP server with esbuild transforms
    const { createServer } = await import('node:http');

    const server = createServer(async (req, res) => {
      const url = req.url ?? '/';
      const cwd = process.cwd();
      const filePath = join(cwd, url.replace(/^\//, ''));

      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      try {
        const { fileUrl } = await rsbuildAdapter.transformFile(filePath, {
          isDev: true,
        });
        const code = await readFile(new URL(fileUrl), 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
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

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Minimal type for @rsbuild/core's programmatic API.
 */
interface RsbuildCoreAPI {
  createRsbuild(opts: Record<string, unknown>): Promise<{
    build(): Promise<void>;
    startDevServer(): Promise<{ port?: number }>;
    close(): Promise<void>;
    devServer?: { ws?: { send(msg: unknown): void } };
  }>;
}

/**
 * Minimal type for Rsbuild plugin API (setup callback).
 */
interface RsbuildPluginApi {
  transform(
    opts: { resource: RegExp },
    cb: (ctx: { code: string; resourcePath: string }) => Promise<{ code: string }> | { code: string },
  ): void;
}

/**
 * Tries to dynamically import @rsbuild/core.
 * Returns null if not installed (falls back to esbuild).
 */
async function tryLoadRsbuild(): Promise<RsbuildCoreAPI | null> {
  try {
    const moduleName = '@rsbuild/core';
    const mod = await import(/* @vite-ignore */ moduleName);
    if (mod && typeof mod.createRsbuild === 'function') {
      return mod as unknown as RsbuildCoreAPI;
    }
    return null;
  } catch {
    return null;
  }
}

function buildAliasMap(config: PledgeConfig): Record<string, string> {
  const alias: Record<string, string> = {};
  if (config.alias) {
    for (const [name, path] of Object.entries(config.alias)) {
      alias[name] = join(config.rootDir, path);
    }
  }
  alias['@'] = join(config.rootDir, config.appDir);
  return alias;
}

async function collectRouteFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  if (!existsSync(dir)) return files;

  async function walk(d: string) {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
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

export default rsbuildAdapter;
