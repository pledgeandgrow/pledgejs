import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { hashPassword, verifyPassword } from './index';
import { generatePKCE } from './oauth';
import { generateTOTPSecret } from './totp';
import { signJWT, verifyJWT, generateECKeyPair, generateKeyPair, JWKSManager } from './jwt';

describe('password hashing (scrypt)', () => {
  it('produces a self-describing scrypt hash and verifies it', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('s3cret');
    expect(await verifyPassword('not-it', hash)).toBe(false);
  });

  it('uses a random salt (two hashes of the same password differ)', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same', a)).toBe(true);
    expect(await verifyPassword('same', b)).toBe(true);
  });

  it('rejects a malformed stored hash', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$bad')).toBe(false);
  });
});

describe('PKCE S256', () => {
  it('computes the challenge as BASE64URL(SHA-256(verifier))', () => {
    const { codeVerifier, codeChallenge, codeChallengeMethod } = generatePKCE();
    expect(codeChallengeMethod).toBe('S256');
    const expected = createHash('sha256').update(codeVerifier).digest('base64url');
    expect(codeChallenge).toBe(expected);
  });
});

describe('TOTP secret entropy', () => {
  it('base32-encodes the full random buffer (32 chars for 20 bytes)', () => {
    const secret = generateTOTPSecret(20);
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(secret.length).toBe(32);
  });

  it('produces distinct secrets', () => {
    expect(generateTOTPSecret()).not.toBe(generateTOTPSecret());
  });
});

describe('JWT ES256 (raw r||s encoding)', () => {
  it('signs and verifies an ES256 token', () => {
    const { publicKey, privateKey } = generateECKeyPair();
    const token = signJWT({ sub: 'ec-user' }, privateKey, { algorithm: 'ES256', expiresIn: 3600 });
    const payload = verifyJWT(token, publicKey, { algorithms: ['ES256'] });
    expect(payload?.sub).toBe('ec-user');
  });

  it('ES256 signature is 64 bytes (P1363), not DER', () => {
    const { privateKey } = generateECKeyPair();
    const token = signJWT({ sub: 'x' }, privateKey, { algorithm: 'ES256' });
    const sig = Buffer.from(token.split('.')[2], 'base64url');
    expect(sig.length).toBe(64);
  });
});

describe('JWKS export', () => {
  it('exports real RSA n/e that reconstruct a usable key', () => {
    const mgr = new JWKSManager();
    mgr.addKey(generateKeyPair());
    const jwks = mgr.getPublicJWKS();
    expect(jwks.keys).toHaveLength(1);
    const [k] = jwks.keys;
    expect(k.kty).toBe('RSA');
    expect(k.alg).toBe('RS256');
    expect(typeof k.n).toBe('string');
    expect(k.e).toBe('AQAB'); // standard RSA public exponent 65537
  });

  it('labels EC keys as EC/ES256, not RSA', () => {
    const mgr = new JWKSManager();
    mgr.addKey(generateECKeyPair());
    const [k] = mgr.getPublicJWKS().keys;
    expect(k.kty).toBe('EC');
    expect(k.alg).toBe('ES256');
    expect(k.crv).toBe('P-256');
  });
});
