import type { Runtime, RenderMode } from './config';

export interface RouteMatch {
  /** The matched route path */
  pathname: string;
  /** Route parameters extracted from dynamic segments */
  params: Record<string, string>;
  /** The resolved route module */
  route: ResolvedRoute;
}

export interface ResolvedRoute {
  /** Absolute path to the route file */
  filePath: string;
  /** URL pattern (e.g. '/blog/[slug]') */
  pattern: string;
  /** Render mode for this route */
  mode: RenderMode;
  /** Runtime for this route */
  runtime: Runtime;
  /** Whether this route is a layout */
  isLayout: boolean;
  /** Whether this route is an error boundary */
  isErrorBoundary: boolean;
  /** Whether this route is a loading state */
  isLoading: boolean;
  /** Whether this route is a not-found page */
  isNotFound: boolean;
  /** Absolute path to the loading.tsx for this segment, if any */
  loadingFilePath?: string;
  /** Absolute path to the error.tsx for this segment, if any */
  errorFilePath?: string;
  /** Absolute path to the not-found.tsx for this segment, if any */
  notFoundFilePath?: string;
  /** Absolute path to the head.tsx for this segment, if any */
  headFilePath?: string;
  /** Absolute path to the template.tsx for this segment, if any */
  templateFilePath?: string;
  /** Absolute path to the global-error.tsx for this segment, if any */
  globalErrorFilePath?: string;
  /** Absolute path to the opengraph-image.tsx for this segment, if any */
  opengraphImageFilePath?: string;
  /** Absolute path to the twitter-image.tsx for this segment, if any */
  twitterImageFilePath?: string;
  /** Parallel route slots: @slot -> resolved file path */
  slots?: Record<string, string>;
  /** Intercepting route metadata: number of levels to intercept (1=.., 2=..., 3=....) */
  interceptLevel?: number;
  /** Route segment metadata */
  metadata?: RouteMetadata;
}

export interface RouteMetadata {
  title?: string;
  description?: string;
  /** Route group for middleware matching */
  group?: string;
  /** Revalidate interval for ISR (in seconds), 0 = no revalidation */
  revalidate?: number;
  /** Whether this route should be statically generated */
  static?: boolean;
  /** Custom runtime override */
  runtime?: Runtime;
  /** Viewport metadata for this route */
  viewport?: Viewport;
}

export interface MiddlewareResult {
  /** Headers to set on the response */
  headers?: Record<string, string>;
  /** Rewrite the request to a different path */
  rewrite?: string;
  /** Redirect the request */
  redirect?: { destination: string; permanent?: boolean; status?: number };
  /** Whether to continue to the next middleware or route handler */
  next?: boolean;
}

export interface PledgeRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
  params: Record<string, string>;
  query: Record<string, string>;
  cookies: Record<string, string>;
}

export interface PledgeResponse {
  status: number;
  headers: Record<string, string>;
  body: string | ReadableStream<Uint8Array> | null;
  /** When true, body is a base64-encoded string (for binary content like images) */
  isBase64?: boolean;
}

export interface I18nConfig {
  /** Supported locales (e.g. ['en', 'fr', 'de']) */
  locales: string[];
  /** Default locale when no prefix is present */
  defaultLocale: string;
  /** Whether to prefix the default locale in URLs (default: false) */
  localePrefix?: 'always' | 'as-needed';
  /** Path to i18n messages directory */
  messagesDir?: string;
}

export interface ServerContext {
  req: PledgeRequest;
  res: PledgeResponse;
  config: import('./config').PledgeConfig;
  locals: Record<string, unknown>;
}

export interface Viewport {
  width?: number | string;
  initialScale?: number;
  maximumScale?: number;
  userScalable?: boolean;
  themeColor?: string;
  colorScheme?: 'light' | 'dark' | 'only light' | 'only dark';
  viewportFit?: 'auto' | 'cover' | 'contain';
}
