/**
 * JS fallback implementations for PSX integrations.
 *
 * When Rust native addons are not available, these implementations
 * use Node.js packages to provide the same functionality.
 * This ensures integrations are usable without Rust installed.
 *
 * The fallbacks are automatically used when `require('../../native/*.node')` fails.
 */

import { createHash, randomBytes as nodeRandomBytes, createCipheriv, createDecipheriv, pbkdf2Sync, createHmac } from 'node:crypto';
import { Buffer } from 'node:buffer';

// ============================================================================
// SQLx fallback — uses pg (node-postgres) or mysql2
// ============================================================================

export class SqlxFallback {
  private pool: unknown = null;
  private config: { url: string; maxConnections?: number };

  constructor(config: { url: string; maxConnections?: number }) {
    this.config = config;
  }

  async connect(): Promise<void> {
    const url = this.config.url;
    if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
      const { Pool } = await import('pg');
      this.pool = new Pool({
        connectionString: url,
        max: this.config.maxConnections ?? 10,
      });
    } else if (url.startsWith('mysql://')) {
      const mysql = await import('mysql2/promise');
      this.pool = mysql.createPool({
        uri: url,
        connectionLimit: this.config.maxConnections ?? 10,
      });
    } else {
      throw new Error(`Unsupported database URL scheme: ${url.split('://')[0]}. Use postgres:// or mysql://`);
    }
  }

  async query<T = unknown>(sql: string, ...params: unknown[]): Promise<{ rows: T[]; rowsAffected: number }> {
    if (!this.pool) await this.connect();
    if (this.config.url.startsWith('postgres')) {
      const result = await (this.pool as { query: (sql: string, params: unknown[]) => Promise<{ rows: T[]; rowCount: number }> }).query(sql, params);
      return { rows: result.rows, rowsAffected: result.rowCount ?? 0 };
    } else {
      const [result] = await (this.pool as { execute: (sql: string, params: unknown[]) => Promise<[unknown[], unknown]> }).execute(sql, params);
      return { rows: result as T[], rowsAffected: 0 };
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      if (this.config.url.startsWith('postgres')) {
        await (this.pool as { end: () => Promise<void> }).end();
      } else {
        await (this.pool as { end: () => Promise<void> }).end();
      }
      this.pool = null;
    }
  }
}

// ============================================================================
// Redis fallback — uses ioredis or node-redis
// ============================================================================

export class RedisFallback {
  private client: unknown = null;
  private config: { url: string; keyPrefix?: string; defaultTtl?: number };

  constructor(config: { url: string; keyPrefix?: string; defaultTtl?: number }) {
    this.config = config;
  }

  async connect(): Promise<void> {
    try {
      const { createClient } = await import('redis');
      this.client = createClient({ url: this.config.url });
      await (this.client as { connect: () => Promise<void> }).connect();
    } catch {
      try {
        const IORedis = (await import('ioredis')).default;
        this.client = new IORedis(this.config.url);
      } catch {
        throw new Error('No Redis client found. Install `redis` or `ioredis`: npm install redis');
      }
    }
  }

  private key(k: string): string {
    return this.config.keyPrefix ? `${this.config.keyPrefix}${k}` : k;
  }

  async get(key: string): Promise<string | null> {
    if (!this.client) await this.connect();
    const c = this.client as { get: (k: string) => Promise<string | null> };
    return c.get(this.key(key));
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    if (!this.client) await this.connect();
    const c = this.client as { set: (k: string, v: string) => Promise<unknown>; setEx?: (k: string, t: number, v: string) => Promise<unknown>; expire?: (k: string, t: number) => Promise<unknown> };
    await c.set(this.key(key), value);
    const effectiveTtl = ttl ?? this.config.defaultTtl;
    if (effectiveTtl) {
      if (c.setEx) {
        await c.setEx(this.key(key), effectiveTtl, value);
      } else if (c.expire) {
        await c.expire(this.key(key), effectiveTtl);
      }
    }
  }

  async del(key: string): Promise<void> {
    if (!this.client) await this.connect();
    const c = this.client as { del: (k: string) => Promise<unknown> };
    await c.del(this.key(key));
  }

  async cacheAside<T>(key: string, fetcher: () => Promise<T>, ttl?: number): Promise<T> {
    const cached = await this.get(key);
    if (cached !== null) {
      return JSON.parse(cached) as T;
    }
    const value = await fetcher();
    await this.set(key, JSON.stringify(value), ttl);
    return value;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      const c = this.client as { disconnect?: () => void; quit?: () => Promise<void> };
      if (c.quit) await c.quit();
      else if (c.disconnect) c.disconnect();
      this.client = null;
    }
  }
}

// ============================================================================
// Auth fallback — uses node's crypto for Argon2 (bcrypt fallback) and jsonwebtoken
// ============================================================================

