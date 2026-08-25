/**
 * #241 — Hybrid SSR orchestration.
 *
 * Intelligent routing of SSR: static parts → Rust renderer, dynamic parts →
 * Node.js React, merge streams with proper ordering and suspense boundary
 * handling.
 *
 * The orchestrator:
 * 1. Analyzes the component tree to classify static vs dynamic parts
 * 2. Renders static parts using the Rust DOM renderer (#240)
 * 3. Renders dynamic parts using React's renderToPipeableStream
 * 4. Merges the outputs with proper ordering
 * 5. Handles Suspense boundaries that span static/dynamic boundaries
 *
 * Classification heuristics:
 * - Components without hooks/state → static (Rust)
 * - Components with useState/useEffect/useContext → dynamic (React)
 * - Suspense boundaries → dynamic (React)
 * - Pure HTML elements → static (Rust)
 * - Server components with async data → dynamic (React)
 */

import { renderToPipeableStream, renderToString } from 'react-dom/server';
import { createElement, Suspense, Component, type ReactNode, type ComponentType } from 'react';
import { Writable } from 'node:stream';
import type { RouteMatch, PledgeConfig } from 'pledgestack-shared';
import { type PledgeManifest } from 'pledgestack-shared';
import type { PageModule, LayoutModule, LoadingModule, ErrorModule, NotFoundModule, HeadModule, TemplateModule } from '../router/types';
import { getLayoutChain } from '../router/router';
import type { RouteTree } from '../router/types';
import { canRenderInRust, renderRustDomToString, renderSimpleHtml } from './rust-dom-renderer';
import { renderHtmlShell } from './rust-html';

export interface HybridSSRContext {
  config: PledgeConfig;
  match: RouteMatch;
  tree: RouteTree;
  modules: Map<string, PageModule | LayoutModule | LoadingModule | ErrorModule | NotFoundModule | HeadModule | TemplateModule>;
  searchParams?: Record<string, string>;
  /** Whether to force Rust rendering for all components */
  forceRust?: boolean;
  /** Whether to force React rendering for all components */
  forceReact?: boolean;
}

export interface HybridSSRResult {
  /** The complete HTML document */
  html: string;
  /** Whether any Rust rendering was used */
  usedRust: boolean;
  /** Number of components rendered by Rust */
  rustComponentCount: number;
  /** Number of components rendered by React */
  reactComponentCount: number;
  /** Render time in milliseconds */
  renderTimeMs: number;
  /** Classification of each component */
  classification?: ComponentClassification[];
}

export interface ComponentClassification {
  /** Component name */
  name: string;
  /** Whether it was rendered by Rust or React */
  renderer: 'rust' | 'react';
  /** Reason for the classification */
  reason: string;
  /** Render time in microseconds */
  renderTimeUs?: number;
}

/**
 * Renders a route using hybrid SSR orchestration.
 *
 * Static parts of the component tree are rendered by the Rust engine,
 * while dynamic parts (hooks, suspense, async data) are rendered by React.
 */
