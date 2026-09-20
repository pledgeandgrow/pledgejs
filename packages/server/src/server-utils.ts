import { AsyncLocalStorage } from 'node:async_hooks';
import type { PledgeRequest } from 'pledgestack-shared';
import { hmacSha256Hex, timingSafeEqualStr } from 'pledgestack-shared';
import { createSafeFetch, type SsrfCheckOptions } from 'pledgestack-auth';
import { makeThenable, type Thenable } from './thenable';

/**
 * Request-scoped storage using AsyncLocalStorage.
 * This allows server utilities (cookies, headers) to access
 * the current request without explicit parameter passing.
 */

interface RequestContext extends PledgeRequest {
  /** Mutable response headers set by headers() mutation */
  _responseHeaders?: Record<string, string>;
  /** Mutable response cookies set by cookies() mutation */
  _responseCookies?: Record<string, string>;
  /** Deferred callbacks to run after response is sent */
  _afterCallbacks?: Array<() => Promise<void> | void>;
  /** Whether notFound() was called */
  _notFoundCalled?: boolean;
  /** Redirect destination if redirect() was called */
  _redirectDestination?: string;
  _redirectStatus?: number;
}

const requestStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Sets the current request context for server utilities.
 * Called by the request handler before rendering.
 *
 * Stores the request object itself (not a copy) so mutations made through
 * cookies()/headers() setters land on the same object the handler merges
 * into the response afterwards.
 */
export function setRequestContext(req: PledgeRequest): void {
  requestStorage.enterWith(req as RequestContext);
}

/**
 * Clears the current request context.
 * Called after the request is complete.
 */
export function clearRequestContext(): void {
  // AsyncLocalStorage doesn't have explicit clear — it's scoped to the async context
}

/**
 * Gets the current request context (internal).
 */
function getRequest(): RequestContext {
  const req = requestStorage.getStore();
  if (!req) {
    throw new Error('Server utilities can only be called during request handling.');
  }
  return req;
}

/**
 * Reads or mutates cookies for the current request.
 *
 * Reading: returns a record of cookie name -> value.
 * Mutation: pass a setter function to set response cookies.
 *
 * Supports both sync and async usage (Next.js 15 style):
 *   const c = cookies(); // sync read (still works)
 *   const c = await cookies(); // async read (Next.js 15 pattern)
 *   cookies((c) => { c.set('session', 'abc', { httpOnly: true }) }); // set response cookie
 */
export function cookies(setter?: (jar: CookieJar) => void): Thenable<Record<string, string>> {
  const ctx = getRequest();
  if (setter) {
    if (!ctx._responseCookies) ctx._responseCookies = {};
    // Secure-by-default: the jar marks cookies `Secure` when the request came
    // in over HTTPS or we're in production (where TLS is terminated upstream).
    const secureDefault = ctx.url.protocol === 'https:' || process.env.NODE_ENV === 'production';
    const jar = new CookieJar(ctx._responseCookies, { secure: secureDefault }, () => {
      if (!ctx._responseHeaders) ctx._responseHeaders = {};
      return ctx._responseHeaders;
    });
    setter(jar);
    return makeThenable(ctx._responseCookies);
  }
  return makeThenable({ ...ctx.cookies });
}

/**
 * Reads or mutates headers for the current request.
 *
 * Reading: returns a readonly record of header name -> value.
 * Mutation: pass a setter function to set response headers.
 *
 * Supports both sync and async usage (Next.js 15 style):
 *   const h = headers(); // sync read (still works)
 *   const h = await headers(); // async read (Next.js 15 pattern)
 *   headers((h) => { h.set('X-Custom', 'value') }); // set response header
 */
export function headers(setter?: (headerStore: HeaderStore) => void): Thenable<Record<string, string>> {
  const ctx = getRequest();
  if (setter) {
    if (!ctx._responseHeaders) ctx._responseHeaders = {};
    const store = new HeaderStore(ctx._responseHeaders);
    setter(store);
    return makeThenable(ctx._responseHeaders);
  }
  return makeThenable({ ...ctx.headers });
}

/**
 * Reads the current request's search params / query.
 *
 * Supports both sync and async usage (Next.js 15 style):
 *   const sp = searchParams(); // sync read (still works)
 *   const sp = await searchParams(); // async read (Next.js 15 pattern)
 */
export function searchParams(): Thenable<Record<string, string>> {
  return makeThenable({ ...getRequest().query });
}

/**
 * Gets the current request params (route parameters).
 *
 * Supports both sync and async usage (Next.js 15 style):
 *   const p = params(); // sync read (still works)
 *   const p = await params(); // async read (Next.js 15 pattern)
 */
export function params(): Thenable<Record<string, string>> {
  return makeThenable({ ...getRequest().params });
}

