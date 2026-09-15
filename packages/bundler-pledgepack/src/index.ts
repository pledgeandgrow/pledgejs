import { spawn, type ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { join, extname } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
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
import { PLEDGEPACK_DEFAULT_PORT } from './transforms';

/**
 * Cached route manifest (loaded once per build, not per request).
 * Invalidated when `resolveProductionPath` is called after a fresh build
 * (the manifest's mtime changes).
 */
let cachedManifest: { routes: Array<{ file?: string }>; manifestPath: string; mtime: number } | null = null;

/**
 * PledgePack bundler adapter.
 *
 * Wraps the existing PledgePack Rust binary for build, dev server,
 * and file transformation. This is the default bundler for PledgeStack.
 *
 * .psx/manifest contract:
 *   - PledgePack (Rust adapter-pledgestack) owns route discovery and
 *     manifest generation (__pledge_ps_manifest.json). It also copies
 *     .psx/.ps files to .rs in the output dir for cargo build.
 *   - This adapter (bundler-pledgepack) owns the TS/TSX transformation
 *     (delegating to the pledgepack binary), .psx→TSX transpilation (the
 *     JSX extraction via pledgestack-core's transformPSX), and Rust addon
 *     compilation (spawning cargo for the .node addon). It consumes the
 *     manifest as a fallback in resolveProductionPath.
 *   - See pledgepack/docs/CONNECTION.md for the full responsibility split.
 *
 * transformFile delegates to pledgestack-server's transformFile so that
 * .psx/.ps/.vue/.svelte/.mdx/.ts/.tsx all go through the SAME code path
 * as the no-adapter fallback. This eliminates a duplicated transformPSXFile
 * / compileRustAddon that had drifted out of sync (missing source-map
 * error mapping, HMR notification, println! bridge, and incremental
 * compilation state). The server's version has all of those features.
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

    const resolvedBinary = resolveBinary();
    if (!resolvedBinary) {
      throw new Error(
        'PledgePack binary not found. Run "cargo build --release" in the pledgepack package.',
      );
    }
    // Re-bound to a plain `string`-typed const: `resolvedBinary`'s
    // null-check above narrows it within this function, but TypeScript
    // doesn't carry that narrowing into the nested closures below
    // (`attachCrashHandler`'s `setTimeout` callback, specifically) since
    // it can't prove none of them run before the narrowing "could" be
    // invalidated — rebinding sidesteps the question instead of fighting it.
    const binary: string = resolvedBinary;

    // Goal 80: probe the port before spawning, so a conflict surfaces as an
    // immediate, specific error instead of a generic 5s "did not start"
    // timeout from waitForServer with no indication of why.
    await checkPortAvailable(hostname, port);

    const spawnArgs = ['dev', '--port', String(port), '--host', hostname];
    const spawnOpts = { stdio: 'inherit' as const, cwd: config.rootDir };

    let proc = spawn(binary, spawnArgs, spawnOpts);
    let stopped = false;
    let restartCount = 0;
    const MAX_RESTARTS = 5;

    // Goal 78-79: track a startup-time failure (spawn error or the process
    // exiting before it ever became reachable) so `waitForServer`'s retry
    // loop can fail fast and with a real cause, instead of retrying blindly
    // for the full 5s timeout and reporting only "did not start" — spawn
    // failures, immediate crashes, ECONNREFUSED-while-still-booting, and
    // ECONNRESET-after-crashing previously all looked identical to the
    // caller.
    let startupFailure: Error | null = null;
    let resolveStartupFailure: (() => void) | null = null;
    const startupFailurePromise = new Promise<void>((resolve) => {
      resolveStartupFailure = resolve;
    });

    function bindStartupFailureHandlers(p: ChildProcess) {
      const onSpawnError = (err: Error) => {
        startupFailure = new Error(
          `Failed to launch the PledgePack dev server binary (${binary}): ${err.message}`,
        );
        resolveStartupFailure?.();
      };
      const onEarlyExit = (code: number | null, signal: NodeJS.Signals | null) => {
        startupFailure = new Error(
          `PledgePack dev server process exited before it started responding ` +
            `(code=${code ?? 'null'}, signal=${signal ?? 'none'}). Check its output above for the real cause.`,
        );
        resolveStartupFailure?.();
      };
      p.once('error', onSpawnError);
      p.once('exit', onEarlyExit);
      return { onSpawnError, onEarlyExit };
    }

    const startupHandlers = bindStartupFailureHandlers(proc);

    try {
      await Promise.race([
        waitForServer(hostname, port, 5000, () => startupFailure),
        startupFailurePromise.then(() => {
          throw startupFailure ?? new Error('PledgePack dev server failed to start');
        }),
      ]);
    } finally {
      // These handlers were only for detecting a *startup* failure; once
      // we're past startup (success or failure) the crash-handling below
      // takes over instead.
      proc.off('error', startupHandlers.onSpawnError);
      proc.off('exit', startupHandlers.onEarlyExit);
    }

    // Goal 83: bounded auto-restart if the dev server crashes *after*
    // successfully starting (not during startup, which is handled above).
    // Exponential backoff (1s, 2s, 4s, ... capped at 30s), gives up after
    // MAX_RESTARTS so a persistently-crashing binary doesn't restart
    // forever and mask the underlying problem.
    function attachCrashHandler(p: ChildProcess) {
      p.on('exit', (code, signal) => {
        if (stopped) return; // Expected exit via stop() below.
        if (restartCount >= MAX_RESTARTS) {
          console.error(
            `[pledgepack] dev server crashed (code=${code ?? 'null'}, signal=${signal ?? 'none'}) ` +
              `and has exceeded ${MAX_RESTARTS} restart attempts — giving up. Run "pledge dev" ` +
              `directly to see the underlying error.`,
          );
          return;
        }
        const delayMs = Math.min(1000 * 2 ** restartCount, 30000);
        restartCount++;
        console.error(
          `[pledgepack] dev server crashed (code=${code ?? 'null'}, signal=${signal ?? 'none'}) — ` +
            `restarting in ${delayMs}ms (attempt ${restartCount}/${MAX_RESTARTS})`,
        );
        setTimeout(() => {
          if (stopped) return;
          proc = spawn(binary, spawnArgs, spawnOpts);
          attachCrashHandler(proc);
        }, delayMs);
      });
    }
    attachCrashHandler(proc);

    return {
      port,
      hostname,
      async stop() {
        stopped = true;
        await stopProcessGracefully(proc);
      },
    };
  },

  async transformFile(
    sourcePath: string,
    options: TransformOptions,
  ): Promise<TransformResult> {
    // Delegate to the server's full-featured transformFile — this ensures
    // .psx/.ps files get source-map error mapping (#210), println! bridge
    // (#211), HMR notification (#208), and incremental compilation state
    // (#214) that the previous local duplicate lacked.
    const { transformFile: serverTransformFile } = await import('pledgestack-server');
    const fileUrl = await serverTransformFile(
      sourcePath,
      options.isDev,
      options.devServerPort,
      options.cargoConfig,
      options.rootDir,
      options.hostname,
    );
    return { fileUrl };
  },

  resolveProductionPath(sourcePath: string, config: PledgeConfig): string {
    const ext = extname(sourcePath);
    const withoutExt = sourcePath.slice(0, -ext.length);
    const relativePath = withoutExt.replace(join(config.rootDir, config.appDir), '');
    const serverOutDir = join(config.rootDir, config.outDir, 'server');

    // Strategy 1: Route manifest lookup (pledgepack generates __pledge_ps_manifest.json)
    // The manifest is loaded once and cached — avoids sync I/O on every request.
    const manifestPath = join(config.rootDir, config.outDir, '__pledge_ps_manifest.json');
    const manifest = loadManifest(manifestPath);
    if (manifest) {
      const allRoutes = manifest;
      const relSource = sourcePath.replace(join(config.rootDir, config.appDir), '').replace(/^[\\/]+/, '');
      const match = allRoutes.find((r: { file?: string }) => r.file?.replace(/\\/g, '/') === relSource);
      if (match) {
        const manifestOutPath = join(serverOutDir, match.file!.replace(/\.[^.]+$/, '.js'));
        if (existsSync(manifestOutPath)) return manifestOutPath;
      }
    }

    // Strategy 2: Direct mapping with .js extension
    const directPath = join(serverOutDir, `${relativePath}.js`);
    if (existsSync(directPath)) return directPath;

    // Strategy 3: Try .mjs and .cjs extensions
    for (const altExt of ['.mjs', '.cjs']) {
      const altPath = join(serverOutDir, `${relativePath}${altExt}`);
      if (existsSync(altPath)) return altPath;
    }

    // Strategy 4: Try index file (e.g., page.tsx → page/index.js)
    const indexDir = relativePath.split(/[\\/]/).pop() ?? relativePath;
    const indexPath = join(serverOutDir, relativePath, indexDir, 'index.js');
    if (existsSync(indexPath)) return indexPath;

    throw new Error(
      `Production module not found: ${sourcePath}\n` +
      `Expected bundled output at: ${directPath}\n` +
      `Tried alternatives: ${relativePath}.mjs, ${relativePath}.cjs, ${relativePath}/${indexDir}/index.js\n` +
      `Did you run "pledge build" first?`
    );
  },
};

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Expected `RouteManifest` schema version — must match
 * `pledgepack_core::PLEDGESTACK_MANIFEST_SCHEMA_VERSION` /
 * `RouteManifest::SCHEMA_VERSION` on the Rust side (see
 * `crates/adapter-pledgestack/src/lib.rs` and `crates/core/src/lib.rs` in
 * the pledgepack repo). There is no automated cross-repo check keeping this
 * in sync (see goal 87) — bump this by hand when that constant bumps.
 * PRODUCTION-READINESS-100.md goal 81.
 */
const EXPECTED_MANIFEST_SCHEMA_VERSION = 1;

/**
 * Loads and caches the route manifest. The manifest is read from disk once
 * and cached by mtime — if the file changes (e.g. after a rebuild), the cache
 * is invalidated and the manifest is re-read. This avoids sync `readFileSync`
 * on every production request.
 *
 * Goal 82: previously a bare `JSON.parse` with a silent catch-all fallthrough
 * to `null` on *any* failure — a malformed-but-present manifest (partial
 * write mid-build, corrupted file, or a genuinely incompatible schema from a
 * future PledgePack version) looked identical to "manifest doesn't exist
 * yet," silently falling through to resolveProductionPath's weaker
 * path-guessing strategies instead of surfacing the real problem. Now
 * validates the parsed shape and the schema version explicitly, logging a
 * specific warning for each distinct failure mode instead of staying silent.
 */
function loadManifest(manifestPath: string): Array<{ file?: string }> | null {
  if (!existsSync(manifestPath)) return null;
  try {
    const stat = statSync(manifestPath);
    if (cachedManifest && cachedManifest.manifestPath === manifestPath && cachedManifest.mtime === stat.mtimeMs) {
      return cachedManifest.routes;
    }

    let raw: string;
    try {
      raw = readFileSync(manifestPath, 'utf-8');
    } catch (err) {
      console.warn(`[pledgepack] Could not read route manifest at ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }

    let manifest: unknown;
    try {
      manifest = JSON.parse(raw);
    } catch (err) {
      console.warn(
        `[pledgepack] Route manifest at ${manifestPath} is not valid JSON ` +
          `(${err instanceof Error ? err.message : String(err)}) — falling back to path-guessing. ` +
          `This usually means the manifest was read mid-write; if it persists, re-run "pledge build".`,
      );
      return null;
    }

    if (typeof manifest !== 'object' || manifest === null) {
      console.warn(`[pledgepack] Route manifest at ${manifestPath} is not a JSON object — falling back to path-guessing.`);
      return null;
    }
    const m = manifest as Record<string, unknown>;

    const schemaVersion = typeof m.schema_version === 'number' ? m.schema_version : 0;
    if (schemaVersion === 0) {
      console.warn(
        `[pledgepack] Route manifest at ${manifestPath} has no schema_version field — it was likely ` +
          `generated by a PledgePack version older than the one this document's goal 81 shipped in. ` +
          `Proceeding, but consider upgrading PledgePack.`,
      );
    } else if (schemaVersion > EXPECTED_MANIFEST_SCHEMA_VERSION) {
      console.warn(
        `[pledgepack] Route manifest at ${manifestPath} has schema_version ${schemaVersion}, newer than ` +
          `this adapter understands (${EXPECTED_MANIFEST_SCHEMA_VERSION}) — proceeding anyway (unknown fields ` +
          `are ignored below), but you should upgrade bundler-pledgepack to match your PledgePack version.`,
      );
    } else if (schemaVersion < EXPECTED_MANIFEST_SCHEMA_VERSION) {
      console.warn(
        `[pledgepack] Route manifest at ${manifestPath} has schema_version ${schemaVersion}, older than ` +
          `this adapter expects (${EXPECTED_MANIFEST_SCHEMA_VERSION}) — your PledgePack binary may be out of date.`,
      );
    }

    const frontend = Array.isArray(m.frontend) ? m.frontend : [];
    const api = Array.isArray(m.api) ? m.api : [];
    const backend = Array.isArray(m.backend) ? m.backend : [];
    if (!Array.isArray(m.frontend) || !Array.isArray(m.api) || !Array.isArray(m.backend)) {
      console.warn(
        `[pledgepack] Route manifest at ${manifestPath} is missing one or more of the expected ` +
          `frontend/api/backend array fields — treating missing fields as empty rather than failing outright.`,
      );
    }
    const routes: Array<{ file?: string }> = [...frontend, ...api, ...backend];

    cachedManifest = { routes, manifestPath, mtime: stat.mtimeMs };
    return routes;
  } catch (err) {
    console.warn(`[pledgepack] Unexpected error loading route manifest at ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Probes whether `port` on `hostname` is free by briefly binding to it.
 * Goal 80: previously the only signal a port conflict gave was
 * waitForServer's generic 5s "did not start" timeout.
 */
function checkPortAvailable(hostname: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const tester = createNetServer();
    tester.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Port ${port} on ${hostname} is already in use — is another dev server (or a previous ` +
              `PledgePack instance that didn't shut down cleanly) still running on it?`,
          ),
        );
      } else {
        // Some other bind error (e.g. EACCES on a privileged port, or a
        // permissions/firewall quirk) — don't block startup on a probe
        // failure that isn't actually "something else owns this port"; let
        // the real spawn attempt surface it if it's a real problem.
        resolve();
      }
    });
    tester.once('listening', () => {
      tester.close(() => resolve());
    });
    tester.listen(port, hostname);
  });
}

