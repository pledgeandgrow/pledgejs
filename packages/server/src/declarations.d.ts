declare module 'drizzle-orm/node-postgres' {
  export function drizzle(pool: unknown): unknown;
}

declare module 'drizzle-orm/mysql2' {
  export function drizzle(conn: unknown): unknown;
}

declare module 'drizzle-orm/better-sqlite3' {
  export function drizzle(db: unknown): unknown;
}

declare module 'pg' {
  export class Pool {
    constructor(config?: { connectionString?: string });
    connect(): Promise<unknown>;
    query(sql: string): Promise<{ rowCount: number }>;
    end(): Promise<void>;
  }
}

declare module 'mysql2/promise' {
  export function createConnection(url: string): Promise<{
    ping(): Promise<void>;
    end(): Promise<void>;
  }>;
  export function createPool(url: string): unknown;
}

declare module 'better-sqlite3' {
  const Database: {
    new (path: string): {
      prepare(sql: string): { get(): unknown };
      close(): void;
    };
  };
  export default Database;
}

declare module 'kysely' {
  export class Kysely<T = unknown> {
    constructor(opts: unknown);
    destroy(): Promise<void>;
    selectNoFrom(fn: unknown): Promise<unknown>;
  }
  export class PostgresDialect {
    constructor(opts: unknown);
  }
  export class MysqlDialect {
    constructor(opts: unknown);
  }
  export class SqliteDialect {
    constructor(opts: unknown);
  }
  export const sql: (strings: TemplateStringsArray, ...values: unknown[]) => { execute(db: unknown): Promise<unknown> };
}
