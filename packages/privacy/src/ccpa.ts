import type { PledgeRequest, PledgeResponse } from 'pledgestack-shared';
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface CCPAConfig {
  /** Privacy policy URL */
  privacyPolicyUrl?: string;
  /** Do Not Sell endpoint path (default: '/api/privacy/do-not-sell') */
  doNotSellEndpoint?: string;
  /** Data categories collected */
  dataCategories?: DataCategory[];
  /** HMAC secret for signing the opt-out cookie (required to prevent forgery) */
  cookieSecret?: string;
  /**
   * Reject unsigned opt-out cookies instead of accepting them (default: false).
   * Without a cookieSecret the opt-out cookie is forgeable by clients — set
   * this to true (and provide a secret) for production deployments.
   */
  requireSignedCookies?: boolean;
}

export interface DataCategory {
  /** Category name (e.g. 'Personal Identifiers') */
  name: string;
  /** Description of data collected */
  description: string;
  /** Examples of data points */
  examples: string[];
  /** Whether this data is sold or shared */
  soldOrShared: boolean;
  /** Whether users can opt out */
  optOutAvailable: boolean;
}

const DEFAULT_DATA_CATEGORIES: DataCategory[] = [
  {
    name: 'Personal Identifiers',
    description: 'Name, email, phone, user ID',
    examples: ['email', 'name', 'phone'],
    soldOrShared: false,
    optOutAvailable: true,
  },
  {
    name: 'Internet Activity',
    description: 'Browsing history, search queries, interactions',
    examples: ['page views', 'search queries'],
    soldOrShared: false,
    optOutAvailable: true,
  },
  {
    name: 'Geolocation Data',
    description: 'Approximate location derived from IP',
    examples: ['IP address', 'city'],
    soldOrShared: false,
    optOutAvailable: true,
  },
];

const DEFAULT_DO_NOT_SELL_ENDPOINT = '/api/privacy/do-not-sell';

/**
 * CCPA compliance helpers — "Do Not Sell My Personal Information" endpoint,
 * privacy policy generator, data category labeling.
 */
export class CCPAManager {
  private config: Required<Omit<CCPAConfig, 'cookieSecret' | 'requireSignedCookies'>>;
  private cookieSecret: string | null;
  private requireSignedCookies: boolean;

  constructor(config: CCPAConfig = {}) {
    this.config = {
      privacyPolicyUrl: config.privacyPolicyUrl ?? '/privacy',
      doNotSellEndpoint: config.doNotSellEndpoint ?? DEFAULT_DO_NOT_SELL_ENDPOINT,
      dataCategories: config.dataCategories ?? DEFAULT_DATA_CATEGORIES,
    };
    this.cookieSecret = config.cookieSecret ?? null;
    this.requireSignedCookies = config.requireSignedCookies ?? false;
    if (!this.cookieSecret) {
      console.warn(
        '[pledgestack-privacy] CCPAManager: no cookieSecret configured — the opt-out cookie is UNSIGNED and forgeable by clients. ' +
          'Provide cookieSecret (and set requireSignedCookies: true) for production use.',
      );
    }
  }

  /**
   * Sign a cookie value with HMAC to prevent client-side forgery.
   * Format: value.signature
   */
  private signCookie(value: string): string {
    if (!this.cookieSecret) return value;
    const sig = createHmac('sha256', this.cookieSecret).update(value).digest('base64url');
    return `${value}.${sig}`;
  }

  /**
   * Verify a signed cookie value. Returns the original value if the signature
   * is valid, or null if tampered. Unsigned cookies are accepted only in
   * legacy mode (no secret configured AND requireSignedCookies is false).
   */
  private verifyCookie(raw: string | undefined): string | null {
    if (!raw) return null;
    if (!this.cookieSecret) {
      // No secret: unsigned cookies accepted only when not enforced.
      return this.requireSignedCookies ? null : raw;
    }
    const parts = raw.split('.');
    if (parts.length !== 2) return null;
    const [value, sig] = parts;
    const expected = createHmac('sha256', this.cookieSecret).update(value).digest('base64url');
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length) return null;
    if (!timingSafeEqual(sigBuf, expBuf)) return null;
    return value;
  }

  /**
   * Handle a "Do Not Sell My Personal Information" request.
   * Call from a route.ts POST handler.
   */
  handleDoNotSellRequest(req: PledgeRequest): PledgeResponse {
    const userId = (req as PledgeRequest & { session?: { userId?: string } }).session?.userId;
    if (!userId) {
      return {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Authentication required to submit Do Not Sell request' }),
      };
    }

    const rawBody = typeof (req as PledgeRequest & { body?: string }).body === 'string'
      ? (req as PledgeRequest & { body?: string }).body
      : '';
    let optOut = true;
    try {
      const parsed = JSON.parse(rawBody || '{}') as { optOut?: boolean };
      optOut = parsed.optOut ?? true;
    } catch {
      // Default to opt-out if body is invalid
    }

    return {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': `__pledge_ccpa_opt_out=${this.signCookie(optOut ? 'true' : 'false')}; Max-Age=${365 * 24 * 60 * 60}; Path=/; SameSite=Lax; Secure; HttpOnly`,
      },
      body: JSON.stringify({
        userId,
        optOut,
        message: optOut
          ? 'Your data will not be sold or shared. This preference is stored for 12 months.'
          : 'Opt-out preference removed. Your data may be sold or shared per the privacy policy.',
        submittedAt: new Date().toISOString(),
      }),
    };
  }

  /**
   * Check if a user has opted out of data selling.
   * Verifies the HMAC signature to prevent cookie forgery.
   */
  hasOptedOut(req: PledgeRequest): boolean {
    const raw = req.cookies['__pledge_ccpa_opt_out'];
    const value = this.verifyCookie(raw);
    return value === 'true';
  }

  /**
   * Generate a privacy policy markdown from configured data categories.
   */
  generatePrivacyPolicy(): string {
    const categories = this.config.dataCategories
      .map((cat) => {
        const soldStatus = cat.soldOrShared
          ? 'This data **may be sold or shared** with third parties.'
          : 'This data is **not sold or shared** with third parties.';
        const optOut = cat.optOutAvailable
          ? 'You may opt out of the collection of this data.'
          : 'Opt-out is not available for this category.';
        return `### ${cat.name}\n\n${cat.description}.\n\n**Examples:** ${cat.examples.join(', ')}\n\n${soldStatus} ${optOut}`;
      })
      .join('\n\n');

    return `# Privacy Policy

Last updated: ${new Date().toISOString().split('T')[0]}

## Information We Collect

${categories}

## Your CCPA Rights

- **Right to Know** — You may request disclosure of the categories and specific pieces of personal information we collect.
- **Right to Delete** — You may request deletion of your personal information.
- **Right to Opt Out** — You may opt out of the sale or sharing of your personal information.
- **Right to Non-Discrimination** — We will not discriminate against you for exercising your privacy rights.

## How to Exercise Your Rights

- Submit a "Do Not Sell My Personal Information" request at ${this.config.doNotSellEndpoint}
- Contact us to request data access or deletion

## Data Retention

We retain personal information only as long as necessary for the purposes described in this policy.
`;
  }

  /**
   * Get the data categories configuration.
   */
  getDataCategories(): DataCategory[] {
    return [...this.config.dataCategories];
  }

  /**
   * Get the do-not-sell endpoint path.
   */
  getDoNotSellEndpoint(): string {
    return this.config.doNotSellEndpoint;
  }
}