/**
 * Goal 79: waits for the dev server to respond, distinguishing *why* each
 * attempt failed instead of treating every connection error identically.
 * `getStartupFailure` lets the caller inject "the process already died" as
 * an immediate failure instead of retrying uselessly until the timeout.
 */
function waitForServer(
  hostname: string,
  port: number,
  timeoutMs: number,
  getStartupFailure?: () => Error | null,
): Promise<void> {
  const startTime = Date.now();
  let lastErrorCode: string | undefined;
  return new Promise((resolve, reject) => {
    function attempt() {
      const startupFailure = getStartupFailure?.();
      if (startupFailure) {
        reject(startupFailure);
        return;
      }
      if (Date.now() - startTime > timeoutMs) {
        const reasonSuffix =
          lastErrorCode === 'ECONNREFUSED'
            ? ' (connection was refused the whole time — the process is running but never opened the port; check its own logs for a startup error)'
            : lastErrorCode === 'ECONNRESET'
              ? ' (connection was reset — the server may be crashing shortly after each connection attempt)'
              : lastErrorCode
                ? ` (last error: ${lastErrorCode})`
                : '';
        reject(new Error(`PledgePack dev server did not start within ${timeoutMs}ms${reasonSuffix}`));
        return;
      }
      const req = httpRequest(`http://${hostname}:${port}/__pledge_router`, { method: 'GET', timeout: 1000 }, (res: import('node:http').IncomingMessage) => {
        const schemaVersion = res.headers['x-pledgepack-schema-version'];
        if (schemaVersion !== undefined) {
          const parsed = Array.isArray(schemaVersion) ? schemaVersion[0] : schemaVersion;
          const versionNum = Number(parsed);
          if (Number.isFinite(versionNum) && versionNum !== EXPECTED_MANIFEST_SCHEMA_VERSION) {
            console.warn(
              `[pledgepack] Dev server reports schema version ${versionNum}, this adapter expects ` +
                `${EXPECTED_MANIFEST_SCHEMA_VERSION} — PledgePack binary and bundler-pledgepack package ` +
                `versions may be mismatched.`,
            );
          }
        }
        res.destroy();
        resolve();
      });
      req.on('error', (err: NodeJS.ErrnoException) => {
        lastErrorCode = err.code;
        setTimeout(attempt, 200);
      });
      req.on('timeout', () => { req.destroy(); setTimeout(attempt, 200); });
      req.end();
    }
    attempt();
  });
}

/**
 * Goal 84: `proc.kill()` alone (the previous implementation) sends SIGTERM
 * and returns immediately without confirming the process actually exited —
 * a hung or slow-to-shutdown PledgePack process would be silently left
 * running. This waits for the real 'exit' event, escalating to SIGKILL if
 * the process hasn't exited within `gracefulTimeoutMs`.
 */
function stopProcessGracefully(proc: ChildProcess, gracefulTimeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      // Already exited (e.g. it crashed and the auto-restart handler gave
      // up before stop() was called).
      resolve();
      return;
    }
    const onExit = () => {
      clearTimeout(killTimer);
      resolve();
    };
    proc.once('exit', onExit);
    const killTimer = setTimeout(() => {
      console.warn(`[pledgepack] dev server did not exit within ${gracefulTimeoutMs}ms of SIGTERM — sending SIGKILL`);
      proc.kill('SIGKILL');
    }, gracefulTimeoutMs);
    proc.kill('SIGTERM');
  });
}

export default pledgepackAdapter;
