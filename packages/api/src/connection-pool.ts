/**
 * Database connection pooling.
 *
 * Provides:
 * - Configurable min/max connections with idle timeout
 * - Health checks on idle connections
 * - Graceful drain on shutdown
 * - Connection lifecycle management
 */

export interface ConnectionPoolConfig {
  /** Minimum connections to maintain (default: 2) */
  min?: number;
  /** Maximum connections (default: 10) */
  max?: number;
  /** Idle timeout in seconds before closing a connection (default: 30) */
  idleTimeout?: number;
  /** Connection timeout in seconds (default: 5) */
  acquireTimeout?: number;
  /** Health check interval in seconds (default: 60) */
  healthCheckInterval?: number;
  /** Whether to run health checks on idle connections */
  healthChecks?: boolean;
}

export interface PooledConnection<T> {
  connection: T;
  createdAt: number;
  lastUsedAt: number;
  inUse: boolean;
  healthy: boolean;
}

export interface ConnectionFactory<T> {
  create(): Promise<T>;
  destroy(connection: T): Promise<void>;
  validate(connection: T): Promise<boolean>;
}

const DEFAULT_MIN = 2;
const DEFAULT_MAX = 10;
const DEFAULT_IDLE_TIMEOUT = 30;
const DEFAULT_ACQUIRE_TIMEOUT = 5;
const DEFAULT_HEALTH_CHECK_INTERVAL = 60;

/**
 * Generic connection pool with configurable min/max, idle timeout,
 * health checks, and graceful drain.
 *
 * Usage:
 * ```typescript
 * const pool = new ConnectionPool({
 *   factory: {
 *     create: () => pg.connect(),
 *     destroy: (conn) => conn.end(),
 *     validate: (conn) => conn.query('SELECT 1').then(() => true).catch(() => false),
 *   },
 *   config: { min: 2, max: 20, idleTimeout: 60 },
 * });
 *
 * const conn = await pool.acquire();
 * try { await conn.query('SELECT * FROM users'); }
 * finally { await pool.release(conn); }
 *
 * await pool.drain(); // graceful shutdown
 * ```
 */
