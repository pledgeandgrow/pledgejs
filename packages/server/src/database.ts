/**
 * Database adapters — integration helpers for Prisma, Drizzle, and Kysely.
 *
 * Provides a unified interface for connecting to databases in PledgeStack
 * applications. Each adapter wraps the ORM's client with request-scoped
 * lifecycle management and graceful shutdown support.
 */

export interface DatabaseAdapter<T = unknown> {
  /** The ORM client instance */
  client: T;
  /** Connect to the database */
  connect(): Promise<void>;
  /** Disconnect from the database */
  disconnect(): Promise<void>;
  /** Health check — returns true if the connection is healthy */
  healthCheck(): Promise<boolean>;
  /** Adapter name */
  name: string;
}

export interface PrismaAdapterOptions {
  /** Prisma client import path (e.g. '@prisma/client') */
  importPath?: string;
  /** Database URL (falls back to DATABASE_URL env var) */
  url?: string;
  /** Log levels */
  log?: ('query' | 'info' | 'warn' | 'error')[];
}

/**
 * Create a Prisma database adapter.
 *
 * Usage:
 *   const prisma = await createPrismaAdapter();
 *   const users = await prisma.client.user.findMany();
 */
export async function createPrismaAdapter(options?: PrismaAdapterOptions): Promise<DatabaseAdapter<unknown>> {
  const importPath = options?.importPath ?? '@prisma/client';
  const mod = await import(importPath) as { PrismaClient: new (opts?: { datasources?: { db?: { url?: string } }; log?: ('query' | 'info' | 'warn' | 'error')[] }) => unknown };

  const clientConfig: { datasources?: { db?: { url?: string } }; log?: ('query' | 'info' | 'warn' | 'error')[] } = {};

  const url = options?.url ?? process.env.DATABASE_URL;
  if (url) {
    clientConfig.datasources = { db: { url } };
  }
  if (options?.log) {
    clientConfig.log = options.log;
  }

  const client = new mod.PrismaClient(clientConfig);

  return {
    name: 'prisma',
    client,
    async connect() {
      await (client as { $connect: () => Promise<void> }).$connect();
    },
    async disconnect() {
      await (client as { $disconnect: () => Promise<void> }).$disconnect();
    },
    async healthCheck() {
      try {
        await (client as { $queryRawUnsafe: (sql: string) => Promise<unknown> }).$queryRawUnsafe('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },
  };
}

export interface DrizzleAdapterOptions {
  /** Drizzle client import path */
  importPath?: string;
  /** Database connection string */
  url?: string;
  /** Database type: 'postgres' | 'mysql' | 'sqlite' */
  type?: 'postgres' | 'mysql' | 'sqlite';
}

/**
 * Create a Drizzle database adapter.
 *
 * Usage:
 *   const drizzle = await createDrizzleAdapter({ type: 'postgres' });
 *   const results = await drizzle.client.select().from(users);
 */
export async function createDrizzleAdapter(options?: DrizzleAdapterOptions): Promise<DatabaseAdapter<unknown>> {
  const type = options?.type ?? 'postgres';
  const url = options?.url ?? process.env.DATABASE_URL;

  if (type === 'postgres') {
        const { drizzle } = await import('drizzle-orm/node-postgres');
        const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: url }) as any;
    const client = drizzle(pool);

    return {
      name: 'drizzle-postgres',
      client,
      async connect() {
        // Verify connectivity, then hand the connection straight back to the pool
        // (holding it forever leaked one pooled connection per connect()).
        const conn = await pool.connect();
        conn.release();
      },
      async disconnect() {
        await pool.end();
      },
      async healthCheck() {
        try {
          const res = await pool.query('SELECT 1');
          return res.rowCount === 1;
        } catch {
          return false;
        }
      },
    };
  }

  if (type === 'mysql') {
        const { drizzle } = await import('drizzle-orm/mysql2');
        const mysql = await import('mysql2/promise');
    const conn = await mysql.createConnection(url ?? '');
    const client = drizzle(conn);

    return {
      name: 'drizzle-mysql',
      client,
      async connect() {
        await conn.ping();
      },
      async disconnect() {
        await conn.end();
      },
      async healthCheck() {
        try {
          await conn.ping();
          return true;
        } catch {
          return false;
        }
      },
    };
  }

  // sqlite
    const { drizzle } = await import('drizzle-orm/better-sqlite3');
    const Database = (await import('better-sqlite3')).default;
  const db = new Database(url ?? ':memory:');
  const client = drizzle(db);

  return {
    name: 'drizzle-sqlite',
    client,
    async connect() {
      // SQLite opens on first query
    },
    async disconnect() {
      db.close();
    },
    async healthCheck() {
      try {
        db.prepare('SELECT 1').get();
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Runs `SELECT 1` through Kysely's `sql` tag — the query builder has no `eb.sql`. */
async function kyselyHealthy(client: unknown): Promise<boolean> {
  const { sql } = await import('kysely');
  await sql`SELECT 1`.execute(client as never);
  return true;
}

export interface KyselyAdapterOptions {
  /** Database connection string */
  url?: string;
  /** Database type: 'postgres' | 'mysql' | 'sqlite' */
  type?: 'postgres' | 'mysql' | 'sqlite';
}

/**
 * Create a Kysely database adapter.
 *
 * Usage:
 *   const kysely = await createKyselyAdapter({ type: 'postgres' });
 *   const results = await kysely.client.selectFrom('users').selectAll().execute();
 */
export async function createKyselyAdapter(options?: KyselyAdapterOptions): Promise<DatabaseAdapter<unknown>> {
  const type = options?.type ?? 'postgres';
  const url = options?.url ?? process.env.DATABASE_URL;

  if (type === 'postgres') {
        const { Kysely, PostgresDialect } = await import('kysely');
        const { Pool } = await import('pg');
    const client = new Kysely({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString: url }) }),
    });

    return {
      name: 'kysely-postgres',
      client,
      async connect() {
        // The pool connects lazily. (This used to call destroy(), tearing the
        // pool down the moment the app connected.)
      },
      async disconnect() {
        await (client as { destroy: () => Promise<void> }).destroy();
      },
      async healthCheck() {
        try {
          return await kyselyHealthy(client);
        } catch {
          return false;
        }
      },
    };
  }

  if (type === 'mysql') {
        const { Kysely, MysqlDialect } = await import('kysely');
        const mysql = await import('mysql2/promise');
    const client = new Kysely({
      dialect: new MysqlDialect({ pool: mysql.createPool(url ?? '') }),
    });

    return {
      name: 'kysely-mysql',
      client,
      async connect() {
        // Connection pool handles this
      },
      async disconnect() {
        await (client as { destroy: () => Promise<void> }).destroy();
      },
      async healthCheck() {
        try {
          return await kyselyHealthy(client);
        } catch {
          return false;
        }
      },
    };
  }

  // sqlite
    const { Kysely, SqliteDialect } = await import('kysely');
    const Database = (await import('better-sqlite3')).default;
  const client = new Kysely({
    dialect: new SqliteDialect({ database: new Database(url ?? ':memory:') }),
  });

  return {
    name: 'kysely-sqlite',
    client,
    async connect() {
      // SQLite opens on first query
    },
    async disconnect() {
      await (client as { destroy: () => Promise<void> }).destroy();
    },
    async healthCheck() {
      try {
        return await kyselyHealthy(client);
      } catch {
        return false;
      }
    },
  };
}

/**
 * Create a database adapter from a connection string.
 * Auto-detects the adapter type from the URL scheme.
 */
export async function createDatabaseAdapter(url?: string): Promise<DatabaseAdapter<unknown>> {
  const dbUrl = url ?? process.env.DATABASE_URL;

  if (!dbUrl) {
    throw new Error('No DATABASE_URL provided. Set DATABASE_URL env var or pass url option.');
  }

  if (dbUrl.startsWith('postgres://') || dbUrl.startsWith('postgresql://')) {
    return createPrismaAdapter({ url: dbUrl });
  }

  if (dbUrl.startsWith('mysql://')) {
    return createDrizzleAdapter({ url: dbUrl, type: 'mysql' });
  }

  if (dbUrl.startsWith('file:') || dbUrl.endsWith('.db') || dbUrl.endsWith('.sqlite')) {
    return createDrizzleAdapter({ url: dbUrl, type: 'sqlite' });
  }

  // Default to Prisma for unknown URL schemes
  return createPrismaAdapter({ url: dbUrl });
}
