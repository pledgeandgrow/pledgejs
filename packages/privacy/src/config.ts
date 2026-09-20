export interface PrivacyConfig {
  /** Enable analytics tracking (default: false) */
  analytics?: boolean;
  /** Enable telemetry (default: false) */
  telemetry?: boolean;
  /** Enable error reporting to third parties (default: false) */
  errorReporting?: boolean;
  /** Enable performance monitoring (default: false) */
  performanceMonitoring?: boolean;
  /** Enable third-party scripts (default: false) */
  thirdPartyScripts?: boolean;
  /** Enable advertising cookies (default: false) */
  advertising?: boolean;
  /** Default consent required before loading non-necessary scripts (default: true) */
  requireConsent?: boolean;
  /** Data retention period in days (default: 90) */
  dataRetentionDays?: number;
  /** Enable PII redaction in logs (default: true) */
  redactPII?: boolean;
  /** Cookie consent policy version (default: '1') */
  consentVersion?: string;
}

/**
 * Privacy-by-default configuration.
 *
 * All tracking, analytics, telemetry, and third-party scripts are
 * disabled by default. Explicit opt-in is required for each.
 *
 * Usage in pledge.config.ts:
 * ```typescript
 * export default defineConfig({
 *   privacy: {
 *     analytics: false,        // must explicitly enable
 *     telemetry: false,        // must explicitly enable
 *     requireConsent: true,    // consent required by default
 *   },
 * });
 * ```
 */
export const DEFAULT_PRIVACY_CONFIG: Required<PrivacyConfig> = {
  analytics: false,
  telemetry: false,
  errorReporting: false,
  performanceMonitoring: false,
  thirdPartyScripts: false,
  advertising: false,
  requireConsent: true,
  dataRetentionDays: 90,
  redactPII: true,
  consentVersion: '1',
};

/**
 * Resolve user privacy config with defaults.
 * Ensures all fields are set and opt-in is enforced.
 */
export function resolvePrivacyConfig(userConfig?: PrivacyConfig): Required<PrivacyConfig> {
  // Drop explicit `undefined`s: spreading them would overwrite a safe default
  // (e.g. requireConsent: undefined silently disabled the consent requirement).
  const defined = Object.fromEntries(
    Object.entries(userConfig ?? {}).filter(([, v]) => v !== undefined),
  ) as PrivacyConfig;
  return { ...DEFAULT_PRIVACY_CONFIG, ...defined };
}

/**
 * Check if a feature is allowed given the privacy config and consent state.
 */
export function isFeatureAllowed(
  feature: 'analytics' | 'telemetry' | 'errorReporting' | 'performanceMonitoring' | 'thirdPartyScripts' | 'advertising',
  config: Required<PrivacyConfig>,
  hasConsent: boolean,
): boolean {
  if (!config[feature]) return false;
  if (config.requireConsent && !hasConsent) return false;
  return true;
}

/**
 * Get a list of all features that are enabled in the config.
 */
export function getEnabledFeatures(config: Required<PrivacyConfig>): string[] {
  const features: string[] = [];
  if (config.analytics) features.push('analytics');
  if (config.telemetry) features.push('telemetry');
  if (config.errorReporting) features.push('errorReporting');
  if (config.performanceMonitoring) features.push('performanceMonitoring');
  if (config.thirdPartyScripts) features.push('thirdPartyScripts');
  if (config.advertising) features.push('advertising');
  return features;
}
