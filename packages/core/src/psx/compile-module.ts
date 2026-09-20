/**
 * Shared .psx/.ps compile pipeline.
 *
 * Every consumer (the SSR server transform, the webpack loader and the
 * Vite / Rollup / Rsbuild plugin `load` hooks) needs the same steps:
 * parse -> write artifacts -> cargo build -> write the NAPI wrapper (or the
 * fallback stub when the addon could not be built). This module is the single
 * implementation so those paths cannot drift apart.
 *
 * Isolation: each source file gets a unique crate name (module name + a hash
 * of its project-relative path) and its compile state is keyed by the source
 * path. Two `page.psx` files in different directories therefore never share a
 * crate, a cargo output file, an addon hash or an in-flight/pending state.
 *
 * Concurrency: builds for one source file are serialized. A request that
 * arrives while a build is in flight with different Rust source marks a
 * pending recompile; when the in-flight build finishes it runs again and every
 * waiter receives the result of the final build.
 */

import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, basename, extname, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { CargoConfig } from 'pledgestack-shared';
import { generateRustFallback } from 'pledgestack-shared';
import { transformPSX } from './transform';
import type { PSXTransformResult, SourceMapEntry } from './types';
import { usesPoolInjection } from './codegen';
import {
  detectCratesFromImports,
  generateModuleCargoToml,
  ensureRootCargoToml,
  rustLibName,
} from './workspace';
import {
  serializeSourceMap,
  mapRustErrors,
  formatMappedError,
  captureRustOutput,
  formatCapturedOutput,
} from './source-map';

// ── Public types ─────────────────────────────────────────────────────

/** Everything a build function needs to produce `<cacheDir>/<name>.node`. */
export interface RustBuildRequest {
  rustDir: string;
  /** Unique (per source file) module identifier used for the cargo crate. */
  crateId: string;
  /** Display name (file basename without extension). */
  moduleName: string;
  cacheDir: string;
  /** Where the built addon must be copied to. */
  addonPath: string;
  isDev: boolean;
  sourceFilePath: string;
  projectRoot: string;
  cargoConfig?: CargoConfig;
  sourceMap: SourceMapEntry[];
}

/** Builds the addon. Resolves true when `addonPath` was written. */
export type RustBuildFn = (req: RustBuildRequest) => Promise<boolean>;

export interface CompilePSXModuleOptions {
  sourcePath: string;
  format?: 'psx' | 'ps';
  isDev: boolean;
  projectRoot?: string;
  cargoConfig?: CargoConfig;
  /** Override the cargo build step (tests, custom toolchains). */
  build?: RustBuildFn;
  /** Called after an addon was (re)built successfully. */
  onAddonBuilt?: (info: { moduleName: string; sourcePath: string }) => void;
  /**
   * Import specifier the emitted TSX uses for the NAPI wrapper. Defaults to
   * `./.pledge-cache/<name>.napi.js` (relative to the source file, which is
   * where bundler load hooks emit the module). The server transform emits the
   * module next to the wrapper and passes `./<name>.napi.js`.
   */
  wrapperImportPath?: string;
}

export interface CompiledPSXModule {
  moduleName: string;
  crateId: string;
  cacheDir: string;
  result: PSXTransformResult;
  /** True when a compiled addon is available and the real wrapper was written. */
  addonReady: boolean;
  /** Absolute path of the written `<name>.napi.js`. */
  wrapperPath: string;
  wrapperUrl: string;
}

// ── Naming ───────────────────────────────────────────────────────────

/**
 * Unique cargo module identifier for a source file: its base name plus a
 * short hash of its path relative to the project root.
 */
export function psxCrateId(sourcePath: string, projectRoot: string): string {
  const moduleName = basename(sourcePath, extname(sourcePath));
  const rel = relative(resolve(projectRoot), resolve(sourcePath)).split('\\').join('/');
  const hash = createHash('sha256').update(rel).digest('hex').slice(0, 8);
  return `${moduleName}_${hash}`;
}

// ── Serialized compile state ─────────────────────────────────────────

interface CompilationState {
  /** Hash of the Rust source currently being built. */
  hash: string;
  compiledAt: number;
  compiling: boolean;
  /** A newer source arrived while building; rebuild once the current build ends. */
  pendingRecompile: boolean;
  /** Settles when the in-flight build (and any pending rebuilds) finished. */
  promise?: Promise<boolean>;
}

const COMPILATION_STATE = new Map<string, CompilationState>();

