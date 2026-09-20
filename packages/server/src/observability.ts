/**
 * Structured JSON logging with request-scoped context, redaction,
 * OpenTelemetry-compatible output, error tracking, slow request detection,
 * cache hit/miss logging, and dev profiler.
 *
 * Items 93, 157, 160, 164, 165, 166 of the PledgeStack roadmap.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

// ---------------------------------------------------------------------------
// 157. Structured JSON logging — OTel-compatible output
// ---------------------------------------------------------------------------

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5,
};

export interface LogContext {
  [key: string]: unknown;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  service?: string;
  traceId?: string;
  spanId?: string;
  requestId?: string;
  [key: string]: unknown;
}

export interface LoggerConfig {
  level: LogLevel;
  serviceName: string;
  redactFields: string[];
  otelCompatible: boolean;
  prettyPrint: boolean;
}

const defaultConfig: LoggerConfig = {
  level: 'info',
  serviceName: 'pledgestack-app',
  redactFields: ['password', 'token', 'secret', 'apiKey', 'authorization', 'cookie'],
  otelCompatible: true,
  prettyPrint: process.env.NODE_ENV !== 'production',
};

let loggerConfig: LoggerConfig = { ...defaultConfig };

const logStorage = new AsyncLocalStorage<LogContext>();

/**
 * Configures the global logger.
 */
export function configureLogger(config: Partial<LoggerConfig>): void {
  loggerConfig = { ...defaultConfig, ...config };
}

/** Entry fields owned by the logger — context keys with these names are kept under a `ctx_` prefix. */
const RESERVED_LOG_KEYS = new Set(['timestamp', 'level', 'message']);

function isRedactedKey(key: string): boolean {
  const lower = key.toLowerCase();
  return loggerConfig.redactFields.some((f) => lower.includes(f.toLowerCase()));
}

/**
 * Redacts sensitive fields from a log context object — including inside
 * arrays and nested objects. Errors are serialised (their fields are
 * non-enumerable, so they used to log as `{}`), Dates become ISO strings and
 * circular references are replaced rather than overflowing the stack.
 */
function redact(ctx: LogContext, ancestors: Set<object> = new Set()): LogContext {
  ancestors.add(ctx);
  const redacted: LogContext = {};
  for (const [key, value] of Object.entries(ctx)) {
    redacted[key] = isRedactedKey(key) ? '[REDACTED]' : redactValue(value, ancestors);
  }
  ancestors.delete(ctx);
  return redacted;
}

function redactValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (ancestors.has(value)) return '[Circular]';

  if (value instanceof Error) {
    ancestors.add(value);
    const out: LogContext = {
      ...redact({ ...(value as unknown as LogContext) }, ancestors),
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
    if ('cause' in value && value.cause !== undefined) out.cause = redactValue(value.cause, ancestors);
    ancestors.delete(value);
    return out;
  }

  if (Array.isArray(value)) {
    ancestors.add(value);
    const out = value.map((item) => redactValue(item, ancestors));
    ancestors.delete(value);
    return out;
  }

  return redact(value as LogContext, ancestors);
}

/**
 * Formats a log entry as JSON (OTel-compatible) or pretty-printed.
 */
function formatEntry(entry: LogEntry): string {
  if (loggerConfig.otelCompatible) {
    const { timestamp: _ts, level: _lvl, message: _msg, ...attributes } = entry;
    const otelEntry: Record<string, unknown> = {
      Timestamp: entry.timestamp,
      SeverityText: entry.level.toUpperCase(),
      SeverityNumber: LOG_LEVEL_PRIORITY[entry.level],
      Body: entry.message,
      Attributes: attributes,
    };
    return JSON.stringify(otelEntry);
  }

  if (loggerConfig.prettyPrint) {
    const ts = entry.timestamp.slice(11, 23);
    const level = entry.level.toUpperCase().padEnd(5);
    const ctx = Object.keys(entry).length > 4
      ? ' ' + JSON.stringify({ ...entry, timestamp: undefined, level: undefined, message: undefined })
      : '';
    return `${ts} ${level} ${entry.message}${ctx}`;
  }

  return JSON.stringify(entry);
}

