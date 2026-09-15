// @unconsumed — exported but not used in the request path. See REMAINING-ISSUES.md.

/**
 * #298 — PSX Monitoring Dashboard.
 *
 * Grafana dashboard template for PledgeStack + Rust: request rate,
 * NAPI call latency, cargo build time, addon memory, cache hit rate.
 *
 * Provides:
 * - Grafana dashboard JSON template
 * - Prometheus metrics endpoint
 * - Custom metric collectors
 * - Alert rule definitions
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DashboardConfig {
  /** Dashboard title */
  title: string;
  /** Datasource name (e.g., 'Prometheus') */
  datasource: string;
  /** Refresh interval (default: '10s') */
  refresh?: string;
  /** Time range (default: 'last 1h') */
  timeRange?: string;
  /** Whether to include Rust-specific panels */
  includeRustPanels?: boolean;
  /** Whether to include NAPI panels */
  includeNapiPanels?: boolean;
  /** Whether to include cache panels */
  includeCachePanels?: boolean;
}

export interface MetricCollector {
  name: string;
  help: string;
  type: 'counter' | 'gauge' | 'histogram';
  labels: string[];
  collect(): number | Record<string, number>;
}

// ---------------------------------------------------------------------------
// Grafana Dashboard Template
// ---------------------------------------------------------------------------

/**
 * Generates a Grafana dashboard JSON template for PledgeStack + Rust monitoring.
 */
export function generateGrafanaDashboard(config: DashboardConfig): string {
  const panels: unknown[] = [];
  let y = 0;

  // Request rate panel
  panels.push({
    id: 1,
    title: 'Request Rate',
    type: 'graph',
    datasource: config.datasource,
    gridPos: { x: 0, y, w: 12, h: 8 },
    targets: [{
      expr: 'rate(http_requests_total[5m])',
      legendFormat: '{{method}} {{route}}',
    }],
  });
  y += 8;

  // NAPI call latency
  if (config.includeNapiPanels !== false) {
    panels.push({
      id: 2,
      title: 'NAPI Call Latency (p50/p95/p99)',
      type: 'graph',
      datasource: config.datasource,
      gridPos: { x: 12, y: y - 8, w: 12, h: 8 },
      targets: [
        { expr: 'histogram_quantile(0.50, rate(napi_call_duration_bucket[5m]))', legendFormat: 'p50' },
        { expr: 'histogram_quantile(0.95, rate(napi_call_duration_bucket[5m]))', legendFormat: 'p95' },
        { expr: 'histogram_quantile(0.99, rate(napi_call_duration_bucket[5m]))', legendFormat: 'p99' },
      ],
    });

    panels.push({
      id: 3,
      title: 'NAPI Calls per Second',
      type: 'graph',
      datasource: config.datasource,
      gridPos: { x: 0, y, w: 12, h: 8 },
      targets: [{
        expr: 'rate(napi_calls_total[5m])',
        legendFormat: '{{function}}',
      }],
    });
    y += 8;
  }

  // Cargo build time
  if (config.includeRustPanels !== false) {
    panels.push({
      id: 4,
      title: 'Cargo Build Time',
      type: 'graph',
      datasource: config.datasource,
      gridPos: { x: 12, y: y - 8, w: 12, h: 8 },
      targets: [{
        expr: 'cargo_build_duration_seconds',
        legendFormat: '{{module}}',
      }],
    });

    panels.push({
      id: 5,
      title: 'Addon Memory Usage',
      type: 'graph',
      datasource: config.datasource,
      gridPos: { x: 0, y, w: 12, h: 8 },
      targets: [{
        expr: 'psx_memory_net_bytes',
        legendFormat: '{{module}}',
      }],
    });
    y += 8;

    panels.push({
      id: 6,
      title: 'Rust Function Call Frequency',
      type: 'heatmap',
      datasource: config.datasource,
      gridPos: { x: 12, y: y - 8, w: 12, h: 8 },
      targets: [{
        expr: 'rate(rust_function_calls_total[5m])',
        legendFormat: '{{function}}',
      }],
    });
  }

  // Cache hit rate
  if (config.includeCachePanels !== false) {
    panels.push({
      id: 7,
      title: 'Cache Hit Rate',
      type: 'gauge',
      datasource: config.datasource,
      gridPos: { x: 0, y, w: 8, h: 6 },
      targets: [{
        expr: 'rate(cache_hits_total[5m]) / (rate(cache_hits_total[5m]) + rate(cache_misses_total[5m])) * 100',
      },
      ],
      fieldConfig: {
        defaults: { min: 0, max: 100, unit: 'percent' },
      },
    });

    panels.push({
      id: 8,
      title: 'Cache Operations',
      type: 'graph',
      datasource: config.datasource,
      gridPos: { x: 8, y, w: 16, h: 6 },
      targets: [
        { expr: 'rate(cache_hits_total[5m])', legendFormat: 'hits' },
        { expr: 'rate(cache_misses_total[5m])', legendFormat: 'misses' },
        { expr: 'rate(cache_invalidations_total[5m])', legendFormat: 'invalidations' },
      ],
    });
    y += 6;
  }

  // Error rate
  panels.push({
    id: 9,
    title: 'Error Rate',
    type: 'graph',
    datasource: config.datasource,
    gridPos: { x: 0, y, w: 24, h: 6 },
    targets: [{
      expr: 'rate(http_requests_total{status=~"5.."}[5m]) / rate(http_requests_total[5m]) * 100',
      legendFormat: 'error %',
    }],
    fieldConfig: {
      defaults: { unit: 'percent' },
    },
  });

  const dashboard = {
    title: config.title,
    schemaVersion: 38,
    version: 1,
    refresh: config.refresh ?? '10s',
    time: { from: config.timeRange ?? 'now-1h', to: 'now' },
    panels,
    templating: {
      list: [{
        name: 'module',
        type: 'query',
        datasource: config.datasource,
        query: 'label_values(psx_memory_net_bytes, module)',
        refresh: 1,
      }],
    },
    alerts: generateAlertRules(),
  };

  return JSON.stringify(dashboard, null, 2);
}

