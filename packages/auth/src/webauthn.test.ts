import { describe, it, expect } from 'vitest';
import { createHash, createSign, generateKeyPairSync, KeyObject } from 'node:crypto';
import { verifyRegistrationResponse, verifyAuthenticationResponse, type WebAuthnConfig } from './webauthn';

const config: WebAuthnConfig = {
  rpName: 'Test RP',
  rpId: 'example.com',
  origin: 'https://example.com',
};

// --- Minimal CBOR encoder (mirror of the decoder subset) for building fixtures ---
function cborUint(n: number): Buffer {
  if (n < 24) return Buffer.from([n]);
  if (n < 256) return Buffer.from([24, n]);
  if (n < 65536) { const b = Buffer.alloc(3); b[0] = 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = 26; b.writeUInt32BE(n, 1); return b;
}
function cborHead(major: number, n: number): Buffer {
  const u = cborUint(n);
  u[0] = (u[0] & 0x1f) | (major << 5);
  return u;
}
function cborBytes(buf: Buffer): Buffer { return Buffer.concat([cborHead(2, buf.length), buf]); }
function cborText(s: string): Buffer { const b = Buffer.from(s, 'utf8'); return Buffer.concat([cborHead(3, b.length), b]); }
function cborNegInt(n: number): Buffer { return cborHead(1, -1 - n); } // n is negative
function cborInt(n: number): Buffer { return n < 0 ? cborNegInt(n) : cborHead(0, n); }
function cborMap(entries: Array<[Buffer, Buffer]>): Buffer {
  return Buffer.concat([cborHead(5, entries.length), ...entries.map(([k, v]) => Buffer.concat([k, v]))]);
}

// Build a COSE_Key map for an EC P-256 public key from its raw x/y coords.
function coseEc2(x: Buffer, y: Buffer): Buffer {
  return cborMap([
    [cborInt(1), cborInt(2)],     // kty: EC2
    [cborInt(3), cborInt(-7)],    // alg: ES256
    [cborInt(-1), cborInt(1)],    // crv: P-256
    [cborInt(-2), cborBytes(x)],  // x
    [cborInt(-3), cborBytes(y)],  // y
  ]);
}

// Extract raw 32-byte x/y from a Node EC public key via JWK.
function ecCoords(pub: KeyObject): { x: Buffer; y: Buffer } {
  const jwk = pub.export({ format: 'jwk' }) as { x: string; y: string };
  return { x: Buffer.from(jwk.x, 'base64url'), y: Buffer.from(jwk.y, 'base64url') };
}

function buildAuthData(rpId: string, flags: number, counter: number, attestedCredData?: Buffer): Buffer {
  const rpIdHash = createHash('sha256').update(rpId).digest();
  const head = Buffer.alloc(37);
  rpIdHash.copy(head, 0);
  head[32] = flags;
  head.writeUInt32BE(counter, 33);
  return attestedCredData ? Buffer.concat([head, attestedCredData]) : head;
}

function buildAttestedCredData(credId: Buffer, cosePublicKey: Buffer): Buffer {
  const aaguid = Buffer.alloc(16);
  const credIdLen = Buffer.alloc(2);
  credIdLen.writeUInt16BE(credId.length, 0);
  return Buffer.concat([aaguid, credIdLen, credId, cosePublicKey]);
}

describe('WebAuthn registration + authentication', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { x, y } = ecCoords(publicKey);
  const cose = coseEc2(x, y);
  const credId = Buffer.from('test-credential-id');
  const credIdB64 = credId.toString('base64url');

  // AT flag (0x40) + UP flag (0x01) for registration.
  const regAuthData = buildAuthData(config.rpId, 0x41, 0, buildAttestedCredData(credId, cose));
  const attestationObject = cborMap([
    [cborText('fmt'), cborText('none')],
    [cborText('attStmt'), cborMap([])],
    [cborText('authData'), cborBytes(regAuthData)],
  ]);

  const regChallenge = 'reg-challenge-123';
  const regResponse = {
    id: credIdB64,
    response: {
      clientDataJSON: JSON.stringify({ type: 'webauthn.create', origin: config.origin, challenge: regChallenge }),
      attestationObject: attestationObject.toString('base64url'),
    },
  };

  it('extracts the real public key from the attestation', () => {
    const cred = verifyRegistrationResponse(regResponse, regChallenge, config);
    expect(cred).not.toBeNull();
    expect(cred!.id).toBe(credIdB64);
    expect(cred!.algorithm).toBe(-7);
    expect(cred!.publicKey).toContain('BEGIN PUBLIC KEY');
  });

  it('rejects registration with a wrong origin or challenge', () => {
    expect(verifyRegistrationResponse(regResponse, 'wrong', config)).toBeNull();
    const badOrigin = { ...regResponse, response: { ...regResponse.response, clientDataJSON: JSON.stringify({ type: 'webauthn.create', origin: 'https://evil.com', challenge: regChallenge }) } };
    expect(verifyRegistrationResponse(badOrigin, regChallenge, config)).toBeNull();
  });

  it('verifies a genuine assertion signature', () => {
    const cred = verifyRegistrationResponse(regResponse, regChallenge, config)!;
    const authData = buildAuthData(config.rpId, 0x01, 5); // UP flag, counter 5
    const authChallenge = 'auth-challenge-456';
    const clientDataJSON = JSON.stringify({ type: 'webauthn.get', origin: config.origin, challenge: authChallenge });
    const signedData = Buffer.concat([authData, createHash('sha256').update(Buffer.from(clientDataJSON)).digest()]);
    const sig = createSign('sha256').update(signedData).end().sign(privateKey); // DER — as real authenticators emit

    const authResponse = {
      id: credIdB64,
      response: {
        clientDataJSON,
        authenticatorData: authData.toString('base64url'),
        signature: sig.toString('base64url'),
      },
    };
    expect(verifyAuthenticationResponse(authResponse, authChallenge, cred, config)).toBe(true);
  });

  it('rejects a forged assertion (bad signature)', () => {
    const cred = verifyRegistrationResponse(regResponse, regChallenge, config)!;
    const authData = buildAuthData(config.rpId, 0x01, 5);
    const authChallenge = 'auth-challenge-456';
    const clientDataJSON = JSON.stringify({ type: 'webauthn.get', origin: config.origin, challenge: authChallenge });
    const authResponse = {
      id: credIdB64,
      response: {
        clientDataJSON,
        authenticatorData: authData.toString('base64url'),
        signature: Buffer.from('garbage-signature-bytes-0000000000000000').toString('base64url'),
      },
    };
    expect(verifyAuthenticationResponse(authResponse, authChallenge, cred, config)).toBe(false);
  });

  it('rejects an assertion whose counter did not advance', () => {
    const cred = verifyRegistrationResponse(regResponse, regChallenge, config)!;
    cred.counter = 10;
    const authData = buildAuthData(config.rpId, 0x01, 5); // counter 5 < stored 10
    const authChallenge = 'auth-challenge-456';
    const clientDataJSON = JSON.stringify({ type: 'webauthn.get', origin: config.origin, challenge: authChallenge });
    const signedData = Buffer.concat([authData, createHash('sha256').update(Buffer.from(clientDataJSON)).digest()]);
    const sig = createSign('sha256').update(signedData).end().sign(privateKey);
    const authResponse = {
      id: credIdB64,
      response: {
        clientDataJSON,
        authenticatorData: authData.toString('base64url'),
        signature: sig.toString('base64url'),
      },
    };
    expect(verifyAuthenticationResponse(authResponse, authChallenge, cred, config)).toBe(false);
  });
});