export class AuthFallback {
  private config: { jwtSecret?: string; jwtExpiry?: number };

  constructor(config: { jwtSecret?: string; jwtExpiry?: number } = {}) {
    this.config = { jwtExpiry: 3600, ...config };
  }

  async hashPassword(password: string): Promise<string> {
    try {
      const argon2 = await import('argon2');
      return argon2.hash(password);
    } catch {
      // Fallback to bcrypt
      try {
        const bcrypt = await import('bcryptjs');
        return bcrypt.hash(password, 12);
      } catch {
        // Last resort: PBKDF2 via node:crypto
        const salt = nodeRandomBytes(16);
        const derived = pbkdf2Sync(password, salt, 100000, 32, 'sha256');
        return `pbkdf2$${salt.toString('hex')}$${derived.toString('hex')}`;
      }
    }
  }

  async verifyPassword(password: string, hash: string): Promise<boolean> {
    try {
      const argon2 = await import('argon2');
      return argon2.verify(hash, password);
    } catch {
      try {
        const bcrypt = await import('bcryptjs');
        return bcrypt.compare(password, hash);
      } catch {
        if (hash.startsWith('pbkdf2$')) {
          const [, saltHex, expectedHash] = hash.split('$');
          const salt = Buffer.from(saltHex, 'hex');
          const derived = pbkdf2Sync(password, salt, 100000, 32, 'sha256');
          return derived.toString('hex') === expectedHash;
        }
        return false;
      }
    }
  }

  async signJwt(payload: Record<string, unknown>): Promise<string> {
    if (!this.config.jwtSecret) throw new Error('JWT secret required');
    try {
      const jwt = await import('jsonwebtoken');
      return jwt.sign(payload, this.config.jwtSecret, { expiresIn: this.config.jwtExpiry });
    } catch {
      // Pure JS fallback: HMAC-SHA256 JWT (HS256)
      const header = { alg: 'HS256', typ: 'JWT' };
      const now = Math.floor(Date.now() / 1000);
      const fullPayload = {
        ...payload,
        iat: now,
        exp: now + (this.config.jwtExpiry ?? 3600),
      };
      const encHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
      const encPayload = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');
      const data = `${encHeader}.${encPayload}`;
      const sig = createHmac('sha256', this.config.jwtSecret).update(data).digest('base64url');
      return `${data}.${sig}`;
    }
  }

  async verifyJwt(token: string): Promise<Record<string, unknown>> {
    if (!this.config.jwtSecret) throw new Error('JWT secret required');
    try {
      const jwt = await import('jsonwebtoken');
      return jwt.verify(token, this.config.jwtSecret) as Record<string, unknown>;
    } catch {
      // Pure JS fallback: verify HS256 JWT
      const parts = token.split('.');
      if (parts.length !== 3) throw new Error('Invalid JWT format');
      const [encHeader, encPayload, sig] = parts;
      const data = `${encHeader}.${encPayload}`;
      const expectedSig = createHmac('sha256', this.config.jwtSecret).update(data).digest('base64url');
      if (sig !== expectedSig) throw new Error('Invalid JWT signature');
      const payload = JSON.parse(Buffer.from(encPayload, 'base64url').toString('utf-8'));
      if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
        throw new Error('JWT token expired');
      }
      return payload;
    }
  }
}

// ============================================================================
// HTTP client fallback — uses node:fetch (Node 18+) or undici
// ============================================================================

export class HttpFallback {
  private config: { timeoutMs?: number; defaultHeaders?: Record<string, string> };

  constructor(config: { timeoutMs?: number; defaultHeaders?: Record<string, string> } = {}) {
    this.config = config;
  }

