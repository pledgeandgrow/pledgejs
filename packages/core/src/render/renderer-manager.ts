/**
 * Renderer manager — resolves and loads the appropriate renderer adapter
 * based on the framework config.
 *
 * This is the bridge between the framework-agnostic core and the
 * framework-specific renderer adapters.
 */

import type { PledgeConfig, Framework, RendererAdapter } from 'pledgestack-shared';
import { getRendererRegistry } from 'pledgestack-shared';

let initialized = false;

/**
 * Initializes the renderer registry by importing the appropriate adapter.
 * Called once at server startup.
 *
 * The React adapter is always available (bundled with pledgestack-core).
 * Other adapters are dynamically imported if installed.
 */
export async function initRenderer(config: PledgeConfig): Promise<RendererAdapter> {
  const framework: Framework = config.framework ?? 'react';
  const registry = getRendererRegistry();

  // If the adapter is already registered, use it
  let adapter = registry.get(framework);

  if (!adapter) {
    // Try to dynamically import the adapter package
    try {
      switch (framework) {
        case 'react':
          await import('pledgestack-renderer-react');
          break;
        case 'vue':
          await import('pledgestack-renderer-vue');
          break;
        case 'solid':
          await import('pledgestack-renderer-solid');
          break;
        case 'svelte':
          await import('pledgestack-renderer-svelte');
          break;
      }
      adapter = registry.get(framework);
    } catch {
      // Adapter package not installed
    }
  }

  if (!adapter) {
    // Fall back to React if the requested framework's adapter isn't available
    if (framework !== 'react') {
      console.warn(`[pledgestack] Renderer adapter for "${framework}" not found. Install pledgestack-renderer-${framework} or use framework: 'react'.`);
      try {
        await import('pledgestack-renderer-react');
        adapter = registry.get('react');
      } catch {
        // React adapter also not available — use the built-in fallback
      }
    }

    if (!adapter) {
      throw new Error(`No renderer adapter available for framework "${framework}". Install pledgestack-renderer-${framework}.`);
    }
  }

  registry.setDefault(framework);
  initialized = true;
  return adapter;
}

/**
 * Gets the active renderer adapter.
 * Must be called after initRenderer().
 */
export function getRenderer(): RendererAdapter {
  const registry = getRendererRegistry();
  const adapter = registry.getDefault();
  if (!adapter) {
    throw new Error('Renderer not initialized. Call initRenderer() first.');
  }
  return adapter;
}

/**
 * Whether the renderer has been initialized.
 */
export function isRendererInitialized(): boolean {
  return initialized;
}
