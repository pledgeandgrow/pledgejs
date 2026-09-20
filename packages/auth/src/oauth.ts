/**
 * OAuth 2.1 / OIDC integration.
 *
 * Provides:
 * - Built-in OAuth provider support with PKCE
 * - State validation
 * - Automatic token refresh
 * - OIDC userinfo endpoint support
 */

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { generateToken } from './index';

/**
 * Encrypt the PKCE code_verifier so it can travel inside the OAuth `state`
 * (through the browser and IdP) without being recoverable by anyone who
 * observes it. The `state` is signed but NOT otherwise encrypted, so embedding
 * the raw verifier there defeated the point of PKCE. AES-256-GCM with a key
 * derived from the app secret keeps it confidential and tamper-evident.
 */
function encryptVerifier(verifier: string, secret: string): string {
  const key = scryptSync(secret, 'pledge-oauth-pkce', 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(verifier, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64url');
}

function decryptVerifier(blob: string, secret: string): string | null {
  try {
    const buf = Buffer.from(blob, 'base64url');
    if (buf.length < 28) return null;
    const key = scryptSync(secret, 'pledge-oauth-pkce', 32);
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export interface OAuthProviderConfig {
  /** Provider name (e.g. 'google', 'github') */
  name: string;
  /** Authorization endpoint URL */
  authorizeUrl: string;
  /** Token endpoint URL */
  tokenUrl: string;
  /** Userinfo endpoint URL (OIDC) */
  userinfoUrl?: string;
  /** Client ID */
  clientId: string;
  /** Client secret */
  clientSecret: string;
  /** Redirect URI */
  redirectUri: string;
  /** Requested scopes */
  scopes: string[];
  /** Whether PKCE is required (default: true per OAuth 2.1) */
  pkceRequired?: boolean;
}

export interface OAuthState {
  provider: string;
  redirect: string;
  codeVerifier: string;
  nonce: string;
  timestamp: number;
  /**
   * SHA-256 (base64url) of the per-browser binding secret held in a cookie.
   * Ties the state to the browser that started the flow (login-CSRF defense).
   */
  bind?: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  tokenType: string;
  expiresAt: number;
  scope?: string;
}

export interface OAuthUserInfo {
  id: string;
  email?: string;
  /** Whether the IdP has verified the email (OIDC `email_verified` claim) */
  emailVerified?: boolean;
  name?: string;
  avatar?: string;
  provider: string;
  raw?: Record<string, unknown>;
}

export interface PKCEChallenge {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

/**
 * Generate a PKCE code verifier and challenge pair.
 * PKCE is required in OAuth 2.1.
 */
export function generatePKCE(): PKCEChallenge {
  const codeVerifier = randomBytes(32).toString('base64url');
  // PKCE S256 (RFC 7636 §4.2) is BASE64URL(SHA-256(ASCII(code_verifier))).
  // This was previously an HMAC keyed by the verifier over an empty message,
  // which no conformant IdP accepts — the code exchange always failed.
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge, codeChallengeMethod: 'S256' };
}

/**
 * Cookie the app must set (HttpOnly, Secure, SameSite=Lax, short-lived) to
 * the `browserBinding` value returned by OAuthManager.initiateAuth().
 */
export const OAUTH_BINDING_COOKIE = '__Host-pledge_oauth';

function hashBinding(binding: string): string {
  return createHash('sha256').update(binding).digest('base64url');
}

/**
 * Create a signed OAuth state parameter.
 * The state encodes the provider, redirect URL, PKCE verifier, and nonce.
 */
export function createOAuthStateParam(
  provider: string,
  redirect: string,
  codeVerifier: string,
  secret: string,
  browserBinding?: string,
): string {
  const nonce = generateToken(16);
  const payload: OAuthState = {
    provider,
    redirect,
    // Store the verifier ENCRYPTED, not in plaintext.
    codeVerifier: encryptVerifier(codeVerifier, secret),
    nonce,
    timestamp: Date.now(),
    ...(browserBinding ? { bind: hashBinding(browserBinding) } : {}),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

/**
 * Verify and decode an OAuth state parameter.
 * Returns null if the signature is invalid or the state is expired.
 */
export function verifyOAuthStateParam(
  state: string,
  secret: string,
  maxAgeSeconds = 600,
): OAuthState | null {
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts;
  const expected = createHmac('sha256', secret).update(encoded).digest('base64url');
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const data: OAuthState = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    if (Date.now() - data.timestamp > maxAgeSeconds * 1000) return null;
    // Decrypt the verifier back to plaintext for the token exchange.
    const verifier = decryptVerifier(data.codeVerifier, secret);
    if (verifier === null) return null;
    data.codeVerifier = verifier;
    return data;
  } catch {
    return null;
  }
}

/**
 * Build the authorization URL for a provider.
 */
export function buildAuthorizeUrl(
  provider: OAuthProviderConfig,
  state: string,
  pkce: PKCEChallenge,
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: provider.clientId,
    redirect_uri: provider.redirectUri,
    state,
    scope: provider.scopes.join(' '),
    code_challenge: pkce.codeChallenge,
    code_challenge_method: pkce.codeChallengeMethod,
  });
  return `${provider.authorizeUrl}?${params}`;
}

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeCodeForTokens(
  provider: OAuthProviderConfig,
  code: string,
  codeVerifier: string,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: provider.redirectUri,
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
    code_verifier: codeVerifier,
  });

  const response = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json() as any;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    idToken: data.id_token,
    tokenType: data.token_type ?? 'Bearer',
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    scope: data.scope,
  };
}

