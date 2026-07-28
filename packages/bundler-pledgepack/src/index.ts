import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { join, dirname, basename, extname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
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
import type {
  BundlerAdapter,
  BuildResult,
  DevServerHandle,
  DevServerOptions,
  TransformOptions,
  TransformResult,
} from 'pledgestack-shared';
import type { PledgeConfig } from 'pledgestack-shared';
import { resolveBinary, runPledgepack } from './binary-resolver';
export { resolveBinary, runPledgepack };
import {
  PLEDGEPACK_DEFAULT_PORT,
  fetchFromPledgepack,
  transformLocally,
  transformTsxLocally,
  generateRustFallback,
} from './transforms';
const TRANSFORM_CACHE = new Map<string, string>();

/**
 * PledgePack bundler adapter.
 *
 * Wraps the existing PledgePack Rust binary for build, dev server,
 * and file transformation. This is the default bundler for PledgeStack.
 */
export const pledgepackAdapter: BundlerAdapter = {
  name: 'pledgepack',

  async build(config: PledgeConfig): Promise<BuildResult> {
    const start = Date.now();
    try {
      await runPledgepack(['build', '--out-dir', config.outDir]);
      return {
        outDir: join(config.rootDir, config.outDir),
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
    const port = options.bundlerPort ?? PLEDGEPACK_DEFAULT_PORT;
    const hostname = options.hostname ?? 'localhost';

    const binary = resolveBinary();
    if (!binary) {
      throw new Error(
        'PledgePack binary not found. Run "cargo build --release" in the pledgepack package.',
      );
    }

    const proc = spawn(binary, ['dev', '--port', String(port), '--host', hostname], {
      stdio: 'inherit',
      cwd: config.rootDir,
    });

    await waitForServer(hostname, port, 5000);

    return {
      port,
      hostname,
      async stop() {
        proc.kill();
      },
    };
  },

  async transformFile(
    sourcePath: string,
    options: TransformOptions,
  ): Promise<TransformResult> {
    const ext = extname(sourcePath);

    // Handle .psx and .ps files
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

    const port = options.devServerPort ?? PLEDGEPACK_DEFAULT_PORT;
    let transformedCode: string;

    if (options.isDev && port > 0) {
      transformedCode = await fetchFromPledgepack(sourcePath, port, options.rootDir);
    } else {
      transformedCode = await transformLocally(sourcePath, ext);
    }

    const hash = createHash('sha256').update(sourcePath).digest('hex').slice(0, 12);
    const cacheDir = join(dirname(sourcePath), '.pledge-cache');
    const outFileName = basename(sourcePath, ext) + `.${hash}.js`;
    const outPath = join(cacheDir, outFileName);

    await mkdir(cacheDir, { recursive: true });

    if (options.isDev) {
      const devOutPath = join(cacheDir, basename(sourcePath, ext) + `.${Date.now()}.js`);
      await writeFile(devOutPath, transformedCode, 'utf-8');
      const fileUrl = pathToFileURL(devOutPath).href;
      TRANSFORM_CACHE.set(cacheKey, fileUrl);
      return { fileUrl };
    }

    await writeFile(outPath, transformedCode, 'utf-8');
    const fileUrl = pathToFileURL(outPath).href;
    TRANSFORM_CACHE.set(cacheKey, fileUrl);
    return { fileUrl };
  },

  resolveProductionPath(sourcePath: string, config: PledgeConfig): string {
    const ext = extname(sourcePath);
    const withoutExt = sourcePath.slice(0, -ext.length);
    const relativePath = withoutExt.replace(join(config.rootDir, config.appDir), '');
    const serverOutDir = join(config.rootDir, config.outDir, 'server');

    // Strategy 1: Direct mapping with .js extension
    const directPath = join(serverOutDir, `${relativePath}.js`);
    if (existsSync(directPath)) return directPath;

    // Strategy 2: Try .mjs and .cjs extensions
    for (const altExt of ['.mjs', '.cjs']) {
      const altPath = join(serverOutDir, `${relativePath}${altExt}`);
      if (existsSync(altPath)) return altPath;
    }

    // Strategy 3: Try index file (e.g., page.tsx → page/index.js)
    const indexDir = basename(withoutExt);
    const indexPath = join(serverOutDir, relativePath, indexDir, 'index.js');
    if (existsSync(indexPath)) return indexPath;

    // Strategy 4: Route manifest lookup
    const manifestPath = join(config.rootDir, config.outDir, '__pledge_ps_manifest.json');
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        const allRoutes = [
          ...(manifest.frontend ?? []),
          ...(manifest.api ?? []),
          ...(manifest.backend ?? []),
        ];
        const relSource = sourcePath.replace(join(config.rootDir, config.appDir), '').replace(/^[\\/]+/, '');
        const match = allRoutes.find((r: { file?: string }) => r.file?.replace(/\\/g, '/') === relSource);
        if (match) {
          const manifestOutPath = join(serverOutDir, match.file.replace(/\.[^.]+$/, '.js'));
          if (existsSync(manifestOutPath)) return manifestOutPath;
        }
      } catch {
        // Manifest parse error — continue to error
      }
    }

    throw new Error(
      `Production module not found: ${sourcePath}\n` +
      `Expected bundled output at: ${directPath}\n` +
      `Tried alternatives: ${relativePath}.mjs, ${relativePath}.cjs, ${relativePath}/${indexDir}/index.js\n` +
      `Did you run "pledge build" first?`
    );
  },
};

// ── Helpers ──────────────────────────────────────────────────────────

async function transformPSXFile(
  sourcePath: string,
  options: TransformOptions,
  format: 'psx' | 'ps',
): Promise<string> {
  const ext = format === 'ps' ? '.ps' : '.psx';
  const source = await readFile(sourcePath, 'utf-8');
  const moduleName = basename(sourcePath, ext);
  const cacheDir = join(dirname(sourcePath), '.pledge-cache');
  const projectRoot = options.rootDir ?? process.cwd();
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

    await ensureRootCargoToml(projectRoot, options.cargoConfig?.dev, options.cargoConfig?.release);

    const detectedCrates = detectCratesFromImports(result.parse.allImports);
    const moduleCargoToml = generateModuleCargoToml(moduleName, detectedCrates);
    await writeFile(join(rustDir, 'Cargo.toml'), moduleCargoToml, 'utf-8');

    addonReady = await compileRustAddon(rustDir, moduleName, cacheDir, options.isDev, options.cargoConfig, projectRoot);
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

  let transformedCode: string;
  const port = options.devServerPort ?? PLEDGEPACK_DEFAULT_PORT;

  if (options.isDev && port > 0) {
    const tsxTempPath = join(cacheDir, `${moduleName}.tsx`);
    await writeFile(tsxTempPath, result.tsx, 'utf-8');
    transformedCode = await fetchFromPledgepack(tsxTempPath, port, projectRoot);
  } else {
    transformedCode = await transformTsxLocally(result.tsx, options.isDev);
  }

  const hash = createHash('sha256').update(sourcePath).digest('hex').slice(0, 12);
  const outFileName = `${moduleName}.${hash}.js`;
  const outPath = join(cacheDir, outFileName);
  await writeFile(outPath, transformedCode, 'utf-8');

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
  rootDir?: string,
): Promise<boolean> {
  const projectRoot = rootDir ?? process.cwd();
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
  const cargoArgs = ['build', '--profile', profile];
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
      const child = spawn('cargo', cargoArgs, {
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

function waitForServer(hostname: string, port: number, timeoutMs: number): Promise<void> {
  const startTime = Date.now();
  return new Promise((resolve, reject) => {
    function attempt() {
      if (Date.now() - startTime > timeoutMs) {
        reject(new Error(`PledgePack dev server did not start within ${timeoutMs}ms`));
        return;
      }
      const req = httpRequest(`http://${hostname}:${port}/__pledge_router`, { method: 'GET', timeout: 1000 }, (res: import('node:http').IncomingMessage) => {
        res.destroy();
        resolve();
      });
      req.on('error', () => setTimeout(attempt, 200));
      req.on('timeout', () => { req.destroy(); setTimeout(attempt, 200); });
      req.end();
    }
    attempt();
  });
}

export default pledgepackAdapter;
