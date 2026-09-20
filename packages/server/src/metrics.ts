export interface MetricsCollector {
  increment(name: string, tags?: Record<string, string>): void;
  gauge(name: string, value: number, tags?: Record<string, string>): void;
  timing(name: string, valueMs: number, tags?: Record<string, string>): void;
  histogram(name: string, value: number, tags?: Record<string, string>): void;
  export(): string;
  json(): Record<string, unknown>;
}

export function createMetricsCollector(): MetricsCollector {
  const counters = new Map<string, number>();
  const gauges = new Map<string, number>();
  const timings = new Map<string, number[]>();
  const histograms = new Map<string, number[]>();

  // Prometheus exposition format: metric and label names must match
  // [a-zA-Z_:][a-zA-Z0-9_:]* and label values must be double-quoted with
  // backslash/quote/newline escaping. Unquoted `k=v` pairs or dotted names
  // make the whole scrape unparseable.
  const sanitizeName = (n: string): string => {
    const s = n.replace(/[^a-zA-Z0-9_:]/g, '_');
    return /^[0-9]/.test(s) ? `_${s}` : s;
  };
  const quoteLabelValue = (v: string): string =>
    `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;

  function key(name: string, tags?: Record<string, string>): string {
    const safeName = sanitizeName(name);
    if (!tags) return safeName;
    const tagStr = Object.entries(tags)
      .map(([k, v]) => `${sanitizeName(k)}=${quoteLabelValue(v)}`)
      .join(',');
    return `${safeName}{${tagStr}}`;
  }

  return {
    increment(name, tags) {
      const k = key(name, tags);
      counters.set(k, (counters.get(k) ?? 0) + 1);
    },

    gauge(name, value, tags) {
      gauges.set(key(name, tags), value);
    },

    timing(name, valueMs, tags) {
      const k = key(name, tags);
      const arr = timings.get(k) ?? [];
      arr.push(valueMs);
      if (arr.length > 1000) arr.shift();
      timings.set(k, arr);
    },

    histogram(name, value, tags) {
      const k = key(name, tags);
      const arr = histograms.get(k) ?? [];
      arr.push(value);
      if (arr.length > 1000) arr.shift();
      histograms.set(k, arr);
    },

    export() {
      const lines: string[] = [];

      // A metric key is `name{labels}`. Prometheus requires the `_sum`/`_count`
      // suffix to attach to the metric NAME, before the label set — i.e.
      // `name_sum{labels}`, never `name{labels}_sum` (which the whole scrape
      // rejects). splitKey separates the two so suffixes are placed correctly.
      const splitKey = (k: string): { name: string; labels: string } => {
        const i = k.indexOf('{');
        return i === -1 ? { name: k, labels: '' } : { name: k.slice(0, i), labels: k.slice(i) };
      };

      for (const [k, v] of counters) {
        lines.push(`# TYPE ${splitKey(k).name} counter`);
        lines.push(`${k} ${v}`);
      }
      for (const [k, v] of gauges) {
        lines.push(`# TYPE ${splitKey(k).name} gauge`);
        lines.push(`${k} ${v}`);
      }
      for (const [k, arr] of timings) {
        const sum = arr.reduce((a, b) => a + b, 0);
        const { name, labels } = splitKey(k);
        // A Prometheus summary exposes `_sum` and `_count`. `_avg` is not a
        // valid summary component, so it is not emitted (compute avg from
        // sum/count on the query side, or via the json() output).
        lines.push(`# TYPE ${name} summary`);
        lines.push(`${name}_sum${labels} ${sum}`);
        lines.push(`${name}_count${labels} ${arr.length}`);
      }
      for (const [k, arr] of histograms) {
        const sum = arr.reduce((a, b) => a + b, 0);
        const { name, labels } = splitKey(k);
        lines.push(`# TYPE ${name} histogram`);
        lines.push(`${name}_sum${labels} ${sum}`);
        lines.push(`${name}_count${labels} ${arr.length}`);
      }

      return lines.join('\n');
    },

    json() {
      const result: Record<string, unknown> = {
        counters: Object.fromEntries(counters),
        gauges: Object.fromEntries(gauges),
      };

      const timingStats: Record<string, unknown> = {};
      for (const [k, arr] of timings) {
        const sum = arr.reduce((a, b) => a + b, 0);
        timingStats[k] = { count: arr.length, sum, avg: sum / arr.length, min: Math.min(...arr), max: Math.max(...arr) };
      }
      result.timings = timingStats;

      return result;
    },
  };
}

export function createMetricsMiddleware(collector: MetricsCollector) {
  return {
    name: 'pledgestack-metrics',
    configureServer() {
      collector.increment('server.started');
    },
    requestStart(method: string, path: string) {
      collector.increment('http.requests_total', { method, path: normalizePath(path) });
      return Date.now();
    },
    requestEnd(method: string, path: string, status: number, startTime: number) {
      const normPath = normalizePath(path);
      collector.timing('http.request_duration_ms', Date.now() - startTime, { method, path: normPath, status: String(status) });
      collector.increment('http.responses_total', { method, path: normPath, status: String(status) });
    },
  };
}

/**
 * Normalize a request path for use as a metrics label. Replaces dynamic
 * segments (numeric IDs, UUIDs) with `:param` placeholders so that
 * `/users/123` and `/users/456` collapse into a single `/users/:id` label.
 * Without this, high-cardinality paths cause unbounded label growth (#39).
 */
export function normalizePath(path: string): string {
  return path
    // UUIDs: /users/550e8400-e29b-41d4-a716-446655440000 → /users/:id
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    // Long hex strings (24-char Mongo ObjectIds, etc.): /assets/507f1f77bcf86cd799439011 → /assets/:id
    .replace(/\/[0-9a-f]{16,}/gi, '/:id')
    // Numeric IDs: /posts/123 → /posts/:id
    .replace(/\/\d+/g, '/:id');
}
