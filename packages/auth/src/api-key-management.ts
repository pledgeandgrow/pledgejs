/**
 * API key management — scoped API keys with rate limits, rotation, and revocation.
 *
 * Provides:
 * - Scoped API key creation with permissions
 * - Rate limiting per key
 * - Key rotation with grace period
 * - Revocation and audit trail
 * - Key validation and lookup
 */

import { randomBytes } from 'node:crypto';
import { generateApiKey, hashApiKey, verifyApiKey } from './api-key';

export interface ApiKeyScope {
  /** Allowed routes or route patterns */
  routes?: string[];
  /** Allowed HTTP methods */
  methods?: string[];
  /** Allowed resources */
  resources?: string[];
  /** Custom permissions */
  permissions?: string[];
}

export interface ApiKeyRateLimit {
  /** Maximum requests per window */
  maxRequests: number;
  /** Window size in seconds */
  windowSeconds: number;
}

export interface ManagedApiKeyRecord {
  id: string;
  keyHash: string;
  name: string;
  userId: string;
  scopes: ApiKeyScope;
  rateLimit?: ApiKeyRateLimit;
  createdAt: number;
  lastUsedAt?: number;
  expiresAt?: number;
  revokedAt?: number;
  rotatedFrom?: string;
  usageCount: number;
  lastIp?: string;
}

export interface CreateApiKeyOptions {
  name: string;
  userId: string;
  scopes: ApiKeyScope;
  rateLimit?: ApiKeyRateLimit;
  expiresIn?: number;
}

export interface ApiKeyValidationResult {
  valid: boolean;
  key?: ManagedApiKeyRecord;
  reason?: string;
}

/**
 * API key manager — creation, validation, rotation, and revocation.
 */
export class ApiKeyManager {
  private keys: Map<string, ManagedApiKeyRecord> = new Map();
  private rateLimitState: Map<string, { count: number; windowStart: number }> = new Map();
  private hashSecret: string;

  constructor(hashSecret: string) {
    this.hashSecret = hashSecret;
  }

  /**
   * Create a new API key.
   * Returns the plaintext key (shown once) and the stored record.
   */
  create(options: CreateApiKeyOptions): { key: string; record: ManagedApiKeyRecord } {
    const pair = generateApiKey();
    const id = randomBytes(8).toString('hex');
    const keyHash = hashApiKey(pair.keySecret, this.hashSecret);

    const record: ManagedApiKeyRecord = {
      id,
      keyHash: keyHash,
      name: options.name,
      userId: options.userId,
      scopes: options.scopes,
      rateLimit: options.rateLimit,
      createdAt: Date.now(),
      expiresAt: options.expiresIn ? Date.now() + options.expiresIn * 1000 : undefined,
      usageCount: 0,
    };

    this.keys.set(id, record);
    return { key: pair.fullKey, record };
  }

  /**
   * Validate an API key and return the associated record.
   */
  validate(plaintextKey: string, ip?: string): ApiKeyValidationResult {
    const parts = plaintextKey.split('.');
    if (parts.length !== 2) return { valid: false, reason: 'Invalid key format' };
    const [, keySecret] = parts;

    for (const record of this.keys.values()) {
      if (record.revokedAt) continue;
      if (record.expiresAt && Date.now() > record.expiresAt) continue;

      if (verifyApiKey(keySecret, record.keyHash, this.hashSecret)) {
        if (record.rateLimit) {
          if (!this.checkRateLimit(record.id, record.rateLimit)) {
            return { valid: false, reason: 'Rate limit exceeded' };
          }
        }

        record.lastUsedAt = Date.now();
        record.usageCount++;
        if (ip) record.lastIp = ip;

        return { valid: true, key: record };
      }
    }

    return { valid: false, reason: 'Invalid API key' };
  }