  async request(method: string, url: string, options: { body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: Record<string, string>; body: unknown; text: () => Promise<string>; json: () => Promise<unknown> }> {
    const headers = { ...this.config.defaultHeaders, ...options.headers };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 30000);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      return {
        status: response.status,
        headers: responseHeaders,
        body: await response.text(),
        text: () => response.clone().text(),
        json: () => response.clone().json(),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ============================================================================
// Crypto fallback — uses node:crypto
// ============================================================================

export class CryptoFallback {
  async sha256(data: Buffer | string): Promise<string> {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    return createHash('sha256').update(buf).digest('hex');
  }

  async sha512(data: Buffer | string): Promise<string> {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    return createHash('sha512').update(buf).digest('hex');
  }

  async randomBytes(length: number): Promise<Buffer> {
    return nodeRandomBytes(length);
  }

  async uuid(): Promise<string> {
    return crypto.randomUUID();
  }

  async encrypt(plaintext: Buffer, key: Buffer): Promise<{ ciphertext: Buffer; nonce: Buffer; tag: Buffer }> {
    const nonce = nodeRandomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { ciphertext, nonce, tag };
  }

  async decrypt(ciphertext: Buffer, key: Buffer, nonce: Buffer, tag: Buffer): Promise<Buffer> {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}

// ============================================================================
// Tracing fallback — uses console
// ============================================================================

export class TracingFallback {
  private config: { level?: string; jsonFormat?: boolean };

  constructor(config: { level?: string; jsonFormat?: boolean } = {}) {
    this.config = { level: 'info', jsonFormat: true, ...config };
  }

  async init(): Promise<void> {
    // No-op — console is always available
  }

  async startSpan(_name: string, _attributes?: Record<string, string>): Promise<string> {
    return '';
  }

  async endSpan(_spanId: string): Promise<void> {
    // No-op
  }

  async event(_spanId: string, _name: string, _attributes?: Record<string, string>): Promise<void> {
    // No-op
  }

  log(level: string, message: string, attributes?: Record<string, unknown>): void {
    if (this.config.jsonFormat) {
      console.log(JSON.stringify({ level, msg: message, attrs: attributes, ts: Date.now() }));
    } else {
      console.log(`[${level.toUpperCase()}] ${message}`, attributes ?? '');
    }
  }
}

// ============================================================================
// File processing fallback — uses CSV/Excel JS libraries
// ============================================================================

export class FileProcessorFallback {
  static async parseCsv(input: Buffer | string, delimiter: string = ','): Promise<string[][]> {
    const text = typeof input === 'string' ? input : input.toString('utf-8');
    const rows: string[][] = [];
    let currentRow: string[] = [];
    let currentField = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            currentField += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          currentField += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === delimiter) {
          currentRow.push(currentField);
          currentField = '';
        } else if (ch === '\n') {
          currentRow.push(currentField);
          rows.push(currentRow);
          currentRow = [];
          currentField = '';
        } else if (ch !== '\r') {
          currentField += ch;
        }
      }
    }
    if (currentField || currentRow.length > 0) {
      currentRow.push(currentField);
      rows.push(currentRow);
    }
    return rows;
  }

  static async generateCsv(rows: unknown[][], delimiter: string = ','): Promise<string> {
    return rows.map(row =>
      row.map(cell => {
        const str = String(cell ?? '');
        if (str.includes(delimiter) || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      }).join(delimiter)
    ).join('\n');
  }

  static async parseExcel(_input: Buffer): Promise<{ sheets: Record<string, unknown[][]> }> {
    try {
      const XLSX = await import('xlsx');
      const workbook = XLSX.read(_input, { type: 'buffer' });
      const sheets: Record<string, unknown[][]> = {};
      for (const sheetName of workbook.SheetNames) {
        sheets[sheetName] = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });
      }
      return { sheets };
    } catch {
      throw new Error('Excel parsing requires `xlsx` package: npm install xlsx');
    }
  }

  static async generateExcel(sheets: Record<string, unknown[][]>): Promise<Buffer> {
    try {
      const XLSX = await import('xlsx');
      const workbook = XLSX.utils.book_new();
      for (const [name, rows] of Object.entries(sheets)) {
        const sheet = XLSX.utils.aoa_to_sheet(rows);
        XLSX.utils.book_append_sheet(workbook, sheet, name);
      }
      return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    } catch {
      throw new Error('Excel generation requires `xlsx` package: npm install xlsx');
    }
  }
}

// ============================================================================
// Image processing fallback — uses sharp
// ============================================================================

export class ImageProcessorFallback {
  static async process(input: Buffer, options: { width?: number; height?: number; format?: string; quality?: number; stripExif?: boolean }): Promise<Buffer> {
    try {
      const sharp = (await import('sharp')).default;
      let pipeline = sharp(input);

      if (options.width || options.height) {
        pipeline = pipeline.resize(options.width, options.height);
      }
      if (options.stripExif) {
        pipeline = pipeline.rotate().rotate(0);
      }
      if (options.format === 'jpeg') {
        pipeline = pipeline.jpeg({ quality: options.quality ?? 80 });
      } else if (options.format === 'png') {
        pipeline = pipeline.png();
      } else if (options.format === 'webp') {
        pipeline = pipeline.webp({ quality: options.quality ?? 80 });
      } else if (options.format === 'avif') {
        pipeline = pipeline.avif({ quality: options.quality ?? 50 });
      }
      return pipeline.toBuffer();
    } catch {
      throw new Error('Image processing requires `sharp` package: npm install sharp');
    }
  }

  static async metadata(input: Buffer): Promise<{ width: number; height: number; format: string }> {
    try {
      const sharp = (await import('sharp')).default;
      const meta = await sharp(input).metadata();
      return { width: meta.width ?? 0, height: meta.height ?? 0, format: meta.format ?? 'unknown' };
    } catch {
      throw new Error('Image processing requires `sharp` package: npm install sharp');
    }
  }
}
