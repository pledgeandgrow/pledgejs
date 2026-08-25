/**
 * JWT security — jose-based JWT signing/verification.
 *
 * Provides:
 * - RS256/ES256 signing and verification
 * - Short-lived access tokens + refresh tokens
 * - alg confusion prevention (enforce expected algorithm)
 * - JWKS support for key rotation
 */

import { createPublicKey, createSign, createVerify, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export type JWTAlgorithm = 'RS256' | 'RS384' | 'RS512' | 'ES256' | 'ES384' | 'ES512';

export interface JWTHeader {
  alg: JWTAlgorithm;
  typ: 'JWT';
  kid?: string;
}

export interface JWTPayload {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  jti?: string;
  [key: string]: unknown;
}

export interface JWTSignOptions {
  algorithm?: JWTAlgorithm;
  expiresIn?: number;
  issuer?: string;
  audience?: string | string[];
  subject?: string;
  jwtid?: string;
  keyid?: string;
}

export interface JWTVerifyOptions {
  algorithms?: JWTAlgorithm[];
  issuer?: string;
  audience?: string | string[];
  subject?: string;
  clockTolerance?: number;
}

export interface KeyPair {
  publicKey: string;
  privateKey: string;
  kid: string;
}

const ALGORITHM_MAP: Record<JWTAlgorithm, string> = {
  RS256: 'RSA-SHA256',
  RS384: 'RSA-SHA384',
  RS512: 'RSA-SHA512',
  ES256: 'sha256',
  ES384: 'sha384',
  ES512: 'sha512',
};

function isEcAlgorithm(alg: JWTAlgorithm): boolean {
  return alg.startsWith('ES');
}

/**
 * Build the key argument for sign()/verify(). For ECDSA (ES*) algorithms JWS
 * requires the raw r||s (IEEE P1363) signature encoding, whereas Node's default
 * is ASN.1/DER — so we must pass `dsaEncoding: 'ieee-p1363'`. Tokens produced
 * with DER encoding are rejected by every conformant JWT library, and DER-decode
 * of an incoming P1363 signature fails verification.
 */
function keyArg(key: string, alg: JWTAlgorithm): string | { key: string; dsaEncoding: 'ieee-p1363' } {
  return isEcAlgorithm(alg) ? { key, dsaEncoding: 'ieee-p1363' } : key;
}

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64url');
}

/** Map a JWK EC curve name to its JWS algorithm identifier. */
function ecCurveToAlg(crv: string | undefined): string {
  switch (crv) {
    case 'P-256': return 'ES256';
    case 'P-384': return 'ES384';
    case 'P-521': return 'ES512';
    default: return 'ES256';
  }
}

function base64urlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

/**
 * Sign a JWT with the specified algorithm and key.
 */
export function signJWT(
  payload: JWTPayload,
  privateKey: string,
  options: JWTSignOptions = {},
): string {
  const algorithm = options.algorithm ?? 'RS256';
  const now = Math.floor(Date.now() / 1000);

  const fullPayload: JWTPayload = {
    iat: now,
    ...payload,
    ...(options.expiresIn ? { exp: now + options.expiresIn } : {}),
    ...(options.issuer ? { iss: options.issuer } : {}),
    ...(options.audience ? { aud: options.audience } : {}),
    ...(options.subject ? { sub: options.subject } : {}),
    ...(options.jwtid ? { jti: options.jwtid } : {}),
  };

  const header: JWTHeader = { alg: algorithm, typ: 'JWT', ...(options.keyid ? { kid: options.keyid } : {}) };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(fullPayload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const sign = createSign(ALGORITHM_MAP[algorithm]);
  sign.update(signingInput);
  sign.end();

  const signature = sign.sign(keyArg(privateKey, algorithm));
  const encodedSignature = base64url(signature);

  return `${signingInput}.${encodedSignature}`;
}

/**
 * Verify a JWT signature and claims.
 * Enforces the expected algorithm to prevent alg confusion attacks.
 */
export function verifyJWT(
  token: string,
  publicKey: string,
  options: JWTVerifyOptions = {},
): JWTPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  let header: JWTHeader;
  let payload: JWTPayload;
  try {
    header = JSON.parse(base64urlDecode(encodedHeader).toString());
    payload = JSON.parse(base64urlDecode(encodedPayload).toString());
  } catch {
    return null;
  }

  const allowedAlgorithms = options.algorithms ?? ['RS256', 'ES256'];
  if (!allowedAlgorithms.includes(header.alg)) {
    return null;
  }

  if (header.typ !== 'JWT') return null;

  const verify = createVerify(ALGORITHM_MAP[header.alg]);
  verify.update(`${encodedHeader}.${encodedPayload}`);
  verify.end();

  const signature = base64urlDecode(encodedSignature);
  let isValid: boolean;
  try {
    isValid = verify.verify(keyArg(publicKey, header.alg), signature);
  } catch {
    return null;
  }
  if (!isValid) return null;

  const now = Math.floor(Date.now() / 1000);
  const tolerance = options.clockTolerance ?? 0;

  if (payload.exp && now > payload.exp + tolerance) return null;
  if (payload.nbf && now < payload.nbf - tolerance) return null;

  if (options.issuer && payload.iss !== options.issuer) return null;
  if (options.subject && payload.sub !== options.subject) return null;
  if (options.audience) {
    const expectedAud = options.audience;
    const tokenAud = payload.aud;
    if (Array.isArray(tokenAud)) {
      if (!tokenAud.includes(expectedAud as string)) return null;
    } else if (tokenAud !== expectedAud) {
      return null;
    }
  }

  return payload;
}