  /**
   * Check if a key has access to a specific route and method — and, when the
   * key's scope restricts `resources` / `permissions`, to the named resource /
   * permission. A scope that lists resources or permissions is FAIL-CLOSED:
   * the caller must pass the resource/permission being accessed, otherwise
   * access is denied (previously these scope fields were silently ignored, so
   * a key limited to `resources: ['reports']` could touch anything the
   * route/method scopes allowed). `'*'` in a scope list grants all.
   */
  canAccess(
    record: ManagedApiKeyRecord,
    route: string,
    method: string,
    access: { resource?: string; permission?: string } = {},
  ): boolean {
    if (record.scopes.routes) {
      const hasRoute = record.scopes.routes.some((pattern) => matchRoute(pattern, route));
      if (!hasRoute) return false;
    }

    if (record.scopes.methods) {
      const hasMethod = record.scopes.methods.some(
        (m) => m.toUpperCase() === method.toUpperCase(),
      );
      if (!hasMethod) return false;
    }

    if (record.scopes.resources) {
      const { resource } = access;
      if (!resource || !record.scopes.resources.some((r) => r === '*' || r === resource)) return false;
    }

    if (record.scopes.permissions) {
      const { permission } = access;
      if (!permission || !record.scopes.permissions.some((p) => p === '*' || p === permission)) return false;
    }

    return true;
  }

  /**
   * Rotate an API key — creates a new key and marks the old one with a grace period.
   */
  rotate(keyId: string, gracePeriodSeconds = 3600): { key: string; record: ManagedApiKeyRecord } | null {
    const oldRecord = this.keys.get(keyId);
    if (!oldRecord || oldRecord.revokedAt) return null;

    const pair = generateApiKey();
    const newId = randomBytes(8).toString('hex');
    const keyHash = hashApiKey(pair.keySecret, this.hashSecret);

    const newRecord: ManagedApiKeyRecord = {
      ...oldRecord,
      id: newId,
      keyHash: keyHash,
      createdAt: Date.now(),
      rotatedFrom: keyId,
      usageCount: 0,
      lastUsedAt: undefined,
    };

    this.keys.set(newId, newRecord);

    oldRecord.expiresAt = Date.now() + gracePeriodSeconds * 1000;

    return { key: pair.fullKey, record: newRecord };
  }

  /**
   * Revoke an API key immediately.
   */
  revoke(keyId: string): boolean {
    const record = this.keys.get(keyId);
    if (!record) return false;
    record.revokedAt = Date.now();
    return true;
  }

  /**
   * Get all keys for a user.
   */
  getKeysForUser(userId: string): ManagedApiKeyRecord[] {
    return [...this.keys.values()].filter((r) => r.userId === userId);
  }

  /**
   * Get a key record by ID.
   */
  getKey(keyId: string): ManagedApiKeyRecord | undefined {
    return this.keys.get(keyId);
  }

  /**
   * Clean up expired and revoked keys.
   */
  cleanup(): number {
    let removed = 0;
    const now = Date.now();
    for (const [id, record] of this.keys) {
      if (record.revokedAt) {
        this.keys.delete(id);
        removed++;
      } else if (record.expiresAt && now > record.expiresAt) {
        this.keys.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Check rate limit for a key.
   */
  private checkRateLimit(keyId: string, limit: ApiKeyRateLimit): boolean {
    const now = Date.now();
    const state = this.rateLimitState.get(keyId);

    if (!state || now - state.windowStart > limit.windowSeconds * 1000) {
      this.rateLimitState.set(keyId, { count: 1, windowStart: now });
      return true;
    }

    state.count++;
    return state.count <= limit.maxRequests;
  }
}

/**
 * Match a route pattern against a route path.
 * Supports * as a wildcard.
 */
function matchRoute(pattern: string, route: string): boolean {
  if (pattern === route) return true;
  if (pattern === '*') return true;
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2);
    // Segment boundary: '/api/*' must not match '/apiary'.
    return route === prefix || route.startsWith(prefix + '/');
  }
  if (pattern.includes('*')) {
    const regex = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return regex.test(route);
  }
  return false;
}
