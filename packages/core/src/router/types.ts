import type { ReactNode, ComponentType } from 'react';
import type { ResolvedRoute, Viewport } from 'pledgestack-shared';

export interface RouteTreeNode {
  pattern: string;
  segment: string;
  children: RouteTreeNode[];
  route?: ResolvedRoute;
  layouts: ResolvedRoute[];
  /** Parallel route slots: slotName -> child node */
  slots?: Record<string, RouteTreeNode>;
}

export interface RouteTree {
  root: RouteTreeNode;
}

export interface PageModule {
  default: ComponentType<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
  viewport?: Viewport;
  generateStaticParams?: () => Promise<Record<string, string>[]>;
  generateMetadata?: (params: Record<string, string>) => Promise<HeadMetadata> | HeadMetadata;
  generateViewport?: () => Promise<Viewport> | Viewport;
  revalidate?: number;
  dynamic?: 'auto' | 'force-dynamic' | 'force-static' | 'error';
  dynamicParams?: boolean;
}

export interface LayoutModule {
  default: ComponentType<{ children: ReactNode }>;
  metadata?: HeadMetadata;
  generateMetadata?: (params: Record<string, string>) => Promise<HeadMetadata> | HeadMetadata;
  viewport?: Viewport;
}

export interface TemplateModule {
  default: ComponentType<{ children: ReactNode }>;
}

export interface RouteHandlerModule {
  GET?: (req: Request) => Promise<Response> | Response;
  POST?: (req: Request) => Promise<Response> | Response;
  PUT?: (req: Request) => Promise<Response> | Response;
  DELETE?: (req: Request) => Promise<Response> | Response;
  PATCH?: (req: Request) => Promise<Response> | Response;
  /** Per-route runtime override: 'node' or 'edge' */
  runtime?: 'node' | 'edge';
}

export interface MiddlewareModule {
  default: (req: Request) => Promise<import('pledgestack-shared').MiddlewareResult> | import('pledgestack-shared').MiddlewareResult;
  /** Path-based middleware activation via export const matcher = [...] */
  matcher?: Array<string | { regex: string }>;
}

export interface LoadingModule {
  default: ComponentType<Record<string, unknown>>;
}

export interface ErrorModule {
  default: ComponentType<{ error: Error; reset: () => void; children?: ReactNode }>;
}

export interface NotFoundModule {
  default: ComponentType<Record<string, unknown>>;
}

export interface GlobalErrorModule {
  default: ComponentType<{ error: Error; reset: () => void; children?: ReactNode }>;
}

export interface HeadModule {
  default: ComponentType<Record<string, unknown>>;
}

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
