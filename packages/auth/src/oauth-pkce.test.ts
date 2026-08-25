import { describe, it, expect } from 'vitest';
import { createOAuthStateParam, verifyOAuthStateParam } from './oauth';

const secret = 'a-strong-app-secret-value';

describe('OAuth PKCE state confidentiality', () => {
  it('round-trips the code_verifier through the state', () => {
    const verifier = 'the-secret-code-verifier-abc123';
    const state = createOAuthStateParam('google', '/dashboard', verifier, secret);
    const decoded = verifyOAuthStateParam(state, secret);
    expect(decoded?.codeVerifier).toBe(verifier);
    expect(decoded?.provider).toBe('google');
    expect(decoded?.redirect).toBe('/dashboard');
  });

  it('does NOT expose the raw verifier anywhere in the state string', () => {
    const verifier = 'super-secret-verifier-xyz789';
    const state = createOAuthStateParam('github', '/', verifier, secret);
    // The verifier is encrypted, so it must not appear in the state or its
    // base64url-decoded payload.
    expect(state).not.toContain(verifier);
    const payload = Buffer.from(state.split('.')[0], 'base64url').toString('utf8');
    expect(payload).not.toContain(verifier);
  });

  it('rejects a state signed with a different secret', () => {
    const state = createOAuthStateParam('google', '/', 'v', secret);
    expect(verifyOAuthStateParam(state, 'other-secret')).toBeNull();
  });
});
