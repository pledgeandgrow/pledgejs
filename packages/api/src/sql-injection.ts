/**
 * SQL injection prevention utilities.
 *
 * Provides:
 * - Parameterized query builder that enforces bind parameters
 * - String concatenation detection in SQL queries
 * - Query sanitization for unsafe inputs
 */

const SQL_KEYWORDS = /\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|CREATE|ALTER|EXEC|TRUNCATE|GRANT|REVOKE)\b/gi;
const DANGEROUS_PATTERNS: RegExp[] = [
  /;\s*\w+/i,
  /--/i,
  /\/\*/i,
  /\*\//i,
  /\bUNION\s+(?:ALL\s+)?SELECT\b/i,
  /\bOR\s+1\s*=\s*1\b/i,
  /\bAND\s+1\s*=\s*1\b/i,
  /\bWAITFOR\s+DELAY\b/i,
  /\bBENCHMARK\s*\(/i,
  /\bSLEEP\s*\(/i,
  /\bLOAD_FILE\s*\(/i,
  /\bINTO\s+(?:OUT|DUMP)FILE\b/i,
  /\bCHAR\s*\(\s*\d+/i,
  /\bCONCAT\s*\(/i,
  /\bGROUP_CONCAT\s*\(/i,
  /\bINFORMATION_SCHEMA\b/i,
];

export interface ParameterizedQuery {
  sql: string;
  params: unknown[];
}

export class QueryBuilder {
  private parts: string[] = [];
  private params: unknown[] = [];

  /**
   * Append raw SQL — only for static, non-user-controlled strings.
   * Detects potential injection patterns.
   */
  raw(sql: string): this {
    this.detectConcatenation(sql);
    this.parts.push(sql);
    return this;
  }

  /**
   * Append a parameterized value.
   * The placeholder style depends on the database driver.
   */
  param(value: unknown, placeholder = '?'): this {
    this.parts.push(placeholder);
    this.params.push(value);
    return this;
  }

  /**
   * Append a column/table identifier (validated against allowlist).
   */
  identifier(name: string, allowlist?: string[]): this {
    if (allowlist && !allowlist.includes(name)) {
      throw new Error(`Identifier "${name}" not in allowlist`);
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      throw new Error(`Invalid identifier: ${name}`);
    }
    this.parts.push(`"${name}"`);
    return this;
  }

  /**
   * Build the final parameterized query.
   */
  build(): ParameterizedQuery {
    return {
      sql: this.parts.join(' '),
      params: this.params,
    };
  }

  /**
   * Detect string concatenation patterns that suggest SQL injection.
   */
  private detectConcatenation(sql: string): void {
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(sql)) {
        throw new Error(`Potential SQL injection detected in query: pattern "${pattern.source}" matched`);
      }
    }
  }
}

/**
 * Sanitize a string for safe inclusion in SQL contexts.
 * This should NOT be used as a replacement for parameterized queries.
 * Use only when parameterization is impossible (e.g. dynamic identifiers).
 */
export function sanitizeSqlInput(input: string): string {
  return input
    .replace(/'/g, "''")
    .replace(/"/g, '""')
    .replace(/\\/g, '\\\\')
    // eslint-disable-next-line no-control-regex -- strip null bytes from SQL input
    .replace(/\x00/g, '')
    .replace(/\n/g, ' ')
    .replace(/\r/g, ' ');
}

/**
 * Detect potential SQL injection in a string.
 * Returns true if suspicious patterns are found.
 */
export function detectSqlInjection(input: string): boolean {
  if (typeof input !== 'string') return false;
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(input)) return true;
  }
  if (SQL_KEYWORDS.test(input)) {
    SQL_KEYWORDS.lastIndex = 0;
    return true;
  }
  return false;
}

/**
 * Validate that a query uses parameterized values, not string concatenation.
 * Checks for common concatenation patterns: +, template literals with ${}, string concat.
 */
export function validateParameterized(query: string): { safe: boolean; reason?: string } {
  if (/\$\{/.test(query) && !query.includes('?') && !query.includes('$1')) {
    return { safe: false, reason: 'Query uses template literal interpolation without parameter placeholders' };
  }

  if (/['"]?\s*\+\s*['"]?/.test(query) && !query.includes('?')) {
    return { safe: false, reason: 'Query appears to use string concatenation without parameter placeholders' };
  }

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(query)) {
      return { safe: false, reason: `Dangerous SQL pattern detected: ${pattern.source}` };
    }
  }

  return { safe: true };
}

/**
 * Create a safe query builder instance.
 */
export function createQueryBuilder(): QueryBuilder {
  return new QueryBuilder();
}
