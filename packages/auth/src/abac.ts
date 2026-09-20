/**
 * Attribute-based access control (ABAC).
 *
 * Provides:
 * - Policy-based authorization with context-aware rules
 * - IP, time, device, risk score conditions
 * - Composable policy rules with AND/OR logic
 * - Rule evaluation engine
 */

export interface ABACContext {
  userId?: string;
  roles?: string[];
  ip?: string;
  userAgent?: string;
  device?: {
    type?: 'mobile' | 'desktop' | 'tablet' | 'unknown';
    trusted?: boolean;
    fingerprint?: string;
  };
  time?: number;
  route?: string;
  resource?: {
    type?: string;
    owner?: string;
    sensitivity?: 'public' | 'internal' | 'confidential' | 'restricted';
  };
  riskScore?: number;
  metadata?: Record<string, unknown>;
}

export type ABACCondition = (ctx: ABACContext) => boolean;

export interface ABACRule {
  name: string;
  description?: string;
  condition: ABACCondition;
  effect: 'allow' | 'deny';
  priority?: number;
}

export interface ABACPolicy {
  name: string;
  description?: string;
  rules: ABACRule[];
  /** Default effect when no rule matches (default: 'deny') */
  defaultEffect?: 'allow' | 'deny';
}

/**
 * Built-in condition factories for common ABAC scenarios.
 */
/** Strict dotted-quad parser: returns the 32-bit value or null when malformed. */
function parseIPv4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    n = n * 256 + octet;
  }
  return n;
}

export const conditions = {
  /** Check if the IP is in a CIDR range */
  ipInRange(cidr: string): ABACCondition {
    const [range, bits] = cidr.split('/');
    const mask = bits !== undefined ? Number(bits) : 32;
    const rangeNum = parseIPv4(range);
    // An invalid CIDR never matches (fail closed).
    if (rangeNum === null || !Number.isInteger(mask) || mask < 0 || mask > 32) {
      return () => false;
    }
    const maskNum = mask === 0 ? 0 : (~0 << (32 - mask)) >>> 0;

    return (ctx: ABACContext) => {
      if (!ctx.ip) return false;
      const ipNum = parseIPv4(ctx.ip);
      if (ipNum === null) return false;
      return ((ipNum & maskNum) >>> 0) === ((rangeNum & maskNum) >>> 0);
    };
  },

  /** Check if the current time is within business hours */
  businessHours(startHour = 9, endHour = 17): ABACCondition {
    return (ctx: ABACContext) => {
      const time = ctx.time ?? Date.now();
      const date = new Date(time);
      const hour = date.getHours();
      const day = date.getDay();
      return day >= 1 && day <= 5 && hour >= startHour && hour < endHour;
    };
  },

  /** Check if the device is trusted */
  trustedDevice(): ABACCondition {
    return (ctx: ABACContext) => ctx.device?.trusted === true;
  },

  /** Check if the risk score is below a threshold */
  lowRisk(maxScore = 50): ABACCondition {
    return (ctx: ABACContext) => (ctx.riskScore ?? 0) <= maxScore;
  },

  /** Check if the user is the resource owner */
  resourceOwner(): ABACCondition {
    return (ctx: ABACContext) => {
      if (!ctx.userId || !ctx.resource?.owner) return false;
      return ctx.userId === ctx.resource.owner;
    };
  },

  /** Check if the resource sensitivity is at or below a level */
  maxSensitivity(level: 'public' | 'internal' | 'confidential' | 'restricted'): ABACCondition {
    const levels = ['public', 'internal', 'confidential', 'restricted'];
    const maxIndex = levels.indexOf(level);
    return (ctx: ABACContext) => {
      const sensitivity = ctx.resource?.sensitivity ?? 'public';
      const index = levels.indexOf(sensitivity);
      // An unrecognised sensitivity label must not be treated as the lowest level.
      if (index === -1 || maxIndex === -1) return false;
      return index <= maxIndex;
    };
  },

  /** Check if the user has a specific role */
  hasRole(role: string): ABACCondition {
    return (ctx: ABACContext) => ctx.roles?.includes(role) ?? false;
  },

  /** Check if the request is from a mobile device */
  mobileDevice(): ABACCondition {
    return (ctx: ABACContext) => ctx.device?.type === 'mobile';
  },

  /** Combine conditions with AND logic */
  and(...conditions: ABACCondition[]): ABACCondition {
    return (ctx: ABACContext) => conditions.every((c) => c(ctx));
  },

  /** Combine conditions with OR logic */
  or(...conditions: ABACCondition[]): ABACCondition {
    return (ctx: ABACContext) => conditions.some((c) => c(ctx));
  },

  /** Negate a condition */
  not(condition: ABACCondition): ABACCondition {
    return (ctx: ABACContext) => !condition(ctx);
  },
};

/**
 * ABAC policy evaluator.
 */
export class ABACEvaluator {
  private policies: Map<string, ABACPolicy> = new Map();

  /**
   * Register a policy.
   */
  addPolicy(policy: ABACPolicy): void {
    this.policies.set(policy.name, policy);
  }

  /**
   * Register multiple policies.
   */
  addPolicies(policies: ABACPolicy[]): void {
    for (const policy of policies) this.addPolicy(policy);
  }

  /**
   * Evaluate a single policy against a context.
   */
  evaluatePolicy(policyName: string, ctx: ABACContext): 'allow' | 'deny' {
    const policy = this.policies.get(policyName);
    if (!policy) return 'deny';

    const sortedRules = [...policy.rules].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    for (const rule of sortedRules) {
      if (rule.condition(ctx)) {
        return rule.effect;
      }
    }

    return policy.defaultEffect ?? 'deny';
  }

  /**
   * Evaluate multiple policies. If any policy denies, the result is deny.
   */
  evaluate(policyNames: string[], ctx: ABACContext): 'allow' | 'deny' {
    for (const name of policyNames) {
      if (this.evaluatePolicy(name, ctx) === 'deny') return 'deny';
    }
    return 'allow';
  }

  /**
   * Check if access is allowed.
   */
  isAllowed(policyNames: string[], ctx: ABACContext): boolean {
    return this.evaluate(policyNames, ctx) === 'allow';
  }

  /**
   * Create middleware for ABAC enforcement.
   */
  createMiddleware(policyNames: string[]) {
    return (ctx: ABACContext): { allowed: boolean; reason?: string } => {
      const result = this.evaluate(policyNames, ctx);
      if (result === 'deny') {
        return { allowed: false, reason: 'Access denied by ABAC policy' };
      }
      return { allowed: true };
    };
  }
}

/**
 * Create a simple ABAC policy.
 */
export function createPolicy(
  name: string,
  rules: ABACRule[],
  defaultEffect: 'allow' | 'deny' = 'deny',
): ABACPolicy {
  return { name, rules, defaultEffect };
}

/**
 * Create a rule that allows access.
 */
export function allowRule(name: string, condition: ABACCondition, priority = 0): ABACRule {
  return { name, condition, effect: 'allow', priority };
}

/**
 * Create a rule that denies access.
 */
export function denyRule(name: string, condition: ABACCondition, priority = 100): ABACRule {
  return { name, condition, effect: 'deny', priority };
}
