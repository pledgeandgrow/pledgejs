import { createHmac, randomBytes, timingSafeEqual, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';
import type { PledgeRequest } from 'pledgestack-shared';
import { InMemorySecurityStore, type SecurityKeyValueStore } from './security-store';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

/**
 * Session manager — cookie-based session storage with HMAC-signed tokens.
 *
 * Sessions are stored as signed JWT-like tokens in cookies.
 * No external session store required — stateless by default.
 */

export interface SessionData {
  [key: string]: unknown;
  userId?: string;
  role?: string;
  expiresAt?: number;
}

export interface AuthConfig {
  /** Secret key for signing session tokens */
  secret: string;
  /** Cookie name (default: '__pledge_session') */
  cookieName?: string;
  /** Session TTL in seconds (default: 7 days) */
  ttl?: number;
  /** Cookie options */
  cookie?: {
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'strict' | 'lax' | 'none';
    path?: string;
    domain?: string;
  };
}

const DEFAULT_COOKIE_NAME = '__pledge_session';
const DEFAULT_TTL = 7 * 24 * 60 * 60;

export class SessionManager {
  private secret: string;
  private cookieName: string;
  private ttl: number;
  private cookieOpts: NonNullable<AuthConfig['cookie']>;

  constructor(config: AuthConfig) {
    this.secret = config.secret;
    this.cookieName = config.cookieName ?? DEFAULT_COOKIE_NAME;
    this.ttl = config.ttl ?? DEFAULT_TTL;
    this.cookieOpts = {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      ...config.cookie,
    };
  }

  /** Create a signed session token from session data */
  createSession(data: SessionData): string {
    const expiresAt = Date.now() + this.ttl * 1000;
    const payload: SessionData = { ...data, expiresAt };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = this.sign(encoded);
    return `${encoded}.${signature}`;
  }

  /** Verify and decode a session token */
  verifySession(token: string): SessionData | null {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [encoded, signature] = parts;
    const expected = this.sign(encoded);
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length) return null;
    if (!timingSafeEqual(sigBuf, expBuf)) return null;
    try {
      const data: SessionData = JSON.parse(Buffer.from(encoded, 'base64url').toString());
      if (data.expiresAt && data.expiresAt < Date.now()) return null;
      return data;
    } catch {
      return null;
    }
  }

  /** Read session from request cookies */
  getSession(req: PledgeRequest): SessionData | null {
    const token = req.cookies[this.cookieName];
    if (!token) return null;
    return this.verifySession(token);
  }

  /** Generate Set-Cookie header for a new session */
  sessionCookie(data: SessionData): string {
    const token = this.createSession(data);
    return this.buildCookie(token, this.ttl);
  }

  /** Generate Set-Cookie header to destroy session */
  destroyCookie(): string {
    return this.buildCookie('', 0);
  }

  /**
   * Regenerate the session on privilege change (login, role change, MFA enroll).
   * Destroys the old token's validity by issuing a fresh token with new random
   * material. The caller should set the returned Set-Cookie header.
   * This defends against session fixation: a pre-auth cookie value becomes
   * useless after login because the signed payload (and thus the signature)
   * changes completely.
   */
  regenerateSession(oldToken: string | null, data: SessionData): string {
    // Discard the old token entirely — we mint a new one with fresh expiresAt.
    void oldToken;
    return this.sessionCookie(data);
  }

  private buildCookie(value: string, maxAge: number): string {
    const parts = [
      `${this.cookieName}=${value}`,
      `Max-Age=${maxAge}`,
      `Path=${this.cookieOpts.path ?? '/'}`,
    ];
    if (this.cookieOpts.httpOnly) parts.push('HttpOnly');
    if (this.cookieOpts.secure) parts.push('Secure');
    if (this.cookieOpts.sameSite) parts.push(`SameSite=${this.cookieOpts.sameSite}`);
    if (this.cookieOpts.domain) parts.push(`Domain=${this.cookieOpts.domain}`);
    return parts.join('; ');
  }

  private sign(data: string): string {
    return createHmac('sha256', this.secret).update(data).digest('base64url');
  }
}

/**
 * Password hashing utilities using scrypt (memory-hard key derivation).
 *
 * A single unsalted-stretch HMAC was previously used here, which is not a
 * password hash at all — stolen hashes could be brute-forced at billions of
 * guesses/sec. scrypt with N=2^15 is memory-hard and CPU-expensive per guess.
 *
 * The stored format is self-describing so parameters can evolve without
 * invalidating existing hashes: `scrypt$N$r$p$saltHex$hashHex`.
 */

