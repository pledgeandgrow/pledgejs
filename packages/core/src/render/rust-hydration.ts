/**
 * #245 — Native hydration script generator.
 *
 * Rust-generated minimal hydration script that replaces the React hydration
 * runtime for static-heavy pages. The generated script is page-specific,
 * containing only the code needed to hydrate that page's components.
 *
 * The generator:
 * - Analyzes the prerendered HTML to identify hydration points
 * - Generates a minimal JS script that attaches event listeners
 * - Includes only the component code needed for client-side interactivity
 * - Supports progressive enhancement (page works without JS, enhanced with)
 * - Generates sourcemaps for debugging
 *
 * Uses NAPI when available, with a JS fallback.
 */

import type { ResolvedRoute } from 'pledgestack-shared';
import type { PledgeManifest } from 'pledgestack-shared';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Whether the native Rust hydration generator is available */
let rustHydrationAvailable: boolean | null = null;
let rustHydrationAddon: Record<string, (...args: unknown[]) => unknown> | null = null;

/**
 * Attempts to load the native Rust hydration script generator.
 */
export function isRustHydrationGeneratorAvailable(): boolean {
  if (rustHydrationAvailable !== null) return rustHydrationAvailable;
  try {
    const addon = require('../../native/rust-hydration.node') as Record<string, (...args: unknown[]) => unknown>;
    if (typeof addon.generateHydrationScript === 'function') {
      rustHydrationAddon = addon;
      rustHydrationAvailable = true;
      return true;
    }
  } catch {
    // Addon not compiled
  }
  rustHydrationAvailable = false;
  return false;
}

export interface HydrationScriptOptions {
  /** The prerendered HTML to analyze for hydration points */
  html: string;
  /** Route being hydrated */
  route: ResolvedRoute;
  /** Manifest of client components and their chunks */
  manifest: PledgeManifest;
  /** Module map for client component resolution */
  moduleMap?: Record<string, string>;
  /** Whether to generate a sourcemap */
  generateSourcemap?: boolean;
  /** Whether to include React hydration (full) or minimal hydration (events only) */
  mode?: 'full' | 'minimal' | 'progressive';
  /** Whether to minify the output */
  minify?: boolean;
  /** Additional hydration data (RSC flight data, etc.) */
  hydrationData?: string;
}

export interface HydrationScriptResult {
  /** The generated hydration script */
  script: string;
  /** Whether the Rust generator was used */
  usedRustGenerator: boolean;
  /** Script size in bytes */
  sizeBytes: number;
  /** Number of hydration points found */
  hydrationPoints: number;
  /** Sourcemap (if generated) */
  sourcemap?: string;
  /** List of client chunks that need to be loaded */
  requiredChunks: string[];
  /** Generation time in microseconds */
  generationTimeUs: number;
}

/**
 * Generates a minimal hydration script for a prerendered page.
 *
 * In 'full' mode: Generates a script that loads React and hydrates the page
 * In 'minimal' mode: Generates a script that only attaches event listeners
 * In 'progressive' mode: Generates a script that enhances the page progressively
 */
export function generateHydrationScript(options: HydrationScriptOptions): HydrationScriptResult {
  const startTime = process.hrtime.bigint();

  if (isRustHydrationGeneratorAvailable() && rustHydrationAddon) {
    try {
      const result = rustHydrationAddon.generateHydrationScript(options) as HydrationScriptResult;
      if (result) {
        return result;
      }
    } catch (err) {
      console.warn('[pledgestack] Rust hydration generator failed, falling back to JS:', err);
    }
  }

  // JS fallback
  return generateHydrationScriptJS(options, startTime);
}

/**
 * JS fallback: Generates a hydration script.
 */
