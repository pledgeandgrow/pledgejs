import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * API key rotation manager.
 *
 * Provides:
 * - Automatic API key rotation with configurable grace period
 * - Old key invalidation after grace period expires
 * - Notification callback when a key is used from a new IP
 * - Key versioning and history tracking
 */

export interface ApiKeyRecord {
  /** Key ID (public identifier) */
  keyId: string;
  /** Hashed key secret (never store plaintext) */
  keyHash: string;
  /** Key version (increments on rotation) */
  version: number;
  /** Whether this key is currently active */
  active: boolean;
  /** Created timestamp */
  createdAt: number;
  /** Last used timestamp */
  lastUsedAt: number | null;
  /** IPs that have used this key */
  knownIps: Set<string>;
  /** Expires at (for grace period of old keys) */
  expiresAt: number | null;
}

export interface ApiKeyRotationConfig {
  /** Secret for hashing keys */
  secret: string;
  /** Rotation interval in seconds (default: 90 days) */
  rotationInterval?: number;
  /** Grace period for old keys after rotation in seconds (default: 7 days) */
  gracePeriod?: number;
  /** Notification callback when key used from new IP */
  onNewIp?: (keyId: string, ip: string, timestamp: number) => void;
  /** Notification callback when key is rotated */
  onRotate?: (oldKeyId: string, newKeyId: string, timestamp: number) => void;
}

const DEFAULT_ROTATION_INTERVAL = 90 * 24 * 60 * 60;
const DEFAULT_GRACE_PERIOD = 7 * 24 * 60 * 60;

export interface ApiKeyPair {
  keyId: string;
  keySecret: string;
  fullKey: string;
}

/**
 * API key rotation manager.
 *
 * Usage:
 * ```typescript
 * const manager = new ApiKeyRotationManager({ secret: process.env.KEY_SECRET });
 *
 * // Create initial key
 * const key = manager.createKey();
 *
 * // Rotate (old key stays valid during grace period)
 * manager.rotate();
 *
 * // Validate an incoming key
 * const result = manager.validate(providedKey, clientIp);
 * ```
 */
export class ApiKeyRotationManager {
  private secret: string;
  private rotationInterval: number;
  private gracePeriod: number;
  private onNewIp?: (keyId: string, ip: string, timestamp: number) => void;
  private onRotate?: (oldKeyId: string, newKeyId: string, timestamp: number) => void;
  private keys: Map<string, ApiKeyRecord> = new Map();
  private activeKeyId: string | null = null;
  private lastRotation: number = 0;

  constructor(config: ApiKeyRotationConfig) {
    this.secret = config.secret;
    this.rotationInterval = config.rotationInterval ?? DEFAULT_ROTATION_INTERVAL;
    this.gracePeriod = config.gracePeriod ?? DEFAULT_GRACE_PERIOD;
    this.onNewIp = config.onNewIp;
    this.onRotate = config.onRotate;
  }

  /**
   * Generate a new API key pair.
   * Format: `pk_<keyId>.<keySecret>`
   */
  createKey(): ApiKeyPair {
    const keyId = `pk_${randomBytes(12).toString('hex')}`;
    const keySecret = randomBytes(32).toString('hex');
    const keyHash = this.hashKey(keySecret);
    const now = Date.now();

    const record: ApiKeyRecord = {
      keyId,
      keyHash,
      version: 1,
      active: true,
      createdAt: now,
      lastUsedAt: null,
      knownIps: new Set(),
      expiresAt: null,
    };

    this.keys.set(keyId, record);
    this.activeKeyId = keyId;
    this.lastRotation = now;

    return {
      keyId,
      keySecret,
      fullKey: `${keyId}.${keySecret}`,
    };
  }

