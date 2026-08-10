import { describe, it, expect } from 'vitest';
import { createHealthCheck } from './health';

describe('Health Check (#7)', () => {
  it('returns healthy status when no checks fail', async () => {
    const health = createHealthCheck({ path: '/health' });
    const result = await health.handler();
    expect(result.status).toBe(200);
    const body = JSON.parse(result.body as string);
    expect(body.status).toBe('healthy');
  });

  it('returns unhealthy when a check fails', async () => {
    const health = createHealthCheck({
      path: '/health',
      checks: {
        database: async () => false,
      },
    });
    const result = await health.handler();
    expect(result.status).toBe(503);
    const body = JSON.parse(result.body as string);
    expect(body.status).toBe('unhealthy');
  });

  it('includes check details in response', async () => {
    const health = createHealthCheck({
      path: '/health',
      checks: {
        db: async () => true,
      },
    });
    const result = await health.handler();
    const body = JSON.parse(result.body as string);
    expect(body.checks).toBeDefined();
    expect(body.checks.db).toBe(true);
  });

  it('includes uptime info', async () => {
    const health = createHealthCheck({ path: '/health' });
    const result = await health.handler();
    const body = JSON.parse(result.body as string);
    expect(body.uptime).toBeDefined();
  });
});
