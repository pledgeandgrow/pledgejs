/**
 * Request tracing — OpenTelemetry integration for distributed tracing.
 *
 * Provides request-scoped spans, automatic HTTP attribute injection,
 * and export to OTLP-compatible backends (Jaeger, Honeycomb, Datadog, etc).
 *
 * Usage in pledge.config.ts:
 *   tracing: { enabled: true, serviceName: 'my-app', exporter: 'otlp' }
 */

export interface TracingConfig {
  /** Enable tracing (default: false) */
  enabled?: boolean;
  /** Service name for traces (default: 'pledgestack-app') */
  serviceName?: string;
  /** Exporter type: 'otlp', 'console', 'none' (default: 'none') */
  exporter?: 'otlp' | 'console' | 'none';
  /** OTLP endpoint URL (for 'otlp' exporter) */
  endpoint?: string;
  /** Sample rate 0-1 (default: 1.0 = all requests) */
  sampleRate?: number;
  /** Additional resource attributes */
  attributes?: Record<string, string>;
}

export interface SpanAttributes {
  [key: string]: string | number | boolean;
}

export interface Span {
  /** Span name */
  name: string;
  /** Start time in milliseconds */
  startTime: number;
  /** End time in milliseconds */
  endTime: number;
  /** Attributes */
  attributes: SpanAttributes;
  /** Status: 'ok', 'error', 'unset' */
  status: 'ok' | 'error' | 'unset';
  /** Error message if status is 'error' */
  errorMessage?: string;
  /** Parent span ID */
  parentSpanId?: string;
  /** Span ID */
  spanId: string;
  /** Trace ID */
  traceId: string;
}

let currentConfig: TracingConfig = { enabled: false };
let spans: Span[] = [];

/**
 * Per-async-context active span. A module-level variable would be shared by
 * every in-flight request, so concurrent requests would parent/annotate each
 * other's spans. AsyncLocalStorage isolates them. On runtimes without
 * node:async_hooks (some edge runtimes) we fall back to a single shared slot,
 * which is only correct for sequential use.
 */
interface SpanStore {
  getStore(): Span | null | undefined;
  enterWith(span: Span | null): void;
  run<T>(span: Span | null, fn: () => T): T;
}

function createSpanStore(): SpanStore {
  try {
    const getBuiltin = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process?.getBuiltinModule;
    const mod = getBuiltin?.('node:async_hooks') as
      | { AsyncLocalStorage?: new () => SpanStore }
      | undefined;
    if (mod?.AsyncLocalStorage) return new mod.AsyncLocalStorage();
  } catch {
    // fall through to the shared-slot fallback
  }
  let slot: Span | null = null;
  return {
    getStore: () => slot,
    enterWith: (span) => { slot = span; },
    run: (span, fn) => {
      const prev = slot;
      slot = span;
      try { return fn(); } finally { slot = prev; }
    },
  };
}

const spanStore = createSpanStore();

function activeSpan(): Span | null {
  return spanStore.getStore() ?? null;
}

/**
 * Run `fn` with its own span context, so spans started inside (and any async
 * work they spawn) never leak into the caller's context.
 */
export function runInSpanContext<T>(fn: () => T): T {
  return spanStore.run(activeSpan(), fn);
}

/** Upper bound on buffered spans, so an unflushed buffer (exporter 'none', or nobody calling flushTraces) cannot grow without limit. */
const MAX_BUFFERED_SPANS = 10_000;

/**
 * Initialize tracing with the given configuration.
 */
export function initTracing(config: TracingConfig): void {
  currentConfig = {
    enabled: config.enabled ?? false,
    serviceName: config.serviceName ?? 'pledgestack-app',
    exporter: config.exporter ?? 'none',
    endpoint: config.endpoint,
    sampleRate: config.sampleRate ?? 1.0,
    attributes: config.attributes,
  };
  spans = [];
}

/**
 * Check if tracing is enabled.
 */
export function isTracingEnabled(): boolean {
  return currentConfig.enabled ?? false;
}

/**
 * Generate a random ID for traces and spans.
 */
