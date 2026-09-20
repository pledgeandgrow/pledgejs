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

// ── PSX integration optional fallback packages ────────────────────────
// These packages are dynamically imported by the JS fallbacks in
// packages/core/src/psx/integrations-fallback.ts (and integrations.ts).
// They are intentionally NOT declared as dependencies — see the
// "comment:optionalRuntimeDeps" note in packages/core/package.json.
// Ambient declarations here let the code typecheck whether or not the
// package is installed.

declare module 'redis' {
  export function createClient(opts?: { url?: string }): {
    connect(): Promise<void>;
    get(key: string): Promise<string | null>;
    set(key: string, value: string, opts?: unknown): Promise<unknown>;
    del(key: string): Promise<unknown>;
    quit(): Promise<void>;
    disconnect(): Promise<void>;
    on(event: string, cb: (err: unknown) => void): unknown;
  };
}

declare module 'ioredis' {
  const Redis: {
    new (url?: string, opts?: unknown): {
      get(key: string): Promise<string | null>;
      set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
      del(key: string): Promise<unknown>;
      quit(): Promise<void>;
      disconnect(): void;
      on(event: string, cb: (err: unknown) => void): unknown;
    };
  };
  export default Redis;
}

declare module 'argon2' {
  export function hash(password: string, opts?: unknown): Promise<string>;
  export function verify(hash: string, password: string): Promise<boolean>;
}

declare module 'bcryptjs' {
  export function hash(password: string, saltOrRounds?: number | string): Promise<string>;
  export function compare(password: string, hash: string): Promise<boolean>;
  export function genSalt(rounds?: number): Promise<string>;
}

declare module 'jsonwebtoken' {
  export function sign(payload: unknown, secret: string, opts?: unknown): string;
  export function verify(token: string, secret: string, opts?: unknown): unknown;
  export function decode(token: string, opts?: unknown): unknown;
}

declare module 'xlsx' {
  export function read(data: unknown, opts?: unknown): {
    SheetNames: string[];
    Sheets: Record<string, unknown>;
  };
  export const utils: {
    sheet_to_json(sheet: unknown, opts?: unknown): unknown[][];
    book_new(): unknown;
    aoa_to_sheet(rows: unknown[][]): unknown;
    book_append_sheet(book: unknown, sheet: unknown, name: string): void;
  };
  export function write(book: unknown, opts: { type: string }): unknown;
}

declare module 'sharp' {
  const sharp: {
    (input: unknown): {
      resize(w?: number, h?: number, opts?: unknown): unknown;
      toFormat(format: string, opts?: unknown): unknown;
      toBuffer(opts?: unknown): Promise<Buffer>;
      metadata(): Promise<{ width?: number; height?: number; format?: string }>;
      withMetadata(opts?: unknown): unknown;
      blur(sigma?: number): unknown;
      sharpen(opts?: unknown): unknown;
    };
  };
  export default sharp;
}

declare module 'puppeteer' {
  export function launch(opts?: { headless?: boolean | 'new' }): Promise<{
    newPage(): Promise<{
      setContent(html: string): Promise<void>;
      pdf(opts?: unknown): Promise<Uint8Array>;
      close(): Promise<void>;
    }>;
    close(): Promise<void>;
  }>;
  const puppeteer: { launch: typeof launch };
  export default puppeteer;
}

declare module 'nodemailer' {
  export function createTransport(opts: unknown): {
    sendMail(msg: {
      from?: string;
      to?: string;
      subject?: string;
      text?: string;
      html?: string;
      attachments?: { filename?: string; content?: unknown }[];
    }): Promise<unknown>;
  };
}
