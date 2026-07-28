/**
 * JIT hot route template compiler.
 *
 * Profiles SSR routes at runtime. When a route is rendered >N times with
 * similar shape, compiles its HTML template to a native function that
 * produces the string directly — bypassing React's reconciliation entirely
 * for cacheable pages.
 *
 * Uses the rust-jit-templates NAPI addon. When not compiled, falls back
 * to a JS Map-based profiler with template string caching.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface NativeJitTemplates {
  recordRender: (routePattern: string, templateHash: number, threshold?: number) => ProfileResult;
  storeCompiledTemplate: (routePattern: string, template: string) => Promise<void>;
  getCompiledTemplate: (routePattern: string) => string | null;
  invalidateTemplate: (routePattern: string) => void;
  clearAllTemplates: () => void;
  getRouteStats: () => RouteStat[];
}

export interface ProfileResult {
  shouldCompile: boolean;
  renderCount: number;
}

export interface RouteStat {
  route: string;
  renderCount: number;
  hasCompiledTemplate: boolean;
}

let nativeAddon: NativeJitTemplates | null = null;
let loadAttempted = false;

function loadNative(): NativeJitTemplates | null {
  if (loadAttempted) return nativeAddon;
  loadAttempted = true;
  try {
    const addon = require('../native/rust-jit-templates.node') as NativeJitTemplates;
    if (typeof addon.recordRender === 'function') {
      nativeAddon = addon;
    }
  } catch {
    // Addon not compiled
  }
  return nativeAddon;
}

// JS fallback state
interface JsProfile {
  renderCount: number;
  lastTemplateHash: number;
  compiledTemplate: string | null;
}
const jsProfiles = new Map<string, JsProfile>();

/**
 * Records a route render and returns whether JIT compilation should occur.
 *
 * @param routePattern The route pattern (e.g. "/blog/:slug")
 * @param templateHash Hash of the rendered HTML structure
 * @param threshold Number of renders before JIT compilation (default: 100)
 */
export function recordRender(routePattern: string, templateHash: number, threshold?: number): ProfileResult {
  const addon = loadNative();
  if (addon) {
    return addon.recordRender(routePattern, templateHash, threshold);
  }

  const thresh = threshold ?? 100;
  let profile = jsProfiles.get(routePattern);

  if (!profile) {
    profile = { renderCount: 0, lastTemplateHash: 0, compiledTemplate: null };
    jsProfiles.set(routePattern, profile);
  }

  profile.renderCount++;
  const sameTemplate = profile.lastTemplateHash === templateHash;
  profile.lastTemplateHash = templateHash;

  const shouldCompile = profile.renderCount >= thresh && sameTemplate && profile.compiledTemplate === null;

  return { shouldCompile, renderCount: profile.renderCount };
}

/**
 * Stores a compiled template for a route.
 */
export async function storeCompiledTemplate(routePattern: string, template: string): Promise<void> {
  const addon = loadNative();
  if (addon) {
    return addon.storeCompiledTemplate(routePattern, template);
  }

  let profile = jsProfiles.get(routePattern);
  if (!profile) {
    profile = { renderCount: 0, lastTemplateHash: 0, compiledTemplate: null };
    jsProfiles.set(routePattern, profile);
  }
  profile.compiledTemplate = template;
}

/**
 * Gets the compiled template for a route, if one exists.
 */
export function getCompiledTemplate(routePattern: string): string | null {
  const addon = loadNative();
  if (addon) {
    return addon.getCompiledTemplate(routePattern);
  }
  return jsProfiles.get(routePattern)?.compiledTemplate ?? null;
}

/**
 * Clears the compiled template for a route (e.g. when content changes).
 */
export function invalidateTemplate(routePattern: string): void {
  const addon = loadNative();
  if (addon) {
    addon.invalidateTemplate(routePattern);
    return;
  }
  const profile = jsProfiles.get(routePattern);
  if (profile) {
    profile.compiledTemplate = null;
    profile.renderCount = 0;
  }
}

/**
 * Clears all compiled templates and profiles.
 */
export function clearAllTemplates(): void {
  const addon = loadNative();
  if (addon) {
    addon.clearAllTemplates();
    return;
  }
  jsProfiles.clear();
}

/**
 * Gets profiling stats for all routes.
 */
export function getRouteStats(): RouteStat[] {
  const addon = loadNative();
  if (addon) {
    return addon.getRouteStats();
  }
  return [...jsProfiles.entries()].map(([route, p]) => ({
    route,
    renderCount: p.renderCount,
    hasCompiledTemplate: p.compiledTemplate !== null,
  }));
}

/**
 * Whether the native JIT template compiler is available.
 */
export function isNativeJitTemplatesAvailable(): boolean {
  return loadNative() !== null;
}
