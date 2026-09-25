import { spawn, type ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { join, extname, relative } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
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
import type { Plugin as EsbuildPlugin, PluginBuild } from 'esbuild';

/**
 * Cached route manifest (loaded once per build, not per request).
 * Invalidated when `resolveProductionPath` is called after a fresh build
 * (the manifest's mtime changes).
 */
let cachedManifest: { routes: Array<{ file?: string }>; manifestPath: string; mtime: number } | null = null;

/**
 * PledgePack's own startup banner (printed with println!, so RUST_LOG can't
 * silence it). PledgeStack prints the one URL users should open instead.
 */
// eslint-disable-next-line no-control-regex -- matching ANSI color codes in the binary's banner
const PLEDGEPACK_BANNER_LINE = /^\s*$|dev server starting\.\.\.|^\s*(?:\x1b\[\d+m)*→(?:\x1b\[\d+m)*\s+https?:\/\/|Ready in \d+ms/;

/** Line-buffers a child stream into `out`, dropping PledgePack banner lines. */
export function forwardFiltered(stream: NodeJS.ReadableStream | null, out: NodeJS.WritableStream): void {
  if (!stream) return;
  let pending = '';
  stream.setEncoding('utf-8');
  stream.on('data', (chunk: string) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    const kept = lines.filter((line) => !PLEDGEPACK_BANNER_LINE.test(line));
    if (kept.length) out.write(kept.join('\n') + '\n');
  });
  stream.on('end', () => {
    if (pending && !PLEDGEPACK_BANNER_LINE.test(pending)) out.write(pending + '\n');
  });
}

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
      const aliasArgs = await pledgepackAliasArgs(config);
      await runPledgepack([...aliasArgs, 'build', '--out-dir', config.outDir]);
      // PledgePack only emits client chunks — bundle each route module into
      // .pledge/server/ for SSG/SSR, matching the layout every other adapter
      // produces and resolveProductionPath expects.
      await buildServerModules(config);
      // The rendered HTML references /__pledge__/client.js for hydration —
      // in production there is no dev server to synthesise that module, so
      // bundle a self-contained equivalent (route map + client runtime +
      // react) into the out dir where the static server can reach it.
      await buildClientBundle(config);
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

    const aliasArgs = await pledgepackAliasArgs(config);
    const spawnArgs = [...aliasArgs, 'dev', '--port', String(port), '--host', hostname];
    // PledgePack is an internal backend of `pledge dev`: its INFO tracing and
    // its own "server running at :3001" banner duplicated PledgeStack's output
    // and advertised the wrong URL. Keep warnings/errors, drop the rest —
    // unless the user opted into RUST_LOG themselves.
    const spawnOpts = {
      stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
      cwd: config.rootDir,
      env: { ...process.env, RUST_LOG: process.env.RUST_LOG ?? 'warn' },
    };
    const spawnQuiet = () => {
      const child = spawn(binary, spawnArgs, spawnOpts);
      forwardFiltered(child.stdout, process.stdout);
      forwardFiltered(child.stderr, process.stderr);
      return child;
    };

    let proc = spawnQuiet();
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
          proc = spawnQuiet();
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
 * Recursively collects route source files under the app directory — same
 * convention as the other adapters' collectRouteFiles.
 */
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
        entry.name.endsWith('.ps') ||
        entry.name.endsWith('.vue') ||
        entry.name.endsWith('.svelte') ||
        entry.name.endsWith('.mdx')
      ) {
        files.push(fullPath);
      }
    }
  }

  await walk(dir);
  return files;
}

/**
 * Bundles each app route module into `.pledge/server/<rel>.js` (ESM) so
 * `resolveProductionPath` can find production modules for SSG and the Node
 * production server. PledgePack's own build output is client-only — this
 * mirrors the server build every other adapter does on top of its client
 * bundle.
 */