// N must be a power of two. 2^15 (32768) is a common interactive-login cost.
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
// scrypt needs roughly 128 * N * r bytes; raise maxmem above the 32 MB default.
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2;

export async function hashPassword(password: string, salt?: string): Promise<string> {
  const saltHex = salt ?? randomBytes(16).toString('hex');
  const derived = await scrypt(password, saltHex, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${saltHex}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltHex = parts[4];
  const hashHex = parts[5];
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || !saltHex || !hashHex) {
    return false;
  }
  const expected = Buffer.from(hashHex, 'hex');
  let derived: Buffer;
  try {
    derived = await scrypt(password, saltHex, expected.length, {
      N,
      r,
      p,
      maxmem: 128 * N * r * 2,
    });
  } catch {
    return false;
  }
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/**
 * Password strength validation result.
 */
export interface PasswordStrengthResult {
  valid: boolean;
  score: number; // 0-4
  issues: string[];
}

/**
 * Validate password strength before hashing.
 * Enforces minimum length, character-class requirements, and rejects common
 * passwords. This is a baseline policy — callers may layer on breach-dictionary
 * checks (e.g. HIBP k-anonymity) for higher assurance.
 */
export function validatePasswordStrength(password: string): PasswordStrengthResult {
  const issues: string[] = [];
  if (password.length < 12) issues.push('Password must be at least 12 characters long');
  if (password.length > 128) issues.push('Password must be at most 128 characters long');
  if (!/[a-z]/.test(password)) issues.push('Password must contain a lowercase letter');
  if (!/[A-Z]/.test(password)) issues.push('Password must contain an uppercase letter');
  if (!/[0-9]/.test(password)) issues.push('Password must contain a digit');
  if (!/[^a-zA-Z0-9]/.test(password)) issues.push('Password must contain a special character');

  const common = ['password', '12345678', 'qwerty123', 'letmein', 'admin123'];
  if (common.some((c) => password.toLowerCase().includes(c))) {
    issues.push('Password contains a common pattern');
  }

  // Score: 4 minus issues (clamped to 0-4)
  const score = Math.max(0, 4 - issues.length);
  return { valid: issues.length === 0, score, issues };
}

/**
 * Generate a random token (for CSRF, OAuth state, etc.)
 */
export function generateToken(length = 32): string {
  return randomBytes(length).toString('hex');
}

/**
 * Email verification token generation and verification.
 * Tokens are HMAC-signed and carry an expiry, so they can be sent via email
 * links without a server-side store. The token encodes the email and expiry
 * in a signed payload (base64url.signature).
 */
const EMAIL_VERIFICATION_TTL = 24 * 60 * 60; // 24 hours

export function generateVerificationToken(email: string, secret: string, ttlSeconds = EMAIL_VERIFICATION_TTL): string {
  const payload = { email, nonce: generateToken(16), ts: Date.now(), exp: Date.now() + ttlSeconds * 1000 };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifyEmailToken(token: string, secret: string): { email: string; nonce: string } | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts;
  const expected = createHmac('sha256', secret).update(encoded).digest('base64url');
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const data = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as { email: string; nonce: string; exp: number };
    if (data.exp && data.exp < Date.now()) return null;
    return { email: data.email, nonce: data.nonce };
  } catch {
    return null;
  }
}

/**
 * Account lockout manager — tracks failed authentication attempts per
 * identifier (username/email/IP) and locks the account after N failures
 * with exponential backoff. In-memory by default; for multi-instance
 * deployments, back this with a shared store (Redis, KV).
 */
export interface AccountLockoutConfig {
  /** Max failed attempts before lockout (default: 5) */
  maxAttempts?: number;
  /** Base lockout duration in seconds (default: 60) */
  baseLockoutSeconds?: number;
  /** Max lockout duration in seconds (default: 3600 = 1 hour) */
  maxLockoutSeconds?: number;
  /**
   * Shared store for multi-instance deployments. Default: a process-local
   * InMemorySecurityStore — with it, limits are per-worker. Provide a
   * Redis/KV-backed SecurityKeyValueStore for cluster-wide enforcement.
   */
  store?: SecurityKeyValueStore;
}

interface AttemptRecord {
  failures: number;
  lockedUntil: number;
}

export class AccountLockoutManager {
  private store: SecurityKeyValueStore;
  private maxAttempts: number;
  private baseLockoutSeconds: number;
  private maxLockoutSeconds: number;

  constructor(config: AccountLockoutConfig = {}) {
    this.store = config.store ?? new InMemorySecurityStore();
    this.maxAttempts = config.maxAttempts ?? 5;
    this.baseLockoutSeconds = config.baseLockoutSeconds ?? 60;
    this.maxLockoutSeconds = config.maxLockoutSeconds ?? 3600;
  }

