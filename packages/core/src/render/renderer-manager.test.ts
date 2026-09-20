import { describe, it, expect, beforeEach } from 'vitest';
import { getRendererRegistry, resetRendererRegistry } from 'pledgestack-shared';
import type { RendererAdapter, PledgeConfig } from 'pledgestack-shared';
import { initRenderer, getRenderer } from './renderer-manager';

function stubAdapter(framework: 'react' | 'vue'): RendererAdapter {
  return {
    framework,
    fileExtension: framework === 'react' ? 'tsx' : 'vue',
    handledExtensions: [framework === 'react' ? 'tsx' : 'vue'],
    renderToString: async () => '',
    renderToStream: async () => '',
    renderToReadableStream: async () => new ReadableStream(),
    renderNotFound: async () => '',
    generateClientScript: () => '',
  };
}

function configWith(framework: PledgeConfig['framework']): PledgeConfig {
  return { framework } as PledgeConfig;
}

describe('initRenderer', () => {
  beforeEach(() => {
    resetRendererRegistry();
  });

  it('resolves the "pledge" full-stack framework to the React adapter', async () => {
    // 'pledge' = React UI + Rust backend; there is no pledgestack-renderer-pledge
    // package — it must use the registered React adapter without warning/throwing.
    getRendererRegistry().register(stubAdapter('react'));
    const adapter = await initRenderer(configWith('pledge'));
    expect(adapter.framework).toBe('react');
    expect(getRenderer().framework).toBe('react');
  });

  it('uses the registered adapter for its own framework', async () => {
    getRendererRegistry().register(stubAdapter('react'));
    getRendererRegistry().register(stubAdapter('vue'));
    const adapter = await initRenderer(configWith('vue'));
    expect(adapter.framework).toBe('vue');
  });
});
