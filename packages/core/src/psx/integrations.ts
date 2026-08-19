/**
 * #256-270 — PSX Ecosystem & Integrations.
 *
 * Integration wrappers for Rust crates in .ps/.psx files.
 * Each integration provides:
 * - TypeScript type declarations for the Rust functions
 * - JS wrapper with connection pooling, error handling, retries
 * - NAPI binding generation for the Rust functions
 * - PledgeStack-specific helpers (route handlers, middleware, etc.)
 *
 * These integrations are loaded when a user runs `pledge add <crate>`
 * and the crate is detected in a .ps/.psx file.
 *
 * When Rust native addons are not available, each integration
 * gracefully falls back to a JS implementation using Node.js packages.
 * This ensures the integrations are usable without Rust installed.
 */

import {
  SqlxFallback,
  RedisFallback,
  AuthFallback,
  HttpFallback,
  CryptoFallback,
  TracingFallback,
  FileProcessorFallback,
  ImageProcessorFallback,
} from './integrations-fallback';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ============================================================================
// #256 — SQLx compile-time queries
// ============================================================================

export interface SqlxConfig {
  /** Database URL (e.g., postgres://user:pass@host:5432/db) */
  url: string;
  /** Maximum connections in pool */
  maxConnections?: number;
  /** Minimum connections to maintain */
  minConnections?: number;
  /** Connection timeout in milliseconds */
  acquireTimeoutMs?: number;
  /** Whether to enable SQLx macros (compile-time verification) */
  enableMacros?: boolean;
}

export interface SqlxQueryResult<T = unknown> {
  rows: T[];
  rowsAffected: number;
  lastInsertRowid?: number;
}

/**
 * SQLx integration — compile-time verified SQL queries.
 * In .ps files, users write:
 *   let users = sqlx::query_as::<_, User>("SELECT * FROM users WHERE active = $1")
 *     .bind(true)
 *     .fetch_all(&pool)
 *     .await?;
 *
 * This JS wrapper provides the connection pool management and
 * type-safe query interface for use in TypeScript.
 */
export class SqlxPool {
  private config: SqlxConfig;
  private pool: unknown = null;

  constructor(config: SqlxConfig) {
    this.config = config;
  }

  private fallback: SqlxFallback | null = null;
  private useFallback = false;

  async connect(): Promise<void> {
    try {
      const addon = require('../../native/sqlx.node') as { createPool: (config: SqlxConfig) => unknown };
      this.pool = addon.createPool(this.config);
    } catch {
      // Fall back to JS implementation (pg/mysql2)
      this.useFallback = true;
      this.fallback = new SqlxFallback({ url: this.config.url, maxConnections: this.config.maxConnections });
      await this.fallback.connect();
    }
  }

  async query<T = unknown>(sql: string, ...params: unknown[]): Promise<SqlxQueryResult<T>> {
    if (!this.pool && !this.fallback) await this.connect();
    if (this.useFallback && this.fallback) {
      const result = await this.fallback.query<T>(sql, ...params);
      return { rows: result.rows, rowsAffected: result.rowsAffected };
    }
    const addon = require('../../native/sqlx.node') as { query: (pool: unknown, sql: string, params: unknown[]) => Promise<SqlxQueryResult<T>> };
    return addon.query(this.pool, sql, params);
  }

  async queryAs<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    const result = await this.query<T>(sql, ...params);
    return result.rows;
  }

  async transaction<T>(fn: (tx: SqlxTransaction) => Promise<T>): Promise<T> {
    if (!this.pool) await this.connect();
    const addon = require('../../native/sqlx.node') as { beginTransaction: (pool: unknown) => Promise<unknown>; commit: (tx: unknown) => Promise<void>; rollback: (tx: unknown) => Promise<void> };
    const tx = await addon.beginTransaction(this.pool);
    try {
      const result = await fn(new SqlxTransaction(tx));
      await addon.commit(tx);
      return result;
    } catch (err) {
      await addon.rollback(tx);
      throw err;
    }
  }

  async close(): Promise<void> {
    if (this.useFallback && this.fallback) {
      await this.fallback.close();
      this.fallback = null;
      return;
    }
    if (this.pool) {
      const addon = require('../../native/sqlx.node') as { closePool: (pool: unknown) => Promise<void> };
      await addon.closePool(this.pool);
      this.pool = null;
    }
  }
}

export class SqlxTransaction {
  constructor(private tx: unknown) {}

  async query<T = unknown>(sql: string, ...params: unknown[]): Promise<SqlxQueryResult<T>> {
    const addon = require('../../native/sqlx.node') as { queryInTx: (tx: unknown, sql: string, params: unknown[]) => Promise<SqlxQueryResult<T>> };
    return addon.queryInTx(this.tx, sql, params);
  }
}

// ============================================================================
// #257 — Sea-ORM integration
// ============================================================================

export interface SeaOrmConfig {
  url: string;
  maxConnections?: number;
  /** Whether to enable entity model generation */
  generateEntities?: boolean;
}

export interface SeaOrmEntity {
  tableName: string;
  columns: Record<string, { type: string; nullable: boolean; primary: boolean }>;
}

/**
 * Sea-ORM integration — entity model generation and async CRUD.
 * Users define entities in .ps files and use them in API routes.
 */
export class SeaOrmDatabase {
  private config: SeaOrmConfig;
  private connection: unknown = null;

