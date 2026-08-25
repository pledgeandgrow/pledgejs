import { describe, it, expect } from 'vitest';
import { createMetricsCollector } from './metrics';
import { createHealthCheck } from './health';

describe('metrics Prometheus format (#50)', () => {
  it('places _sum/_count suffixes on the metric name, before the labels', () => {
    const c = createMetricsCollector();
    c.timing('http.request_duration_ms', 12, { method: 'GET', path: '/' });
    const out = c.export();
    // Correct: name_sum{labels}. Never name{labels}_sum.
    expect(out).toContain('http.request_duration_ms_sum{method=GET,path=/} 12');
    expect(out).toContain('http.request_duration_ms_count{method=GET,path=/} 1');
    expect(out).not.toMatch(/}_sum/);
    // _avg is not a valid summary component and must not be emitted.
    expect(out).not.toContain('_avg');
  });
});

describe('health tri-state (#49)', () => {
  it('reports degraded when some checks pass and some fail', async () => {
    const hc = createHealthCheck({ checks: { a: () => true, b: () => false } });
    const status = await hc.check();
    expect(status.status).toBe('degraded');
  });

  it('reports unhealthy when all checks fail', async () => {
    const hc = createHealthCheck({ checks: { a: () => false, b: () => false } });
    const status = await hc.check();
    expect(status.status).toBe('unhealthy');
  });

  it('reports healthy when all checks pass', async () => {
    const hc = createHealthCheck({ checks: { a: () => true } });
    const status = await hc.check();
    expect(status.status).toBe('healthy');
  });

  it('degraded status still returns a 200 from the handler', async () => {
    const hc = createHealthCheck({ checks: { a: () => true, b: () => false } });
    const res = await hc.handler();
    expect(res.status).toBe(200);
  });

  it('all-fail returns 503 from the handler', async () => {
    const hc = createHealthCheck({ checks: { a: () => false } });
    const res = await hc.handler();
    expect(res.status).toBe(503);
  });
});