/**
 * Decode a JWT without verification (for inspection only).
 */
export function decodeJWT(token: string): { header: JWTHeader; payload: JWTPayload } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(base64urlDecode(parts[0]).toString());
    const payload = JSON.parse(base64urlDecode(parts[1]).toString());
    return { header, payload };
  } catch {
    return null;
  }
}

/**
 * Generate an RSA key pair for JWT signing.
 */
export function generateKeyPair(kid?: string): KeyPair {
  const { generateKeyPairSync } = require('node:crypto');
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey, kid: kid ?? randomBytes(8).toString('hex') };
}

/**
 * Generate an EC key pair for JWT signing.
 */
export function generateECKeyPair(kid?: string): KeyPair {
  const { generateKeyPairSync } = require('node:crypto');
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey, kid: kid ?? randomBytes(8).toString('hex') };
}

/**
 * JWKS (JSON Web Key Set) manager for key rotation.
 */
export class JWKSManager {
  private keys: Map<string, KeyPair> = new Map();
  private currentKid: string | null = null;

  addKey(keyPair: KeyPair, makeCurrent = false): void {
    this.keys.set(keyPair.kid, keyPair);
    if (makeCurrent || !this.currentKid) {
      this.currentKid = keyPair.kid;
    }
  }

  removeKey(kid: string): boolean {
    if (this.currentKid === kid) return false;
    return this.keys.delete(kid);
  }

  getCurrentKey(): KeyPair | null {
    if (!this.currentKid) return null;
    return this.keys.get(this.currentKid) ?? null;
  }

  getKey(kid: string): KeyPair | null {
    return this.keys.get(kid) ?? null;
  }

  getPublicJWKS(): { keys: Array<{ kid: string; kty: string; use: string; alg: string; n?: string; e?: string; x?: string; y?: string; crv?: string }> } {
    const keys: any[] = [];
    for (const [kid, keyPair] of this.keys) {
      const pubKey = createPublicKey(keyPair.publicKey);
      // Export the real JWK parameters. The previous implementation fabricated
      // `n`/`e` by slicing fixed byte ranges out of the SPKI DER, which produced
      // a nonsense key that no relying party could verify against, and always
      // labelled EC keys as RSA/RS256.
      const jwk = pubKey.export({ format: 'jwk' }) as {
        kty?: string; n?: string; e?: string; x?: string; y?: string; crv?: string;
      };
      const alg = jwk.kty === 'EC' ? ecCurveToAlg(jwk.crv) : 'RS256';
      keys.push({ kid, use: 'sig', alg, ...jwk });
    }
    return { keys };
  }

  sign(payload: JWTPayload, options: JWTSignOptions = {}): string {
    const key = this.getCurrentKey();
    if (!key) throw new Error('No signing key available');
    return signJWT(payload, key.privateKey, { ...options, keyid: key.kid, algorithm: options.algorithm ?? 'RS256' });
  }

  verify(token: string, options: JWTVerifyOptions = {}): JWTPayload | null {
    const decoded = decodeJWT(token);
    if (!decoded) return null;
    const key = this.getKey(decoded.header.kid ?? '');
    if (!key) return null;
    return verifyJWT(token, key.publicKey, options);
  }
}

/**
 * Create a short-lived access token and a long-lived refresh token.
 */
export function createTokenPair(
  payload: JWTPayload,
  privateKey: string,
  options: JWTSignOptions & { refreshExpiresIn?: number } = {},
): { accessToken: string; refreshToken: string } {
  const accessToken = signJWT(payload, privateKey, {
    ...options,
    expiresIn: options.expiresIn ?? 900,
  });

  const refreshPayload: JWTPayload = {
    ...payload,
    jti: randomBytes(16).toString('hex'),
    typ: 'refresh',
  };

  const refreshToken = signJWT(refreshPayload, privateKey, {
    ...options,
    expiresIn: options.refreshExpiresIn ?? 7 * 24 * 60 * 60,
  });

  return { accessToken, refreshToken };
}