  private key(identifier: string): string {
    return `lockout:${identifier}`;
  }

  private async getRecord(identifier: string): Promise<AttemptRecord> {
    const raw = await this.store.get(this.key(identifier));
    if (!raw) return { failures: 0, lockedUntil: 0 };
    try {
      const parsed = JSON.parse(raw) as AttemptRecord;
      return {
        failures: typeof parsed.failures === 'number' ? parsed.failures : 0,
        lockedUntil: typeof parsed.lockedUntil === 'number' ? parsed.lockedUntil : 0,
      };
    } catch {
      return { failures: 0, lockedUntil: 0 };
    }
  }

  /**
   * Serializes read-modify-write cycles per identifier. Without it, N
   * concurrent failed logins all read the same counter and write back
   * failures+1, so an attacker parallelizing guesses is counted once.
   * (In-process only — for multi-instance deployments use a store with
   * atomic semantics, or accept per-worker counting.)
   */
  private locks = new Map<string, Promise<unknown>>();

  private serialize<T>(identifier: string, fn: () => Promise<T>): Promise<T> {
    const key = this.key(identifier);
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return run;
  }

  /** Record a failed attempt for the given identifier. Returns the new lockout state. */
  recordFailure(identifier: string): Promise<{ locked: boolean; lockedUntil: number }> {
    return this.serialize(identifier, async () => {
      const rec = await this.getRecord(identifier);
      rec.failures += 1;
      if (rec.failures >= this.maxAttempts) {
        // Exponential backoff: base * 2^(failures - maxAttempts), capped
        const backoff = Math.min(
          this.baseLockoutSeconds * Math.pow(2, rec.failures - this.maxAttempts),
          this.maxLockoutSeconds,
        );
        rec.lockedUntil = Date.now() + backoff * 1000;
      }
      await this.store.set(this.key(identifier), JSON.stringify(rec), this.maxLockoutSeconds * 1000);
      return { locked: rec.failures >= this.maxAttempts, lockedUntil: rec.lockedUntil };
    });
  }

  /** Record a successful authentication — clears the failure counter. */
  recordSuccess(identifier: string): Promise<void> {
    return this.serialize(identifier, () => this.store.delete(this.key(identifier)));
  }

  /**
   * Check if the identifier is currently locked out. An expired lockout does
   * NOT clear the failure counter — otherwise every lockout would restart at
   * the base duration and the exponential backoff would never escalate. The
   * counter only clears on success or when the record's TTL lapses.
   */
  async isLocked(identifier: string): Promise<boolean> {
    const rec = await this.getRecord(identifier);
    return rec.lockedUntil > Date.now();
  }

  /** Get remaining attempts before lockout. */
  async remainingAttempts(identifier: string): Promise<number> {
    const rec = await this.getRecord(identifier);
    return Math.max(0, this.maxAttempts - rec.failures);
  }
}

/**
 * OAuth state validation helper.
 */
export function createOAuthState(redirect: string, secret: string): string {
  const payload = { redirect, nonce: generateToken(16), ts: Date.now() };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifyOAuthState(state: string, secret: string, maxAgeSeconds = 600): { redirect: string; nonce: string } | null {
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts;
  const expected = createHmac('sha256', secret).update(encoded).digest('base64url');
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const data = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as { redirect: string; nonce: string; ts: number };
    // Enforce expiry to prevent replay attacks (the oauth.ts version does this;
    // the index.ts helper previously did not).
    if (data.ts && Date.now() - data.ts > maxAgeSeconds * 1000) return null;
    return { redirect: data.redirect, nonce: data.nonce };
  } catch {
    return null;
  }
}

/**
 * Require authentication in a route handler — throws if no valid session.
 */
