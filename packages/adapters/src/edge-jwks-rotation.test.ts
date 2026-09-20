import { describe, it, expect, afterEach } from 'vitest';
import { verifyEdgeJwt } from './edge-security';

const b64u = (b: ArrayBuffer | Uint8Array | string) =>
  Buffer.from(typeof b === 'string' ? b : new Uint8Array(b as ArrayBuffer)).toString('base64url');

async function makeKey(kid: string) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid, alg: 'ES256', use: 'sig' };
  return { jwk, privateKey: pair.privateKey };
}

async function sign(privateKey: CryptoKey, kid: string) {
  const header = b64u(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid }));
  const payload = b64u(JSON.stringify({ sub: 'u', exp: Math.floor(Date.now() / 1000) + 600 }));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64u(sig)}`;
}

describe('JWKS key rotation', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('refetches the JWKS when a token references a kid missing from the cached set', async () => {
    const oldKey = await makeKey('old');
    const newKey = await makeKey('new');
    let served: unknown[] = [oldKey.jwk];
    let fetches = 0;
    globalThis.fetch = (async () => { fetches++; return new Response(JSON.stringify({ keys: served }), { status: 200 }); }) as typeof fetch;

    const uri = 'https://idp.example/rotation-jwks';
    const first = await verifyEdgeJwt(await sign(oldKey.privateKey, 'old'), { jwksUri: uri });
    expect(first.valid).toBe(true);

    served = [oldKey.jwk, newKey.jwk]; // IdP rotated in a new signing key
    const second = await verifyEdgeJwt(await sign(newKey.privateKey, 'new'), { jwksUri: uri });
    expect(second.valid).toBe(true);
    expect(fetches).toBe(2);
  });

  it('does not let unknown kids trigger unbounded refetches', async () => {
    const key = await makeKey('k');
    let fetches = 0;
    globalThis.fetch = (async () => { fetches++; return new Response(JSON.stringify({ keys: [key.jwk] }), { status: 200 }); }) as typeof fetch;
    const uri = 'https://idp.example/cooldown-jwks';
    for (let i = 0; i < 5; i++) {
      const r = await verifyEdgeJwt(await sign(key.privateKey, `missing-${i}`), { jwksUri: uri });
      expect(r.valid).toBe(false);
    }
    expect(fetches).toBeLessThanOrEqual(2);
  });
});