  /**
   * Rotate the active API key.
   * The old key remains valid during the grace period.
   */
  rotate(): ApiKeyPair {
    const oldKeyId = this.activeKeyId;
    const now = Date.now();

    if (oldKeyId) {
      const oldKey = this.keys.get(oldKeyId);
      if (oldKey) {
        oldKey.active = false;
        oldKey.expiresAt = now + this.gracePeriod * 1000;
      }
    }

    const newKey = this.createKey();

    if (oldKeyId) {
      const newRecord = this.keys.get(newKey.keyId);
      if (newRecord && oldKeyId) {
        newRecord.version = (this.keys.get(oldKeyId)?.version ?? 0) + 1;
      }
      this.onRotate?.(oldKeyId, newKey.keyId, now);
    }

    this.lastRotation = now;
    return newKey;
  }

  /**
   * Validate a provided API key.
   * Returns the key record if valid, null otherwise.
   * Tracks IP usage and notifies on new IPs.
   */
  validate(fullKey: string, clientIp?: string): ApiKeyRecord | null {
    const parts = fullKey.split('.');
    if (parts.length !== 2) return null;

    const [keyId, keySecret] = parts;
    const record = this.keys.get(keyId);

    if (!record) return null;

    if (!record.active && record.expiresAt && Date.now() >= record.expiresAt) {
      this.keys.delete(keyId);
      return null;
    }

    const providedHash = this.hashKey(keySecret);
    const provBuf = Buffer.from(providedHash);
    const hashBuf = Buffer.from(record.keyHash);
    if (provBuf.length !== hashBuf.length) return null;
    if (!timingSafeEqual(provBuf, hashBuf)) {
      return null;
    }

    record.lastUsedAt = Date.now();

    if (clientIp) {
      if (!record.knownIps.has(clientIp)) {
        record.knownIps.add(clientIp);
        this.onNewIp?.(keyId, clientIp, Date.now());
      }
    }

    return record;
  }

  /**
   * Check if rotation is due.
   */
  needsRotation(): boolean {
    return Date.now() - this.lastRotation > this.rotationInterval * 1000;
  }

  /**
   * Invalidate a specific key immediately.
   */
  invalidate(keyId: string): boolean {
    const record = this.keys.get(keyId);
    if (!record) return false;
    record.active = false;
    record.expiresAt = Date.now();
    return true;
  }

  /**
   * Clean up expired keys past their grace period.
   */
  cleanup(): number {
    let removed = 0;
    const now = Date.now();
    for (const [keyId, record] of this.keys) {
      if (!record.active && record.expiresAt && now >= record.expiresAt) {
        this.keys.delete(keyId);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Get the active key ID.
   */
  getActiveKeyId(): string | null {
    return this.activeKeyId;
  }

  /**
   * Get all key records (for admin/audit purposes).
   */
  getAllKeys(): Array<Omit<ApiKeyRecord, 'knownIps'> & { knownIps: string[] }> {
    return [...this.keys.values()].map((r) => ({
      ...r,
      knownIps: [...r.knownIps],
    }));
  }

  /**
   * Get the next scheduled rotation time.
   */
  getNextRotation(): number {
    return this.lastRotation + this.rotationInterval * 1000;
  }

  private hashKey(keySecret: string): string {
    return createHmac('sha256', this.secret).update(keySecret).digest('hex');
  }
}

/**
 * Generate a standalone API key pair (without rotation management).
 */
export function generateApiKey(): ApiKeyPair {
  const keyId = `pk_${randomBytes(12).toString('hex')}`;
  const keySecret = randomBytes(32).toString('hex');
  return { keyId, keySecret, fullKey: `${keyId}.${keySecret}` };
}

/**
 * Hash an API key secret for storage.
 */
export function hashApiKey(keySecret: string, secret: string): string {
  return createHmac('sha256', secret).update(keySecret).digest('hex');
}

/**
 * Verify an API key against a stored hash.
 */
export function verifyApiKey(keySecret: string, storedHash: string, secret: string): boolean {
  const computed = hashApiKey(keySecret, secret);
  const compBuf = Buffer.from(computed);
  const hashBuf = Buffer.from(storedHash);
  if (compBuf.length !== hashBuf.length) return false;
  return timingSafeEqual(compBuf, hashBuf);
}
