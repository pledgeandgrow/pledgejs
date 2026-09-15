import type { Server } from 'node:http';

export interface HealthCheckOptions {
  /** Path for health check endpoint (default: '/health') */
  path?: string;
  /** Custom checks to run */
  checks?: Record<string, () => Promise<boolean> | boolean>;
  /** Include memory usage in response (default: true) */
  includeMemory?: boolean;
  /** Include uptime in response (default: true) */
  includeUptime?: boolean;
}

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime?: number;
  memory?: { rss: number; heapUsed: number; heapTotal: number };
  checks: Record<string, boolean>;
}

export function createHealthCheck(options: HealthCheckOptions = {}) {
  const {
    path: _path = '/health',
    checks = {},
    includeMemory = true,
    includeUptime = true,
  } = options;

  const startTime = Date.now();

  async function check(): Promise<HealthStatus> {
    const results: Record<string, boolean> = {};

    for (const [name, fn] of Object.entries(checks)) {
      try {
        results[name] = await fn();
      } catch {
        results[name] = false;
      }
    }

    // Tri-state: all pass → healthy; all fail → unhealthy; a mix → degraded.
    // (Previously `anyUnhealthy` was the exact negation of `allHealthy`, so the
    // `degraded` branch could never be reached.)
    const values = Object.values(results);
    const passed = values.filter((v) => v).length;
    const status: HealthStatus['status'] =
      values.length === 0 || passed === values.length
        ? 'healthy'
        : passed === 0
          ? 'unhealthy'
          : 'degraded';

    return {
      status,
      timestamp: new Date().toISOString(),
      ...(includeUptime && { uptime: Math.floor((Date.now() - startTime) / 1000) }),
      ...(includeMemory && process.memoryUsage && {
        memory: {
          rss: process.memoryUsage().rss,
          heapUsed: process.memoryUsage().heapUsed,
          heapTotal: process.memoryUsage().heapTotal,
        },
      }),
      checks: results,
    };
  }

  return {
    check,
    handler: async () => {
      const status = await check();
      return {
        // 200 for healthy AND degraded (the instance can still serve
        // traffic); 503 only when all checks fail. Returning 503 for
        // degraded would cause load balancers to drain instances that
        // are partially healthy, defeating the tri-state design.
        status: status.status === 'unhealthy' ? 503 : 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(status, null, 2),
      };
    },
  };
}

export function attachHealthCheck(server: Server, options: HealthCheckOptions = {}) {
  const { path = '/health' } = options;
  const healthCheck = createHealthCheck(options);

  server.on('request', async (req, res) => {
    const url = req.url?.split('?')[0];
    // Only handle GET/HEAD on the health path, and never write if another
    // listener already responded — otherwise this second request listener
    // would double-write and throw ERR_HTTP_HEADERS_SENT.
    if (url === path && (req.method === 'GET' || req.method === 'HEAD') && !res.headersSent) {
      const result = await healthCheck.handler();
      if (res.headersSent) return;
      res.writeHead(result.status, result.headers);
      res.end(req.method === 'HEAD' ? undefined : result.body);
    }
  });

  return healthCheck;
}