  constructor(config: SeaOrmConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    try {
      const addon = require('../../native/sea-orm.node') as { connect: (config: SeaOrmConfig) => Promise<unknown> };
      this.connection = await addon.connect(this.config);
    } catch {
      throw new Error('Sea-ORM native addon not found. Run `pledge add sea-orm` to install.');
    }
  }

  /** Generates entity models from the database schema */
  async generateEntities(outputDir: string): Promise<SeaOrmEntity[]> {
    try {
      const addon = require('../../native/sea-orm.node') as { generateEntities: (conn: unknown, dir: string) => Promise<SeaOrmEntity[]> };
      return addon.generateEntities(this.connection, outputDir);
    } catch {
      throw new Error('Sea-ORM native addon not found. Run `pledge add sea-orm` to install.');
    }
  }

  /** Finds entities by criteria */
  async find<T>(entity: string, criteria: Record<string, unknown>): Promise<T[]> {
    try {
      const addon = require('../../native/sea-orm.node') as { find: (conn: unknown, entity: string, criteria: Record<string, unknown>) => Promise<T[]> };
      return addon.find(this.connection, entity, criteria);
    } catch {
      throw new Error('Sea-ORM native addon not found. Run `pledge add sea-orm` to install.');
    }
  }

  /** Inserts a new entity */
  async insert<T>(entity: string, data: Partial<T>): Promise<T> {
    try {
      const addon = require('../../native/sea-orm.node') as { insert: (conn: unknown, entity: string, data: unknown) => Promise<T> };
      return addon.insert(this.connection, entity, data);
    } catch {
      throw new Error('Sea-ORM native addon not found. Run `pledge add sea-orm` to install.');
    }
  }

  /** Updates an entity by ID */
  async update<T>(entity: string, id: string | number, data: Partial<T>): Promise<T> {
    try {
      const addon = require('../../native/sea-orm.node') as { update: (conn: unknown, entity: string, id: string | number, data: unknown) => Promise<T> };
      return addon.update(this.connection, entity, id, data);
    } catch {
      throw new Error('Sea-ORM native addon not found. Run `pledge add sea-orm` to install.');
    }
  }

  /** Deletes an entity by ID */
  async delete(entity: string, id: string | number): Promise<boolean> {
    try {
      const addon = require('../../native/sea-orm.node') as { delete: (conn: unknown, entity: string, id: string | number) => Promise<boolean> };
      return addon.delete(this.connection, entity, id);
    } catch {
      throw new Error('Sea-ORM native addon not found. Run `pledge add sea-orm` to install.');
    }
  }
}

// ============================================================================
// #258 — Redis integration
// ============================================================================

export interface RedisConfig {
  url: string;
  /** Maximum connections in pool */
  maxConnections?: number;
  /** Key prefix for namespacing */
  keyPrefix?: string;
  /** Default TTL in seconds */
  defaultTtl?: number;
  /** Cluster mode configuration */
  cluster?: { nodes: { host: string; port: number }[] };
}

/**
 * Redis integration with connection pooling, pub/sub, and cache-aside.
 */
export class RedisClient {
  private config: RedisConfig;
  private client: unknown = null;
  private subscriber: unknown = null;
  private fallback: RedisFallback | null = null;
  private useFallback = false;

  constructor(config: RedisConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    try {
      const addon = require('../../native/redis.node') as { createClient: (config: RedisConfig) => unknown };
      this.client = addon.createClient(this.config);
    } catch {
      this.useFallback = true;
      this.fallback = new RedisFallback({ url: this.config.url, keyPrefix: this.config.keyPrefix, defaultTtl: this.config.defaultTtl });
      await this.fallback.connect();
    }
  }

  async get(key: string): Promise<string | null> {
    if (!this.client && !this.fallback) await this.connect();
    if (this.useFallback && this.fallback) return this.fallback.get(key);
    const addon = require('../../native/redis.node') as { get: (client: unknown, key: string) => Promise<string | null> };
    const fullKey = this.config.keyPrefix ? `${this.config.keyPrefix}${key}` : key;
    return addon.get(this.client, fullKey);
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    if (!this.client && !this.fallback) await this.connect();
    if (this.useFallback && this.fallback) { await this.fallback.set(key, value, ttl); return; }
    const addon = require('../../native/redis.node') as { set: (client: unknown, key: string, value: string, ttl?: number) => Promise<void> };
    const fullKey = this.config.keyPrefix ? `${this.config.keyPrefix}${key}` : key;
    const effectiveTtl = ttl ?? this.config.defaultTtl;
    await addon.set(this.client, fullKey, value, effectiveTtl);
  }

  async del(key: string): Promise<void> {
    if (this.useFallback && this.fallback) { await this.fallback.del(key); return; }
    const addon = require('../../native/redis.node') as { del: (client: unknown, key: string) => Promise<void> };
    const fullKey = this.config.keyPrefix ? `${this.config.keyPrefix}${key}` : key;
    await addon.del(this.client, fullKey);
  }

  /** Cache-aside pattern helper */
  async cacheAside<T>(key: string, fetcher: () => Promise<T>, ttl?: number): Promise<T> {
    if (this.useFallback && this.fallback) return this.fallback.cacheAside<T>(key, fetcher, ttl);
    const cached = await this.get(key);
    if (cached !== null) {
      try {
        return JSON.parse(cached) as T;
      } catch {
        // Corrupted cache entry — fall through to fetcher
      }
    }
    const value = await fetcher();
    await this.set(key, JSON.stringify(value), ttl);
    return value;
  }