/**
 * Refresh an access token using a refresh token.
 */
export async function refreshAccessToken(
  provider: OAuthProviderConfig,
  refreshToken: string,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
  });

  const response = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`);
  }

  const data = await response.json() as any;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    tokenType: data.token_type ?? 'Bearer',
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    scope: data.scope,
  };
}

/**
 * Fetch user info from the provider's userinfo endpoint.
 */
export async function fetchUserInfo(
  provider: OAuthProviderConfig,
  accessToken: string,
): Promise<OAuthUserInfo> {
  if (!provider.userinfoUrl) {
    throw new Error(`Provider ${provider.name} does not have a userinfo endpoint`);
  }

  const response = await fetch(provider.userinfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`Userinfo fetch failed: ${response.status}`);
  }

  const data = await response.json() as any;
  return normalizeUserInfo(data, provider.name);
}

/**
 * Check if a token needs refresh (expires within 5 minutes).
 */
export function needsRefresh(tokens: OAuthTokens): boolean {
  return Date.now() > tokens.expiresAt - 5 * 60 * 1000;
}

/**
 * Auto-refresh tokens if needed.
 */
export async function ensureValidTokens(
  provider: OAuthProviderConfig,
  tokens: OAuthTokens,
): Promise<OAuthTokens> {
  if (!needsRefresh(tokens)) return tokens;
  if (!tokens.refreshToken) return tokens;
  return refreshAccessToken(provider, tokens.refreshToken);
}

/**
 * OAuth provider manager — handles multiple providers.
 */
export class OAuthManager {
  private providers: Map<string, OAuthProviderConfig> = new Map();
  private secret: string;

  constructor(secret: string) {
    this.secret = secret;
  }

  registerProvider(config: OAuthProviderConfig): void {
    this.providers.set(config.name, config);
  }

  getProvider(name: string): OAuthProviderConfig | undefined {
    return this.providers.get(name);
  }

  /**
   * Starts an authorization flow. The returned `browserBinding` MUST be stored
   * in the initiating browser (cookie `OAUTH_BINDING_COOKIE`, HttpOnly, Secure,
   * SameSite=Lax) and passed back to handleCallback() — otherwise an attacker
   * could start a flow themselves and trick a victim into completing it
   * (login CSRF / session fixation onto the attacker's account).
   */
  initiateAuth(providerName: string, redirect: string): { url: string; state: string; browserBinding: string } {
    const provider = this.providers.get(providerName);
    if (!provider) throw new Error(`Unknown provider: ${providerName}`);

    // Validate the redirect URL against same-origin to prevent open redirect.
    // Only same-origin relative paths or the configured redirectUri are allowed.
    if (!isSafeRedirect(redirect, provider.redirectUri)) {
      throw new Error('Invalid redirect URL: must be same-origin or match the configured redirect URI');
    }

    const pkce = generatePKCE();
    const browserBinding = generateToken(32);
    const state = createOAuthStateParam(providerName, redirect, pkce.codeVerifier, this.secret, browserBinding);
    const url = buildAuthorizeUrl(provider, state, pkce);
    return { url, state, browserBinding };
  }

  async handleCallback(
    providerName: string,
    code: string,
    state: string,
    /** Value of the OAUTH_BINDING_COOKIE cookie sent by the callback request. */
    browserBinding: string | undefined,
  ): Promise<{ tokens: OAuthTokens; userInfo: OAuthUserInfo; redirect: string }> {
    const provider = this.providers.get(providerName);
    if (!provider) throw new Error(`Unknown provider: ${providerName}`);

    const stateData = verifyOAuthStateParam(state, this.secret);
    if (!stateData || stateData.provider !== providerName) {
      throw new Error('Invalid or expired OAuth state');
    }
    // Bind to the initiating browser: the state alone is attacker-obtainable.
    if (!browserBinding || !stateData.bind) {
      throw new Error('OAuth state is not bound to this browser');
    }
    const a = Buffer.from(hashBinding(browserBinding));
    const b = Buffer.from(stateData.bind);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error('OAuth state does not belong to this browser session');
    }

    const tokens = await exchangeCodeForTokens(provider, code, stateData.codeVerifier);
    const userInfo = provider.userinfoUrl
      ? await fetchUserInfo(provider, tokens.accessToken)
      : { id: '', provider: providerName };

    return { tokens, userInfo, redirect: stateData.redirect };
  }
}

function normalizeUserInfo(data: any, provider: string): OAuthUserInfo {
  const id = data.sub ?? data.id ?? data.uid ?? '';
  const email = data.email;
  const name = data.name ?? data.nickname ?? data.preferred_username;
  const avatar = data.picture ?? data.avatar_url ?? data.avatar;

  return { id, email, emailVerified: data.email_verified === true, name, avatar, provider, raw: data };
}

/**
 * Validate that a redirect URL is safe (same-origin relative path or matches
 * the allowed base). Prevents open redirect via crafted OAuth state.
 */
function isSafeRedirect(redirect: string, allowedBase: string): boolean {
  // Backslashes and control characters are normalised by browsers ("/\evil.com"
  // becomes "//evil.com"), so they must never appear in a same-origin path.
  // eslint-disable-next-line no-control-regex
  if (/[\\\x00-\x20]/.test(redirect)) return false;
  // Relative paths (starting with /) are same-origin.
  if (redirect.startsWith('/') && !redirect.startsWith('//')) return true;
  try {
    const redirectUrl = new URL(redirect);
    const baseUrl = new URL(allowedBase);
    return redirectUrl.origin === baseUrl.origin;
  } catch {
    return false;
  }
}