async function buildServerModules(config: PledgeConfig): Promise<void> {
  const appDir = join(config.rootDir, config.appDir);
  const routeFiles = await collectRouteFiles(appDir);
  if (routeFiles.length === 0) return;

  const serverOutDir = join(config.rootDir, config.outDir, 'server');
  await mkdir(serverOutDir, { recursive: true });

  const { build: esbuild } = await import('esbuild');
  const external = [
    'react',
    'react-dom',
    'react/jsx-runtime',
    'react-dom/server',
    // Non-React frameworks resolve their runtime from the app's node_modules
    // at request time — keep them external like react/react-dom.
    'vue',
    'vue/server-renderer',
    'solid-js',
    'solid-js/web',
    'svelte',
    'pledgestack-core',
    'pledgestack-shared',
    'pledgestack-server',
  ];

  for (const routeFile of routeFiles) {
    const ext = extname(routeFile);
    const relPath = relative(appDir, routeFile);
    const outName = relPath.slice(0, -ext.length) + '.js';

    let input = routeFile;
    // esbuild can't parse .psx/.ps/.vue/.svelte/.mdx — run them through the
    // shared transform pipeline first and bundle the transformed JS instead.
    if (TRANSFORM_FIRST_EXTS.has(ext)) {
      const { fileUrl } = await pledgepackAdapter.transformFile(routeFile, {
        isDev: false,
        rootDir: config.rootDir,
      });
      input = fileURLToPath(fileUrl);
    }

    await esbuild({
      entryPoints: [input],
      bundle: true,
      format: 'esm',
      platform: 'node',
      jsx: 'automatic',
      target: 'es2022',
      external,
      alias: buildPledgepackAliasMap(config),
      // Server modules render markup, not styles — stub stylesheet imports so
      // esbuild never parses them (a `@import "tailwindcss"` would otherwise
      // fail to resolve: the package's `.` export only maps under the `style`
      // condition, and PledgePack already expands it for the client bundle).
      loader: {
        '.css': 'empty',
        '.scss': 'empty',
        '.sass': 'empty',
        '.less': 'empty',
      },
      outfile: join(serverOutDir, outName),
      logLevel: 'warning',
    });
  }
}

/** Conventions whose default export hydrates client-side (route handlers,
 * middleware, head, and image generators are server-only — bundling them
 * would drag node builtins into the browser bundle). */
const CLIENT_ROUTE_CONVENTIONS = new Set([
  'page',
  'layout',
  'loading',
  'error',
  'global-error',
  'template',
  'not-found',
]);

/**
 * Extra component extensions scanned for the client bundle per framework —
 * Vue/Svelte SFCs are component files and must be part of the client route
 * map (they go through transformFile → .pledge-cache JS before bundling).
 * React/Solid pages are already covered by the tsx/ts/jsx/js filter.
 */
const FRAMEWORK_CLIENT_EXTS: Record<string, RegExp> = {
  vue: /\.(tsx|ts|jsx|js|vue)$/,
  svelte: /\.(tsx|ts|jsx|js|svelte)$/,
};

/** Extensions the local transform pipeline can compile to plain JS/JSX for
 * esbuild (everything else esbuild loads directly). */
const TRANSFORM_FIRST_EXTS = new Set(['.vue', '.svelte', '.psx', '.ps', '.mdx']);

/** Mirrors pledgestack-client's routeMapKey / server's virtual-modules. */
function clientRouteMapKey(convention: string, pattern: string): string {
  return convention === 'page' || convention === 'route' ? pattern : `${convention}:${pattern}`;
}

interface ClientRouteFile {
  relativePath: string;
  convention: string;
  routePattern: string;
}

/**
 * Scans the app dir for component conventions — mirrors scanRouteFiles in
 * pledgestack-server's virtual-modules.ts (route groups / parallel slots
 * contribute no URL segment).
 */
function scanClientRouteFiles(appDir: string, framework?: string): ClientRouteFile[] {
  const results: ClientRouteFile[] = [];
  const fileRe = FRAMEWORK_CLIENT_EXTS[framework ?? 'react'] ?? /\.(tsx|ts|jsx|js)$/;

  function walk(dir: string, prefix: string) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (entry.startsWith('.') || entry === 'node_modules') continue;
        let segment = entry;
        if (/^\([^)]+\)$/.test(segment)) segment = '';
        if (segment.startsWith('@')) segment = '';
        walk(fullPath, prefix + '/' + segment);
      } else if (stat.isFile() && fileRe.test(entry)) {
        const base = entry.replace(fileRe, '');
        if (!CLIENT_ROUTE_CONVENTIONS.has(base)) continue;
        const relPath = relative(appDir, fullPath).split(/[\\/]/).join('/');
        let pattern = prefix || '/';
        pattern = pattern.replace(/\/+/g, '/') || '/';
        if (pattern.endsWith('/') && pattern !== '/') pattern = pattern.slice(0, -1);
        results.push({ relativePath: relPath, convention: base, routePattern: pattern });
      }
    }
  }

  walk(appDir, '');
  return results;
}

