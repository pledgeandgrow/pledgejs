/**
 * Rust SSR acceleration — optional native addon for faster server-side rendering.
 * Falls back to React's renderToString if the addon is not compiled.
 */

import { createRequire } from 'node:module';
import type { RenderContext } from 'pledgestack-shared';

const require = createRequire(import.meta.url);

type AddonFn = (...args: unknown[]) => unknown;
type AddonMethods = Record<string, AddonFn>;

let rustSSRAvailable: boolean | null = null;
let rustSSRAddon: AddonMethods | null = null;

/**
 * Checks if the native Rust SSR addon is available.
 */
export function isRustSSRAvailable(): boolean {
  if (rustSSRAvailable !== null) return rustSSRAvailable;
  try {
    const addon = require('../native/rust-ssr.node') as AddonMethods;
    if (typeof addon.renderToString === 'function') {
      rustSSRAddon = addon;
      rustSSRAvailable = true;
      return true;
    }
  } catch {
    // Addon not compiled
  }
  rustSSRAvailable = false;
  return false;
}

/**
 * Renders using the native Rust SSR engine.
 * Returns null if the Rust renderer can't handle this page (falls back to React).
 */
export async function renderRustSSR(ctx: RenderContext): Promise<string | null> {
  if (!rustSSRAddon) return null;

  try {
    const result = rustSSRAddon.renderToString(ctx) as string;
    return result;
  } catch {
    return null;
  }
}