export class ConnectionPool<T> {
  private factory: ConnectionFactory<T>;
  private config: Required<ConnectionPoolConfig>;
  private pool: PooledConnection<T>[] = [];
  private waitQueue: Array<{ resolve: (conn: T) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  private healthCheckTimer?: ReturnType<typeof setInterval>;
  private draining = false;
  private drainWaiters: Array<() => void> = [];
  /** Connections currently being created (count toward `max` before they land in `pool`). */
  private creating = 0;
  private _totalAcquired = 0;
  private _totalReleased = 0;
  private _totalCreated = 0;
  private _totalDestroyed = 0;

  constructor(factory: ConnectionFactory<T>, config: ConnectionPoolConfig = {}) {
    this.factory = factory;
    this.config = {
      min: config.min ?? DEFAULT_MIN,
      max: config.max ?? DEFAULT_MAX,
      idleTimeout: config.idleTimeout ?? DEFAULT_IDLE_TIMEOUT,
      acquireTimeout: config.acquireTimeout ?? DEFAULT_ACQUIRE_TIMEOUT,
      healthCheckInterval: config.healthCheckInterval ?? DEFAULT_HEALTH_CHECK_INTERVAL,
      healthChecks: config.healthChecks ?? true,
    };
  }

  async initialize(): Promise<void> {
    for (let i = 0; i < this.config.min; i++) {
      await this.createConnection();
    }
    if (this.config.healthChecks) {
      this.healthCheckTimer = setInterval(() => {
        // A rejected factory.destroy/create must not become an unhandled rejection.
        this.runHealthChecks().catch(() => {});
      }, this.config.healthCheckInterval * 1000);
      // Don't keep the process alive just for health checks.
      (this.healthCheckTimer as { unref?: () => void }).unref?.();
    }
  }

  async acquire(): Promise<T> {
    if (this.draining) throw new Error('Pool is draining, cannot acquire new connections');

    const free = this.pool.find((c) => !c.inUse && c.healthy);
    if (free) {
      free.inUse = true;
      free.lastUsedAt = Date.now();
      this._totalAcquired++;
      return free.connection;
    }

    // Count in-flight creations so concurrent acquirers can't overshoot `max`.
    if (this.pool.length + this.creating < this.config.max) {
      // Created already marked in-use: after the await, `pool[length-1]` is not
      // necessarily this connection's entry when several creations overlap.
      const conn = await this.createConnection(true);
      this._totalAcquired++;
      return conn;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waitQueue.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.waitQueue.splice(idx, 1);
        reject(new Error(`Connection acquire timeout after ${this.config.acquireTimeout}s`));
      }, this.config.acquireTimeout * 1000);

      this.waitQueue.push({ resolve, reject, timer });
    });
  }

  async release(connection: T): Promise<void> {
    const entry = this.pool.find((c) => c.connection === connection);
    if (!entry) return;

    entry.inUse = false;
    entry.lastUsedAt = Date.now();
    this._totalReleased++;

    // Draining: the released connection is closed instead of being reused.
    if (this.draining) {
      await this.destroyEntry(entry).catch(() => {});
      return;
    }

    const waiter = this.waitQueue.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      entry.inUse = true;
      waiter.resolve(entry.connection);
    }
  }

  /**
   * Graceful shutdown: stops handing out connections, destroys idle ones
   * immediately, and WAITS for in-use connections to be released (each is
   * destroyed on release) so in-flight queries aren't cut off. After
   * `timeoutMs` (default 30s) any connection still checked out is destroyed
   * forcibly and drain resolves.
   */
  async drain(timeoutMs = 30_000): Promise<void> {
    this.draining = true;
    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);

    for (const waiter of this.waitQueue) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Pool is draining'));
    }
    this.waitQueue = [];

    // Idle connections go now; in-use ones are destroyed as they're released.
    await Promise.allSettled(
      this.pool.filter((e) => !e.inUse).map((e) => this.destroyEntry(e)),
    );

    if (this.pool.length > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        (timer as { unref?: () => void }).unref?.();
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        this.drainWaiters.push(done);
      });
    }

    // Timed out: force-close whatever is still checked out.
    await Promise.allSettled([...this.pool].map((e) => this.destroyEntry(e)));
    this.drainWaiters = [];
  }

  private async destroyEntry(entry: PooledConnection<T>): Promise<void> {
    if (!this.removeEntry(entry)) return;
    try {
      await this.factory.destroy(entry.connection);
    } finally {
      if (this.draining && this.pool.length === 0) {
        for (const w of this.drainWaiters) w();
      }
    }
  }

  getStats() {
    return {
      total: this.pool.length,
      inUse: this.pool.filter((c) => c.inUse).length,
      idle: this.pool.filter((c) => !c.inUse).length,
      waiting: this.waitQueue.length,
      totalAcquired: this._totalAcquired,
      totalReleased: this._totalReleased,
      totalCreated: this._totalCreated,
      totalDestroyed: this._totalDestroyed,
    };
  }

  isDraining(): boolean {
    return this.draining;
  }

  private async createConnection(inUse = false): Promise<T> {
    this.creating++;
    let connection: T;
    try {
      connection = await this.factory.create();
    } finally {
      this.creating--;
    }
    const entry: PooledConnection<T> = {
      connection,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      inUse,
      healthy: true,
    };
    this.pool.push(entry);
    this._totalCreated++;
    return connection;
  }

  private removeEntry(entry: PooledConnection<T>): boolean {
    // Indices captured before an await go stale (acquire/drain mutate the pool),
    // so always locate the entry again.
    const idx = this.pool.indexOf(entry);
    if (idx === -1) return false;
    this.pool.splice(idx, 1);
    this._totalDestroyed++;
    return true;
  }

  private async runHealthChecks(): Promise<void> {
    const now = Date.now();
    const idleTimeoutMs = this.config.idleTimeout * 1000;

    for (const entry of [...this.pool].reverse()) {
      if (!this.pool.includes(entry)) continue;

      if (!entry.inUse) {
        if (now - entry.lastUsedAt > idleTimeoutMs && this.pool.length > this.config.min) {
          if (this.removeEntry(entry)) await this.factory.destroy(entry.connection).catch(() => {});
          continue;
        }

        if (this.config.healthChecks) {
          try {
            entry.healthy = await this.factory.validate(entry.connection);
          } catch {
            entry.healthy = false;
          }

          // The entry may have been acquired while validate() was pending.
          if (!entry.healthy && !entry.inUse && this.removeEntry(entry)) {
            await this.factory.destroy(entry.connection).catch(() => {});
          }
        }
      }
    }

    while (this.pool.length < this.config.min && !this.draining) {
      await this.createConnection();
    }
  }
}