/**
 * Draft mode / preview mode utility.
 * Returns an object with isEnabled and enable/enable methods.
 */
const DRAFT_COOKIE = '__pledge_draft';

export function draftMode(): {
  isEnabled: boolean;
  enable(): void;
  disable(): void;
} {
  const req = getRequest();
  // The cookie is HMAC-signed: an unsigned `__pledge_draft=true` sent by any
  // visitor must not switch on preview/draft content.
  const draftCookie = req.cookies[DRAFT_COOKIE];
  let enabled = draftCookie ? verifyCookieValue(draftCookie, DRAFT_COOKIE) === 'true' : false;

  return {
    get isEnabled() {
      return enabled;
    },
    enable() {
      enabled = true;
      cookies((jar) => jar.set(DRAFT_COOKIE, signCookieValue('true', DRAFT_COOKIE), { httpOnly: true, sameSite: 'lax', path: '/' }));
    },
    disable() {
      enabled = false;
      cookies((jar) => jar.delete(DRAFT_COOKIE, { path: '/' }));
    },
  };
}

// ---------------------------------------------------------------------------
// CookieJar — mutable cookie store for cookies() mutation
// ---------------------------------------------------------------------------

export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'strict' | 'lax' | 'none';
  maxAge?: number;
  expires?: Date;
  path?: string;
  domain?: string;
}

export interface CookieJarDefaults {
  /** Default for the Secure flag — true on HTTPS requests and in production. */
  secure?: boolean;
}

// ---------------------------------------------------------------------------
// Cookie value signing — HMAC-SHA256, zero configuration
// ---------------------------------------------------------------------------

let cachedSecret: string | null = null;
let warnedAboutSecret = false;

/**
 * Resolves the framework signing secret used by setSigned()/getSignedCookie()
 * and the action-endpoint token. Production deployments must set
 * PLEDGE_SECRET (or SESSION_SECRET); in dev a random per-process secret is
 * generated so nothing is ever hardcoded.
 */
/** Whether a real deployment secret is configured (vs. the dev fallback). */
export function hasConfiguredSecret(): boolean {
  return !!(typeof process !== 'undefined' && (process.env.PLEDGE_SECRET ?? process.env.SESSION_SECRET));
}

export function getSigningSecret(): string {
  const envSecret =
    (typeof process !== 'undefined' && (process.env.PLEDGE_SECRET ?? process.env.SESSION_SECRET)) || undefined;
  if (envSecret) return envSecret;
  if (cachedSecret) return cachedSecret;
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  cachedSecret = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  if (!warnedAboutSecret && process.env.NODE_ENV === 'production') {
    warnedAboutSecret = true;
    console.warn(
      '[pledgestack/security] PLEDGE_SECRET is not set — signed cookies and the ' +
        'action-endpoint token are using a random per-process secret. Signatures ' +
        'will not survive restarts. Set PLEDGE_SECRET in production.',
    );
  }
  return cachedSecret;
}

/**
 * Signs a cookie value: `v2.<value>.<hmac>` where the MAC covers BOTH the
 * cookie name and the value. Binding the name stops cross-cookie
 * substitution — a validly signed `draft=true` (or any other signed cookie)
 * can't be replayed as `role=...`. The version prefix lets the format evolve
 * without silently accepting old signatures.
 */
export function signCookieValue(value: string, name: string): string {
  return `v2.${value}.${hmacSha256Hex(getSigningSecret(), `cookie:v2:${name}\n${value}`)}`;
}

/**
 * Verifies a signed cookie value for the cookie `name`, returning the payload
 * or null.
 *
 * Rotation from the old name-unbound `v1.` format: v1 values are REJECTED by
 * default (users are simply re-issued a v2 cookie on next sign-in). To keep
 * existing sessions alive during a migration window set
 * PLEDGE_ACCEPT_LEGACY_COOKIES=1, then remove it once old cookies have
 * expired — v1 signatures are not name-bound and so allow cross-cookie replay.
 */
export function verifyCookieValue(signed: string, name: string): string | null {
  const parts = signed.split('.');
  if (parts.length < 3) return null;
  const version = parts[0];
  const sig = parts.pop()!;
  const value = parts.slice(1).join('.');
  if (version === 'v2') {
    const expected = hmacSha256Hex(getSigningSecret(), `cookie:v2:${name}\n${value}`);
    return timingSafeEqualStr(sig, expected) ? value : null;
  }
  if (version === 'v1' && typeof process !== 'undefined' && process.env.PLEDGE_ACCEPT_LEGACY_COOKIES === '1') {
    const expected = hmacSha256Hex(getSigningSecret(), `cookie:${value}`);
    return timingSafeEqualStr(sig, expected) ? value : null;
  }
  return null;
}