function generateId(length = 16): string {
  return Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

/**
 * Start a new span. Returns the span and a function to end it.
 */
export function startSpan(
  name: string,
  attributes?: SpanAttributes,
  parentSpan?: Span | null,
): { span: Span; end: (error?: Error) => void } {
  // sampleRate applies to root spans; children follow their parent's decision
  // (a child only exists if its parent was recorded).
  const rate = currentConfig.sampleRate ?? 1;
  const sampled = parentSpan ? parentSpan.spanId !== '' : rate >= 1 || Math.random() < rate;
  if (!isTracingEnabled() || !sampled) {
    const noopSpan: Span = {
      name,
      startTime: 0,
      endTime: 0,
      attributes: {},
      status: 'unset',
      spanId: '',
      traceId: '',
    };
    return { span: noopSpan, end: () => {} };
  }

  const traceId = parentSpan?.traceId ?? generateId(32);
  const spanId = generateId(16);

  const span: Span = {
    name,
    startTime: Date.now(),
    endTime: 0,
    attributes: {
      'service.name': currentConfig.serviceName ?? 'pledgestack-app',
      ...attributes,
    },
    status: 'unset',
    spanId,
    traceId,
    parentSpanId: parentSpan?.spanId,
  };

  const previousSpan = activeSpan();
  spanStore.enterWith(span);

  return {
    span,
    end: (error?: Error) => {
      span.endTime = Date.now();
      if (error) {
        span.status = 'error';
        span.errorMessage = error.message;
        span.attributes['error'] = true;
        span.attributes['error.message'] = error.message;
        span.attributes['error.stack'] = error.stack ?? '';
      } else {
        span.status = 'ok';
      }
      spans.push(span);
      if (spans.length > MAX_BUFFERED_SPANS) spans.splice(0, spans.length - MAX_BUFFERED_SPANS);
      spanStore.enterWith(previousSpan);
    },
  };
}

/**
 * Get the current active span.
 */
export function getCurrentSpan(): Span | null {
  return activeSpan();
}

/**
 * Add an attribute to the current span.
 */
export function setSpanAttribute(key: string, value: string | number | boolean): void {
  const currentSpan = activeSpan();
  if (currentSpan) {
    currentSpan.attributes[key] = value;
  }
}

/**
 * Record an error on the current span.
 */
export function recordError(error: Error): void {
  const currentSpan = activeSpan();
  if (currentSpan) {
    currentSpan.status = 'error';
    currentSpan.errorMessage = error.message;
    currentSpan.attributes['error'] = true;
    currentSpan.attributes['error.message'] = error.message;
    currentSpan.attributes['error.stack'] = error.stack ?? '';
  }
}

/**
 * Create HTTP request span attributes from a request.
 */
export function httpRequestAttributes(
  method: string,
  url: string,
  status: number,
  durationMs: number,
): SpanAttributes {
  const parsed = new URL(url, 'http://localhost');
  return {
    'http.method': method,
    'http.url': url,
    'http.host': parsed.host,
    'http.scheme': parsed.protocol.replace(':', ''),
    'http.target': parsed.pathname,
    'http.status_code': status,
    'http.duration_ms': durationMs,
    'http.route': parsed.pathname,
  };
}

/**
 * Flush all collected spans to the configured exporter.
 */
export async function flushTraces(): Promise<void> {
  if (!isTracingEnabled() || spans.length === 0) return;

  const toExport = [...spans];
  spans = [];

  const exporter = currentConfig.exporter ?? 'none';

  if (exporter === 'console') {
    for (const span of toExport) {
      const duration = span.endTime - span.startTime;
      console.log(`[trace] ${span.name} ${duration}ms ${span.status}${span.errorMessage ? ' — ' + span.errorMessage : ''}`);
    }
  } else if (exporter === 'otlp' && currentConfig.endpoint) {
    try {
      const response = await fetch(currentConfig.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // A hung collector must not pin the request that triggered the flush.
        signal: AbortSignal.timeout(5000),
        body: JSON.stringify({
          resourceSpans: [{
            resource: {
              // service.name must be a *resource* attribute — backends group
              // and label services by it (span attributes alone show up as
              // "unknown_service").
              attributes: Object.entries({
                'service.name': currentConfig.serviceName ?? 'pledgestack-app',
                ...currentConfig.attributes,
              }).map(([k, v]) => ({ key: k, value: { stringValue: v } })),
            },
            scopeSpans: [{
              spans: toExport.map((s) => ({
                traceId: s.traceId,
                spanId: s.spanId,
                parentSpanId: s.parentSpanId,
                name: s.name,
                startTimeUnixNano: String(s.startTime * 1_000_000),
                endTimeUnixNano: String(s.endTime * 1_000_000),
                attributes: Object.entries(s.attributes).map(([k, v]) => ({
                  key: k,
                  value: typeof v === 'string' ? { stringValue: v } : typeof v === 'number' ? { doubleValue: v } : { boolValue: v },
                })),
                status: {
                  code: s.status === 'error' ? 2 : s.status === 'ok' ? 1 : 0,
                  message: s.errorMessage,
                },
              })),
            }],
          }],
        }),
      });
      if (!response.ok) {
        console.error(`[pledgestack] Trace export rejected by ${currentConfig.endpoint}: HTTP ${response.status}`);
      }
    } catch (err) {
      console.error('[pledgestack] Failed to export traces:', err);
    }
  }
}

/**
 * Get all collected spans (for testing/debugging).
 */
export function getSpans(): Span[] {
  return [...spans];
}

/**
 * Tracing middleware — wraps each request in a span.
 */
export function tracingMiddleware(config: TracingConfig) {
  initTracing(config);

  return {
    name: 'pledgestack-tracing',
    onRequest(req: { method: string; url: URL; headers: Record<string, string> }) {
      const { span, end } = startSpan(`HTTP ${req.method} ${req.url.pathname}`, {
        'http.method': req.method,
        'http.url': req.url.toString(),
      });

      return {
        span,
        endSpan: (status: number) => {
          const duration = Date.now() - span.startTime;
          setSpanAttribute('http.status_code', status);
          setSpanAttribute('http.duration_ms', duration);
          end();
          flushTraces();
        },
      };
    },
  };
}
