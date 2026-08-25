/**
 * Minimal CBOR decoder and COSE-key conversion for WebAuthn verification.
 *
 * WebAuthn attestation objects are CBOR-encoded and the credential public key
 * inside them is a COSE_Key map. Verifying an assertion signature requires
 * decoding both. This implements just the CBOR subset the WebAuthn data model
 * uses (unsigned/negative ints, byte/text strings, arrays, maps) plus COSE→
 * KeyObject conversion for the two algorithms real authenticators use: ES256
 * (COSE alg -7, EC P-256) and RS256 (COSE alg -257, RSA).
 *
 * This is deliberately dependency-free; it is not a general-purpose CBOR
 * library (no floats, tags, or indefinite-length items — none occur here).
 */

import { createPublicKey, type KeyObject } from 'node:crypto';

interface DecodeResult {
  value: unknown;
  offset: number;
}

function decodeItem(buf: Buffer, offset: number): DecodeResult {
  const first = buf[offset];
  const major = first >> 5;
  const info = first & 0x1f;
  let len = info;
  let cursor = offset + 1;

  if (info === 24) { len = buf[cursor]; cursor += 1; }
  else if (info === 25) { len = buf.readUInt16BE(cursor); cursor += 2; }
  else if (info === 26) { len = buf.readUInt32BE(cursor); cursor += 4; }
  else if (info === 27) {
    // 64-bit length — safe for the small values WebAuthn uses.
    const hi = buf.readUInt32BE(cursor);
    const lo = buf.readUInt32BE(cursor + 4);
    len = hi * 0x100000000 + lo;
    cursor += 8;
  } else if (info > 27) {
    throw new Error(`Unsupported CBOR additional info: ${info}`);
  }

  switch (major) {
    case 0: // unsigned integer
      return { value: len, offset: cursor };
    case 1: // negative integer
      return { value: -1 - len, offset: cursor };
    case 2: { // byte string
      const value = buf.subarray(cursor, cursor + len);
      return { value, offset: cursor + len };
    }
    case 3: { // text string
      const value = buf.subarray(cursor, cursor + len).toString('utf8');
      return { value, offset: cursor + len };
    }
    case 4: { // array
      const arr: unknown[] = [];
      let c = cursor;
      for (let i = 0; i < len; i++) {
        const r = decodeItem(buf, c);
        arr.push(r.value);
        c = r.offset;
      }
      return { value: arr, offset: c };
    }
    case 5: { // map
      const map = new Map<unknown, unknown>();
      let c = cursor;
      for (let i = 0; i < len; i++) {
        const k = decodeItem(buf, c);
        const v = decodeItem(buf, k.offset);
        map.set(k.value, v.value);
        c = v.offset;
      }
      return { value: map, offset: c };
    }
    default:
      throw new Error(`Unsupported CBOR major type: ${major}`);
  }
}

/** Decode a single top-level CBOR item from a buffer. */
export function decodeCbor(buf: Buffer): unknown {
  return decodeItem(buf, 0).value;
}

/**
 * Convert a COSE_Key (as a decoded CBOR Map) into a Node public KeyObject.
 * Supports EC2/P-256 (ES256) and RSA (RS256). Returns null for anything else.
 */
export function coseKeyToPublicKey(cose: Map<unknown, unknown>): KeyObject | null {
  const kty = cose.get(1); // 1 = kty: 2 = EC2, 3 = RSA
  try {
    if (kty === 2) {
      const crv = cose.get(-1); // 1 = P-256
      const x = cose.get(-2) as Buffer;
      const y = cose.get(-3) as Buffer;
      if (crv !== 1 || !Buffer.isBuffer(x) || !Buffer.isBuffer(y)) return null;
      return createPublicKey({
        key: {
          kty: 'EC',
          crv: 'P-256',
          x: x.toString('base64url'),
          y: y.toString('base64url'),
        },
        format: 'jwk',
      });
    }
    if (kty === 3) {
      const n = cose.get(-1) as Buffer;
      const e = cose.get(-2) as Buffer;
      if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e)) return null;
      return createPublicKey({
        key: {
          kty: 'RSA',
          n: n.toString('base64url'),
          e: e.toString('base64url'),
        },
        format: 'jwk',
      });
    }
  } catch {
    return null;
  }
  return null;
}

/** COSE alg identifier → Node hash + whether signatures are DER-encoded ECDSA. */
export function coseAlgFromKey(cose: Map<unknown, unknown>): { hash: string; isEc: boolean } | null {
  const alg = cose.get(3);
  switch (alg) {
    case -7: return { hash: 'sha256', isEc: true };   // ES256
    case -35: return { hash: 'sha384', isEc: true };  // ES384
    case -36: return { hash: 'sha512', isEc: true };  // ES512
    case -257: return { hash: 'sha256', isEc: false }; // RS256
    case -258: return { hash: 'sha384', isEc: false }; // RS384
    case -259: return { hash: 'sha512', isEc: false }; // RS512
    default: return null;
  }
}

/**
 * Parse the attested credential data out of an authenticatorData buffer and
 * return the COSE public key map. Returns null if authData has no attested
 * credential data (AT flag / registration only).
 *
 * authData layout: rpIdHash(32) | flags(1) | signCount(4) |
 *   [ AAGUID(16) | credIdLen(2) | credId(credIdLen) | COSEPublicKey(rest) ]
 */
export function parseCredentialPublicKey(authData: Buffer): Map<unknown, unknown> | null {
  if (authData.length < 37) return null;
  const flags = authData[32];
  const hasAttestedCredData = (flags & 0x40) !== 0; // AT flag (bit 6)
  if (!hasAttestedCredData) return null;
  if (authData.length < 55) return null;
  const credIdLen = authData.readUInt16BE(53);
  const coseStart = 55 + credIdLen;
  if (authData.length < coseStart) return null;
  const coseBytes = authData.subarray(coseStart);
  const decoded = decodeCbor(coseBytes);
  return decoded instanceof Map ? decoded : null;
}