/**
 * Bundles the hydration entry — route map + client runtime + react — into
 * `outDir/__pledge__/client.js`. The SSR shells reference that URL for
 * hydration; in dev the virtual module intercepts it first, in production
 * the static server serves this bundle instead.
 */
async function buildClientBundle(config: PledgeConfig): Promise<void> {
  const appDir = join(config.rootDir, config.appDir);
  const framework = config.framework ?? 'react';
  const files = scanClientRouteFiles(appDir, framework);
  if (files.length === 0) return;

  // Component files esbuild can't load natively (.vue/.svelte/.mdx/.psx/.ps)
  // go through the shared transform pipeline first; their imports then point
  // at the generated .pledge-cache JS so the client bundle is framework-real.
  const routeImports: string[] = [];
  const routeEntries: string[] = [];
  for (const file of files) {
    const abs = join(appDir, file.relativePath);
    let spec = `./${file.relativePath}`;
    if (TRANSFORM_FIRST_EXTS.has(extname(abs))) {
      const { fileUrl } = await pledgepackAdapter.transformFile(abs, {
        isDev: false,
        rootDir: config.rootDir,
      });
      spec = `./${relative(appDir, fileURLToPath(fileUrl)).split(/[\\/]/).join('/')}`;
    }
    const varName = `mod_${routeEntries.length}`;
    routeImports.push(`import ${varName} from ${JSON.stringify(spec)};`);
    const key = clientRouteMapKey(file.convention, file.routePattern);
    routeEntries.push(`  ${JSON.stringify(key)}: { type: ${JSON.stringify(file.convention)}, component: ${varName} }`);
  }

  // React keeps the dedicated entry; every other renderer emits its own
  // bootstrap (the same one dev serves), with its `await import('/__pledge_router')`
  // satisfied by an esbuild-plugin module carrying the route map.
  let entrySource: string;
  let routerPlugin: EsbuildPlugin | undefined;

  const { initRenderer } = await import('pledgestack-core');
  const renderer = await initRenderer(config);

  if (renderer.framework === 'react') {
    // Same bootstrap as the dev virtual client script: rebuild the server's
    // element tree from window.__PLEDGE_ROUTE__ and hydrate #__pledge_root__.
    entrySource = `import { hydrateRoot } from 'react-dom/client';
import { createElement } from 'react';
import { RouterProvider, resolveRouteElement, initPledgeHydration } from 'pledgestack-client';
${routeImports.join('\n')}

const routes = {
${routeEntries.join(',\n')}
};

const root = document.getElementById('__pledge_root__');
if (root) {
  const routeData = window.__PLEDGE_ROUTE__ || { pattern: window.location.pathname, params: {}, searchParams: {} };
  const tree = resolveRouteElement(routes, routeData);
  const app = createElement(RouterProvider, { children: tree });
  try {
    hydrateRoot(root, app, {
      onRecoverableError(error) {
        console.error('[pledgestack] React hydration recoverable error:', error);
      },
    });
  } catch (e) {
    console.error('[pledgestack] Hydration failed, falling back to client render:', e);
    const { createRoot } = await import('react-dom/client');
    createRoot(root).render(app);
  }
  try { initPledgeHydration(); } catch (e) { console.error('[pledgestack] pledge hydration failed:', e); }
}
`;
  } else {
    entrySource = renderer.generateClientScript({ isDev: false, rscEnabled: false });
    const routerModuleSource = `${routeImports.join('\n')}
export const routes = {
${routeEntries.join(',\n')}
};
export { resolveRouteChain, installSpaNavigation, navigate } from 'pledgestack-client';
`;
    routerPlugin = {
      name: 'pledge-router-module',
      setup(build: PluginBuild) {
        build.onResolve({ filter: /^\/__pledge_router$/ }, () => ({ path: '/__pledge_router', namespace: 'pledge-router' }));
        build.onLoad({ filter: /.*/, namespace: 'pledge-router' }, () => ({
          contents: routerModuleSource,
          loader: 'js',
          resolveDir: appDir,
        }));
      },
    };
  }

  const { build: esbuild } = await import('esbuild');
  const outDir = join(config.rootDir, config.outDir, '__pledge__');
  await mkdir(outDir, { recursive: true });
  // dist/client.js retains a few Node-context references (env checks,
  // process.cwd/process.emit guards) — inject a browser shim for `process`
  // rather than weakening with defines (esbuild define can't map callables).
  const shimPath = join(outDir, '.process-shim.mjs');
  await writeFile(
    shimPath,
    'export const process = { env: { NODE_ENV: "production" }, cwd: () => "/", emit: () => undefined, browser: true };\n',
    'utf-8',
  );
  try {
    await esbuild({
      stdin: { contents: entrySource, resolveDir: appDir, loader: 'js' },
      bundle: true,
      format: 'esm',
      platform: 'browser',
      jsx: 'automatic',
      target: 'es2022',
      // Non-React entries import the generated '/__pledge_router' virtual
      // module — the plugin supplies it in-bundle (route map + client runtime
      // re-exports), so the dev/prod client scripts are byte-identical.
      plugins: routerPlugin ? [routerPlugin] : [],
      // The client runtime is the framework's bundled dist — the same module
      // the dev import map points at (/node_modules/pledgestack/dist/client.js).
      alias: { 'pledgestack-client': 'pledgestack/client' },
      inject: [shimPath],
      // Styles ship via /__pledge__/client.css — stub imports so esbuild
      // never tries to resolve the tailwind package's style-only export.
      loader: {
        '.css': 'empty',
        '.scss': 'empty',
        '.sass': 'empty',
        '.less': 'empty',
      },
      outfile: join(outDir, 'client.js'),
      logLevel: 'warning',
    });
  } finally {
    await rm(shimPath, { force: true });
  }
}

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