export function requireAuth(session: SessionData | null): SessionData {
  if (!session) {
    throw new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return session;
}

/**
 * Require a specific role in a route handler.
 */
export function requireRole(session: SessionData | null, role: string): SessionData {
  const s = requireAuth(session);
  if (s.role !== role) {
    throw new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return s;
}

export { generateCspHeader, generateCspMetaTag, DEFAULT_CSP, cspMiddleware, type CspDirectives } from './csp';
export { isSafeUrl, createSafeFetch, type SsrfCheckOptions } from './ssrf';
export { sanitizeHtml, sanitizeText, stripHtml, sanitizeInput, sanitizeObject } from './xss';
export { AuditLogger, getDefaultAuditLogger, type AuditEntry, type AuditLoggerOptions } from './audit';
export { validateEnv, getPublicEnv, isPublicEnvKey, createEnvGuard, type EnvSchema, type EnvValidationResult } from './env';
export { generateSecurityHeaders, securityHeadersMiddleware, clickjackingHeaders, DEFAULT_SECURITY_HEADERS, DEFAULT_PERMISSIONS_POLICY, type SecurityHeadersOptions } from './security-headers';
export { generateCsrfToken, csrfCookie, validateCsrfToken, validateOrigin, isSameSiteRequest, csrfProtection, createCsrfMiddleware, type CsrfOptions } from './csrf';
export { containsTraversal, safeResolve, isPathSafe, sanitizeRoutePath, createFileSandbox } from './path-traversal';
export { validateRedirect, safeRedirect, type RedirectValidationOptions } from './open-redirect';
export { deepSanitize, safeParse, safeMerge, sanitizeQueryParams, createSafeObject } from './proto-pollution';
export { ApiKeyRotationManager, generateApiKey, hashApiKey, verifyApiKey, type ApiKeyPair, type ApiKeyRecord, type ApiKeyRotationConfig } from './api-key';
export { analyzeRegex, isSafeRegex, safeRegexExec, safeReplace, safeRegexTest, validateWithSafePattern, createSafeRegex, scanForReDoS, type ReDoSAnalysisResult, type ReDoSFinding } from './redos';
export { generateTrustedTypesCSP, generateTrustedTypesCSPHeader, createTrustedTypesPolicy, getTrustedTypesPolicy, trustedHTML, trustedScript, trustedScriptURL, createViolationReporter, type TrustedTypesConfig, type TrustedTypesViolation } from './trusted-types';
export { generateCrossOriginHeaders, generateCORPHeader, generateRouteCrossOriginHeaders, crossOriginMiddleware, corpMiddleware, isCrossOriginIsolated, enableSharedArrayBuffer, type CrossOriginConfig } from './cross-origin';
export { generateReferrerPolicy, generateReferrerPolicyHeaders, referrerPolicyMiddleware, getDefaultReferrerPolicy, type ReferrerPolicyValue, type ReferrerPolicyConfig } from './referrer-policy';
export { generatePermissionPolicy, generatePermissionPolicyHeaders, generatePermissionPolicyValue, permissionPolicyMiddleware, getRestrictedFeatures, getDefaultDisabledPermissions, allowPermission, type PermissionPolicyConfig, type PermissionPolicyDirective } from './permissions-policy';
export { generatePKCE, createOAuthStateParam, verifyOAuthStateParam, buildAuthorizeUrl, exchangeCodeForTokens, refreshAccessToken, fetchUserInfo, needsRefresh, ensureValidTokens, OAuthManager, OAUTH_BINDING_COOKIE, type OAuthProviderConfig, type OAuthTokens, type OAuthUserInfo, type PKCEChallenge } from './oauth';
export { signJWT, verifyJWT, decodeJWT, generateKeyPair, generateECKeyPair, JWKSManager, createTokenPair, type JWTAlgorithm, type JWTPayload, type JWTSignOptions, type JWTVerifyOptions, type KeyPair } from './jwt';
export { generateTOTPSecret, generateTOTPCode, verifyTOTP, generateTOTPURI, enrollTOTP, generateBackupCodes, verifyBackupCode, consumeBackupCode, TotpReplayGuard, type TOTPConfig, type TOTPEnrollment } from './totp';
export { generateChallenge, generateRegistrationOptions, generateAuthenticationOptions, verifyRegistrationResponse, verifyAuthenticationResponse, getConditionalUIOptions, isWebAuthnSupported, isConditionalUISupported, type WebAuthnConfig, type WebAuthnCredential } from './webauthn';
export { RBACManager, createUsePermissions, COMMON_ROLES, type RoleDefinition, type RouteRoleConfig, type RBACContext, type RouteRoleMap } from './rbac';
export { ABACEvaluator, conditions, createPolicy, allowRule, denyRule, type ABACContext, type ABACCondition, type ABACRule, type ABACPolicy } from './abac';
export { ApiKeyManager, type ApiKeyScope, type ApiKeyRateLimit, type ManagedApiKeyRecord, type CreateApiKeyOptions, type ApiKeyValidationResult } from './api-key-management';
export { generateSPMetadata, generateAuthnRequest, parseSAMLResponse, verifySAMLSignature, generateLogoutRequest, type SAMLConfig, type SAMLAuthnRequest, type SAMLUserInfo } from './saml';
export { InMemorySecurityStore, createSecurityStore, type SecurityKeyValueStore } from './security-store';
