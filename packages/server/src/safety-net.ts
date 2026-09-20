/**
 * Developer safety net — bot detection, brute force protection,
 * error boundary telemetry, development security warnings.
 *
 * Items 170, 171, 175, 176 of the PledgeStack roadmap.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { InMemorySecurityStore, type SecurityKeyValueStore } from 'pledgestack-auth';
import { escapeHtml, type PledgeConfig } from 'pledgestack-shared';


// ---------------------------------------------------------------------------
// 170. Bot detection — heuristic UA/pattern/CAPTCHA
// ---------------------------------------------------------------------------

export interface BotDetectionResult {
  isBot: boolean;
  confidence: number;
  signals: string[];
  shouldChallenge: boolean;
}

const BOT_UA_PATTERNS = [
  /bot\b/i, /crawler\b/i, /spider\b/i, /scraper\b/i,
  /curl/i, /wget/i, /python-requests/i, /go-http-client/i,
  /java\//i, /okhttp/i, /httpclient/i, /axios/i,
  /googlebot/i, /bingbot/i, /yandexbot/i, /baiduspider/i,
  /semrush/i, /ahrefs/i, /dotbot/i, /rogerbot/i,
  /headless/i, /phantom/i, /selenium/i, /puppeteer/i,
  /cypress/i, /playwright/i, /lighthouse/i,
];

const HEADLESS_SIGNALS = [
  'webdriver', 'headless', 'selenium', 'puppeteer', 'playwright',
];

/**
 * Detects bots using User-Agent heuristics and request pattern analysis.
 */
export function detectBot(request: {
  headers?: Record<string, string>;
  userAgent?: string;
  method?: string;
  path?: string;
}): BotDetectionResult {
  const ua = request.userAgent ?? request.headers?.['user-agent'] ?? '';
  const signals: string[] = [];
  let confidence = 0;

  // UA pattern matching
  for (const pattern of BOT_UA_PATTERNS) {
    if (pattern.test(ua)) {
      signals.push(`UA match: ${pattern.source}`);
      confidence += 0.3;
      break;
    }
  }

  // Headless browser detection
  for (const signal of HEADLESS_SIGNALS) {
    if (ua.toLowerCase().includes(signal)) {
      signals.push(`Headless signal: ${signal}`);
      confidence += 0.2;
    }
  }

  // Missing common browser headers
  const accept = request.headers?.['accept'] ?? '';
  const acceptLanguage = request.headers?.['accept-language'] ?? '';
  const acceptEncoding = request.headers?.['accept-encoding'] ?? '';

  if (!acceptLanguage) {
    signals.push('Missing Accept-Language header');
    confidence += 0.15;
  }
  if (!accept) {
    signals.push('Missing Accept header');
    confidence += 0.15;
  }
  if (!acceptEncoding) {
    signals.push('Missing Accept-Encoding header');
    confidence += 0.1;
  }

  // Empty or suspiciously short UA
  if (ua.length < 20) {
    signals.push('Suspiciously short User-Agent');
    confidence += 0.2;
  }

  // POST without proper content-type (common bot pattern)
  if (request.method === 'POST') {
    const contentType = request.headers?.['content-type'] ?? '';
    if (!contentType.includes('application/x-www-form-urlencoded') && !contentType.includes('multipart/form-data') && !contentType.includes('application/json')) {
      signals.push('POST without proper Content-Type');
      confidence += 0.1;
    }
  }

  confidence = Math.min(confidence, 1);
  const isBot = confidence >= 0.5;
  // A request worth challenging is anything at or above the suspicion floor.
  // The previous `< 0.7` upper bound meant the MOST confident bots (>= 0.7)
  // reported shouldChallenge=false and slipped through the handler's
  // `isBot && shouldChallenge` gate, i.e. detection was inverted at the top end.
  const shouldChallenge = confidence >= 0.3;

  return { isBot, confidence, signals, shouldChallenge };
}

/**
 * Generates a CAPTCHA challenge HTML page.
 */
export function captchaChallengePage(action: string): string {
  return `<!DOCTYPE html>
<html><head><title>Verification Required</title></head>
<body>
<h1>Please verify you are human</h1>
<form method="POST" action="${escapeHtml(action)}">
<input type="hidden" name="_captcha_challenge" value="${crypto.randomUUID()}" />
<button type="submit">I am human</button>
</form>
</body></html>`;
}