/**
 * Core log function — writes structured entry to stdout/stderr.
 */
function log(level: LogLevel, message: string, context?: LogContext): void {
  if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[loggerConfig.level]) return;

  const requestCtx = logStorage.getStore() ?? {};
  const mergedCtx = { ...requestCtx, ...context };
  const redactedCtx = redact(mergedCtx);

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    service: loggerConfig.serviceName,
  };
  // Context must never overwrite the entry's own timestamp/level/message
  // (`logger.info('done', { message: err.message })` used to replace the log
  // message, and a `level` key corrupted severity).
  for (const [key, value] of Object.entries(redactedCtx)) {
    entry[RESERVED_LOG_KEYS.has(key) ? `ctx_${key}` : key] = value;
  }

  const formatted = formatEntry(entry);
  if (level === 'error' || level === 'fatal') {
    process.stderr.write(formatted + '\n');
  } else {
    process.stdout.write(formatted + '\n');
  }
}

/**
 * Logger instance with chained context support.
 */
export interface Logger {
  trace(msg: string, ctx?: LogContext): void;
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  fatal(msg: string, ctx?: LogContext): void;
  child(ctx: LogContext): Logger;
  withRequest<T>(ctx: LogContext, fn: () => T): T;
}

function createLogger(baseCtx: LogContext = {}): Logger {
  return {
    trace: (msg, ctx) => log('trace', msg, { ...baseCtx, ...ctx }),
    debug: (msg, ctx) => log('debug', msg, { ...baseCtx, ...ctx }),
    info: (msg, ctx) => log('info', msg, { ...baseCtx, ...ctx }),
    warn: (msg, ctx) => log('warn', msg, { ...baseCtx, ...ctx }),
    error: (msg, ctx) => log('error', msg, { ...baseCtx, ...ctx }),
    fatal: (msg, ctx) => log('fatal', msg, { ...baseCtx, ...ctx }),
    child: (ctx) => createLogger({ ...baseCtx, ...ctx }),
    withRequest: <T>(ctx: LogContext, fn: () => T): T => logStorage.run({ ...baseCtx, ...ctx }, fn),
  };
}

/**
 * The root logger instance.
 */
export const logger = createLogger();

/**
 * Creates a request-scoped logger that automatically includes
 * requestId, traceId, and other request context.
 */
export function createRequestLogger(requestContext: {
  requestId?: string;
  traceId?: string;
  method?: string;
  path?: string;
}): Logger {
  return logger.child({
    requestId: requestContext.requestId,
    traceId: requestContext.traceId,
    'http.method': requestContext.method,
    'http.target': requestContext.path,
  });
}

// ---------------------------------------------------------------------------
// 160. Error tracking — Sentry/Bugsnag adapter
// ---------------------------------------------------------------------------

export type ErrorTrackerType = 'sentry' | 'bugsnag' | 'custom' | 'none';

export interface ErrorTrackerConfig {
  type: ErrorTrackerType;
  dsn?: string;
  apiKey?: string;
  environment?: string;
  release?: string;
  sampleRate?: number;
  /** Custom error reporter function (for 'custom' type) */
  reportFn?: (error: Error, context?: LogContext) => Promise<void>;
}

export interface ErrorReport {
  error: Error;
  context: LogContext;
  timestamp: string;
  level: 'error' | 'warning' | 'info';
}

let errorTrackerConfig: ErrorTrackerConfig = { type: 'none' };
const errorBuffer: ErrorReport[] = [];

/**
 * Initializes the error tracking adapter.
 */
export function initErrorTracking(config: ErrorTrackerConfig): void {
  errorTrackerConfig = {
    environment: process.env.NODE_ENV ?? 'development',
    sampleRate: 1.0,
    ...config,
  };
}

/**
 * Reports an error to the configured error tracker.
 * Includes PII scrubbing, source map context, and request enrichment.
 */