/**
 * Generates alert rules for PledgeStack monitoring.
 */
export function generateAlertRules(): unknown[] {
  return [
    {
      name: 'HighErrorRate',
      message: 'Error rate > 5% for 5 minutes',
      conditions: [{
        type: 'query',
        query: { datasource: 'Prometheus', expr: 'rate(http_requests_total{status=~"5.."}[5m]) / rate(http_requests_total[5m]) * 100 > 5' },
        evaluator: { type: 'gt', params: [5] },
        for: '5m',
      }],
    },
    {
      name: 'HighNapiLatency',
      message: 'NAPI p95 latency > 100ms for 5 minutes',
      conditions: [{
        type: 'query',
        query: { datasource: 'Prometheus', expr: 'histogram_quantile(0.95, rate(napi_call_duration_bucket[5m])) > 0.1' },
        evaluator: { type: 'gt', params: [0.1] },
        for: '5m',
      }],
    },
    {
      name: 'LowCacheHitRate',
      message: 'Cache hit rate < 50% for 10 minutes',
      conditions: [{
        type: 'query',
        query: { datasource: 'Prometheus', expr: 'rate(cache_hits_total[10m]) / (rate(cache_hits_total[10m]) + rate(cache_misses_total[10m])) * 100 < 50' },
        evaluator: { type: 'lt', params: [50] },
        for: '10m',
      }],
    },
    {
      name: 'AddonMemoryLeak',
      message: 'Addon memory growing > 10MB in 30 minutes',
      conditions: [{
        type: 'query',
        query: { datasource: 'Prometheus', expr: 'deriv(psx_memory_net_bytes[30m]) > 100000' },
        evaluator: { type: 'gt', params: [100000] },
        for: '30m',
      }],
    },
  ];
}

// ---------------------------------------------------------------------------
// Prometheus Metrics Endpoint
// ---------------------------------------------------------------------------

/**
 * Generates Prometheus-format metrics for PSX monitoring.
 */
export function generatePrometheusMetrics(metrics: {
  requestCount?: number;
  errorCount?: number;
  napiCalls?: Record<string, { count: number; durationMs: number }>;
  memoryUsage?: Record<string, number>;
  cacheHits?: number;
  cacheMisses?: number;
  cacheInvalidations?: number;
  cargoBuildTime?: Record<string, number>;
}): string {
  const lines: string[] = [];

  // HTTP requests
  lines.push('# HELP http_requests_total Total HTTP requests');
  lines.push('# TYPE http_requests_total counter');
  if (metrics.requestCount !== undefined) {
    lines.push(`http_requests_total ${metrics.requestCount}`);
  }

  // Errors
  lines.push('# HELP http_errors_total Total HTTP errors');
  lines.push('# TYPE http_errors_total counter');
  if (metrics.errorCount !== undefined) {
    lines.push(`http_errors_total ${metrics.errorCount}`);
  }

  // NAPI calls
  lines.push('# HELP napi_calls_total Total NAPI calls');
  lines.push('# TYPE napi_calls_total counter');
  lines.push('# HELP napi_call_duration_seconds NAPI call duration');
  lines.push('# TYPE napi_call_duration_seconds histogram');
  if (metrics.napiCalls) {
    for (const [fn, data] of Object.entries(metrics.napiCalls)) {
      lines.push(`napi_calls_total{function="${fn}"} ${data.count}`);
      lines.push(`napi_call_duration_seconds{function="${fn}"} ${data.durationMs / 1000}`);
    }
  }

  // Memory
  lines.push('# HELP psx_memory_net_bytes Net memory usage per module');
  lines.push('# TYPE psx_memory_net_bytes gauge');
  if (metrics.memoryUsage) {
    for (const [module, bytes] of Object.entries(metrics.memoryUsage)) {
      lines.push(`psx_memory_net_bytes{module="${module}"} ${bytes}`);
    }
  }

  // Cache
  lines.push('# HELP cache_hits_total Cache hits');
  lines.push('# TYPE cache_hits_total counter');
  if (metrics.cacheHits !== undefined) {
    lines.push(`cache_hits_total ${metrics.cacheHits}`);
  }
  lines.push('# HELP cache_misses_total Cache misses');
  lines.push('# TYPE cache_misses_total counter');
  if (metrics.cacheMisses !== undefined) {
    lines.push(`cache_misses_total ${metrics.cacheMisses}`);
  }
  lines.push('# HELP cache_invalidations_total Cache invalidations');
  lines.push('# TYPE cache_invalidations_total counter');
  if (metrics.cacheInvalidations !== undefined) {
    lines.push(`cache_invalidations_total ${metrics.cacheInvalidations}`);
  }

  // Cargo build time
  lines.push('# HELP cargo_build_duration_seconds Cargo build duration');
  lines.push('# TYPE cargo_build_duration_seconds gauge');
  if (metrics.cargoBuildTime) {
    for (const [module, seconds] of Object.entries(metrics.cargoBuildTime)) {
      lines.push(`cargo_build_duration_seconds{module="${module}"} ${seconds}`);
    }
  }

  return lines.join('\n');
}