// ---------------------------------------------------------------------------
// 171. Brute force protection — exponential backoff, lockout, CAPTCHA
// ---------------------------------------------------------------------------

interface FailedAttempt {
  count: number;
  firstAttemptAt: number;
  lastAttemptAt: number;
  lockedUntil: number;
}

/**
 * Pluggable store for brute-force state. Default: process-local in-memory —
 * with it, limits are per-worker (effective limit = maxAttempts × workers).
 * For multi-instance deployments, call setBruteForceStore() with a shared
 * SecurityKeyValueStore (Redis, KV, DB) before serving traffic.
 */
let attemptStore: SecurityKeyValueStore = new InMemorySecurityStore();

/** Sets the brute-force state store (e.g. a Redis-backed SecurityKeyValueStore). */
export function setBruteForceStore(store: SecurityKeyValueStore): void {
  attemptStore = store;
}

const BF_KEY_PREFIX = 'bf:';

function bfKey(identifier: string): string {
  return BF_KEY_PREFIX + identifier;
}

async function getAttempt(identifier: string): Promise<FailedAttempt | null> {
  const raw = await attemptStore.get(bfKey(identifier));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<FailedAttempt>;
    return {
      count: typeof parsed.count === 'number' ? parsed.count : 0,
      firstAttemptAt: typeof parsed.firstAttemptAt === 'number' ? parsed.firstAttemptAt : 0,
      lastAttemptAt: typeof parsed.lastAttemptAt === 'number' ? parsed.lastAttemptAt : 0,
      lockedUntil: typeof parsed.lockedUntil === 'number' ? parsed.lockedUntil : 0,
    };
  } catch {
    return null;
  }
}

async function setAttempt(identifier: string, entry: FailedAttempt, ttlMs: number): Promise<void> {
  await attemptStore.set(bfKey(identifier), JSON.stringify(entry), ttlMs);
}

/**
 * Stops the brute force cleanup timer (for tests or graceful shutdown).
 * Retained for API compatibility — with the pluggable store, expiry is
 * handled by store TTLs and no timer is needed.
 */
export function stopBruteForceCleanup(): void {
  // No-op: expiry is delegated to the store's TTL.
}

export interface BruteForceConfig {
  /** Max attempts before lockout */
  maxAttempts: number;
  /** Base delay for exponential backoff (ms) */
  baseDelayMs: number;
  /** Max delay cap (ms) */
  maxDelayMs: number;
  /** Lockout duration after max attempts (ms) */
  lockoutDurationMs: number;
  /** Attempts before CAPTCHA is required */
  captchaThreshold: number;
  /** Window for counting attempts (ms) */
  windowMs: number;
}

const defaultBruteForceConfig: BruteForceConfig = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  lockoutDurationMs: 900000,
  captchaThreshold: 3,
  windowMs: 600000,
};

export interface BruteForceCheckResult {
  allowed: boolean;
  requiresCaptcha: boolean;
  lockedOut: boolean;
  remainingAttempts: number;
  retryAfterMs: number;
  lockoutEndsAt: number | null;
}

/**
 * Checks if a login attempt should be allowed, throttled, or blocked.
 */
export async function checkBruteForce(
  identifier: string,
  config: Partial<BruteForceConfig> = {},
): Promise<BruteForceCheckResult> {
  const cfg = { ...defaultBruteForceConfig, ...config };
  const now = Date.now();
  const entry = await getAttempt(identifier);

  // Reset if window has passed — but never while a lockout is still active
  // (lockoutDurationMs can outlast windowMs; resetting would end it early).
  if (entry && entry.lockedUntil <= now && now - entry.firstAttemptAt > cfg.windowMs) {
    await attemptStore.delete(bfKey(identifier));
    return {
      allowed: true,
      requiresCaptcha: false,
      lockedOut: false,
      remainingAttempts: cfg.maxAttempts,
      retryAfterMs: 0,
      lockoutEndsAt: null,
    };
  }

  if (!entry) {
    return {
      allowed: true,
      requiresCaptcha: false,
      lockedOut: false,
      remainingAttempts: cfg.maxAttempts,
      retryAfterMs: 0,
      lockoutEndsAt: null,
    };
  }

  // Check lockout
  if (entry.lockedUntil > now) {
    return {
      allowed: false,
      requiresCaptcha: false,
      lockedOut: true,
      remainingAttempts: 0,
      retryAfterMs: entry.lockedUntil - now,
      lockoutEndsAt: entry.lockedUntil,
    };
  }

  const remainingAttempts = Math.max(0, cfg.maxAttempts - entry.count);
  const requiresCaptcha = entry.count >= cfg.captchaThreshold;

  // Exponential backoff delay
  const delay = Math.min(
    cfg.baseDelayMs * Math.pow(2, entry.count - 1),
    cfg.maxDelayMs,
  );

  return {
    allowed: true,
    requiresCaptcha,
    lockedOut: false,
    remainingAttempts,
    retryAfterMs: delay,
    lockoutEndsAt: null,
  };
}