/** Test hook: clears compile state. */
export function resetCompilationState(): void {
  COMPILATION_STATE.clear();
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Builds `req.addonPath` from `<rustDir>/lib.rs`, skipping when the content
 * hash is unchanged, serializing builds per source file and honouring a
 * pending recompile.
 */
export async function compileRustAddon(
  req: RustBuildRequest,
  build: RustBuildFn = cargoBuild,
  onAddonBuilt?: (info: { moduleName: string; sourcePath: string }) => void,
): Promise<boolean> {
  const key = resolve(req.sourceFilePath);
  const libRs = join(req.rustDir, 'lib.rs');
  const hashFile = join(req.cacheDir, `${req.moduleName}.node.hash`);

  const currentHash = sha(await readFile(libRs, 'utf-8'));

  const existing = COMPILATION_STATE.get(key);
  if (existing?.compiling && existing.promise) {
    if (existing.hash !== currentHash) existing.pendingRecompile = true;
    // Wait for the in-flight build and any rebuild it triggers.
    return existing.promise;
  }

  const state: CompilationState = {
    hash: currentHash,
    compiledAt: 0,
    compiling: true,
    pendingRecompile: false,
  };
  COMPILATION_STATE.set(key, state);

  state.promise = (async () => {
    let ok = false;
    try {
      let hash = currentHash;
      do {
        state.pendingRecompile = false;
        state.hash = hash;

        if (existsSync(req.addonPath) && existsSync(hashFile) && (await readFile(hashFile, 'utf-8')) === hash) {
          ok = true; // up to date
        } else {
          ok = await build(req);
          if (ok) {
            await writeFile(hashFile, hash, 'utf-8');
            state.compiledAt = Date.now();
            try {
              onAddonBuilt?.({ moduleName: req.moduleName, sourcePath: req.sourceFilePath });
            } catch {
              // listener errors must not affect compilation
            }
          }
        }

        if (state.pendingRecompile) hash = sha(await readFile(libRs, 'utf-8'));
      } while (state.pendingRecompile);
    } catch (err) {
      console.error(`[pledgestack] Rust compilation failed for ${req.moduleName}:`, err);
      ok = false;
    } finally {
      state.compiling = false;
    }
    return ok;
  })();

  return state.promise;
}

// ── Default cargo build ──────────────────────────────────────────────

let SCCACHE_AVAILABLE: boolean | undefined;

async function probe(cmd: string): Promise<boolean> {
  const { spawn } = await import('node:child_process');
  return new Promise<boolean>((resolvePromise) => {
    const child = spawn(cmd, ['--version'], { stdio: 'ignore' });
    child.on('error', () => resolvePromise(false));
    child.on('close', (code) => resolvePromise(code === 0));
  });
}

/**
 * Default build: `cargo build` in the module's crate dir with a persistent
 * shared target directory. Crates have unique names, so sharing the target
 * dir (and therefore the dependency cache) cannot make two files collide.
 * Resolves false (never throws) when cargo is missing or the build fails.
 */
export const cargoBuild: RustBuildFn = async (req) => {
  if (!(await probe('cargo'))) return false;
  const { spawn } = await import('node:child_process');
  const { cargoConfig, isDev, rustDir, moduleName } = req;

  const sharedTargetDir = cargoConfig?.targetDir ?? join(req.projectRoot, 'target');
  const cargoEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CARGO_TARGET_DIR: sharedTargetDir,
  };

  if (cargoConfig?.sccache !== false) {
    SCCACHE_AVAILABLE ??= await probe('sccache');
    if (SCCACHE_AVAILABLE) cargoEnv.RUSTC_WRAPPER = 'sccache';
  }

  const timeoutMs = cargoConfig?.timeout ?? (isDev ? 30000 : 120000);
  let stdout: string;
  try {
    stdout = await new Promise<string>((resolvePromise, reject) => {
      const child = spawn('cargo', ['build', '--profile', isDev ? 'dev' : 'release'], {
        cwd: rustDir,
        stdio: 'pipe',
        timeout: timeoutMs,
        env: cargoEnv,
      });
      let out = '';
      let err = '';
      child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { if (err.length < 256 * 1024) err += d.toString(); });
      child.on('error', reject);
      child.on('close', (code, signal) => {
        if (code === 0) return resolvePromise(out);
        const mapped = mapRustErrors(err, req.sourceMap, moduleName, req.sourceFilePath);
        if (mapped.length > 0) {
          for (const e of mapped) console.error(formatMappedError(e, req.sourceFilePath));
        } else {
          console.error(`[pledgestack] Rust compilation failed for ${moduleName}:\n${err}`);
        }
        if (code === null && signal === 'SIGTERM') reject(new Error(`cargo build timed out after ${timeoutMs}ms`));
        else if (code === null) reject(new Error(`cargo was killed by signal ${signal ?? 'unknown'}`));
        else reject(new Error(`cargo exited with code ${code}`));
      });
    });
  } catch {
    return false;
  }

  if (stdout.trim()) {
    const captured = captureRustOutput(stdout, 'stdout', req.sourceMap, req.sourceFilePath);
    for (const line of formatCapturedOutput(captured)) console.log(line);
  }

  const targetDir = join(sharedTargetDir, isDev ? 'debug' : 'release');
  const libName = rustLibName(req.crateId);
  for (const candidate of [
    join(targetDir, `lib${libName}.so`),
    join(targetDir, `lib${libName}.dylib`),
    join(targetDir, `${libName}.dll`),
  ]) {
    if (existsSync(candidate)) {
      await copyFile(candidate, req.addonPath);
      return true;
    }
  }
  console.error(`[pledgestack] Compiled addon not found for ${moduleName}`);
  return false;
};