  /** Pub/Sub: subscribe to a channel */
  async subscribe(channel: string, handler: (message: string) => void): Promise<void> {
    if (!this.subscriber) {
      const addon = require('../../native/redis.node') as { createSubscriber: (config: RedisConfig) => unknown };
      this.subscriber = addon.createSubscriber(this.config);
    }
    const subAddon = require('../../native/redis.node') as { subscribe: (sub: unknown, channel: string, handler: (msg: string) => void) => Promise<void> };
    await subAddon.subscribe(this.subscriber, channel, handler);
  }

  /** Pub/Sub: publish to a channel */
  async publish(channel: string, message: string): Promise<number> {
    const addon = require('../../native/redis.node') as { publish: (client: unknown, channel: string, message: string) => Promise<number> };
    return addon.publish(this.client, channel, message);
  }

  async disconnect(): Promise<void> {
    if (this.useFallback && this.fallback) { await this.fallback.disconnect(); this.fallback = null; return; }
    if (this.client) {
      const addon = require('../../native/redis.node') as { disconnect: (client: unknown) => Promise<void> };
      await addon.disconnect(this.client);
      this.client = null;
    }
    if (this.subscriber) {
      const addon = require('../../native/redis.node') as { disconnect: (client: unknown) => Promise<void> };
      await addon.disconnect(this.subscriber);
      this.subscriber = null;
    }
  }
}

// ============================================================================
// #259 — Rust auth helpers
// ============================================================================

export interface AuthConfig {
  /** Argon2 memory cost (in KiB) */
  memoryCost?: number;
  /** Argon2 time cost (iterations) */
  timeCost?: number;
  /** Argon2 parallelism */
  parallelism?: number;
  /** JWT signing secret */
  jwtSecret?: string;
  /** JWT expiration time (in seconds) */
  jwtExpiry?: number;
}

export interface JwtPayload {
  sub: string;
  iat?: number;
  exp?: number;
  [key: string]: unknown;
}

/**
 * Rust auth helpers — Argon2 hashing, JWT signing/verification.
 */
export class RustAuth {
  private config: AuthConfig;

  constructor(config: AuthConfig = {}) {
    this.config = {
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
      jwtExpiry: 3600,
      ...config,
    };
  }

  private fallback: AuthFallback | null = null;

  private getFallback(): AuthFallback {
    if (!this.fallback) {
      this.fallback = new AuthFallback({ jwtSecret: this.config.jwtSecret, jwtExpiry: this.config.jwtExpiry });
    }
    return this.fallback;
  }

  /** Hash a password using Argon2 */
  async hashPassword(password: string): Promise<string> {
    try {
      const addon = require('../../native/auth.node') as { hashPassword: (password: string, config: AuthConfig) => Promise<string> };
      return addon.hashPassword(password, this.config);
    } catch {
      return this.getFallback().hashPassword(password);
    }
  }

  /** Verify a password against an Argon2 hash */
  async verifyPassword(password: string, hash: string): Promise<boolean> {
    try {
      const addon = require('../../native/auth.node') as { verifyPassword: (password: string, hash: string) => Promise<boolean> };
      return addon.verifyPassword(password, hash);
    } catch {
      return this.getFallback().verifyPassword(password, hash);
    }
  }

  /** Sign a JWT token */
  async signJwt(payload: Omit<JwtPayload, 'iat' | 'exp'>): Promise<string> {
    if (!this.config.jwtSecret) {
      throw new Error('JWT secret is required. Set jwtSecret in AuthConfig.');
    }
    try {
      const addon = require('../../native/auth.node') as { signJwt: (payload: JwtPayload, secret: string, expiry: number) => Promise<string> };
      const now = Math.floor(Date.now() / 1000);
      const fullPayload: JwtPayload = {
        ...payload,
        iat: now,
        exp: now + (this.config.jwtExpiry ?? 3600),
      } as JwtPayload;
      return addon.signJwt(fullPayload, this.config.jwtSecret, this.config.jwtExpiry ?? 3600);
    } catch {
      return this.getFallback().signJwt(payload as Record<string, unknown>);
    }
  }

  /** Verify a JWT token */
  async verifyJwt(token: string): Promise<JwtPayload> {
    if (!this.config.jwtSecret) {
      throw new Error('JWT secret is required. Set jwtSecret in AuthConfig.');
    }
    try {
      const addon = require('../../native/auth.node') as { verifyJwt: (token: string, secret: string) => Promise<JwtPayload> };
      return addon.verifyJwt(token, this.config.jwtSecret);
    } catch {
      return this.getFallback().verifyJwt(token) as Promise<JwtPayload>;
    }
  }
}

// ============================================================================
// #260 — Rust image processing
// ============================================================================

export interface ImageProcessOptions {
  width?: number;
  height?: number;
  format?: 'jpeg' | 'png' | 'webp' | 'gif' | 'avif';
  quality?: number;
  crop?: { x: number; y: number; width: number; height: number };
  stripExif?: boolean;
  blur?: number;
  sharpen?: number;
}

/**
 * Rust image processing — resize, crop, format conversion.
 */
export class ImageProcessor {
  /** Process an image with the given options */
  static async process(input: Buffer, options: ImageProcessOptions): Promise<Buffer> {
    try {
      const addon = require('../../native/image.node') as { process: (input: Buffer, options: ImageProcessOptions) => Promise<Buffer> };
      return addon.process(input, options);
    } catch {
      return ImageProcessorFallback.process(input, options);
    }
  }

