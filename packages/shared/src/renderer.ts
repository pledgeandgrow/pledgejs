/**
 * Renderer abstraction layer — makes PledgeStack framework-agnostic.
 *
 * Each renderer adapter implements SSR, streaming, hydration, and error boundary
 * support for a specific UI framework (React, Vue, Solid, Svelte).
 *
 * The core routing/caching/server-utils are framework-agnostic. Only the
 * rendering layer is pluggable via this interface.
 */

import type { ReadableStream } from 'node:stream/web';
import type { ResolvedRoute, Viewport, RouteMatch, MiddlewareResult } from './types';

/**
 * Framework types supported by PledgeStack.
 */
export type Framework = 'react' | 'vue' | 'solid' | 'svelte';

/**
 * Generic module types — framework-agnostic representations of route modules.
 * Each renderer adapter is responsible for interpreting these.
 */
export interface GenericPageModule {
  default: unknown;
  metadata?: Record<string, unknown>;
  viewport?: Viewport;
  generateStaticParams?: () => Promise<Record<string, string>[]>;
  generateMetadata?: (params: Record<string, string>) => Promise<HeadMetadata> | HeadMetadata;
  generateViewport?: () => Promise<Viewport> | Viewport;
  revalidate?: number;
  dynamic?: 'auto' | 'force-dynamic' | 'force-static' | 'error';
  dynamicParams?: boolean;
}

export interface GenericLayoutModule {
  default: unknown;
  metadata?: HeadMetadata;
  generateMetadata?: (params: Record<string, string>) => Promise<HeadMetadata> | HeadMetadata;
  viewport?: Viewport;
}

export interface GenericLoadingModule {
  default: unknown;
}

export interface GenericErrorModule {
  default: unknown;
}

export interface GenericNotFoundModule {
  default: unknown;
}

export interface GenericHeadModule {
  default: unknown;
}

export interface GenericTemplateModule {
  default: unknown;
}

export interface GenericRouteHandlerModule {
  GET?: (req: Request) => Promise<Response> | Response;
  POST?: (req: Request) => Promise<Response> | Response;
  PUT?: (req: Request) => Promise<Response> | Response;
  DELETE?: (req: Request) => Promise<Response> | Response;
  PATCH?: (req: Request) => Promise<Response> | Response;
  runtime?: 'node' | 'edge';
}

export interface GenericMiddlewareModule {
  default: (req: Request) => Promise<MiddlewareResult> | MiddlewareResult;
  matcher?: Array<string | { regex: string }>;
}

export type AnyGenericModule =
  | GenericPageModule
  | GenericLayoutModule
  | GenericLoadingModule
  | GenericErrorModule
  | GenericNotFoundModule
  | GenericHeadModule
  | GenericTemplateModule
  | GenericRouteHandlerModule
  | GenericMiddlewareModule;

export interface HeadMetadata {
  title?: string;
  description?: string;
  keywords?: string[];
  openGraph?: {
    title?: string;
    description?: string;
    images?: string[];
    url?: string;
    type?: string;
    siteName?: string;
  };
  twitter?: {
    card?: string;
    title?: string;
    description?: string;
    images?: string[];
    site?: string;
    creator?: string;
  };
  robots?: string;
  themeColor?: string;
  alternates?: { canonical?: string };
  icons?: { icon?: string; apple?: string; favicon?: string };
  structuredData?: Record<string, unknown> | Record<string, unknown>[];
  other?: Record<string, string>;
}

// MiddlewareResult is defined in ./types and re-exported via index.ts

/**
 * Context passed to renderer methods.
 */
export interface RenderContext {
  /** The matched route */
  match: RouteMatch;
  /** The route tree */
  tree: RouteTree;
  /** All loaded modules for this route (file path -> module) */
  modules: Map<string, AnyGenericModule>;
  /** Search params for the current request */
  searchParams?: Record<string, string>;
  /** Whether RSC is enabled (React only) */
  rsc?: boolean;
  /** Client manifest for RSC (React only) */
  clientManifest?: Record<string, string>;
}

/**
 * Result of a string render (SSR/SSG).
 */
export interface RenderResult {
  /** The rendered HTML body content (without shell) */
  html: string;
  /** Resolved metadata */
  metadata: HeadMetadata;
  /** Resolved viewport */
  viewport?: Viewport;
  /** Head HTML (from head.tsx or generated) */
  headHtml?: string;
}

/**
 * The renderer adapter interface — implemented by each framework adapter.
 *
 * This is the core abstraction that makes PledgeStack framework-agnostic.
 * The server handler calls these methods without knowing which framework
 * is being used.
 */
export interface RendererAdapter {
  /** Framework name */
  readonly framework: Framework;

  /** Render a page to an HTML string (SSR/SSG) */
  renderToString(ctx: RenderContext): Promise<string>;

  /** Render a page to a streaming HTML string (buffered, but uses streaming internally) */
  renderToStream(ctx: RenderContext): Promise<string>;

