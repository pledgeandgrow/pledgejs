/**
 * OAuth 2.1 / OIDC integration.
 *
 * Provides:
 * - Built-in OAuth provider support with PKCE
 * - State validation
 * - Automatic token refresh
 * - OIDC userinfo endpoint support
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { generateToken } from './index';

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
 * Create a signed OAuth state parameter.
 * The state encodes the provider, redirect URL, PKCE verifier, and nonce.
 */
export function createOAuthStateParam(
  provider: string,
  redirect: string,
  codeVerifier: string,
  secret: string,
): string {
  const nonce = generateToken(16);
  const payload: OAuthState = {
    provider,
    redirect,
    codeVerifier,
    nonce,
    timestamp: Date.now(),
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

  initiateAuth(providerName: string, redirect: string): { url: string; state: string } {
    const provider = this.providers.get(providerName);
    if (!provider) throw new Error(`Unknown provider: ${providerName}`);

    const pkce = generatePKCE();
    const state = createOAuthStateParam(providerName, redirect, pkce.codeVerifier, this.secret);
    const url = buildAuthorizeUrl(provider, state, pkce);
    return { url, state };
  }

  async handleCallback(
    providerName: string,
    code: string,
    state: string,
  ): Promise<{ tokens: OAuthTokens; userInfo: OAuthUserInfo; redirect: string }> {
    const provider = this.providers.get(providerName);
    if (!provider) throw new Error(`Unknown provider: ${providerName}`);

    const stateData = verifyOAuthStateParam(state, this.secret);
    if (!stateData || stateData.provider !== providerName) {
      throw new Error('Invalid or expired OAuth state');
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

  return { id, email, name, avatar, provider, raw: data };
}
