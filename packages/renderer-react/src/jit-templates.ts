/**
 * JIT template profiling — records route renders and checks for compiled templates.
 *
 * Self-contained implementation with a JS Map-based profiler. Tries to load
 * the native rust-jit-templates NAPI addon for better performance; falls back
 * to the JS implementation if the addon is not compiled.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface NativeJitTemplates {
  recordRender: (routePattern: string, templateHash: number, threshold?: number) => { shouldCompile: boolean; renderCount: number };
  storeCompiledTemplate: (routePattern: string, template: string) => Promise<void>;
  getCompiledTemplate: (routePattern: string) => string | null;
  invalidateTemplate: (routePattern: string) => void;
  clearAllTemplates: () => void;
  getRouteStats: () => Array<{ route: string; renderCount: number; hasCompiledTemplate: boolean }>;
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
 * Records a route render for JIT profiling.
 */
export function recordRender(routePattern: string, templateHash: number, threshold?: number): { shouldCompile: boolean; renderCount: number } {
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
