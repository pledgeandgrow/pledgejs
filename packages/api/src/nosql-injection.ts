/**
 * NoSQL injection prevention utilities.
 *
 * Provides:
 * - Sanitization of MongoDB-style operator queries
 * - Blocking of dangerous operators ($where, $function, $expr)
 * - Deep sanitization of query objects from user input
 */

const DANGEROUS_OPERATORS = new Set([
  '$where',
  '$function',
  '$expr',
]);

const SENSITIVE_OPERATORS = new Set([
  '$ne',
  '$gt',
  '$gte',
  '$lt',
  '$lte',
  '$in',
  '$nin',
  '$exists',
  '$regex',
  '$mod',
  '$size',
  '$all',
  '$elemMatch',
  '$not',
  '$or',
  '$and',
  '$nor',
]);

export type MongoValue = string | number | boolean | null | MongoQuery | MongoValue[];
export interface MongoQuery {
  [key: string]: MongoValue;
}

export interface SanitizeOptions {
  /** Block all operator keys (not just dangerous ones) */
  blockAllOperators?: boolean;
  /** Allowlist of permitted operators */
  allowedOperators?: string[];
  /** Max depth of nested query objects */
  maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 10;

/**
 * Sanitize a MongoDB-style query object from user input.
 *
 * Removes dangerous operators ($where, $function, $expr) that can execute
 * arbitrary JavaScript or perform expensive operations.
 */
export function sanitizeMongoQuery(
  query: unknown,
  options: SanitizeOptions = {},
  depth = 0,
): MongoQuery | MongoValue[] | null {
  if (depth > (options.maxDepth ?? DEFAULT_MAX_DEPTH)) {
    throw new Error(`Query depth exceeds maximum of ${options.maxDepth ?? DEFAULT_MAX_DEPTH}`);
  }

  if (query === null || query === undefined) return null;
  if (typeof query !== 'object') return null;
  if (Array.isArray(query)) {
    // Array input produces an array of sanitized values — return MongoValue[]
    // honestly rather than casting an array to MongoQuery, which broke
    // callers expecting object semantics.
    return query
      .map((item) => sanitizeMongoQuery(item, options, depth + 1))
      .filter((v): v is NonNullable<typeof v> => v !== null);
  }

  const result: MongoQuery = {};
  const allowed = options.allowedOperators ? new Set(options.allowedOperators) : null;

  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (key.startsWith('$')) {
      if (DANGEROUS_OPERATORS.has(key)) {
        continue;
      }

      if (options.blockAllOperators) {
        continue;
      }

      if (allowed && !allowed.has(key)) {
        continue;
      }

      if (SENSITIVE_OPERATORS.has(key)) {
        // Sensitive query operators ($ne, $gt, $regex, $in, …) are the vector
        // for NoSQL operator-injection auth bypasses such as
        // `{ password: { $ne: null } }`. They are stripped by default and only
        // kept when the caller explicitly opts in through `allowedOperators`.
        if (!allowed) {
          continue;
        }
        result[key] = sanitizeValue(value, options, depth + 1);
        continue;
      }

      result[key] = sanitizeValue(value, options, depth + 1);
    } else {
      result[key] = sanitizeValue(value, options, depth + 1);
    }
  }

  return result;
}

/**
 * Sanitize a scalar or object value.
 */
function sanitizeValue(value: unknown, options: SanitizeOptions, depth: number): MongoValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'object') {
    const sanitized = sanitizeMongoQuery(value, options, depth);
    return sanitized ?? null;
  }
  return null;
}

/**
 * Check if a query object contains dangerous operators.
 */
export function hasDangerousOperators(query: unknown): boolean {
  if (query === null || typeof query !== 'object') return false;

  if (Array.isArray(query)) {
    return query.some(hasDangerousOperators);
  }

  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (DANGEROUS_OPERATORS.has(key)) return true;
    if (typeof value === 'object' && value !== null && hasDangerousOperators(value)) return true;
  }

  return false;
}

/**
 * Strip $-prefixed keys from an object, keeping only plain field values.
 * Use when user input should only contain field:value pairs, not operators.
 */
export function stripOperators(query: unknown): Record<string, unknown> {
  if (query === null || typeof query !== 'object' || Array.isArray(query)) {
    return {};
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (!key.startsWith('$')) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        result[key] = stripOperators(value);
      } else {
        result[key] = value;
      }
    }
  }
  return result;
}

/**
 * Sanitize a MongoDB projection object (field selection).
 * Only allows field names with 0/1 values, no operators.
 */
export function sanitizeProjection(projection: unknown): Record<string, 0 | 1> {
  if (projection === null || typeof projection !== 'object' || Array.isArray(projection)) {
    return {};
  }

  const result: Record<string, 0 | 1> = {};
  for (const [key, value] of Object.entries(projection as Record<string, unknown>)) {
    if (key.startsWith('$')) continue;
    if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(key)) continue;
    result[key] = value === 1 || value === true ? 1 : 0;
  }
  return result;
}

/**
 * Create a safe query sanitizer with configured options.
 */
export function createQuerySanitizer(options: SanitizeOptions = {}): (query: unknown) => MongoQuery | MongoValue[] | null {
  return (query: unknown) => sanitizeMongoQuery(query, options);
}