/**
 * Reads a signed cookie from the current request. Returns the verified
 * value, or null if the cookie is missing or the signature doesn't verify
 * (tampered values are indistinguishable from absent ones).
 */
export function getSignedCookie(name: string): string | null {
  const raw = getRequest().cookies[name];
  if (!raw) return null;
  return verifyCookieValue(raw, name);
}

const VALID_COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export class CookieJar {
  constructor(
    private store: Record<string, string>,
    private defaults: CookieJarDefaults = {},
    private responseHeaders?: () => Record<string, string>,
  ) {}

  /**
   * Sets a cookie. Secure-by-default: HttpOnly, SameSite=Lax, and Secure (on
   * HTTPS/production) are applied unless explicitly opted out — pass
   * `{ httpOnly: false }` for cookies client-side JS must read, or
   * `{ secure: false }` on plain-HTTP deployments.
   *
   * Names are validated against the RFC 6265 token grammar — a name or
   * domain containing CR/LF would otherwise let a malicious cookie name
   * inject raw response headers.
   */
  set(name: string, value: string, options: CookieOptions = {}): void {
    if (!VALID_COOKIE_NAME.test(name)) {
      throw new Error(`Invalid cookie name: ${JSON.stringify(name)}`);
    }
    // eslint-disable-next-line no-control-regex -- deliberately matches CTLs to reject header-splitting domains
    if (options.domain && /[\r\n\x00-\x1f\x7f]/.test(options.domain)) {
      throw new Error('Invalid cookie domain');
    }
    // Path is emitted verbatim — a `;` or CTL would inject extra attributes.
    // eslint-disable-next-line no-control-regex -- deliberately matches CTLs
    if (options.path && /[; -]/.test(options.path)) {
      throw new Error('Invalid cookie path');
    }
    const httpOnly = options.httpOnly ?? true;
    const sameSite = options.sameSite ?? 'lax';
    // SameSite=None is only valid with Secure — browsers silently drop the
    // cookie otherwise, so the attribute pair is forced rather than left to
    // the caller to get wrong.
    const secure = sameSite === 'none' ? true : (options.secure ?? this.defaults.secure ?? false);

    const parts: string[] = [`${name}=${encodeURIComponent(value)}`];
    if (httpOnly) parts.push('HttpOnly');
    if (secure) parts.push('Secure');
    parts.push(`SameSite=${sameSite.charAt(0).toUpperCase()}${sameSite.slice(1)}`);
    if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
    if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
    if (options.path) parts.push(`Path=${options.path}`);
    if (options.domain) parts.push(`Domain=${options.domain}`);
    this.store[name] = parts.join('; ');
  }

  /**
   * Sets a session cookie hardened to the `__Host-` prefix rules: Secure,
   * Path=/, no Domain, HttpOnly. The `__Host-` prefix is added if absent —
   * browsers reject `__Host-` cookies that violate these constraints, so the
   * helper enforces them instead of letting a misconfigured cookie silently
   * downgrade.
   */
  setSession(name: string, value: string, options: CookieOptions = {}): void {
    if (options.domain) {
      throw new Error('__Host- session cookies must not set a Domain attribute');
    }
    const cookieName = name.startsWith('__Host-') ? name : `__Host-${name}`;
    this.set(cookieName, value, {
      ...options,
      secure: true,
      httpOnly: true,
      path: '/',
      domain: undefined,
      sameSite: options.sameSite ?? 'lax',
    });
  }

  /**
   * Sets an HMAC-signed cookie — the value is integrity-protected, so client
   * tampering (role escalation, ID flipping) is detected on read via
   * getSignedCookie(). Uses the framework signing secret (PLEDGE_SECRET);
   * still send the signed value through getSignedCookie/verifyCookieValue
   * on read — never trust an unsigned cookie.
   */
  setSigned(name: string, value: string, options: CookieOptions = {}): void {
    this.set(name, signCookieValue(value, name), { ...options, httpOnly: true });
  }

  /**
   * Session-fixation defense — call on privilege change (login, role
   * upgrade, MFA completion). Generates a fresh random session id, writes
   * it under the __Host- cookie, and returns it so the caller can store it
   * server-side and invalidate the pre-auth id. Without rotation, an
   * attacker who planted a session id before login rides the victim's
   * authenticated session.
   */
  rotateSession(name: string = 'session', options: CookieOptions = {}): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    this.setSession(name, id, options);
    return id;
  }

  /**
   * One-call secure logout: expires the __Host- session cookie AND emits
   * `Clear-Site-Data: "cookies", "storage"` so the browser wipes every
   * cookie and client-side storage bucket — the step hand-rolled logout
   * implementations almost always miss.
   */
  clearSession(name: string = 'session'): void {
    const cookieName = name.startsWith('__Host-') ? name : `__Host-${name}`;
    this.delete(cookieName, { path: '/', secure: true });
    if (this.responseHeaders) {
      const headers = this.responseHeaders();
      headers['Clear-Site-Data'] = '"cookies", "storage"';
    }
  }

  delete(name: string, options: CookieOptions = {}): void {
    this.set(name, '', { ...options, maxAge: 0, expires: new Date(0) });
  }

  get(name: string): string | undefined {
    return this.store[name];
  }

  getAll(): Record<string, string> {
    return { ...this.store };
  }
}

