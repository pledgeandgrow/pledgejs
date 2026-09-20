/**
 * GraphQL security utilities.
 *
 * Provides:
 * - Query depth limiting to prevent deeply nested queries
 * - Query complexity analysis with cost-based rejection
 * - Introspection disabling for production
 * - Persisted queries (allowlist) support
 */

export interface GraphQLSecurityConfig {
  /** Maximum query depth (default: 10) */
  maxDepth?: number;
  /** Maximum query complexity cost (default: 1000) */
  maxComplexity?: number;
  /** Disable introspection in production (default: true) */
  disableIntrospection?: boolean;
  /** Enable persisted queries only (block ad-hoc queries) */
  persistedQueriesOnly?: boolean;
  /** Cost per field type */
  fieldCosts?: Record<string, number>;
  /** Default cost per field (default: 1) */
  defaultFieldCost?: number;
  /** Cost multipliers for list fields (default: 2) */
  listMultiplier?: number;
}

const DEFAULT_MAX_DEPTH = 10;
const DEFAULT_MAX_COMPLEXITY = 1000;
const DEFAULT_FIELD_COST = 1;
const DEFAULT_LIST_MULTIPLIER = 2;

const INTROSPECTION_FIELDS = new Set([
  '__schema',
  '__type',
  '__inputValue',
  '__field',
  '__enumValue',
  '__directive',
]);

export interface QueryAnalysisResult {
  depth: number;
  complexity: number;
  allowed: boolean;
  reason?: string;
  fields: string[];
  hasIntrospection: boolean;
}

/**
 * Analyze a GraphQL query string for depth and complexity.
 * This is a lightweight parser — for full AST analysis, use graphql-js's parse().
 */
export function analyzeQuery(query: string, config: GraphQLSecurityConfig = {}): QueryAnalysisResult {
  const maxDepth = config.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxComplexity = config.maxComplexity ?? DEFAULT_MAX_COMPLEXITY;
  const fieldCosts = config.fieldCosts ?? {};
  const defaultCost = config.defaultFieldCost ?? DEFAULT_FIELD_COST;
  const listMultiplier = config.listMultiplier ?? DEFAULT_LIST_MULTIPLIER;

  let depth = 0;
  let complexity = 0;
  let currentDepth = 0;
  let hasIntrospection = false;
  const fields: string[] = [];

  const tokens = tokenizeQuery(query);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token === '{') {
      currentDepth++;
      depth = Math.max(depth, currentDepth);
    } else if (token === '}') {
      currentDepth--;
    } else if (token && !isKeyword(token) && token !== '(' && token !== ')' && token !== ':' && token !== '...' && !token.startsWith('$')) {
      if (INTROSPECTION_FIELDS.has(token)) {
        hasIntrospection = true;
      }

      if (!isGraphQLKeyword(token)) {
        fields.push(token);
        const cost = fieldCosts[token] ?? defaultCost;
        const nextToken = tokens[i + 1];

        if (nextToken === '{') {
          complexity += cost * listMultiplier;
        } else {
          complexity += cost;
        }
      }
    }
  }

  const reasons: string[] = [];
  if (depth > maxDepth) {
    reasons.push(`Query depth ${depth} exceeds maximum ${maxDepth}`);
  }
  if (complexity > maxComplexity) {
    reasons.push(`Query complexity ${complexity} exceeds maximum ${maxComplexity}`);
  }
  if (hasIntrospection && (config.disableIntrospection ?? true)) {
    reasons.push('Introspection is disabled');
  }

  return {
    depth,
    complexity,
    allowed: reasons.length === 0,
    reason: reasons.length > 0 ? reasons.join('; ') : undefined,
    fields,
    hasIntrospection,
  };
}

/**
 * Validate a GraphQL query against security config.
 * Returns an error message if the query is rejected.
 */
export function validateQuery(query: string, config: GraphQLSecurityConfig = {}): string | null {
  const analysis = analyzeQuery(query, config);
  if (!analysis.allowed) {
    return analysis.reason ?? 'Query rejected by security policy';
  }
  return null;
}

/**
 * Check if a query contains introspection fields.
 */
export function isIntrospectionQuery(query: string): boolean {
  return analyzeQuery(query).hasIntrospection;
}

/**
 * Persisted query store — maps query hashes to full query strings.
 * Only allow queries that have been pre-registered.
 */
export class PersistedQueryStore {
  private queries: Map<string, string> = new Map();

  register(hash: string, query: string): void {
    this.queries.set(hash, query);
  }

  get(hash: string): string | undefined {
    return this.queries.get(hash);
  }

  has(hash: string): boolean {
    return this.queries.has(hash);
  }

  /**
   * Resolve a persisted query hash to the full query.
   * Returns null if the hash is not registered.
   */
  resolve(hash: string): string | null {
    return this.queries.get(hash) ?? null;
  }

  /**
   * Check if a request should be allowed based on persisted query policy.
   * If persistedQueriesOnly is true, only registered hashes are allowed.
   */
  isAllowed(hash: string | undefined, _query: string | undefined, persistedOnly: boolean): boolean {
    if (!persistedOnly) return true;
    if (!hash) return false;
    return this.has(hash);
  }

  clear(): void {
    this.queries.clear();
  }

  size(): number {
    return this.queries.size;
  }
}

/**
 * Create a GraphQL security middleware function.
 * Use in route handlers to validate incoming GraphQL queries.
 */
export function createGraphQLSecurityMiddleware(config: GraphQLSecurityConfig = {}) {
  const store = new PersistedQueryStore();
  const persistedOnly = config.persistedQueriesOnly ?? false;

  return {
    store,
    validate(query: string): { allowed: boolean; error?: string } {
      const error = validateQuery(query, config);
      if (error) return { allowed: false, error };
      return { allowed: true };
    },
    validateRequest(params: { query?: string; persistedQueryKey?: string }): { allowed: boolean; error?: string } {
      if (persistedOnly) {
        const key = params.persistedQueryKey;
        if (!key || !store.has(key)) {
          return { allowed: false, error: 'Persisted query not found. Ad-hoc queries are not allowed.' };
        }
        const resolvedQuery = store.resolve(key);
        if (resolvedQuery) {
          return this.validate(resolvedQuery);
        }
      }

      if (!params.query) {
        return { allowed: false, error: 'No query provided' };
      }

      return this.validate(params.query);
    },
  };
}

function tokenizeQuery(query: string): string[] {
  return query
    // Drop string literals FIRST (block strings, then quoted strings) so braces,
    // parens or '#' inside argument values can't skew depth/complexity counts
    // or be mistaken for comments.
    .replace(/"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"/g, '')
    .replace(/#.*/g, '')
    .replace(/"/g, '')
    // Match the `...` spread as a single token (alternation) — inside the
    // character class it was just three literal dots, so fragment spreads
    // (`...Frag`, `...on Type`) were split into three `.` tokens and never
    // recognized, inflating the complexity/field counts.
    .split(/(\.\.\.|\s+|[{}()!:,])/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function isKeyword(token: string): boolean {
  return ['query', 'mutation', 'subscription', 'fragment', 'on', 'schema', 'type', 'input', 'interface', 'union', 'enum', 'scalar', 'directive', 'extend', 'implements'].includes(token.toLowerCase());
}

function isGraphQLKeyword(token: string): boolean {
  return isKeyword(token) || token === '...' || token.startsWith('$');
}