/**
 * Records a failed authentication attempt.
 */
export async function recordFailedAttempt(
  identifier: string,
  config: Partial<BruteForceConfig> = {},
): Promise<BruteForceCheckResult> {
  const cfg = { ...defaultBruteForceConfig, ...config };
  const now = Date.now();
  let entry = await getAttempt(identifier);

  if (!entry || (entry.lockedUntil <= now && now - entry.firstAttemptAt > cfg.windowMs)) {
    entry = {
      count: 1,
      firstAttemptAt: now,
      lastAttemptAt: now,
      lockedUntil: 0,
    };
  } else {
    entry.count++;
    entry.lastAttemptAt = now;
    if (entry.count >= cfg.maxAttempts) {
      entry.lockedUntil = now + cfg.lockoutDurationMs;
    }
  }

  // TTL covers both the counting window and any active lockout.
  const ttl = Math.max(cfg.windowMs, cfg.lockoutDurationMs) + 60_000;
  await setAttempt(identifier, entry, ttl);

  return checkBruteForce(identifier, config);
}

/**
 * Clears failed attempts after successful authentication.
 */
export async function clearFailedAttempts(identifier: string): Promise<void> {
  await attemptStore.delete(bfKey(identifier));
}

/**
 * Gets the current brute force state for an identifier.
 */
export async function getBruteForceState(identifier: string): Promise<FailedAttempt | null> {
  return getAttempt(identifier);
}

// ---------------------------------------------------------------------------
// 175. Error boundary telemetry — auto capture in error.tsx
// ---------------------------------------------------------------------------

export interface ErrorBoundaryTelemetryConfig {
  /** Error tracker endpoint */
  endpoint?: string;
  /** Whether to sanitize stack traces */
  sanitizeStacks: boolean;
  /** Whether to include user context */
  includeUserContext: boolean;
  /** Sample rate (0-1) */
  sampleRate: number;
}

const defaultTelemetryConfig: ErrorBoundaryTelemetryConfig = {
  sanitizeStacks: true,
  includeUserContext: false,
  sampleRate: 1.0,
};

let telemetryConfig: ErrorBoundaryTelemetryConfig = { ...defaultTelemetryConfig };

/**
 * Configures error boundary telemetry.
 */
export function configureErrorBoundaryTelemetry(config: Partial<ErrorBoundaryTelemetryConfig>): void {
  telemetryConfig = { ...defaultTelemetryConfig, ...config };
}

/**
 * Sanitizes a stack trace by removing file paths and line numbers
 * in production, keeping only function names.
 */
function sanitizeStack(stack: string): string {
  return stack
    .replace(/\s+at\s+.+?\(?(.+?):\d+:\d+\)?/g, 'at $1')
    .replace(/file:\/\/.+/g, '[file]')
    .replace(/https?:\/\/.+/g, '[url]');
}

/**
 * Reports an error from an error boundary.
 * Automatically called by error.tsx boundaries.
 */
export async function reportBoundaryError(
  error: Error,
  context?: {
    route?: string;
    userId?: string;
    componentStack?: string;
    [key: string]: unknown;
  },
): Promise<void> {
  if (Math.random() > telemetryConfig.sampleRate) return;

  const report: Record<string, unknown> = {
    name: error.name,
    message: error.message,
    stack: telemetryConfig.sanitizeStacks ? sanitizeStack(error.stack ?? '') : error.stack,
    timestamp: new Date().toISOString(),
    route: context?.route,
    componentStack: context?.componentStack,
  };

  if (telemetryConfig.includeUserContext && context?.userId) {
    report.userId = context.userId;
  }

  // Add extra context
  if (context) {
    for (const [key, value] of Object.entries(context)) {
      if (!['route', 'userId', 'componentStack'].includes(key)) {
        report[key] = value;
      }
    }
  }

  if (telemetryConfig.endpoint) {
    try {
      await fetch(telemetryConfig.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(report),
      });
    } catch {
      // Silently fail — error telemetry should never break the app
    }
  }
}

