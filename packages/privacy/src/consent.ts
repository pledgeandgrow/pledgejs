import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PledgeRequest } from 'pledgestack-shared';

export type ConsentCategory = 'necessary' | 'analytics' | 'marketing' | 'functional';

export interface ConsentRecord {
  category: ConsentCategory;
  granted: boolean;
  timestamp: number;
  version: string;
}

export interface ConsentState {
  records: ConsentRecord[];
  version: string;
  updatedAt: number;
}

export interface ConsentConfig {
  /** Cookie name for storing consent (default: '__pledge_consent') */
  cookieName?: string;
  /** Consent policy version — bump to re-request consent (default: '1') */
  version?: string;
  /** Cookie max age in seconds (default: 365 days) */
  maxAge?: number;
  /** Categories that cannot be revoked (default: ['necessary']) */
  immutableCategories?: ConsentCategory[];
  /**
   * Secret used to HMAC-sign the consent cookie so a client cannot forge or
   * tamper with the stored consent. Strongly recommended; when omitted the
   * cookie is stored unsigned (and a forged cookie would be accepted).
   */
  secret?: string;
}

const DEFAULT_COOKIE_NAME = '__pledge_consent';
const DEFAULT_VERSION = '1';
const DEFAULT_MAX_AGE = 365 * 24 * 60 * 60;
const DEFAULT_IMMUTABLE: ConsentCategory[] = ['necessary'];

const ALL_CATEGORIES: ConsentCategory[] = ['necessary', 'analytics', 'marketing', 'functional'];

/**
 * Consent manager — GDPR/CCPA-compliant consent tracking with versioned policies.
 *
 * When a `secret` is configured the consent cookie is HMAC-signed and verified
 * on read, so a client cannot forge or tamper with the recorded consent.
 * Supports granular categories, version bumping (re-request on policy change),
 * and immutable categories.
 */
export class ConsentManager {
  private cookieName: string;
  private version: string;
  private maxAge: number;
  private immutable: Set<ConsentCategory>;
  private secret?: string;

  constructor(config: ConsentConfig = {}) {
    this.cookieName = config.cookieName ?? DEFAULT_COOKIE_NAME;
    this.version = config.version ?? DEFAULT_VERSION;
    this.maxAge = config.maxAge ?? DEFAULT_MAX_AGE;
    this.immutable = new Set(config.immutableCategories ?? DEFAULT_IMMUTABLE);
    this.secret = config.secret;
  }

  private sign(value: string): string {
    return createHmac('sha256', this.secret!).update(value).digest('base64url');
  }

  /**
   * Read consent state from request cookies.
   * Returns null if no consent has been given, the version is outdated, or the
   * signature is missing/invalid (when a secret is configured).
   */
  getConsent(req: PledgeRequest): ConsentState | null {
    const raw = req.cookies[this.cookieName];
    if (!raw) return null;

    let payload = raw;
    if (this.secret) {
      // Cookie format when signed: `<encoded>.<signature>`.
      const dot = raw.lastIndexOf('.');
      if (dot === -1) return null;
      const encoded = raw.slice(0, dot);
      const signature = raw.slice(dot + 1);
      // The framework's cookie parser percent-decodes values before they get
      // here, but the signature covers the percent-ENCODED form — accept
      // either representation (encodeURIComponent is canonical, so
      // re-encoding a decoded value reproduces what was signed).
      const sigBuf = Buffer.from(signature);
      const verified = [encoded, encodeURIComponent(encoded)].some((candidate) => {
        const expBuf = Buffer.from(this.sign(candidate));
        return sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf);
      });
      if (!verified) return null;
      payload = encoded;
    }

    try {
      let text = payload;
      try {
        text = decodeURIComponent(payload);
      } catch {
        // Already decoded by the cookie parser (contains a literal '%').
      }
      const state = JSON.parse(text) as ConsentState;
      // Shape check: a crafted (unsigned-mode) cookie like {"version":"1"} must
      // not make hasConsent() throw on state.records.find().
      if (!state || typeof state !== 'object' || !Array.isArray(state.records)) return null;
      if (state.version !== this.version) return null;
      return state;
    } catch {
      return null;
    }
  }

  /**
   * Check if a specific category has consent.
   * 'necessary' is always true.
   */
  hasConsent(req: PledgeRequest, category: ConsentCategory): boolean {
    if (category === 'necessary') return true;
    const state = this.getConsent(req);
    if (!state) return false;
    const record = state.records.find((r) => r.category === category);
    return record?.granted ?? false;
  }

  /**
   * Create a consent state from user selections.
   * Immutable categories are always granted.
   */
  createConsentState(selections: Partial<Record<ConsentCategory, boolean>>): ConsentState {
    const records: ConsentRecord[] = ALL_CATEGORIES.map((category) => ({
      category,
      granted: this.immutable.has(category) ? true : selections[category] ?? false,
      timestamp: Date.now(),
      version: this.version,
    }));

    return {
      records,
      version: this.version,
      updatedAt: Date.now(),
    };
  }

  /**
   * Generate Set-Cookie header for consent state.
   */
  consentCookie(state: ConsentState): string {
    const encoded = encodeURIComponent(JSON.stringify(state));
    const value = this.secret ? `${encoded}.${this.sign(encoded)}` : encoded;
    return [
      `${this.cookieName}=${value}`,
      `Max-Age=${this.maxAge}`,
      'Path=/',
      'SameSite=Lax',
      'Secure',
      'HttpOnly',
    ].join('; ');
  }

  /**
   * Generate Set-Cookie header to clear consent.
   */
  clearConsentCookie(): string {
    return `${this.cookieName}=; Max-Age=0; Path=/; SameSite=Lax; Secure; HttpOnly`;
  }

  /**
   * Check if consent needs to be re-requested (version mismatch or missing).
   */
  needsConsent(req: PledgeRequest): boolean {
    return this.getConsent(req) === null;
  }

  /**
   * Get all categories.
   */
  getCategories(): ConsentCategory[] {
    return [...ALL_CATEGORIES];
  }

  /**
   * Get immutable categories (always granted).
   */
  getImmutableCategories(): ConsentCategory[] {
    return [...this.immutable];
  }
}

/**
 * Cookie consent banner component props.
 * Use in a React component to render the consent UI.
 */
export interface CookieConsentBannerProps {
  /** Consent manager instance */
  manager: ConsentManager;
  /** Current request (for checking existing consent) */
  request: PledgeRequest;
  /** Callback when user accepts all */
  onAcceptAll: () => void;
  /** Callback when user rejects non-necessary */
  onRejectAll: () => void;
  /** Callback when user saves custom preferences */
  onSavePreferences: (selections: Partial<Record<ConsentCategory, boolean>>) => void;
  /** Custom banner title */
  title?: string;
  /** Custom banner message */
  message?: string;
  /** Privacy policy URL */
  privacyPolicyUrl?: string;
}

/**
 * Default banner text values.
 */
export const DEFAULT_BANNER_TEXT = {
  title: 'Cookie Consent',
  message: 'We use cookies to enhance your experience. You can choose which categories to allow.',
  privacyPolicyUrl: '/privacy',
  acceptAll: 'Accept All',
  rejectAll: 'Reject Non-Essential',
  customize: 'Customize',
  save: 'Save Preferences',
} as const;
