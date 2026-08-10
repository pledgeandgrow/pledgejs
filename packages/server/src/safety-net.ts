/**
 * Developer safety net — bot detection, brute force protection,
 * error boundary telemetry, development security warnings.
 *
 * Items 170, 171, 175, 176 of the PledgeStack roadmap.
 */


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
  const shouldChallenge = confidence >= 0.3 && confidence < 0.7;

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
<form method="POST" action="${action}">
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

const attemptStore = new Map<string, FailedAttempt>();

/** Max entries in the brute force store before cleanup evicts stale entries */
const MAX_ATTEMPT_STORE_ENTRIES = 10000;

/** Periodic cleanup interval (10 minutes) */
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
let bruteForceCleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Removes stale entries from the attempt store.
 * An entry is stale if its window has passed AND it's not currently locked out.
 */
function cleanupStaleAttempts(): void {
  const now = Date.now();
  for (const [key, entry] of attemptStore.entries()) {
    const windowPassed = now - entry.firstAttemptAt > defaultBruteForceConfig.windowMs;
    const notLocked = entry.lockedUntil <= now;
    if (windowPassed && notLocked) {
      attemptStore.delete(key);
    }
  }
}

/**
 * Ensures the periodic cleanup timer is running.
 * Called automatically when brute force protection is used.
 */
function ensureBruteForceCleanup(): void {
  if (bruteForceCleanupTimer) return;
  bruteForceCleanupTimer = setInterval(cleanupStaleAttempts, CLEANUP_INTERVAL_MS);
  if (bruteForceCleanupTimer.unref) bruteForceCleanupTimer.unref();
}

/**
 * Stops the brute force cleanup timer (for tests or graceful shutdown).
 */
export function stopBruteForceCleanup(): void {
  if (bruteForceCleanupTimer) {
    clearInterval(bruteForceCleanupTimer);
    bruteForceCleanupTimer = null;
  }
}

/**
 * Enforces max entry limit by removing stale entries first, then oldest if needed.
 */
function enforceAttemptStoreLimit(): void {
  if (attemptStore.size <= MAX_ATTEMPT_STORE_ENTRIES) return;
  // First try cleaning up stale entries
  cleanupStaleAttempts();
  // If still over limit, remove oldest entries
  if (attemptStore.size <= MAX_ATTEMPT_STORE_ENTRIES) return;
  const toEvict = attemptStore.size - MAX_ATTEMPT_STORE_ENTRIES;
  let count = 0;
  for (const key of attemptStore.keys()) {
    if (count >= toEvict) break;
    attemptStore.delete(key);
    count++;
  }
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
export function checkBruteForce(
  identifier: string,
  config: Partial<BruteForceConfig> = {},
): BruteForceCheckResult {
  ensureBruteForceCleanup();
  const cfg = { ...defaultBruteForceConfig, ...config };
  const now = Date.now();
  let entry = attemptStore.get(identifier);

  // Reset if window has passed
  if (entry && now - entry.firstAttemptAt > cfg.windowMs) {
    attemptStore.delete(identifier);
    entry = undefined;
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
export function recordFailedAttempt(
  identifier: string,
  config: Partial<BruteForceConfig> = {},
): BruteForceCheckResult {
  const cfg = { ...defaultBruteForceConfig, ...config };
  const now = Date.now();
  let entry = attemptStore.get(identifier);

  if (!entry || now - entry.firstAttemptAt > cfg.windowMs) {
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

  attemptStore.set(identifier, entry);
  enforceAttemptStoreLimit();

  return checkBruteForce(identifier, config);
}

/**
 * Clears failed attempts after successful authentication.
 */
export function clearFailedAttempts(identifier: string): void {
  attemptStore.delete(identifier);
}

/**
 * Gets the current brute force state for an identifier.
 */
export function getBruteForceState(identifier: string): FailedAttempt | null {
  return attemptStore.get(identifier) ?? null;
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