export async function renderHybridSSR(ctx: HybridSSRContext): Promise<HybridSSRResult> {
  const startTime = Date.now();

  const { match, tree, modules } = ctx;
  const pageModule = modules.get(match.route.filePath) as PageModule | undefined;
  if (!pageModule) {
    throw new Error(`Page module not found: ${match.route.filePath}`);
  }

  // Build the element tree
  const searchParamsRecord = ctx.searchParams ?? {};
  let element: ReactNode = createElement(pageModule.default, {
    params: match.params,
    searchParams: searchParamsRecord,
  });

  // Wrap with error boundary
  if (match.route.errorFilePath) {
    const errorModule = modules.get(match.route.errorFilePath) as ErrorModule | undefined;
    if (errorModule) {
      element = createElement(HybridErrorBoundary, { fallback: errorModule.default }, element);
    }
  }

  // Wrap with Suspense
  if (match.route.loadingFilePath) {
    const loadingModule = modules.get(match.route.loadingFilePath) as LoadingModule | undefined;
    if (loadingModule) {
      element = createElement(Suspense, { fallback: createElement(loadingModule.default, {}) }, element);
    }
  }

  // Wrap in template
  if (match.route.templateFilePath) {
    const templateModule = modules.get(match.route.templateFilePath) as TemplateModule | undefined;
    if (templateModule) {
      element = createElement(templateModule.default, { children: element });
    }
  }

  // Wrap in layout chain
  const layouts = getLayoutChain(match, tree);
  for (const layout of layouts) {
    const layoutModule = modules.get(layout.filePath) as LayoutModule | undefined;
    if (layoutModule) {
      let layoutContent: ReactNode = createElement(layoutModule.default, { children: element });

      if (layout.errorFilePath) {
        const layoutErrorModule = modules.get(layout.errorFilePath) as ErrorModule | undefined;
        if (layoutErrorModule) {
          layoutContent = createElement(HybridErrorBoundary, { fallback: layoutErrorModule.default }, layoutContent);
        }
      }

      if (layout.loadingFilePath) {
        const layoutLoadingModule = modules.get(layout.loadingFilePath) as LoadingModule | undefined;
        if (layoutLoadingModule) {
          layoutContent = createElement(Suspense, { fallback: createElement(layoutLoadingModule.default, {}) }, layoutContent);
        }
      }

      if (layout.templateFilePath) {
        const layoutTemplateModule = modules.get(layout.templateFilePath) as TemplateModule | undefined;
        if (layoutTemplateModule) {
          layoutContent = createElement(layoutTemplateModule.default, { children: layoutContent });
        }
      }

      element = layoutContent;
    }
  }

  // Classify components and decide rendering strategy
  const classification = classifyComponents(element);
  const rustComponentCount = classification.filter(c => c.renderer === 'rust').length;
  const reactComponentCount = classification.filter(c => c.renderer === 'react').length;

  // If everything can be rendered in Rust, use the fast path
  const allRust = ctx.forceRust || (reactComponentCount === 0 && !ctx.forceReact);
  let html: string;
  let usedRust: boolean;

  if (allRust) {
    // Fast path: render everything in Rust
    const result = renderRustDomToString(element);
    html = result.html;
    usedRust = result.usedRust;
  } else {
    // Hybrid path: use React for the full tree, but use Rust for static subtrees
    const result = await renderHybrid(element, ctx);
    html = result;
    usedRust = rustComponentCount > 0;
  }

  // Wrap in HTML shell using the Rust HTML template engine (#238)
  const manifest: PledgeManifest = { pledges: [] };
  const shellResult = renderHtmlShell({
    content: html,
    route: match.route,
    manifest,
    cssFiles: ['/__pledge__/client.css'],
    jsModules: ['/__pledge__/client.js'],
  });

  const renderTimeMs = Date.now() - startTime;

  return {
    html: shellResult.html,
    usedRust,
    rustComponentCount,
    reactComponentCount,
    renderTimeMs,
    classification,
  };
}

/**
 * Classifies components in the element tree as static (Rust) or dynamic (React).
 */
function classifyComponents(element: ReactNode): ComponentClassification[] {
  const classifications: ComponentClassification[] = [];
  const visited = new Set<unknown>();

  function walk(node: ReactNode, depth: number): void {
    if (depth > 50) return; // Prevent infinite recursion

    if (node === null || node === undefined || typeof node === 'boolean') return;
    if (typeof node === 'string' || typeof node === 'number') return;

    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }

    if (typeof node === 'object' && '$$typeof' in node) {
      const el = node as { type: unknown; props: Record<string, unknown> };

      if (typeof el.type === 'string') {
        classifications.push({
          name: el.type,
          renderer: 'rust',
          reason: 'HTML element',
        });
      } else if (typeof el.type === 'function') {
        const fn = el.type as { name?: string; displayName?: string };
        const name = fn.displayName ?? fn.name ?? 'Anonymous';

        if (visited.has(el.type)) return;
        visited.add(el.type);

        if (canRenderInRust(node)) {
          classifications.push({
            name,
            renderer: 'rust',
            reason: 'No hooks detected',
          });
        } else {
          classifications.push({
            name,
            renderer: 'react',
            reason: 'Uses hooks or state',
          });
        }
      } else if (el.type === Suspense) {
        classifications.push({
          name: 'Suspense',
          renderer: 'react',
          reason: 'Suspense boundary requires React',
        });
      }

      if (el.props?.children) {
        walk(el.props.children as ReactNode, depth + 1);
      }
    }
  }

  walk(element, 0);
  return classifications;
}