// ── Pipeline ─────────────────────────────────────────────────────────

/**
 * Parses a .psx/.ps file, writes its artifacts under `<dir>/.pledge-cache`,
 * builds the Rust addon (when the file has Rust) and writes the NAPI wrapper
 * (or the fallback stub when the addon is unavailable).
 */
export async function compilePSXModule(opts: CompilePSXModuleOptions): Promise<CompiledPSXModule> {
  const { sourcePath, isDev } = opts;
  const format = opts.format ?? (sourcePath.endsWith('.ps') ? 'ps' : 'psx');
  const projectRoot = opts.projectRoot ?? process.cwd();
  const ext = format === 'ps' ? '.ps' : '.psx';
  const moduleName = basename(sourcePath, ext);
  const crateId = psxCrateId(sourcePath, projectRoot);
  const cacheDir = join(dirname(sourcePath), '.pledge-cache');
  await mkdir(cacheDir, { recursive: true });

  const source = await readFile(sourcePath, 'utf-8');
  const result = transformPSX(source, {
    moduleName,
    compileRust: true,
    addonPath: `./${moduleName}.node`,
    wrapperImportPath: opts.wrapperImportPath ?? `./.pledge-cache/${moduleName}.napi.js`,
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

    await ensureRootCargoToml(projectRoot, opts.cargoConfig?.dev, opts.cargoConfig?.release);

    const crates = new Set(detectCratesFromImports(result.parse.allImports));
    if (usesPoolInjection(result.parse)) crates.add('sqlx');
    await writeFile(join(rustDir, 'Cargo.toml'), generateModuleCargoToml(crateId, [...crates]), 'utf-8');

    addonReady = await compileRustAddon(
      {
        rustDir,
        crateId,
        moduleName,
        cacheDir,
        addonPath: join(cacheDir, `${moduleName}.node`),
        isDev,
        sourceFilePath: sourcePath,
        projectRoot,
        cargoConfig: opts.cargoConfig,
        sourceMap: result.sourceMap ?? [],
      },
      opts.build ?? cargoBuild,
      opts.onAddonBuilt,
    );
  }

  const wrapperPath = join(cacheDir, `${moduleName}.napi.js`);
  if (result.napiWrapper) {
    await writeFile(
      wrapperPath,
      addonReady ? result.napiWrapper : generateRustFallback(moduleName),
      'utf-8',
    );
  } else if (format === 'ps') {
    await writeFile(wrapperPath, generateRustFallback(moduleName), 'utf-8');
  }

  return {
    moduleName,
    crateId,
    cacheDir,
    result,
    addonReady,
    wrapperPath,
    wrapperUrl: pathToFileURL(wrapperPath).href,
  };
}

/**
 * Module source a bundler `load` hook should return for a compiled file:
 * the transformed TSX for .psx, a re-export of the wrapper for .ps.
 */
export function psxLoadOutput(compiled: CompiledPSXModule, format: 'psx' | 'ps'): string {
  if (format === 'ps') {
    return `export { rust } from ${JSON.stringify(compiled.wrapperPath.split('\\').join('/'))};\n`;
  }
  return compiled.result.tsx;
}

export interface LoadPSXOptions {
  isDev: boolean;
  projectRoot?: string;
  cargoConfig?: CargoConfig;
  /** Override the cargo build step (tests, custom toolchains). */
  build?: RustBuildFn;
}

/**
 * What a bundler `load`/loader hook does for a .psx/.ps file: compile the
 * Rust (writing the addon + wrapper next to the source) and return the module
 * source. Shared by the webpack loader and the Vite / Rollup / Rsbuild plugins.
 */
export async function loadPSXModule(sourcePath: string, opts: LoadPSXOptions): Promise<string> {
  const format = sourcePath.endsWith('.ps') ? 'ps' : 'psx';
  const compiled = await compilePSXModule({ sourcePath, format, ...opts });
  return psxLoadOutput(compiled, format);
}