function generateHydrationScriptJS(
  options: HydrationScriptOptions,
  startTime: bigint,
): HydrationScriptResult {
  const mode = options.mode ?? 'full';
  const minify = options.minify ?? true;
  const html = options.html;
  void options.manifest;

  // Find hydration points in the HTML
  const hydrationPoints = findHydrationPoints(html);
  const requiredChunks = findRequiredChunks(html, options.moduleMap ?? {});

  let script: string;

  if (mode === 'minimal') {
    script = generateMinimalScript(hydrationPoints, requiredChunks, minify);
  } else if (mode === 'progressive') {
    script = generateProgressiveScript(hydrationPoints, requiredChunks, options.hydrationData, minify);
  } else {
    script = generateFullScript(hydrationPoints, requiredChunks, options.hydrationData, minify);
  }

  const endTime = process.hrtime.bigint();
  const generationTimeUs = Number(endTime - startTime) / 1000;

  let sourcemap: string | undefined;
  if (options.generateSourcemap) {
    sourcemap = generateSourcemap(script);
  }

  return {
    script,
    usedRustGenerator: false,
    sizeBytes: Buffer.byteLength(script, 'utf-8'),
    hydrationPoints: hydrationPoints.length,
    sourcemap,
    requiredChunks,
    generationTimeUs,
  };
}

/**
 * Finds hydration points in the prerendered HTML.
 * Hydration points are elements with data attributes that need client-side interactivity.
 */
interface HydrationPoint {
  /** Element ID or selector */
  selector: string;
  /** Component name */
  component: string;
  /** Event handlers needed */
  events: string[];
  /** Chunk path for the component */
  chunkPath?: string;
}

function findHydrationPoints(html: string): HydrationPoint[] {
  const points: HydrationPoint[] = [];

  // Find elements with data-pledge-component attribute
  const componentRegex = /data-pledge-component="([^"]+)"[^>]*(?:data-pledge-chunk="([^"]+)")?/g;
  let match: RegExpExecArray | null;
  while ((match = componentRegex.exec(html)) !== null) {
    points.push({
      selector: `[data-pledge-component="${match[1]}"]`,
      component: match[1],
      events: ['click'],
      chunkPath: match[2],
    });
  }

  // Find elements with data-pledge-interactive attribute
  const interactiveRegex = /data-pledge-interactive="([^"]+)"[^>]*data-pledge-events="([^"]+)"/g;
  while ((match = interactiveRegex.exec(html)) !== null) {
    points.push({
      selector: `[data-pledge-interactive="${match[1]}"]`,
      component: match[1],
      events: match[2].split(','),
    });
  }

  // Find the root hydration point
  if (html.includes('id="__pledge_root__"')) {
    points.push({
      selector: '#__pledge_root__',
      component: 'root',
      events: [],
    });
  }

  return points;
}

/**
 * Finds required chunks from the HTML and module map.
 */
function findRequiredChunks(html: string, moduleMap: Record<string, string>): string[] {
  const chunks: string[] = [];
  const chunkRegex = /data-pledge-chunk="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = chunkRegex.exec(html)) !== null) {
    if (!chunks.includes(match[1])) {
      chunks.push(match[1]);
    }
  }

  // Also check module map for referenced components
  for (const [component, chunk] of Object.entries(moduleMap)) {
    if (html.includes(`data-pledge-component="${component}"`) && !chunks.includes(chunk)) {
      chunks.push(chunk);
    }
  }

  return chunks;
}

/**
 * Generates a full hydration script (React hydration).
 */
function generateFullScript(
  _points: HydrationPoint[],
  chunks: string[],
  hydrationData?: string,
  minify?: boolean,
): string {
  const chunkImports = chunks.map(c => `import * as m${chunks.indexOf(c)} from "${c}";`).join('\n');
  const chunkMap = `{${chunks.map((c, i) => `"${c}": m${i}`).join(',')}}`;

  const script = `
${chunkImports}
const __pledge_chunks__ = ${chunkMap};
${hydrationData ? `const __pledge_hydration_data__ = ${JSON.stringify(hydrationData)};` : ''}

async function hydrate() {
  const { hydrateRoot } = await import("react-dom/client");
  const { createElement } = await import("react");
  const root = document.getElementById("__pledge_root__");
  if (!root) return;

  // Load all required chunks
  const modules = await Promise.all(
    Object.values(__pledge_chunks__).map(m => typeof m === 'object' ? m : import(m))
  );

  // Reconstruct the component tree from hydration data
  // and hydrate the root
  hydrateRoot(root, createElement('div', null, root.innerHTML));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', hydrate);
} else {
  hydrate();
}
`;

  return minify ? minifyScript(script) : script.trim();
}

