import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface AuditEntry {
  timestamp: string;
  action: string;
  userId?: string;
  ip?: string;
  method?: string;
  path?: string;
  status?: number;
  metadata?: Record<string, unknown>;
}

export interface AuditLoggerOptions {
  /** Log file path (default: '.pledge/audit.log') */
  filePath?: string;
  /** Also log to console (default: true in dev) */
  console?: boolean;
  /** Max file size before rotation in bytes (default: 10MB) */
  maxFileSize?: number;
  /** Rotated files to keep (`audit.log.1` … `audit.log.N`; default: 5). Older ones are deleted. */
  maxFiles?: number;
}

export class AuditLogger {
  private filePath: string;
  private logToConsole: boolean;
  private initialized = false;
  private maxFileSize: number;
  private maxFiles: number;
  /** Serializes writes so rotation can't interleave with appends. */
  private queue: Promise<void> = Promise.resolve();

  constructor(options: AuditLoggerOptions = {}) {
    this.filePath = options.filePath ?? '.pledge/audit.log';
    this.logToConsole = options.console ?? process.env.NODE_ENV !== 'production';
    this.maxFileSize = options.maxFileSize ?? 10 * 1024 * 1024;
    this.maxFiles = Math.max(1, options.maxFiles ?? 5);
  }

  async log(entry: Omit<AuditEntry, 'timestamp'>): Promise<void> {
    const fullEntry: AuditEntry = {
      timestamp: new Date().toISOString(),
      ...entry,
    };

    const line = JSON.stringify(fullEntry) + '\n';

    if (this.logToConsole) {
      console.log(`[audit] ${line.trim()}`);
    }

    const write = async () => {
      try {
        if (!this.initialized) {
          // dirname handles both '/' and Windows '\' separators.
          await mkdir(dirname(this.filePath), { recursive: true });
          this.initialized = true;
        }
        await this.rotateIfNeeded(Buffer.byteLength(line));
        await appendFile(this.filePath, line);
      } catch {
        /* ignore file errors */
      }
    };
    this.queue = this.queue.then(write, write);
    await this.queue;
  }

  /** Rotates audit.log -> audit.log.1 -> … once the next line would exceed maxFileSize. */
  private async rotateIfNeeded(incomingBytes: number): Promise<void> {
    let size: number;
    try {
      size = (await stat(this.filePath)).size;
    } catch {
      return; // no file yet
    }
    if (size === 0 || size + incomingBytes <= this.maxFileSize) return;
    await rm(`${this.filePath}.${this.maxFiles}`, { force: true });
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      await rename(`${this.filePath}.${i}`, `${this.filePath}.${i + 1}`).catch(() => undefined);
    }
    await rename(this.filePath, `${this.filePath}.1`);
  }

  async logServerAction(action: string, userId?: string, metadata?: Record<string, unknown>): Promise<void> {
    await this.log({ action: `server-action:${action}`, userId, metadata });
  }

  async logAuth(action: 'login' | 'logout' | 'failed' | 'signup', userId?: string, ip?: string): Promise<void> {
    await this.log({ action: `auth:${action}`, userId, ip });
  }

  async logRequest(method: string, path: string, status: number, userId?: string, ip?: string): Promise<void> {
    await this.log({ action: 'request', method, path, status, userId, ip });
  }
}

let defaultLogger: AuditLogger | null = null;

export function getDefaultAuditLogger(): AuditLogger {
  if (!defaultLogger) {
    defaultLogger = new AuditLogger();
  }
  return defaultLogger;
}
