import { describe, it, expect } from 'vitest';
import { PluginRunner, definePlugin } from './plugin-runner';
import type { PledgeConfig, PledgePlugin } from './config';

const mockConfig: PledgeConfig = {
  rootDir: '/test',
  appDir: 'app',
  publicDir: 'public',
  outDir: '.pledge',
  framework: 'react',
  bundler: 'pledgepack',
  defaultRuntime: 'node',
  output: 'standalone',
  rsc: false,
  tailwind: false,
  securityHeaders: true,
};

describe('PluginRunner (#40)', () => {
  it('runs configResolved hooks in order', async () => {
    const plugin1: PledgePlugin = {
      name: 'p1',
      configResolved: async (config) => ({ ...config, rootDir: '/modified1' }),
    };
    const plugin2: PledgePlugin = {
      name: 'p2',
      configResolved: async (config) => ({ ...config, rootDir: '/modified2' }),
    };
    const runner = new PluginRunner([plugin1, plugin2]);
    const result = await runner.runConfigResolved(mockConfig);
    expect(result.rootDir).toBe('/modified2');
  });

  it('runs buildStart hooks', async () => {
    let called = false;
    const plugin: PledgePlugin = {
      name: 'test',
      buildStart: async () => { called = true; },
    };
    const runner = new PluginRunner([plugin]);
    await runner.runBuildStart(mockConfig);
    expect(called).toBe(true);
  });

  it('runs buildEnd hooks', async () => {
    let called = false;
    const plugin: PledgePlugin = {
      name: 'test',
      buildEnd: async () => { called = true; },
    };
    const runner = new PluginRunner([plugin]);
    await runner.runBuildEnd(mockConfig);
    expect(called).toBe(true);
  });

  it('chains renderEnd hooks', async () => {
    const plugin1: PledgePlugin = {
      name: 'p1',
      renderEnd: async (_ctx, html) => html + '<p1>',
    };
    const plugin2: PledgePlugin = {
      name: 'p2',
      renderEnd: async (_ctx, html) => html + '<p2>',
    };
    const runner = new PluginRunner([plugin1, plugin2]);
    const result = await runner.runRenderEnd({} as never, '<html>');
    expect(result).toBe('<html><p1><p2>');
  });

  it('chains transformHtml hooks', async () => {
    const plugin: PledgePlugin = {
      name: 'test',
      transformHtml: async (html) => html.replace('</head>', '<meta name="test" /></head>'),
    };
    const runner = new PluginRunner([plugin]);
    const result = await runner.runTransformHtml('<html><head></head></html>', {} as never);
    expect(result).toContain('<meta name="test" />');
  });

  it('runs configureServer hooks', async () => {
    let called = false;
    const plugin: PledgePlugin = {
      name: 'test',
      configureServer: async () => { called = true; },
    };
    const runner = new PluginRunner([plugin]);
    await runner.runConfigureServer({} as never);
    expect(called).toBe(true);
  });

  it('runs fetchIntercept hooks — first match wins', async () => {
    const plugin1: PledgePlugin = {
      name: 'p1',
      fetchIntercept: async () => new Response('intercepted'),
    };
    const plugin2: PledgePlugin = {
      name: 'p2',
      fetchIntercept: async () => new Response('not reached'),
    };
    const runner = new PluginRunner([plugin1, plugin2]);
    const result = await runner.runFetchIntercept('https://example.com', {});
    expect(result).not.toBeNull();
    expect(await result!.text()).toBe('intercepted');
  });

  it('definePlugin returns the plugin as-is', () => {
    const plugin: PledgePlugin = { name: 'test' };
    expect(definePlugin(plugin)).toBe(plugin);
  });

  it('handles empty plugin list gracefully', async () => {
    const runner = new PluginRunner([]);
    const result = await runner.runConfigResolved(mockConfig);
    expect(result).toBe(mockConfig);
  });
});
