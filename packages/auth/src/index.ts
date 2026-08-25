import { createHmac, randomBytes, timingSafeEqual, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';
import type { PledgeRequest } from 'pledgestack-shared';

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
 * Generate a random token (for CSRF, OAuth state, etc.)
 */
export function generateToken(length = 32): string {
  return randomBytes(length).toString('hex');
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

export function verifyOAuthState(state: string, secret: string): { redirect: string; nonce: string } | null {
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts;
  const expected = createHmac('sha256', secret).update(encoded).digest('base64url');
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString());
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
export { generatePKCE, createOAuthStateParam, verifyOAuthStateParam, buildAuthorizeUrl, exchangeCodeForTokens, refreshAccessToken, fetchUserInfo, needsRefresh, ensureValidTokens, OAuthManager, type OAuthProviderConfig, type OAuthTokens, type OAuthUserInfo, type PKCEChallenge } from './oauth';
export { signJWT, verifyJWT, decodeJWT, generateKeyPair, generateECKeyPair, JWKSManager, createTokenPair, type JWTAlgorithm, type JWTPayload, type JWTSignOptions, type JWTVerifyOptions, type KeyPair } from './jwt';
export { generateTOTPSecret, generateTOTPCode, verifyTOTP, generateTOTPURI, enrollTOTP, generateBackupCodes, verifyBackupCode, consumeBackupCode, type TOTPConfig, type TOTPEnrollment } from './totp';
export { generateChallenge, generateRegistrationOptions, generateAuthenticationOptions, verifyRegistrationResponse, verifyAuthenticationResponse, getConditionalUIOptions, isWebAuthnSupported, isConditionalUISupported, type WebAuthnConfig, type WebAuthnCredential } from './webauthn';
export { RBACManager, createUsePermissions, COMMON_ROLES, type RoleDefinition, type RouteRoleConfig, type RBACContext, type RouteRoleMap } from './rbac';
export { ABACEvaluator, conditions, createPolicy, allowRule, denyRule, type ABACContext, type ABACCondition, type ABACRule, type ABACPolicy } from './abac';
export { ApiKeyManager, type ApiKeyScope, type ApiKeyRateLimit, type ManagedApiKeyRecord, type CreateApiKeyOptions, type ApiKeyValidationResult } from './api-key-management';
export { generateSPMetadata, generateAuthnRequest, parseSAMLResponse, verifySAMLSignature, generateLogoutRequest, type SAMLConfig, type SAMLAuthnRequest, type SAMLUserInfo } from './saml';