export async function reportError(
  error: Error,
  context?: LogContext,
  level: 'error' | 'warning' | 'info' = 'error',
): Promise<void> {
  if (errorTrackerConfig.type === 'none') return;

  if (Math.random() > (errorTrackerConfig.sampleRate ?? 1.0)) return;

  const report: ErrorReport = {
    error,
    context: redact(context ?? {}),
    timestamp: new Date().toISOString(),
    level,
  };

  switch (errorTrackerConfig.type) {
    case 'sentry':
      await reportToSentry(report);
      break;
    case 'bugsnag':
      await reportToBugsnag(report);
      break;
    case 'custom':
      if (errorTrackerConfig.reportFn) {
        await errorTrackerConfig.reportFn(error, report.context);
      }
      break;
  }

  errorBuffer.push(report);
  if (errorBuffer.length > 100) errorBuffer.shift();
}

/**
 * Parse a Sentry DSN (`https://<public_key>@<host>/<project_id>`) into the
 * ingest URL and public key. The public key is sent via the X-Sentry-Auth
 * header, NOT in the request body.
 */
function parseSentryDsn(dsn: string): { url: string; publicKey: string } | null {
  try {
    const u = new URL(dsn);
    const publicKey = u.username;
    const projectId = u.pathname.replace(/^\//, '');
    if (!publicKey || !projectId) return null;
    return { url: `${u.protocol}//${u.host}/api/${projectId}/envelope/`, publicKey };
  } catch {
    return null;
  }
}

async function reportToSentry(report: ErrorReport): Promise<void> {
  if (!errorTrackerConfig.dsn) return;
  const dsn = parseSentryDsn(errorTrackerConfig.dsn);
  if (!dsn) return;

  try {
    const eventId = crypto.randomUUID().replace(/-/g, '');
    const event = {
      event_id: eventId,
      timestamp: report.timestamp,
      level: report.level,
      environment: errorTrackerConfig.environment,
      release: errorTrackerConfig.release,
      exception: {
        values: [{
          type: report.error.name,
          value: report.error.message,
          stacktrace: { frames: parseStack(report.error.stack) },
        }],
      },
      extra: report.context,
    };

    // A Sentry envelope is newline-delimited JSON:
    //   {envelope header}\n{item header}\n{item payload}
    // sent to /api/<project>/envelope/ with the public key in X-Sentry-Auth.
    // (Previously a single JSON object with the DSN in the body was POSTed to a
    // wrong URL, so every report was rejected and the DSN was leaked in-band.)
    const body = [
      JSON.stringify({ event_id: eventId, sent_at: report.timestamp }),
      JSON.stringify({ type: 'event' }),
      JSON.stringify(event),
    ].join('\n');

    await fetch(dsn.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${dsn.publicKey}, sentry_client=pledgestack/1.0`,
      },
      body,
    });
  } catch (err) {
    logger.error('Failed to report to Sentry', { error: err });
  }
}

async function reportToBugsnag(report: ErrorReport): Promise<void> {
  if (!errorTrackerConfig.apiKey) return;
  try {
    await fetch('https://notify.bugsnag.com', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Bugsnag-Api-Key': errorTrackerConfig.apiKey,
      },
      body: JSON.stringify({
        apiKey: errorTrackerConfig.apiKey,
        events: [{
          exceptions: [{
            errorClass: report.error.name,
            message: report.error.message,
            stacktrace: parseStack(report.error.stack),
          }],
          severity: report.level,
          app: {
            environment: errorTrackerConfig.environment,
            releaseStage: errorTrackerConfig.environment,
          },
          metaData: report.context,
        }],
      }),
    });
  } catch (err) {
    logger.error('Failed to report to Bugsnag', { error: err });
  }
}

function parseStack(stack?: string): Array<{ filename: string; lineno: number; function: string }> {
  if (!stack) return [];
  return stack.split('\n').slice(1).map((line) => {
    const match = line.match(/at\s+(.+?)\s+\(?(.+?):(\d+):\d+\)?/);
    if (!match) return { filename: 'unknown', lineno: 0, function: 'anonymous' };
    return { filename: match[2], lineno: parseInt(match[3], 10), function: match[1] };
  });
}

/**
 * Gets buffered error reports (for testing/debugging).
 */
export function getErrorBuffer(): ErrorReport[] {
  return [...errorBuffer];
}

// ---------------------------------------------------------------------------
// 164. Slow request detection — threshold logging
// ---------------------------------------------------------------------------

export interface SlowRequestConfig {
  /** Threshold in ms — requests slower than this are logged */
  thresholdMs: number;
  /** Whether to include stack traces */
  includeStack: boolean;
  /** Whether to log route attribution */
  logRoute: boolean;
}

const slowRequestConfig: SlowRequestConfig = {
  thresholdMs: 1000,
  includeStack: true,
  logRoute: true,
};

/**
 * Configures slow request detection.
 */
export function configureSlowRequestDetection(config: Partial<SlowRequestConfig>): void {
  Object.assign(slowRequestConfig, config);
}

/**
 * Records a request duration and logs if it exceeds the threshold.
 */
export function recordRequestDuration(
  method: string,
  path: string,
  status: number,
  durationMs: number,
  route?: string,
): void {
  if (durationMs < slowRequestConfig.thresholdMs) return;

  const context: LogContext = {
    'http.method': method,
    'http.path': path,
    'http.status': status,
    'http.duration_ms': durationMs,
    slow: true,
  };

  if (slowRequestConfig.logRoute && route) {
    context['http.route'] = route;
  }

  if (slowRequestConfig.includeStack) {
    context.stack = new Error().stack;
  }

  logger.warn('Slow request detected', context);
}

// ---------------------------------------------------------------------------
// 165. Cache hit/miss logging — debug-level
// ---------------------------------------------------------------------------

export interface CacheLogEntry {
  decision: 'hit' | 'miss' | 'stale' | 'revalidate' | 'bypass';
  key: string;
  ttl?: number;
  tags?: string[];
  route?: string;
}

/**
 * Logs cache decisions at debug level.
 */
export function logCacheDecision(entry: CacheLogEntry): void {
  if (LOG_LEVEL_PRIORITY['debug'] < LOG_LEVEL_PRIORITY[loggerConfig.level]) return;

  logger.debug(`Cache ${entry.decision}`, {
    'cache.decision': entry.decision,
    'cache.key': entry.key,
    'cache.ttl': entry.ttl,
    'cache.tags': entry.tags,
    'cache.route': entry.route,
  });
}

/**
 * Wraps a cache get/set function with automatic logging.
 */
export function withCacheLogging<T>(
  key: string,
  fn: () => Promise<T>,
  options: { ttl?: number; tags?: string[]; route?: string } = {},
): Promise<T> {
  return (async () => {
    try {
      const result = await fn();
      logCacheDecision({ decision: 'hit', key, ...options });
      return result;
    } catch (err) {
      logCacheDecision({ decision: 'miss', key, ...options });
      throw err;
    }
  })();
}

// ---------------------------------------------------------------------------
// 93 & 166. Dev profiler — per-route render time, flamegraph, waterfall
// ---------------------------------------------------------------------------

export interface ProfileSpan {
  name: string;
  category: 'render' | 'data' | 'middleware' | 'route' | 'cache' | 'custom';
  startTime: number;
  endTime: number;
  duration: number;
  attributes?: Record<string, unknown>;
  children?: ProfileSpan[];
}

export interface RouteProfile {
  route: string;
  method: string;
  totalDuration: number;
  spans: ProfileSpan[];
  renderTime: number;
  dataFetchTime: number;
  middlewareTime: number;
  cacheHits: number;
  cacheMisses: number;
}

const profileStorage = new AsyncLocalStorage<RouteProfile>();

/**
 * Starts a profiling span.
 */
export function startProfileSpan(
  name: string,
  category: ProfileSpan['category'],
  attributes?: Record<string, unknown>,
): { end: () => void; span: ProfileSpan } {
  const startTime = performance.now();

  const span: ProfileSpan = {
    name,
    category,
    startTime,
    endTime: 0,
    duration: 0,
    attributes,
  };

  return {
    span,
    end: () => {
      span.endTime = performance.now();
      span.duration = span.endTime - span.startTime;

      const profile = profileStorage.getStore();
      if (profile) {
        profile.spans.push(span);
        if (category === 'render') profile.renderTime += span.duration;
        if (category === 'data') profile.dataFetchTime += span.duration;
        if (category === 'middleware') profile.middlewareTime += span.duration;
        if (category === 'cache') {
          if (attributes?.decision === 'hit') profile.cacheHits++;
          else profile.cacheMisses++;
        }
      }
    },
  };
}

/**
 * Profiles a request handler and returns a RouteProfile.
 */
export function profileRequest<T>(
  route: string,
  method: string,
  fn: () => T,
): T {
  const profile: RouteProfile = {
    route,
    method,
    totalDuration: 0,
    spans: [],
    renderTime: 0,
    dataFetchTime: 0,
    middlewareTime: 0,
    cacheHits: 0,
    cacheMisses: 0,
  };

  const start = performance.now();
  const result = profileStorage.run(profile, fn);

  const finish = (): void => {
    profile.totalDuration = performance.now() - start;

    if (loggerConfig.level === 'debug' || process.env.PLEDGE_PROFILE === '1') {
      logger.debug('Route profile', {
        route: profile.route,
        method: profile.method,
        totalDuration: Math.round(profile.totalDuration * 100) / 100,
        renderTime: Math.round(profile.renderTime * 100) / 100,
        dataFetchTime: Math.round(profile.dataFetchTime * 100) / 100,
        middlewareTime: Math.round(profile.middlewareTime * 100) / 100,
        cacheHits: profile.cacheHits,
        cacheMisses: profile.cacheMisses,
        spanCount: profile.spans.length,
      });
    }
  };

  // Async handlers return before any work has happened: measure to
  // completion, otherwise totalDuration is ~0 and the profile is logged with
  // none of its spans. (Both settle paths are handled so no rejection leaks
  // from the derived promise; the caller still receives the original one.)
  if (result != null && typeof (result as { then?: unknown }).then === 'function') {
    (result as unknown as PromiseLike<unknown>).then(finish, finish);
  } else {
    finish();
  }

  return result;
}

/**
 * Generates a flamegraph representation of a profile.
 */
export function generateFlamegraph(profile: RouteProfile): string {
  const lines: string[] = [`Flamegraph: ${profile.method} ${profile.route} (${Math.round(profile.totalDuration)}ms)`];
  lines.push('');

  const sorted = [...profile.spans].sort((a, b) => a.startTime - b.startTime);
  for (const span of sorted) {
    const bar = '█'.repeat(Math.max(1, Math.round(span.duration / profile.totalDuration * 40)));
    const indent = '  '.repeat(0);
    lines.push(`${indent}${bar} ${span.name} (${Math.round(span.duration)}ms) [${span.category}]`);
  }

  lines.push('');
  lines.push(`Render: ${Math.round(profile.renderTime)}ms | Data: ${Math.round(profile.dataFetchTime)}ms | MW: ${Math.round(profile.middlewareTime)}ms`);
  lines.push(`Cache: ${profile.cacheHits} hits, ${profile.cacheMisses} misses`);

  return lines.join('\n');
}

/**
 * Generates a data fetch waterfall from a profile.
 */
export function generateWaterfall(profile: RouteProfile): string {
  const lines: string[] = [`Waterfall: ${profile.method} ${profile.route}`];
  lines.push('');

  const dataSpans = profile.spans.filter((s) => s.category === 'data' || s.category === 'cache');
  for (const span of dataSpans) {
    const offset = Math.round(span.startTime);
    const duration = Math.round(span.duration);
    const bar = '─'.repeat(Math.max(1, Math.round(duration / 10)));
    lines.push(`${' '.repeat(Math.min(offset, 60))}${bar} ${span.name} (${duration}ms)`);
  }

  return lines.join('\n');
}

/**
 * Gets the current route profile (if profiling is active).
 */
export function getCurrentProfile(): RouteProfile | null {
  return profileStorage.getStore() ?? null;
}
