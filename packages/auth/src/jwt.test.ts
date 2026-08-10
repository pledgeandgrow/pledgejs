import { describe, it, expect } from 'vitest';
import { decodeJWT, generateKeyPair, signJWT, verifyJWT } from './jwt';

describe('JWT', () => {
  describe('generateKeyPair', () => {
    it('generates an RSA key pair', () => {
      const { publicKey, privateKey } = generateKeyPair();
      expect(publicKey).toContain('BEGIN PUBLIC KEY');
      expect(privateKey).toContain('BEGIN PRIVATE KEY');
    });

    it('generates unique key pairs', () => {
      const kp1 = generateKeyPair();
      const kp2 = generateKeyPair();
      expect(kp1.publicKey).not.toBe(kp2.publicKey);
    });
  });

  describe('signJWT and verifyJWT', () => {
    it('signs and verifies a JWT', () => {
      const { publicKey, privateKey } = generateKeyPair();
      const token = signJWT({ sub: 'user123' }, privateKey, { expiresIn: 3600 });
      expect(token.split('.').length).toBe(3);

      const payload = verifyJWT(token, publicKey);
      expect(payload).not.toBeNull();
      expect(payload?.sub).toBe('user123');
    });

    it('rejects tampered token', () => {
      const { publicKey, privateKey } = generateKeyPair();
      const token = signJWT({ sub: 'user123' }, privateKey);
      const tampered = token.slice(0, -5) + 'aaaaa';
      expect(verifyJWT(tampered, publicKey)).toBeNull();
    });

    it('rejects expired token', () => {
      const { publicKey, privateKey } = generateKeyPair();
      const token = signJWT({ sub: 'user123' }, privateKey, { expiresIn: -1 });
      expect(verifyJWT(token, publicKey)).toBeNull();
    });

    it('includes iat and exp claims', () => {
      const { publicKey, privateKey } = generateKeyPair();
      const token = signJWT({ sub: 'user123' }, privateKey, { expiresIn: 3600 });
      const payload = verifyJWT(token, publicKey);
      expect(payload?.iat).toBeDefined();
      expect(payload?.exp).toBeDefined();
    });
  });

  describe('decodeJWT', () => {
    it('decodes a JWT without verification', () => {
      const { privateKey } = generateKeyPair();
      const token = signJWT({ sub: 'user123', custom: 'value' }, privateKey);
      const decoded = decodeJWT(token);
      expect(decoded).not.toBeNull();
      expect(decoded?.header.alg).toBe('RS256');
      expect(decoded?.payload.sub).toBe('user123');
      expect(decoded?.payload.custom).toBe('value');
    });

    it('returns null for invalid token', () => {
      expect(decodeJWT('not.a.jwt.token')).toBeNull();
      expect(decodeJWT('invalid')).toBeNull();
      expect(decodeJWT('')).toBeNull();
    });
  });
});
