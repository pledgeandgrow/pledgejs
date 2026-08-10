import type { Server, IncomingMessage, ServerResponse } from 'node:http';

export interface GracefulShutdownOptions {
  /** Timeout before forcing shutdown (default: 10000ms) */
  timeout?: number;
  /** Callbacks to run during shutdown */
  onShutdown?: Array<() => Promise<void> | void>;
  /** Logger function (default: console.log) */
  logger?: (msg: string) => void;
  /** Server instances to close */
  servers?: Server[];
}

/**
 * Tracks in-flight requests so graceful shutdown can wait for them to complete.
 */
class RequestTracker {
  private inflight = new Set<IncomingMessage>();
  private drainWaiters: Array<() => void> = [];

  track(req: IncomingMessage, res: ServerResponse): void {
    this.inflight.add(req);
    res.on('finish', () => {
      this.inflight.delete(req);
      if (this.inflight.size === 0) {
        for (const waiter of this.drainWaiters) waiter();
        this.drainWaiters = [];
      }
    });
    res.on('close', () => {
      this.inflight.delete(req);
      if (this.inflight.size === 0) {
        for (const waiter of this.drainWaiters) waiter();
        this.drainWaiters = [];
      }
    });
  }

  get count(): number {
    return this.inflight.size;
  }

  /** Returns a promise that resolves when all in-flight requests complete */
  waitForDrain(): Promise<void> {
    if (this.inflight.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }
}

export function setupGracefulShutdown(options: GracefulShutdownOptions = {}) {
  const {
    timeout = 10000,
    onShutdown = [],
    logger = (msg) => console.log(`[pledgestack] ${msg}`),
    servers = [],
  } = options;

  let shuttingDown = false;
  const tracker = new RequestTracker();

  /** Middleware to track in-flight requests. Call this for each request. */
  function trackRequest(req: IncomingMessage, res: ServerResponse): void {
    tracker.track(req, res);
  }

  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;

    logger(`Received ${signal}, starting graceful shutdown...`);

    const forceTimer = setTimeout(() => {
      logger('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, timeout);

    // Stop accepting new connections
    for (const server of servers) {
      server.close();
    }

    // Wait for in-flight requests to complete
    if (tracker.count > 0) {
      logger(`Waiting for ${tracker.count} in-flight request(s) to complete...`);
      await tracker.waitForDrain();
    }

    // Run shutdown hooks
    for (const fn of onShutdown) {
      try {
        await fn();
      } catch (err) {
        logger(`Shutdown hook failed: ${err}`);
      }
    }

    clearTimeout(forceTimer);
    logger('Graceful shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return { shutdown, isShuttingDown: () => shuttingDown, trackRequest, getInflightCount: () => tracker.count };
}