/**
 * Renders the element tree with React's streaming SSR.
 *
 * NOTE: despite this module's name, the render is currently 100% React — the
 * Rust static-subtree split (renderStaticParts / fillDynamicPlaceholders /
 * replacePlaceholders below) is not invoked from here or anywhere else, and
 * this module is not wired into the request pipeline. Treat "hybrid" as
 * aspirational until that path is implemented and connected.
 */
async function renderHybrid(element: ReactNode, _ctx: HybridSSRContext): Promise<string> {
  return new Promise((resolve, reject) => {
    let html = '';
    let shellReady = false;

    const writable = new Writable({
      write(chunk: Buffer, _encoding: string, callback: () => void) {
        html += chunk.toString('utf-8');
        callback();
      },
    });

    const { pipe } = renderToPipeableStream(createElement(() => element as ReactNode), {
      onShellReady() {
        shellReady = true;
        pipe(writable);
      },
      onAllReady() {
        resolve(html);
      },
      onShellError(error) {
        reject(error);
      },
      onError(error) {
        if (!shellReady) reject(error);
      },
    });
    void pipe;
  });
}

/**
 * Error boundary for hybrid SSR.
 */
class HybridErrorBoundary extends Component<
  { fallback: ComponentType<{ error: Error; reset: () => void; children?: ReactNode }>; children?: ReactNode },
  { hasError: boolean; error: Error | null }
> {
  state = { hasError: false, error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError && this.state.error) {
      const Fallback = this.props.fallback;
      return createElement(Fallback, {
        error: this.state.error,
        reset: () => this.setState({ hasError: false, error: null }),
      });
    }
    return this.props.children as ReactNode;
  }
}

/**
 * Renders only the static parts of a tree using Rust, returning placeholders
 * for dynamic parts that React will fill in.
 */
export function renderStaticParts(element: ReactNode): { html: string; placeholders: StaticPlaceholder[] } {
  const placeholders: StaticPlaceholder[] = [];
  let placeholderIdCounter = 0;

  function render(node: ReactNode): string {
    if (node === null || node === undefined || typeof node === 'boolean') return '';
    if (typeof node === 'string') return escapeHtml(node);
    if (typeof node === 'number') return String(node);

    if (Array.isArray(node)) {
      return node.map(render).join('');
    }

    if (typeof node === 'object' && '$$typeof' in node) {
      if (canRenderInRust(node)) {
        // Render static content with Rust
        const result = renderRustDomToString(node);
        return result.html;
      }

      // Dynamic content — insert placeholder
      const id = `__pledge_dynamic_${placeholderIdCounter++}`;
      placeholders.push({
        id,
        element: node,
        renderTimeUs: 0,
      });
      return `<div id="${id}" data-pledge-dynamic="true"></div>`;
    }

    return '';
  }

  function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  const html = render(element);
  return { html, placeholders };
}

export interface StaticPlaceholder {
  id: string;
  element: ReactNode;
  renderTimeUs: number;
}

/**
 * Fills in dynamic placeholders with React-rendered content.
 */
export async function fillDynamicPlaceholders(
  placeholders: StaticPlaceholder[],
  _ctx: HybridSSRContext,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  for (const placeholder of placeholders) {
    try {
      const html = renderToString(placeholder.element);
      results.set(placeholder.id, html);
    } catch (err) {
      console.warn(`[pledgestack] Failed to render dynamic placeholder ${placeholder.id}:`, err);
      results.set(placeholder.id, '<!-- render error -->');
    }
  }

  return results;
}

/**
 * Replaces placeholders in HTML with rendered content.
 */
export function replacePlaceholders(html: string, replacements: Map<string, string>): string {
  let result = html;
  for (const [id, content] of replacements) {
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`<div id="${escapedId}" data-pledge-dynamic="true"></div>`, 'g');
    result = result.replace(regex, content.replace(/\$/g, '$$$$'));
  }
  return result;
}

// Re-export for convenience
export { renderSimpleHtml };
