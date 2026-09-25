import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PledgeConfig } from 'pledgestack-shared';

// The native binary is not exercised — resolve/run are stubbed so adapter.build
// reaches the JS-side server/client bundling stages.
vi.mock('./binary-resolver', () => ({
  resolveBinary: vi.fn(() => 'C:\\fake\\pledgepack.exe'),
  runPledgepack: vi.fn(async () => undefined),
}));

// esbuild is the real bundler at runtime; here we capture every invocation so
// tests can assert on the generated client entry instead of bundling.
interface CapturedPlugin {
  setup: (build: {
    onResolve: (o: { filter: RegExp }, cb: () => { path: string; namespace: string }) => void;
    onLoad: (o: { filter: RegExp; namespace: string }, cb: () => { contents: string }) => void;
  }) => void;
}
interface CapturedCall {
  stdin?: { contents: string; resolveDir: string };
  entryPoints?: string[];
  plugins?: CapturedPlugin[];
  outfile?: string;
}
const mockEsbuildCalls: CapturedCall[] = [];
vi.mock('esbuild', () => ({
  build: vi.fn(async (opts: CapturedCall) => {
    mockEsbuildCalls.push(opts);
  }),
}));

import { pledgepackAdapter } from './index';
import 'pledgestack-renderer-react';
import 'pledgestack-renderer-vue';

/** Extracts the synthesized `/__pledge_router` module source from the client build's plugin. */
function routerModuleSource(call: CapturedCall): string | undefined {
  const plugin = call.plugins?.[0];
  if (!plugin) return undefined;
  let contents: string | undefined;
  plugin.setup({
    onResolve: () => {},
    onLoad: (_o, cb) => {
      contents = cb().contents;
    },
  });
  return contents;
}

describe('framework-aware production client bundle', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pledge-pp-fw-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  });

  it('emits the React hydration entry for framework: react', async () => {
    const app = join(dir, 'react-app');
    await mkdir(app, { recursive: true });
    await writeFile(join(app, 'page.tsx'), 'export default function Page() { return null; }');
    mockEsbuildCalls.length = 0;

    const config = { rootDir: dir, appDir: 'react-app', outDir: '.pledge', framework: 'react' } as PledgeConfig;
    const result = await pledgepackAdapter.build(config);

    expect(result.success).toBe(true);
    const client = mockEsbuildCalls.find((c) => c.stdin?.contents);
    expect(client).toBeDefined();
    expect(client!.stdin!.contents).toContain('hydrateRoot');
    expect(client!.stdin!.contents).toContain('RouterProvider');
    // React's entry embeds the route map directly — no virtual router module.
    expect(client!.plugins ?? []).toHaveLength(0);
    expect(client!.stdin!.contents).toContain('"/"');
  });

  it('emits the Vue renderer bootstrap — not React hydration — for framework: vue', async () => {
    const app = join(dir, 'vue-app');
    await mkdir(app, { recursive: true });
    await writeFile(
      join(app, 'page.vue'),
      '<template><p>hi</p></template><script setup></script>',
    );
    // Unit scope is bundle wiring, not SFC compilation (covered by
    // sfc-transform.test.ts) — return the transformed JS path directly.
    const tf = vi
      .spyOn(pledgepackAdapter, 'transformFile')
      .mockResolvedValue({
        fileUrl: pathToFileURL(join(dir, '.pledge-cache', 'page.vue.abc.js')).href,
      } as Awaited<ReturnType<typeof pledgepackAdapter.transformFile>>);
    mockEsbuildCalls.length = 0;

    try {
      const config = { rootDir: dir, appDir: 'vue-app', outDir: '.pledge', framework: 'vue' } as PledgeConfig;
      const result = await pledgepackAdapter.build(config);

      expect(result.success).toBe(true);
      // The .vue route file must have gone through the shared transform
      // pipeline — esbuild cannot parse SFCs.
      expect(tf).toHaveBeenCalled();
      const client = mockEsbuildCalls.find((c) => c.stdin?.contents);
      expect(client).toBeDefined();
      expect(client!.stdin!.contents).toContain('createSSRApp');
      expect(client!.stdin!.contents).toContain('installSpaNavigation');
      expect(client!.stdin!.contents).not.toContain('hydrateRoot');

      // Its `await import('/__pledge_router')` is satisfied in-bundle by the
      // plugin carrying the route map + client-runtime re-exports.
      const routerSource = routerModuleSource(client!);
      expect(routerSource).toBeDefined();
      expect(routerSource).toContain('"/"');
      expect(routerSource).toContain('type: "page"');
      expect(routerSource).toContain('resolveRouteChain');
      expect(routerSource).toContain('installSpaNavigation');
    } finally {
      tf.mockRestore();
    }
  });
});
