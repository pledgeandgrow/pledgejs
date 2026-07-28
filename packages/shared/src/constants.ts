/** File conventions for the app directory */
export const FILE_CONVENTIONS = {
  page: 'page',
  layout: 'layout',
  loading: 'loading',
  error: 'error',
  'not-found': 'not-found',
  'global-error': 'global-error',
  template: 'template',
  route: 'route',
  middleware: 'middleware',
  'head': 'head',
} as const;

export type FileConvention = keyof typeof FILE_CONVENTIONS;

/** Dynamic segment pattern: [param] */
export const DYNAMIC_SEGMENT_PATTERN = /^\[([a-zA-Z0-9_]+)\]$/;

/** Catch-all segment pattern: [...param] */
export const CATCH_ALL_PATTERN = /^\[\.\.\.([a-zA-Z0-9_]+)\]$/;

/** Optional catch-all pattern: [[...param]] */
export const OPTIONAL_CATCH_ALL_PATTERN = /^\[\[\.\.\.([a-zA-Z0-9_]+)\]\]$/;

/** Route group pattern: (group) */
export const ROUTE_GROUP_PATTERN = /^\(([a-zA-Z0-9_]+)\)$/;

/** Parallel route slot pattern: @slot */
export const PARALLEL_ROUTE_PATTERN = /^@([a-zA-Z0-9_]+)$/;

/** Intercepting route patterns: (..), (...), (....) */
export const INTERCEPT_ROUTE_PATTERN = /^\(\.{1,4}\)$/;

/** Intercepting route with segment: (..)folder */
export const INTERCEPT_ROUTE_SEGMENT_PATTERN = /^\(\.{1,4}\)(.+)$/;

/** Default port for dev server */
export const DEFAULT_DEV_PORT = 3000;

/** Default port for production server */
export const DEFAULT_PROD_PORT = 3000;

/** Framework version */
export const PLEDGE_VERSION = '0.1.10';