describe('WebAuthn user-verification enforcement', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { x, y } = ecCoords(publicKey);
  const cose = coseEc2(x, y);
  const credId = Buffer.from('uv-credential-id');
  const credIdB64 = credId.toString('base64url');

  const uvConfig: WebAuthnConfig = { ...config, userVerification: 'required' };

  function regResponseWithFlags(flags: number) {
    const authData = buildAuthData(config.rpId, flags, 0, buildAttestedCredData(credId, cose));
    const attestationObject = cborMap([
      [cborText('fmt'), cborText('none')],
      [cborText('attStmt'), cborMap([])],
      [cborText('authData'), cborBytes(authData)],
    ]);
    const challenge = 'uv-reg-challenge';
    return {
      challenge,
      response: {
        id: credIdB64,
        response: {
          clientDataJSON: JSON.stringify({ type: 'webauthn.create', origin: config.origin, challenge }),
          attestationObject: attestationObject.toString('base64url'),
        },
      },
    };
  }

  function authResponseWithFlags(cred: ReturnType<typeof verifyRegistrationResponse>, flags: number) {
    const authData = buildAuthData(config.rpId, flags, 1);
    const challenge = 'uv-auth-challenge';
    const clientDataJSON = JSON.stringify({ type: 'webauthn.get', origin: config.origin, challenge });
    const signedData = Buffer.concat([authData, createHash('sha256').update(Buffer.from(clientDataJSON)).digest()]);
    const sig = createSign('sha256').update(signedData).end().sign(privateKey);
    return {
      challenge,
      response: {
        id: credIdB64,
        response: {
          clientDataJSON,
          authenticatorData: authData.toString('base64url'),
          signature: sig.toString('base64url'),
        },
      },
    };
  }

  it('rejects registration without the UV flag when userVerification is required', () => {
    // 0x41 = UP + AT, no UV (0x04).
    const { challenge, response } = regResponseWithFlags(0x41);
    expect(verifyRegistrationResponse(response, challenge, uvConfig)).toBeNull();
  });

  it('accepts registration with the UV flag when userVerification is required', () => {
    // 0x45 = UP + UV + AT.
    const { challenge, response } = regResponseWithFlags(0x45);
    const cred = verifyRegistrationResponse(response, challenge, uvConfig);
    expect(cred).not.toBeNull();
    expect(cred!.id).toBe(credIdB64);
  });

  it('rejects an assertion without the UV flag when userVerification is required', () => {
    const { challenge, response } = regResponseWithFlags(0x45);
    const cred = verifyRegistrationResponse(response, challenge, uvConfig)!;
    // 0x01 = UP only, no UV.
    const auth = authResponseWithFlags(cred, 0x01);
    expect(verifyAuthenticationResponse(auth.response, auth.challenge, cred, uvConfig)).toBe(false);
  });

  it('accepts an assertion with the UV flag when userVerification is required', () => {
    const { challenge, response } = regResponseWithFlags(0x45);
    const cred = verifyRegistrationResponse(response, challenge, uvConfig)!;
    // 0x05 = UP + UV.
    const auth = authResponseWithFlags(cred, 0x05);
    expect(verifyAuthenticationResponse(auth.response, auth.challenge, cred, uvConfig)).toBe(true);
  });

  it('still accepts UP-only responses when userVerification is preferred', () => {
    const { challenge, response } = regResponseWithFlags(0x41);
    const cred = verifyRegistrationResponse(response, challenge, config);
    expect(cred).not.toBeNull();
    const auth = authResponseWithFlags(cred, 0x01);
    expect(verifyAuthenticationResponse(auth.response, auth.challenge, cred!, config)).toBe(true);
  });
});