// ---------------------------------------------------------------------------
// 176. Development security warnings — console warnings in dev mode
// ---------------------------------------------------------------------------

export interface SecurityWarning {
  category: 'http' | 'csrf' | 'cors' | 'csp' | 'cookies' | 'secrets' | 'misc';
  severity: 'warn' | 'error';
  message: string;
  file?: string;
  fix?: string;
}

const warningsEmitted = new Set<string>();

/**
 * Emits a security warning in development mode.
 * Each unique warning is only emitted once per session.
 */
export function emitSecurityWarning(warning: SecurityWarning): void {
  if (process.env.NODE_ENV === 'production') return;

  const key = `${warning.category}:${warning.message}`;
  if (warningsEmitted.has(key)) return;
  warningsEmitted.add(key);

  const prefix = `[pledgestack/security]`;
  const location = warning.file ? ` (${warning.file})` : '';
  const fix = warning.fix ? `\n  Fix: ${warning.fix}` : '';

  if (warning.severity === 'error') {
    console.error(`${prefix} ${warning.message}${location}${fix}`);
  } else {
    console.warn(`${prefix} ${warning.message}${location}${fix}`);
  }
}

/**
 * Checks for common insecure patterns and emits warnings.
 */
export function checkSecurityPatterns(config: {
  https?: boolean;
  csrfEnabled?: boolean;
  corsOrigin?: string;
  cspEnabled?: boolean;
  cookieSecure?: boolean;
  envVars?: Record<string, string>;
}): void {
  if (process.env.NODE_ENV === 'production') return;

  // HTTP in production
  if (!config.https && process.env.NODE_ENV === 'production') {
    emitSecurityWarning({
      category: 'http',
      severity: 'error',
      message: 'HTTPS is not enabled. Use TLS in production.',
      fix: 'Set up a reverse proxy with TLS or use --https flag',
    });
  }

  // Missing CSRF protection
  if (config.csrfEnabled === false) {
    emitSecurityWarning({
      category: 'csrf',
      severity: 'warn',
      message: 'CSRF protection is disabled.',
      fix: 'Enable csrf: true in your pledge.config.ts',
    });
  }

  // Loose CORS
  if (config.corsOrigin === '*') {
    emitSecurityWarning({
      category: 'cors',
      severity: 'warn',
      message: 'CORS origin is set to "*" — allows any origin.',
      fix: 'Specify allowed origins explicitly in config.cors.origins',
    });
  }

  // Missing CSP
  if (config.cspEnabled === false) {
    emitSecurityWarning({
      category: 'csp',
      severity: 'warn',
      message: 'Content-Security-Policy is disabled.',
      fix: 'Enable CSP in config.security.csp',
    });
  }

  // Insecure cookies
  if (config.cookieSecure === false) {
    emitSecurityWarning({
      category: 'cookies',
      severity: 'warn',
      message: 'Cookies are not marked as Secure.',
      fix: 'Set secure: true in cookie options',
    });
  }

  // Secrets in env
  if (config.envVars) {
    const secretKeys = ['SECRET', 'PASSWORD', 'API_KEY', 'TOKEN', 'PRIVATE_KEY'];
    for (const [key, value] of Object.entries(config.envVars)) {
      if (secretKeys.some((s) => key.toUpperCase().includes(s)) && value.length < 8) {
        emitSecurityWarning({
          category: 'secrets',
          severity: 'error',
          message: `Environment variable ${key} appears to have a weak value.`,
          fix: 'Use a strong, randomly generated secret (at least 32 characters)',
        });
      }
    }
  }
}

/**
 * Clears emitted warnings (for testing).
 */
export function clearSecurityWarnings(): void {
  warningsEmitted.clear();
}

// ---------------------------------------------------------------------------
// Production posture — fail-loud checks wired into `pledge start`/`pledge build`
// ---------------------------------------------------------------------------

export interface ProductionPostureIssue {
  severity: 'error' | 'warn';
  message: string;
  fix: string;
}

