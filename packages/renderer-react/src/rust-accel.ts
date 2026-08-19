/**
 * Rust SSR acceleration — optional native addon for faster server-side rendering.
 * Falls back to React's renderToString if the addon is not compiled.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RenderContext } from 'pledgestack-shared';

const require = createRequire(import.meta.url);

type AddonFn = (...args: unknown[]) => unknown;
type AddonMethods = Record<string, AddonFn>;

let rustSSRAvailable: boolean | null = null;
let rustSSRAddon: AddonMethods | null = null;
let cachedCoreNativeDir: string | null = null;

/**
 * Locates pledgestack-core's `native/` directory, where every compiled Rust
 * addon (.node file) lives (see packages/core/native/build.sh). The addon
 * used here (rust-ssr.node) is built as part of pledgestack-core, not this
 * package — renderer-react has no `native/` folder of its own — so this
 * resolves core's package root via Node's own module resolution (works via
 * the pnpm workspace symlink) rather than a relative path from this file,
 * which would point at the wrong package entirely.
 *
 * Uses `import.meta.resolve` rather than `require.resolve` because
 * pledgestack-core's package.json `exports` only declares an "import"
 * condition (it's ESM-only, no "require"/"default" fallback) — a plain
 * `createRequire(...).resolve()` throws ERR_PACKAGE_PATH_NOT_EXPORTED
 * against a package like that.
 */
function getCoreNativeDir(): string {
  if (cachedCoreNativeDir) return cachedCoreNativeDir;
  // Resolves to <core>/dist/index.js (the "." export) — the native/ dir is
  // a sibling of dist/, i.e. two levels up from the resolved file.
  const coreEntryUrl = import.meta.resolve('pledgestack-core');
  const coreEntryPath = fileURLToPath(coreEntryUrl);
  cachedCoreNativeDir = join(dirname(dirname(coreEntryPath)), 'native');
  return cachedCoreNativeDir;
}

/**
 * Checks if the native Rust SSR addon is available.
 */
export function isRustSSRAvailable(): boolean {
  if (rustSSRAvailable !== null) return rustSSRAvailable;
  try {
    const addonPath = join(getCoreNativeDir(), 'rust-ssr.node');
    const addon = require(addonPath) as AddonMethods;
    if (typeof addon.renderToString === 'function') {
      rustSSRAddon = addon;
      rustSSRAvailable = true;
      return true;
    }
  } catch {
    // Addon not compiled, or pledgestack-core isn't resolvable in this context
    // (e.g. import.meta.resolve unavailable on an older Node, or the optional
    // pledgestack-core peer dependency isn't installed) — fall back to JS SSR.
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
