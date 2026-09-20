import { describe, it, expect } from 'vitest';
import { OAuthManager } from './oauth';

function manager() {
  const m = new OAuthManager('secret-secret-secret');
  m.registerProvider({
    name: 'p', authorizeUrl: 'https://idp.example/auth', tokenUrl: 'https://idp.example/token',
    clientId: 'c', clientSecret: 's', redirectUri: 'https://app.example/cb', scopes: ['openid'],
  });
  return m;
}

describe('OAuth state is bound to the initiating browser (login CSRF)', () => {
  it('rejects a callback that carries no browser binding', async () => {
    const m = manager();
    const { state } = m.initiateAuth('p', '/dashboard');
    await expect(m.handleCallback('p', 'code', state, undefined)).rejects.toThrow(/not bound/);
  });

  it('rejects a callback from a different browser (attacker-initiated state)', async () => {
    const m = manager();
    const attacker = m.initiateAuth('p', '/dashboard');
    const victimBinding = manager().initiateAuth('p', '/').browserBinding;
    await expect(m.handleCallback('p', 'code', attacker.state, victimBinding)).rejects.toThrow(/does not belong/);
  });

  it('accepts the matching binding (fails later, at the token exchange, not at state check)', async () => {
    const m = manager();
    const { state, browserBinding } = m.initiateAuth('p', '/dashboard');
    await expect(m.handleCallback('p', 'code', state, browserBinding)).rejects.not.toThrow(/browser/);
  });
});