describe('WebAuthn credential user linkage', () => {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const { x, y } = ecCoords(publicKey);
  const credId = Buffer.from('userid-credential');

  function reg(userHandle?: string) {
    const authData = buildAuthData(config.rpId, 0x41, 0, buildAttestedCredData(credId, coseEc2(x, y)));
    const attestationObject = cborMap([
      [cborText('fmt'), cborText('none')],
      [cborText('attStmt'), cborMap([])],
      [cborText('authData'), cborBytes(authData)],
    ]);
    return {
      id: credId.toString('base64url'),
      response: {
        clientDataJSON: JSON.stringify({ type: 'webauthn.create', origin: config.origin, challenge: 'c1' }),
        attestationObject: attestationObject.toString('base64url'),
        userHandle,
      },
    };
  }

  it('stores the caller-supplied real userId on the credential', () => {
    const cred = verifyRegistrationResponse(reg(), 'c1', config, { userId: 'user-42' });
    expect(cred?.userId).toBe('user-42');
  });

  it('falls back to the decoded userHandle when no userId is supplied', () => {
    const handle = Buffer.from('user-77').toString('base64url');
    const cred = verifyRegistrationResponse(reg(handle), 'c1', config);
    expect(cred?.userId).toBe('user-77');
  });

  it('prefers the explicit userId over a userHandle', () => {
    const handle = Buffer.from('other').toString('base64url');
    const cred = verifyRegistrationResponse(reg(handle), 'c1', config, { userId: 'real' });
    expect(cred?.userId).toBe('real');
  });
});
