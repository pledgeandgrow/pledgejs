const PII_PATTERNS: Array<{ name: string; pattern: RegExp; replacement: string }> = [
  { name: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[REDACTED-SSN]' },
  { name: 'email', pattern: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g, replacement: '[REDACTED-EMAIL]' },
  { name: 'phone', pattern: /\b\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, replacement: '[REDACTED-PHONE]' },
  { name: 'credit_card', pattern: /\b(?:\d[ -]*?){13,16}\b/g, replacement: '[REDACTED-CC]' },
  { name: 'ip_address', pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, replacement: '[REDACTED-IP]' },
  { name: 'api_key', pattern: /\b(?:sk|pk|api[_-]?key)[_-]?[a-zA-Z0-9]{20,}\b/gi, replacement: '[REDACTED-KEY]' },
  { name: 'jwt', pattern: /\beyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*\b/g, replacement: '[REDACTED-JWT]' },
];

const SENSITIVE_KEYS = new Set([
  'password', 'passwd', 'secret', 'token', 'apiKey', 'api_key',
  'ssn', 'socialSecurity', 'creditCard', 'credit_card',
  'cvv', 'pin', 'privateKey', 'private_key',
  'accessToken', 'access_token', 'refreshToken', 'refresh_token',
  'authorization', 'cookie',
]);

export interface PIIRedactionConfig {
  /** Additional patterns to redact */
  customPatterns?: Array<{ name: string; pattern: RegExp; replacement: string }>;
  /** Additional sensitive key names */
  customSensitiveKeys?: string[];
  /** Keys to skip redaction for (whitelist) */
  whitelistKeys?: string[];
  /** Whether to redact IP addresses (default: true) */
  redactIP?: boolean;
}

/**
 * PII redaction middleware — automatic redaction of sensitive fields
 * from logs, error reports, and any structured data.
 *
 * Redacts:
 * - SSN, email, phone, credit card, IP, API keys, JWTs
 * - Sensitive object keys (password, token, secret, etc.)
 */
export class PIIRedactor {
  private patterns: Array<{ name: string; pattern: RegExp; replacement: string }>;
  private sensitiveKeys: Set<string>;
  private whitelist: Set<string>;

  constructor(config: PIIRedactionConfig = {}) {
    this.patterns = [...PII_PATTERNS, ...(config.customPatterns ?? [])];
    if (config.redactIP === false) {
      this.patterns = this.patterns.filter((p) => p.name !== 'ip_address');
    }
    // Stored lowercased: the built-in list is camelCase ("apiKey"), so an
    // exact-case Set missed "apikey"/"APIKEY"/"ApiKey" variants.
    this.sensitiveKeys = new Set(
      [...SENSITIVE_KEYS, ...(config.customSensitiveKeys ?? [])].map((k) => k.toLowerCase()),
    );
    this.whitelist = new Set(config.whitelistKeys ?? []);
  }

  /**
   * Redact PII from a string.
   */
  redactString(input: string): string {
    let result = input;
    for (const { pattern, replacement } of this.patterns) {
      result = result.replace(pattern, replacement);
    }
    return result;
  }

  /**
   * Redact PII from an object (deep traversal).
   * Sensitive keys are replaced with '[REDACTED]'.
   * String values are pattern-redacted.
   */
  redactObject<T>(input: T): T {
    return this.redactValue(input, new WeakSet<object>()) as T;
  }

  private redactValue(input: unknown, seen: WeakSet<object>): unknown {
    if (input === null || input === undefined) return input;
    if (typeof input === 'string') return this.redactString(input);
    if (typeof input !== 'object') return input;
    // Circular structures (very common in logged request/error objects) must
    // not blow the stack, and non-plain objects (Date, Map, Buffer…) have no
    // enumerable own keys — flattening them to {} silently destroyed the value.
    if (seen.has(input as object)) return '[Circular]';
    if (Array.isArray(input)) {
      seen.add(input);
      return input.map((item) => this.redactValue(item, seen));
    }
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) return input;
    seen.add(input as object);

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (this.whitelist.has(key)) {
        result[key] = value;
        continue;
      }

      if (this.sensitiveKeys.has(key.toLowerCase())) {
        result[key] = '[REDACTED]';
        continue;
      }

      result[key] = this.redactValue(value, seen);
    }
    return result;
  }

  /**
   * Create a redacted error object for logging.
   */
  redactError(error: Error): Record<string, unknown> {
    const obj: Record<string, unknown> = {
      name: error.name,
      message: this.redactString(error.message),
      stack: error.stack ? this.redactString(error.stack) : undefined,
    };
    if (error.cause) {
      obj.cause = this.redactError(error.cause as Error);
    }
    return obj;
  }

  /**
   * Middleware function for log redaction.
   * Wraps a logger function to automatically redact PII.
   */
  wrapLogger(
    logFn: (level: string, message: string, meta?: Record<string, unknown>) => void,
  ): (level: string, message: string, meta?: Record<string, unknown>) => void {
    return (level: string, message: string, meta?: Record<string, unknown>) => {
      const redactedMessage = this.redactString(message);
      const redactedMeta = meta ? this.redactObject(meta) : undefined;
      logFn(level, redactedMessage, redactedMeta);
    };
  }

  /**
   * Get list of redaction pattern names.
   */
  getPatternNames(): string[] {
    return this.patterns.map((p) => p.name);
  }
}

/**
 * Default redactor instance — use directly or create a custom one.
 */
export const defaultRedactor = new PIIRedactor();