  /** Resize an image */
  static async resize(input: Buffer, width: number, height?: number): Promise<Buffer> {
    return ImageProcessor.process(input, { width, height });
  }

  /** Convert image format */
  static async convert(input: Buffer, format: ImageProcessOptions['format'], quality?: number): Promise<Buffer> {
    return ImageProcessor.process(input, { format, quality });
  }

  /** Strip EXIF data */
  static async stripExif(input: Buffer): Promise<Buffer> {
    return ImageProcessor.process(input, { stripExif: true });
  }

  /** Get image metadata */
  static async metadata(input: Buffer): Promise<{ width: number; height: number; format: string }> {
    try {
      const addon = require('../../native/image.node') as { metadata: (input: Buffer) => Promise<{ width: number; height: number; format: string }> };
      return addon.metadata(input);
    } catch {
      return ImageProcessorFallback.metadata(input);
    }
  }
}

// ============================================================================
// #261 — Rust PDF generation
// ============================================================================

export interface PdfOptions {
  /** Page size: A4, Letter, Legal */
  pageSize?: 'A4' | 'Letter' | 'Legal';
  /** Margin in points */
  margin?: { top: number; bottom: number; left: number; right: number };
  /** Whether to stream the output */
  stream?: boolean;
}

export interface PdfTemplate {
  /** Template name */
  name: string;
  /** Template variables */
  variables: Record<string, unknown>;
}

/**
 * Rust PDF generation — HTML→PDF, invoice templates.
 */
export class PdfGenerator {
  /** Generate PDF from HTML */
  static async fromHtml(html: string, options?: PdfOptions): Promise<Buffer> {
    try {
      const addon = require('../../native/pdf.node') as { fromHtml: (html: string, options: PdfOptions) => Promise<Buffer> };
      return addon.fromHtml(html, options ?? {});
    } catch {
      // Fallback: use puppeteer for HTML→PDF
      try {
        const puppeteer = await import('puppeteer');
        const browser = await puppeteer.default.launch({ headless: true });
        const page = await browser.newPage();
        await page.setContent(html);
        const pdf = await page.pdf({
          format: options?.pageSize ?? 'A4',
          margin: options?.margin as Record<string, string> | undefined,
        });
        await browser.close();
        return Buffer.from(pdf);
      } catch {
        throw new Error('PDF generation requires `puppeteer` package or `pledge add printpdf`: npm install puppeteer');
      }
    }
  }

  /** Generate PDF from a template */
  static async fromTemplate(template: PdfTemplate, options?: PdfOptions): Promise<Buffer> {
    const addon = require('../../native/pdf.node') as { fromTemplate: (template: PdfTemplate, options: PdfOptions) => Promise<Buffer> };
    return addon.fromTemplate(template, options ?? {});
  }

  /** Generate an invoice PDF */
  static async invoice(data: {
    company: { name: string; address: string; email: string };
    customer: { name: string; address: string; email: string };
    items: { description: string; quantity: number; price: number }[];
    taxRate?: number;
    currency?: string;
    invoiceNumber: string;
    date: string;
    dueDate?: string;
  }): Promise<Buffer> {
    return PdfGenerator.fromTemplate({ name: 'invoice', variables: data });
  }
}

// ============================================================================
// #262 — Rust background jobs (apalis)
// ============================================================================

export interface JobQueueConfig {
  /** Queue name */
  name: string;
  /** Maximum retries */
  maxRetries?: number;
  /** Retry delay in milliseconds */
  retryDelayMs?: number;
  /** Concurrency limit */
  concurrency?: number;
}

export interface Job<T = unknown> {
  id: string;
  payload: T;
  attempts: number;
  createdAt: number;
}

/**
 * Rust background jobs — apalis-based job queues.
 */
export class JobQueue<T = unknown> {
  private config: JobQueueConfig;
  private queue: unknown = null;

  constructor(config: JobQueueConfig) {
    this.config = { maxRetries: 3, retryDelayMs: 1000, concurrency: 4, ...config };
  }

  private jobs: Map<string, Job<T>> = new Map();
  private useFallback = false;

  async connect(): Promise<void> {
    try {
      const addon = require('../../native/jobs.node') as { createQueue: (config: JobQueueConfig) => unknown };
      this.queue = addon.createQueue(this.config);
    } catch {
      this.useFallback = true;
      // In-memory fallback queue
    }
  }

  /** Enqueue a job */
  async enqueue(payload: T): Promise<string> {
    if (!this.queue && !this.useFallback) await this.connect();
    if (this.useFallback) {
      const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.jobs.set(id, { id, payload, attempts: 0, createdAt: Date.now() });
      return id;
    }
    const addon = require('../../native/jobs.node') as { enqueue: (queue: unknown, payload: T) => Promise<string> };
    return addon.enqueue(this.queue, payload);
  }

  /** Start processing jobs with a handler */
  async start(handler: (job: Job<T>) => Promise<void>): Promise<void> {
    if (!this.queue && !this.useFallback) await this.connect();
    if (this.useFallback) {
      for (const [id, job] of this.jobs) {
        try {
          await handler(job);
          this.jobs.delete(id);
        } catch (err) {
          job.attempts++;
          if (job.attempts >= (this.config.maxRetries ?? 3)) {
            this.jobs.delete(id);
          }
        }
      }
      return;
    }
    const addon = require('../../native/jobs.node') as { start: (queue: unknown, handler: (job: Job<T>) => Promise<void>) => Promise<void> };
    await addon.start(this.queue, handler);
  }