/**
 * Audits a resolved config for production-unsafe settings. Unlike the
 * dev-mode warnings above, this runs in production context (`pledge start`,
 * `pledge build`) and always emits — the whole point is that disabling a
 * protection should be a loud, deliberate choice, not a silent default.
 */
export function checkProductionPosture(config: PledgeConfig): ProductionPostureIssue[] {
  const issues: ProductionPostureIssue[] = [];

  if (config.securityHeaders === false) {
    issues.push({
      severity: 'error',
      message: 'securityHeaders is disabled — no CSP, clickjacking, or isolation headers will be sent.',
      fix: "Remove `securityHeaders: false` from pledge.config.ts",
    });
  }

  if (config.csrf === false) {
    issues.push({
      severity: 'error',
      message: 'CSRF protection is disabled — cross-site POSTs to API routes and server actions will not be rejected.',
      fix: "Remove `csrf: false` from pledge.config.ts",
    });
  }

  if (config.cors?.origins?.includes('*')) {
    issues.push({
      severity: config.cors.credentials ? 'error' : 'warn',
      message: config.cors.credentials
        ? "CORS origins is '*' with credentials: true — any origin can make credentialed requests."
        : "CORS origins is '*' — any origin can read API responses.",
      fix: 'Set config.cors.origins to an explicit allowlist',
    });
  }

  if (config.rateLimit === false) {
    issues.push({
      severity: 'warn',
      message: 'rateLimit is fully disabled — the server-action RPC endpoint is unthrottled.',
      fix: "Remove `rateLimit: false` or scope it (the endpoint limit only needs ~100 burst / 2 rps)",
    });
  }

  if (!process.env.PLEDGE_SECRET && !process.env.SESSION_SECRET) {
    issues.push({
      severity: 'warn',
      message: 'PLEDGE_SECRET is not set — signed cookies and the action-endpoint token fall back to a per-process secret that does not survive restarts.',
      fix: 'Set PLEDGE_SECRET to a stable random value in production',
    });
  }

  // security.txt: served automatically from public/ when present — this is a
  // presence check, not an enforcement, since a fake default would be worse.
  try {
    const securityTxt = join(config.rootDir, config.publicDir, '.well-known', 'security.txt');
    if (!existsSync(securityTxt)) {
      issues.push({
        severity: 'warn',
        message: 'No /.well-known/security.txt — security researchers have no documented contact channel.',
        fix: 'Add public/.well-known/security.txt (served automatically)',
      });
    }
  } catch {
    // fs unavailable (edge build) — skip the presence check.
  }

  // Publicly-reachable source maps hand an attacker unobfuscated source for
  // every shipped bundle. They're legitimate for internal observability, so
  // this warns rather than errors — the fix is excluding them from public/.
  try {
    const publicRoot = join(config.rootDir, config.publicDir);
    const walk = (dir: string, depth: number): boolean => {
      if (depth > 4) return false;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && walk(join(dir, entry.name), depth + 1)) return true;
        if (entry.isFile() && entry.name.endsWith('.map')) return true;
      }
      return false;
    };
    if (existsSync(publicRoot) && walk(publicRoot, 0)) {
      issues.push({
        severity: 'warn',
        message: '.map source map files found under public/ — they are served verbatim and expose unobfuscated source.',
        fix: 'Remove *.map from public/ or exclude them from the build output',
      });
    }
  } catch {
    // fs unavailable — skip.
  }

  if (process.env.NODE_ENV !== 'production') {
    issues.push({
      severity: 'warn',
      message: 'NODE_ENV is not "production" — dev-mode error detail and relaxed checks may be active.',
      fix: 'Run with NODE_ENV=production',
    });
  }

  return issues;
}

/**
 * Prints production posture issues to the console. Returns the issue list so
 * callers can decide whether to abort (e.g. on severity 'error' under a
 * future strict mode).
 */
export function reportProductionPosture(config: PledgeConfig): ProductionPostureIssue[] {
  const issues = checkProductionPosture(config);
  if (issues.length === 0) return issues;

  console.warn('\n  [pledgestack/security] Production posture warnings:\n');
  for (const issue of issues) {
    const tag = issue.severity === 'error' ? 'ERROR' : 'WARN ';
    console.warn(`    ${tag} ${issue.message}`);
    console.warn(`         Fix: ${issue.fix}`);
  }
  console.warn('');
  return issues;
}
