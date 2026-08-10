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
    expect(exported).toContain('test.counter');
  });

  it('records timings', () => {
    const collector = createMetricsCollector();
    collector.timing('test.duration', 100);
    collector.timing('test.duration', 200);
    const json = collector.json() as Record<string, unknown>;
    const timings = json.timings as Record<string, { count: number; sum: number; avg: number }>;
    expect(timings['test.duration'].count).toBe(2);
    expect(timings['test.duration'].sum).toBe(300);
    expect(timings['test.duration'].avg).toBe(150);
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
    expect(exported).toContain('http.requests_total');
    expect(exported).toContain('http.responses_total');
  });
});