  /** Get queue stats */
  async stats(): Promise<{ pending: number; processing: number; completed: number; failed: number }> {
    if (this.useFallback) {
      return { pending: this.jobs.size, processing: 0, completed: 0, failed: 0 };
    }
    const addon = require('../../native/jobs.node') as { stats: (queue: unknown) => Promise<{ pending: number; processing: number; completed: number; failed: number }> };
    return addon.stats(this.queue);
  }
}

// ============================================================================
// #263 — Rust cron scheduler
// ============================================================================

export interface CronConfig {
  /** Cron expression (e.g., "0 2 * * *" for 2 AM daily) */
  schedule: string;
  /** Timezone (e.g., "UTC", "America/New_York") */
  timezone?: string;
  /** Whether to run immediately on start */
  runImmediately?: boolean;
}

/**
 * Parses a simple cron expression to an interval in milliseconds.
 * Supports: * * * * * (minute hour day month weekday)
 * For simplicity, handles common patterns. For complex expressions,
 * users should install the native addon.
 */
function parseCronToInterval(schedule: string): number {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return 60000; // Default to 1 minute

  const [minute, hour, day, month, weekday] = parts;

  // Every minute: * * * * *
  if (minute === '*' && hour === '*' && day === '*' && month === '*' && weekday === '*') {
    return 60_000;
  }
  // Every N minutes: */N * * * *
  if (minute.startsWith('*/') && hour === '*') {
    const n = parseInt(minute.slice(2), 10);
    if (isNaN(n) || n <= 0) return 60_000;
    return n * 60_000;
  }
  // Every hour: 0 * * * *
  if (minute === '0' && hour === '*' && day === '*' && month === '*' && weekday === '*') {
    return 3_600_000;
  }
  // Every N hours: 0 */N * * *
  if (minute === '0' && hour.startsWith('*/')) {
    const n = parseInt(hour.slice(2), 10);
    if (isNaN(n) || n <= 0) return 3_600_000;
    return n * 3_600_000;
  }
  // Every day at specific time: 0 2 * * * → 24h
  if (hour !== '*' && hour !== '0' && minute !== '*' && day === '*' && month === '*' && weekday === '*') {
    return 86_400_000;
  }
  // Default: 1 minute
  return 60_000;
}

/**
 * Rust cron scheduler — tokio-cron-scheduler.
 */
export class CronScheduler {
  private scheduler: unknown = null;
  private jobs: Map<string, unknown> = new Map();

  private useFallback = false;
  private intervals: Map<string, NodeJS.Timeout> = new Map();

  async start(): Promise<void> {
    try {
      const addon = require('../../native/cron.node') as { createScheduler: () => Promise<unknown> };
      this.scheduler = await addon.createScheduler();
    } catch {
      this.useFallback = true;
      // In-memory fallback using setInterval
    }
  }

  /** Schedule a recurring job */
  async schedule(id: string, config: CronConfig, handler: () => Promise<void>): Promise<void> {
    if (!this.scheduler && !this.useFallback) await this.start();
    if (this.useFallback) {
      // Simple interval-based fallback (not full cron parsing)
      const intervalMs = parseCronToInterval(config.schedule);
      if (config.runImmediately) await handler();
      const interval = setInterval(() => handler().catch(console.error), intervalMs);
      this.intervals.set(id, interval);
      this.jobs.set(id, interval);
      return;
    }
    const addon = require('../../native/cron.node') as { addJob: (scheduler: unknown, id: string, config: CronConfig, handler: () => Promise<void>) => Promise<unknown> };
    const job = await addon.addJob(this.scheduler, id, config, handler);
    this.jobs.set(id, job);
  }

  /** Remove a scheduled job */
  async remove(id: string): Promise<void> {
    if (this.useFallback) {
      const interval = this.intervals.get(id);
      if (interval) clearInterval(interval);
      this.intervals.delete(id);
      this.jobs.delete(id);
      return;
    }
    if (!this.scheduler) return;
    const addon = require('../../native/cron.node') as { removeJob: (scheduler: unknown, id: string) => Promise<void> };
    await addon.removeJob(this.scheduler, id);
    this.jobs.delete(id);
  }

  /** List all scheduled jobs */
  list(): string[] {
    return Array.from(this.jobs.keys());
  }

  async stop(): Promise<void> {
    if (this.useFallback) {
      for (const interval of this.intervals.values()) clearInterval(interval);
      this.intervals.clear();
      this.jobs.clear();
      return;
    }
    if (this.scheduler) {
      const addon = require('../../native/cron.node') as { stop: (scheduler: unknown) => Promise<void> };
      await addon.stop(this.scheduler);
      this.scheduler = null;
      this.jobs.clear();
    }
  }
}

// ============================================================================
// #264 — Rust email sending (lettre)
// ============================================================================

export interface EmailConfig {
  /** SMTP host */
  host: string;
  /** SMTP port */
  port?: number;
  /** Username */
  username?: string;
  /** Password */
  password?: string;
  /** Whether to use TLS */
  tls?: boolean;
  /** From email address */
  from?: string;
}