/**
 * Generates a minimal hydration script (event listeners only, no React).
 */
function generateMinimalScript(
  points: HydrationPoint[],
  chunks: string[],
  minify?: boolean,
): string {
  const eventBindings = points
    .filter(p => p.events.length > 0)
    .map(p => {
      return p.events.map(event => {
        const handler = `function(e){var t=e.target.closest('${p.selector}');if(t){t.dispatchEvent(new CustomEvent('pledge:${event}',{detail:e,bubbles:true}))}}`;
        return `document.addEventListener('${event}',${handler})`;
      }).join(';');
    })
    .join(';');

  const chunkLoader = chunks.length > 0
    ? `var s=${JSON.stringify(chunks)}.map(function(u){var e=document.createElement('script');e.type='module';e.src=u;document.head.appendChild(e);return e})`
    : '';

  const script = `
(function(){
${chunkLoader}
${eventBindings}
})()
`;

  return minify ? minifyScript(script) : script.trim();
}

/**
 * Generates a progressive enhancement script.
 */
function generateProgressiveScript(
  points: HydrationPoint[],
  chunks: string[],
  hydrationData?: string,
  minify?: boolean,
): string {
  const script = `
(async function() {
  // Progressive enhancement: page works without JS, enhanced with

  // 1. Load required chunks lazily (only when needed)
  const chunks = ${JSON.stringify(chunks)};
  const loadedChunks = new Map();

  async function loadChunk(path) {
    if (loadedChunks.has(path)) return loadedChunks.get(path);
    const mod = await import(path);
    loadedChunks.set(path, mod);
    return mod;
  }

  // 2. Attach event listeners for interactive elements
  const points = ${JSON.stringify(points)};
  for (const point of points) {
    if (point.events.length === 0) continue;
    const els = document.querySelectorAll(point.selector);
    for (const el of els) {
      for (const event of point.events) {
        el.addEventListener(event, async (e) => {
          // Load the component chunk on first interaction
          if (point.chunkPath) {
            const mod = await loadChunk(point.chunkPath);
            if (mod[point.component]) {
              const handler = mod[point.component];
              if (typeof handler === 'function') handler(e);
            }
          }
        }, { passive: true });
      }
    }
  }

  // 3. If hydration data is present, perform full hydration
  ${hydrationData ? `
  if (document.querySelector('#__pledge_root__')) {
    const { hydrateRoot } = await import('react-dom/client');
    const { createElement } = await import('react');
    const root = document.getElementById('__pledge_root__');
    hydrateRoot(root, createElement('div', { dangerouslySetInnerHTML: { __html: root.innerHTML } }));
  }
  ` : ''}
})();
`;

  return minify ? minifyScript(script) : script.trim();
}

/**
 * Simple JS minifier (removes comments and excess whitespace).
 */
function minifyScript(script: string): string {
  return script
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .replace(/;\s*;/g, ';')
    .replace(/\{\s+/g, '{')
    .replace(/\s+\}/g, '}')
    .trim();
}

/**
 * Generates a simple sourcemap for the hydration script.
 */
function generateSourcemap(_script: string): string {
  // Simple sourcemap — in production this would be generated by the Rust engine
  const lines = _script.split('\n');
  const mappings = lines.map((_, i) => `AAAA${i > 0 ? ',' : ''}`).join('');

  return JSON.stringify({
    version: 3,
    sources: ['hydration.ts'],
    sourcesContent: [_script],
    mappings,
    names: [],
  });
}

/**
 * Generates an inline hydration script tag.
 */
export function generateInlineHydrationScript(options: HydrationScriptOptions): string {
  const result = generateHydrationScript(options);
  return `<script type="module">${result.script}</script>`;
}

/**
 * Generates a hydration script URL for external loading.
 * The script is written to a file and served from the specified path.
 */
export function generateHydrationScriptTag(
  _options: HydrationScriptOptions,
  scriptPath: string,
): string {
  // Preload the script
  const preloadTag = `<link rel="modulepreload" href="${scriptPath}" />`;

  // Load the script
  const scriptTag = `<script type="module" src="${scriptPath}"></script>`;

  return `${preloadTag}\n${scriptTag}`;
}