/**
 * `config.alias` as plain-prefix, root-anchored absolute paths: tsconfig-style
 * `@/lib/*` -> `lib/*` becomes `@/lib` -> `<root>/lib`.
 */
export function buildPledgepackAliasMap(config: PledgeConfig): Record<string, string> {
  const alias: Record<string, string> = {};
  for (const [name, target] of Object.entries(config.alias ?? {})) {
    alias[name.replace(/\/\*$/, '')] = join(config.rootDir, target.replace(/\/\*$/, ''));
  }
  return alias;
}

/**
 * The pledgepack binary reads its own config (`pledge.json`), not
 * pledge.config.ts, so `config.alias` would otherwise be ignored by the client
 * build/dev server. When aliases are configured, write a merged config
 * (existing `pledge.json` + `resolve.alias`) into the out dir and return the
 * `--root/--config` flags that point the binary at it. Returns `[]` when there
 * are no aliases, leaving the binary's own config discovery untouched.
 */
export async function pledgepackAliasArgs(config: PledgeConfig): Promise<string[]> {
  const alias = buildPledgepackAliasMap(config);
  if (Object.keys(alias).length === 0) return [];

  let base: Record<string, unknown> = {};
  const userConfigPath = join(config.rootDir, 'pledge.json');
  if (existsSync(userConfigPath)) {
    try {
      base = JSON.parse(readFileSync(userConfigPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      base = {};
    }
  }
  const resolve = (base.resolve && typeof base.resolve === 'object' ? base.resolve : {}) as Record<string, unknown>;
  const merged = {
    ...base,
    resolve: { ...resolve, alias: { ...((resolve.alias as Record<string, string>) ?? {}), ...alias } },
  };

  const outDir = join(config.rootDir, config.outDir);
  await mkdir(outDir, { recursive: true });
  const configPath = join(outDir, 'pledgepack.alias.config.json');
  await writeFile(configPath, JSON.stringify(merged, null, 2), 'utf-8');
  return ['--root', config.rootDir, '--config', configPath];
}