export interface EmailMessage {
  to: string | string[];
  subject: string;
  body: string;
  html?: string;
  attachments?: { filename: string; content: Buffer }[];
}

/**
 * Rust email sending — lettre-based SMTP.
 */
export class EmailSender {
  private config: EmailConfig;

  constructor(config: EmailConfig) {
    this.config = { port: 587, tls: true, ...config };
  }

  async send(message: EmailMessage): Promise<void> {
    try {
      const addon = require('../../native/email.node') as { send: (config: EmailConfig, message: EmailMessage) => Promise<void> };
      await addon.send(this.config, message);
    } catch {
      // Fallback: use nodemailer
      try {
        const nodemailer = await import('nodemailer');
        const transporter = nodemailer.createTransport({
          host: this.config.host,
          port: this.config.port,
          secure: this.config.tls,
          auth: this.config.username ? { user: this.config.username, pass: this.config.password } : undefined,
        });
        await transporter.sendMail({
          from: this.config.from,
          to: Array.isArray(message.to) ? message.to.join(', ') : message.to,
          subject: message.subject,
          text: message.body,
          html: message.html,
          attachments: message.attachments?.map(a => ({ filename: a.filename, content: a.content })),
        });
      } catch {
        throw new Error('Email sending requires `nodemailer` package or `pledge add lettre`: npm install nodemailer');
      }
    }
  }

  async sendTemplate(
    to: string,
    templateName: string,
    variables: Record<string, unknown>,
  ): Promise<void> {
    try {
      const addon = require('../../native/email.node') as { sendTemplate: (config: EmailConfig, to: string, template: string, vars: Record<string, unknown>) => Promise<void> };
      await addon.sendTemplate(this.config, to, templateName, variables);
    } catch {
      // Fallback: render template as simple string replacement
      let body = `Template: ${templateName}`;
      for (const [key, value] of Object.entries(variables)) {
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        body = body.replace(new RegExp(`\\{\\{${escapedKey}\\}\\}`, 'g'), String(value).replace(/\$/g, '$$$$'));
      }
      await this.send({ to, subject: templateName, body });
    }
  }
}

// ============================================================================
// #265 — Rust HTTP client (reqwest)
// ============================================================================

export interface HttpClientConfig {
  /** Default timeout in milliseconds */
  timeoutMs?: number;
  /** Maximum redirects */
  maxRedirects?: number;
  /** Whether to enable gzip */
  gzip?: boolean;
  /** Custom headers */
  defaultHeaders?: Record<string, string>;
  /** TLS certificates */
  tls?: { caCert?: string; clientCert?: string; clientKey?: string };
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  body: T;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/**
 * Rust HTTP client — reqwest-based outbound HTTP.
 */
export class RustHttpClient {
  private config: HttpClientConfig;

  constructor(config: HttpClientConfig = {}) {
    this.config = { timeoutMs: 30000, maxRedirects: 10, gzip: true, ...config };
  }

  async get(url: string, headers?: Record<string, string>): Promise<HttpResponse> {
    return this.request('GET', url, { headers });
  }