// ---------------------------------------------------------------------------
// HeaderStore — mutable header store for headers() mutation
// ---------------------------------------------------------------------------

export class HeaderStore {
  constructor(private store: Record<string, string>) {}

  set(name: string, value: string): void {
    this.store[name] = value;
  }

  append(name: string, value: string): void {
    if (this.store[name]) {
      this.store[name] = `${this.store[name]}, ${value}`;
    } else {
      this.store[name] = value;
    }
  }

  delete(name: string): void {
    delete this.store[name];
  }

  get(name: string): string | undefined {
    return this.store[name];
  }

  getAll(): Record<string, string> {
    return { ...this.store };
  }
}

// ---------------------------------------------------------------------------
// redirect() — type-safe redirect from server components, route handlers, middleware
// ---------------------------------------------------------------------------

export class RedirectError extends Error {
  readonly destination: string;
  readonly status: number;

  constructor(destination: string, status: number = 307) {
    super(`Redirecting to ${destination}`);
    this.name = 'RedirectError';
    this.destination = destination;
    this.status = status;
  }
}

export function redirect(destination: string, status: number = 307): never {
  const ctx = getRequest();
  ctx._redirectDestination = destination;
  ctx._redirectStatus = status;
  throw new RedirectError(destination, status);
}

// ---------------------------------------------------------------------------
// notFound() — trigger 404 rendering from server components and route handlers
// ---------------------------------------------------------------------------

export class NotFoundError extends Error {
  constructor() {
    super('Not Found');
    this.name = 'NotFoundError';
  }
}

export function notFound(): never {
  const ctx = getRequest();
  ctx._notFoundCalled = true;
  throw new NotFoundError();
}

// ---------------------------------------------------------------------------
// after() — defer non-critical work until after response is sent to client
// ---------------------------------------------------------------------------

export function after(callback: () => Promise<void> | void): void {
  const ctx = getRequest();
  if (!ctx._afterCallbacks) ctx._afterCallbacks = [];
  ctx._afterCallbacks.push(callback);
}

export function getAfterCallbacks(): Array<() => Promise<void> | void> {
  const ctx = getRequest();
  return ctx._afterCallbacks ?? [];
}

// ---------------------------------------------------------------------------
// connection() — connection state in server components for streaming/edge
// ---------------------------------------------------------------------------

export interface ConnectionState {
  /** Whether the connection is still open */
  isOpen: boolean;
  /** Whether the response has started streaming */
  isStreaming: boolean;
  /** Wait for the connection to be ready (edge/streaming) */
  ready: () => Promise<void>;
}

export function connection(): ConnectionState {
  getRequest();
  let _open = true;
  let _streaming = false;

  return {
    get isOpen() {
      return _open;
    },
    get isStreaming() {
      return _streaming;
    },
    ready: async () => {
      _streaming = true;
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers for handler to check redirect/notFound state
// ---------------------------------------------------------------------------

export function getRedirectDestination(): { destination: string; status: number } | null {
  const ctx = requestStorage.getStore();
  if (!ctx) return null;
  if (ctx._redirectDestination) {
    return { destination: ctx._redirectDestination, status: ctx._redirectStatus ?? 307 };
  }
  return null;
}

export function wasNotFoundCalled(): boolean {
  const ctx = requestStorage.getStore();
  return ctx?._notFoundCalled ?? false;
}

// ---------------------------------------------------------------------------
// SSRF-safe fetch for server-side requests
// ---------------------------------------------------------------------------

/**
 * Returns an SSRF-hardened `fetch` for server-side requests whose URL is
 * user-influenced (webhook targets, avatar imports, link previews).
 *
 * Blocks loopback/private/link-local destinations (incl. 169.254.169.254
 * cloud metadata), re-validates every redirect hop, and pins the validated
 * DNS answer so a rebinding attack can't resolve a safe IP for the check
 * and a private IP for the connection. Pass `{ allowPrivate: true }` etc.
 * for intranet deployments.
 */
export function serverFetch(options?: SsrfCheckOptions): typeof fetch {
  return createSafeFetch(options);
}
