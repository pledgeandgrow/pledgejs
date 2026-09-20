import { describe, it, expect } from 'vitest';
import { createMetricsCollector, createMetricsMiddleware } from './metrics';

describe('Metrics (#8)', () => {
  it('creates a metrics collector', () => {
    const collector = createMetricsCollector();
    expect(collector).toBeDefined();
    expect(typeof collector.export).toBe('function');
    expect(typeof collector.json).toBe('function');
  });

  it('counts increments', () => {
    const collector = createMetricsCollector();
    collector.increment('test.counter');
    collector.increment('test.counter');
    const exported = collector.export();
    // Dots are not valid in Prometheus metric names — sanitized to underscores.
    expect(exported).toContain('test_counter 2');
  });

  it('records timings', () => {
    const collector = createMetricsCollector();
    collector.timing('test.duration', 100);
    collector.timing('test.duration', 200);
    const json = collector.json() as Record<string, unknown>;
    const timings = json.timings as Record<string, { count: number; sum: number; avg: number }>;
    expect(timings['test_duration'].count).toBe(2);
    expect(timings['test_duration'].sum).toBe(300);
    expect(timings['test_duration'].avg).toBe(150);
  });

  it('emits valid Prometheus exposition format', () => {
    const collector = createMetricsCollector();
    collector.increment('http.requests', { method: 'GET', path: '/users/:id' });
    const exported = collector.export();
    // Label values must be double-quoted — unquoted `method=GET` fails to parse.
    expect(exported).toContain('# TYPE http_requests counter');
    expect(exported).toContain('http_requests{method="GET",path="/users/:id"} 1');
  });

  it('escapes quotes, backslashes and newlines in label values', () => {
    const collector = createMetricsCollector();
    collector.increment('ev', { ua: 'a"b\\c\nd' });
    const exported = collector.export();
    expect(exported).toContain('ev{ua="a\\"b\\\\c\\nd"} 1');
  });

  it('sanitizes invalid metric and label names', () => {
    const collector = createMetricsCollector();
    collector.increment('9bad-name.metric', { 'la-bel': 'v' });
    const exported = collector.export();
    // Leading digit gets an underscore prefix; dashes/dots become underscores.
    expect(exported).toContain('_9bad_name_metric{la_bel="v"} 1');
  });

  it('places _sum/_count on the metric name, before the label set', () => {
    const collector = createMetricsCollector();
    collector.timing('req.dur', 50, { route: '/a' });
    const exported = collector.export();
    // `req_dur_sum{route="/a"}` — never `req_dur{route="/a"}_sum`.
    expect(exported).toContain('# TYPE req_dur summary');
    expect(exported).toContain('req_dur_sum{route="/a"} 50');
    expect(exported).toContain('req_dur_count{route="/a"} 1');
    expect(exported).not.toContain('}_sum');
    expect(exported).not.toContain('}_count');
  });

  it('creates metrics middleware', () => {
    const collector = createMetricsCollector();
    const middleware = createMetricsMiddleware(collector);
    expect(middleware).toBeDefined();
    expect(typeof middleware.requestStart).toBe('function');
    expect(typeof middleware.requestEnd).toBe('function');
  });

  it('middleware tracks request start and end', () => {
    const collector = createMetricsCollector();
    const middleware = createMetricsMiddleware(collector);
    const startTime = middleware.requestStart('GET', '/test');
    expect(typeof startTime).toBe('number');
    middleware.requestEnd('GET', '/test', 200, startTime);
    const exported = collector.export();
    expect(exported).toContain('http_requests_total');
    expect(exported).toContain('http_responses_total');
  });
});