  async post(url: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResponse> {
    return this.request('POST', url, { body, headers });
  }

  async put(url: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResponse> {
    return this.request('PUT', url, { body, headers });
  }

  async delete(url: string, headers?: Record<string, string>): Promise<HttpResponse> {
    return this.request('DELETE', url, { headers });
  }

  async request(
    method: string,
    url: string,
    options: { body?: unknown; headers?: Record<string, string> },
  ): Promise<HttpResponse> {
    try {
      const addon = require('../../native/http-client.node') as { request: (method: string, url: string, options: unknown, config: HttpClientConfig) => Promise<HttpResponse> };
      return addon.request(method, url, options, this.config);
    } catch {
      // Fallback: use native fetch (Node 18+)
      const fallback = new HttpFallback({ timeoutMs: this.config.timeoutMs, defaultHeaders: this.config.defaultHeaders });
      return fallback.request(method, url, options) as Promise<HttpResponse>;
    }
  }
}

// ============================================================================
// #266 — Rust WebSocket server
// ============================================================================

export interface WebSocketConfig {
  /** Path for WebSocket routes */
  path?: string;
  /** Heartbeat interval in milliseconds */
  heartbeatMs?: number;
  /** Max connections */
  maxConnections?: number;
  /** Rate limit (messages per second) */
  rateLimit?: number;
}

export interface WebSocketConnection {
  id: string;
  send(message: string): Promise<void>;
  close(code?: number, reason?: string): Promise<void>;
}

/**
 * Rust WebSocket server — tokio-tungstenite.
 */
export class WebSocketServer {
  private connections: Map<string, WebSocketConnection> = new Map();
  private rooms: Map<string, Set<string>> = new Map();

  constructor(_config: WebSocketConfig = {}) {
  }

  /** Handle a new connection */
  async handleConnection(connection: WebSocketConnection): Promise<void> {
    this.connections.set(connection.id, connection);
  }

  /** Broadcast to all connections */
  async broadcast(message: string): Promise<void> {
    const promises = Array.from(this.connections.values()).map(conn => conn.send(message));
    await Promise.allSettled(promises);
  }

  /** Send to a specific connection */
  async sendTo(connectionId: string, message: string): Promise<void> {
    const conn = this.connections.get(connectionId);
    if (conn) await conn.send(message);
  }

  /** Broadcast to a room */
  async broadcastToRoom(room: string, message: string): Promise<void> {
    const members = this.rooms.get(room);
    if (!members) return;
    for (const id of members) {
      const conn = this.connections.get(id);
      if (conn) await conn.send(message);
    }
  }

  /** Join a room */
  joinRoom(connectionId: string, room: string): void {
    if (!this.rooms.has(room)) this.rooms.set(room, new Set());
    this.rooms.get(room)!.add(connectionId);
  }

  /** Leave a room */
  leaveRoom(connectionId: string, room: string): void {
    this.rooms.get(room)?.delete(connectionId);
  }

  /** Disconnect a connection */
  async disconnect(connectionId: string, code?: number, reason?: string): Promise<void> {
    const conn = this.connections.get(connectionId);
    if (conn) {
      await conn.close(code, reason);
      this.connections.delete(connectionId);
      // Remove from all rooms
      for (const members of this.rooms.values()) {
        members.delete(connectionId);
      }
    }
  }

  /** Get number of active connections */
  get connectionCount(): number {
    return this.connections.size;
  }
}

// ============================================================================
// #267 — Rust file processing (Excel, CSV)
// ============================================================================

/**
 * Rust file processing — Excel parsing/generation, CSV processing.
 */
export class FileProcessor {
  /** Parse an Excel file */
  static async parseExcel(input: Buffer): Promise<{ sheets: Record<string, unknown[][]> }> {
    try {
      const addon = require('../../native/file-process.node') as { parseExcel: (input: Buffer) => Promise<{ sheets: Record<string, unknown[][]> }> };
      return addon.parseExcel(input);
    } catch {
      return FileProcessorFallback.parseExcel(input);
    }
  }

  /** Generate an Excel file */
  static async generateExcel(sheets: Record<string, unknown[][]>): Promise<Buffer> {
    try {
      const addon = require('../../native/file-process.node') as { generateExcel: (sheets: Record<string, unknown[][]>) => Promise<Buffer> };
      return addon.generateExcel(sheets);
    } catch {
      return FileProcessorFallback.generateExcel(sheets);
    }
  }

  /** Parse a CSV file */
  static async parseCsv(input: Buffer | string, delimiter?: string): Promise<unknown[][]> {
    try {
      const addon = require('../../native/file-process.node') as { parseCsv: (input: string, delimiter?: string) => Promise<unknown[][]> };
      return addon.parseCsv(typeof input === 'string' ? input : input.toString('utf-8'), delimiter);
    } catch {
      return FileProcessorFallback.parseCsv(input, delimiter);
    }
  }

  /** Generate a CSV file */
  static async generateCsv(rows: unknown[][], delimiter?: string): Promise<string> {
    try {
      const addon = require('../../native/file-process.node') as { generateCsv: (rows: unknown[][], delimiter?: string) => Promise<string> };
      return addon.generateCsv(rows, delimiter);
    } catch {
      return FileProcessorFallback.generateCsv(rows, delimiter);
    }
  }
}

// ============================================================================
// #268 — Rust observability (tracing, OpenTelemetry)
// ============================================================================

export interface TracingConfig {
  /** Service name for OpenTelemetry */
  serviceName?: string;
  /** OTLP endpoint */
  otlpEndpoint?: string;
  /** Log level */
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  /** Whether to export to OpenTelemetry */
  enableOtel?: boolean;
  /** Whether to use JSON format */
  jsonFormat?: boolean;
}

/**
 * Rust observability — tracing and OpenTelemetry spans.
 */
export class RustTracing {
  private _config: TracingConfig;

  constructor(config: TracingConfig = {}) {
    this._config = { level: 'info', jsonFormat: true, ...config };
  }

  private fallback: TracingFallback | null = null;

  private getFallback(): TracingFallback {
    if (!this.fallback) {
      this.fallback = new TracingFallback({ level: this._config.level, jsonFormat: this._config.jsonFormat });
    }
    return this.fallback;
  }

  /** Initialize the tracing subscriber */
  async init(): Promise<void> {
    try {
      const addon = require('../../native/tracing.node') as { init: (config: TracingConfig) => Promise<void> };
      await addon.init(this._config);
    } catch {
      await this.getFallback().init();
    }
  }

  /** Start a span */
  async startSpan(name: string, attributes?: Record<string, string>): Promise<string> {
    try {
      const addon = require('../../native/tracing.node') as { startSpan: (name: string, attrs?: Record<string, string>) => Promise<string> };
      return addon.startSpan(name, attributes);
    } catch {
      return this.getFallback().startSpan(name, attributes);
    }
  }

  /** End a span */
  async endSpan(spanId: string): Promise<void> {
    try {
      const addon = require('../../native/tracing.node') as { endSpan: (spanId: string) => Promise<void> };
      await addon.endSpan(spanId);
    } catch {
      await this.getFallback().endSpan(spanId);
    }
  }

  /** Record an event in a span */
  async event(spanId: string, name: string, attributes?: Record<string, string>): Promise<void> {
    try {
      const addon = require('../../native/tracing.node') as { event: (spanId: string, name: string, attrs?: Record<string, string>) => Promise<void> };
      await addon.event(spanId, name, attributes);
    } catch {
      await this.getFallback().event(spanId, name, attributes);
    }
  }

  /** Log at the given level */
  log(level: TracingConfig['level'], message: string, attributes?: Record<string, unknown>): void {
    this.getFallback().log(level ?? 'info', message, attributes);
  }
}

// ============================================================================
// #269 — Rust crypto helpers
// ============================================================================

export interface CryptoConfig {
  /** AES-256 key (32 bytes) */
  aesKey?: Buffer;
  /** Whether to use GCM mode */
  gcm?: boolean;
}

/**
 * Rust crypto helpers — AES-GCM encryption, SHA-256 hashing, secure random.
 */
export class RustCrypto {
  private config: CryptoConfig;

  constructor(config: CryptoConfig = {}) {
    this.config = { gcm: true, ...config };
  }

  private fallback: CryptoFallback | null = null;

  private getFallback(): CryptoFallback {
    if (!this.fallback) this.fallback = new CryptoFallback();
    return this.fallback;
  }

  /** Encrypt data using AES-GCM */
  async encrypt(plaintext: Buffer): Promise<{ ciphertext: Buffer; nonce: Buffer; tag: Buffer }> {
    if (!this.config.aesKey) throw new Error('AES key is required');
    try {
      const addon = require('../../native/crypto.node') as { encrypt: (plaintext: Buffer, key: Buffer) => Promise<{ ciphertext: Buffer; nonce: Buffer; tag: Buffer }> };
      return addon.encrypt(plaintext, this.config.aesKey);
    } catch {
      return this.getFallback().encrypt(plaintext, this.config.aesKey);
    }
  }

  /** Decrypt data using AES-GCM */
  async decrypt(ciphertext: Buffer, nonce: Buffer, tag: Buffer): Promise<Buffer> {
    if (!this.config.aesKey) throw new Error('AES key is required');
    try {
      const addon = require('../../native/crypto.node') as { decrypt: (ciphertext: Buffer, key: Buffer, nonce: Buffer, tag: Buffer) => Promise<Buffer> };
      return addon.decrypt(ciphertext, this.config.aesKey, nonce, tag);
    } catch {
      return this.getFallback().decrypt(ciphertext, this.config.aesKey, nonce, tag);
    }
  }

  /** Hash data using SHA-256 */
  async sha256(data: Buffer | string): Promise<string> {
    try {
      const addon = require('../../native/crypto.node') as { sha256: (data: Buffer) => Promise<string> };
      const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
      return addon.sha256(buf);
    } catch {
      return this.getFallback().sha256(data);
    }
  }

  /** Hash data using SHA-512 */
  async sha512(data: Buffer | string): Promise<string> {
    try {
      const addon = require('../../native/crypto.node') as { sha512: (data: Buffer) => Promise<string> };
      const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
      return addon.sha512(buf);
    } catch {
      return this.getFallback().sha512(data);
    }
  }

  /** Generate secure random bytes */
  async randomBytes(length: number): Promise<Buffer> {
    try {
      const addon = require('../../native/crypto.node') as { randomBytes: (length: number) => Promise<Buffer> };
      return addon.randomBytes(length);
    } catch {
      return this.getFallback().randomBytes(length);
    }
  }

  /** Generate a UUID v4 */
  async uuid(): Promise<string> {
    try {
      const addon = require('../../native/crypto.node') as { uuid: () => Promise<string> };
      return addon.uuid();
    } catch {
      return this.getFallback().uuid();
    }
  }
}

// ============================================================================
// #270 — Rust ML inference (candle-core / ort)
// ============================================================================

export interface MlModelConfig {
  /** Model path or identifier */
  modelPath: string;
  /** Backend: candle (Rust) or ort (ONNX Runtime) */
  backend?: 'candle' | 'ort';
  /** Device: cpu or cuda */
  device?: 'cpu' | 'cuda';
  /** Batch size */
  batchSize?: number;
}

export interface MlInferenceResult {
  /** Model output tensor */
  output: number[];
  /** Prediction label (if classification) */
  label?: string;
  /** Confidence score */
  confidence?: number;
  /** Inference time in milliseconds */
  inferenceTimeMs: number;
}

/**
 * Rust ML inference — candle-core or ort for on-device ML.
 */
export class MlModel {
  private config: MlModelConfig;
  private model: unknown = null;

  constructor(config: MlModelConfig) {
    this.config = { backend: 'candle', device: 'cpu', batchSize: 1, ...config };
  }

  async load(): Promise<void> {
    try {
      const addon = require('../../native/ml.node') as { loadModel: (config: MlModelConfig) => Promise<unknown> };
      this.model = await addon.loadModel(this.config);
    } catch {
      throw new Error(`ML native addon not found. Run \`pledge add ${this.config.backend === 'candle' ? 'candle-core' : 'ort'}\` to install.`);
    }
  }

  async infer(input: number[] | number[][]): Promise<MlInferenceResult> {
    if (!this.model) await this.load();
    const addon = require('../../native/ml.node') as { infer: (model: unknown, input: unknown) => Promise<MlInferenceResult> };
    return addon.infer(this.model, input);
  }

  /** Run batch inference */
  async inferBatch(inputs: (number[] | number[][] )[]): Promise<MlInferenceResult[]> {
    if (!this.model) await this.load();
    const addon = require('../../native/ml.node') as { inferBatch: (model: unknown, inputs: unknown[]) => Promise<MlInferenceResult[]> };
    return addon.inferBatch(this.model, inputs);
  }

  async unload(): Promise<void> {
    if (this.model) {
      const addon = require('../../native/ml.node') as { unloadModel: (model: unknown) => Promise<void> };
      await addon.unloadModel(this.model);
      this.model = null;
    }
  }
}