  /** Render a page to a Web ReadableStream (true streaming) */
  renderToReadableStream(ctx: RenderContext): Promise<ReadableStream<Uint8Array>>;

  /** Render the not-found page */
  renderNotFound(ctx: RenderContext): Promise<string>;

  /** Render RSC payload to HTML (React only — other frameworks throw or fall back to SSR) */
  renderRSC?(ctx: RenderContext): Promise<string>;

  /** Render RSC payload as a streaming response (React only) */
  renderRSCStream?(ctx: RenderContext): Promise<ReadableStream<Uint8Array>>;

  /** Prerender the static shell for PPR */
  prerenderStaticShell?(ctx: RenderContext): Promise<string>;

  /** Render dynamic holes for PPR */
  renderDynamicHoles?(ctx: RenderContext): Promise<ReadableStream<Uint8Array>>;

  /** Generate the client hydration script */
  generateClientScript(options: ClientScriptOptions): string;

  /** Generate the RSC client script (React only) */
  generateRSCClientScript?(options: ClientScriptOptions): string;

  /** File extension for page/layout files (e.g. 'tsx' for React, 'vue' for Vue) */
  readonly fileExtension: string;

  /** File extensions that this renderer can handle */
  readonly handledExtensions: readonly string[];
}

export interface ClientScriptOptions {
  /** Whether in dev mode */
  isDev: boolean;
  /** PledgePack dev server port (for module proxying) */
  pledgepackPort?: number;
  /** Whether RSC is enabled */
  rscEnabled: boolean;
}

/**
 * Registry of renderer adapters — maps framework name to adapter.
 */
export class RendererRegistry {
  private adapters = new Map<Framework, RendererAdapter>();
  private defaultFramework: Framework = 'react';

  /** Register a renderer adapter */
  register(adapter: RendererAdapter): void {
    this.adapters.set(adapter.framework, adapter);
  }

  /** Get the adapter for a framework */
  get(framework: Framework): RendererAdapter | undefined {
    return this.adapters.get(framework);
  }

  /** Get the default adapter */
  getDefault(): RendererAdapter | undefined {
    return this.adapters.get(this.defaultFramework);
  }

  /** Set the default framework */
  setDefault(framework: Framework): void {
    if (!this.adapters.has(framework)) {
      throw new Error(`Renderer adapter for "${framework}" is not registered`);
    }
    this.defaultFramework = framework;
  }

  /** List registered frameworks */
  list(): Framework[] {
    return [...this.adapters.keys()];
  }
}

/** Global renderer registry singleton */
let globalRegistry: RendererRegistry | null = null;

/** Get the global renderer registry */
export function getRendererRegistry(): RendererRegistry {
  if (!globalRegistry) {
    globalRegistry = new RendererRegistry();
  }
  return globalRegistry;
}

/** Reset the global renderer registry (for testing) */
export function resetRendererRegistry(): void {
  globalRegistry = null;
}

// --- Shared route tree types and layout chain ---

/**
 * A node in the route tree. Framework-agnostic — built by the core router.
 */
export interface RouteTreeNode {
  pattern: string;
  segment: string;
  children: RouteTreeNode[];
  route?: ResolvedRoute;
  layouts: ResolvedRoute[];
  slots?: Record<string, RouteTreeNode>;
}

/**
 * The route tree. Framework-agnostic — built by the core router.
 */
export interface RouteTree {
  root: RouteTreeNode;
}

/**
 * Gets the chain of layouts for a matched route, from outermost to innermost.
 * Walks the route tree to collect layouts at each path segment.
 *
 * This is shared across all renderer adapters — the route tree structure
 * is framework-agnostic.
 */
export function getLayoutChain(match: RouteMatch, tree: unknown): ResolvedRoute[] {
  if (!tree || typeof tree !== 'object') return [];
  const t = tree as RouteTree;
  if (!t?.root) return [];

  const layouts: ResolvedRoute[] = [];
  const pathSegments = match.route.pattern.split('/').filter(Boolean);

  let node: RouteTreeNode | undefined = t.root;

  for (const segment of pathSegments) {
    if (!node) break;

    // Collect layouts at this level
    for (const layout of node.layouts) {
      layouts.push(layout);
    }

    // Find the child matching this segment
    const child: RouteTreeNode | undefined = node.children.find((c: RouteTreeNode) => {
      if (c.segment === segment) return true;
      // Dynamic segment match
      if (c.segment.startsWith('[') && c.segment.endsWith(']')) return true;
      // Catch-all match
      if (c.segment.startsWith('[...')) return true;
      // Route group — skip (doesn't affect URL)
      if (c.segment.startsWith('(') && c.segment.endsWith(')')) return true;
      return false;
    });

    node = child;
  }

  // Collect layouts at the final level
  if (node) {
    for (const layout of node.layouts) {
      layouts.push(layout);
    }
  }

  return layouts;
}
