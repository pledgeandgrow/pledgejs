/**
 * Passkey / WebAuthn support.
 *
 * Provides:
 * - Passwordless authentication with platform authenticators
 * - Conditional UI mediation
 * - Registration and authentication ceremony helpers
 * - Challenge generation and verification
 */

import { createHash, createPublicKey, createVerify, randomBytes, type KeyObject } from 'node:crypto';
import { coseAlgFromKey, coseKeyToPublicKey, decodeCbor, parseCredentialPublicKey } from './webauthn-cbor';

/** Coerce a WebAuthn transport value (base64url string, ArrayBuffer, or typed array) to a Buffer. */
function toBuffer(input: unknown): Buffer | null {
  if (input == null) return null;
  if (Buffer.isBuffer(input)) return input;
  if (typeof input === 'string') return Buffer.from(input, 'base64url');
  if (input instanceof ArrayBuffer) return Buffer.from(new Uint8Array(input));
  if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  return null;
}

/**
 * Resolve clientDataJSON — which may arrive as base64url (the common WebAuthn
 * transport encoding), an ArrayBuffer/typed array, a raw JSON string, or an
 * already-parsed object — into both its exact bytes (needed to hash for the
 * signature) and its parsed object. Returns raw=null when the input was a
 * pre-parsed object with no recoverable byte form.
 */
function resolveClientData(input: unknown): { json: any; raw: Buffer | null } | null {
  try {
    if (typeof input === 'string') {
      // base64url cannot contain '{'; a leading brace means it's raw JSON text.
      const raw = input.trimStart().startsWith('{')
        ? Buffer.from(input, 'utf8')
        : Buffer.from(input, 'base64url');
      return { json: JSON.parse(raw.toString('utf8')), raw };
    }
    if (input instanceof ArrayBuffer || ArrayBuffer.isView(input) || Buffer.isBuffer(input)) {
      const raw = toBuffer(input)!;
      return { json: JSON.parse(raw.toString('utf8')), raw };
    }
    if (input && typeof input === 'object') {
      return { json: input, raw: null };
    }
  } catch {
    return null;
  }
  return null;
}

export interface WebAuthnConfig {
  /** Relying party name */
  rpName: string;
  /** Relying party ID (domain) */
  rpId: string;
  /** Expected origin (e.g. 'https://example.com') */
  origin: string;
  /** Timeout for ceremonies in ms (default: 60000) */
  timeout?: number;
  /** User verification requirement (default: 'preferred') */
  userVerification?: 'required' | 'preferred' | 'discouraged';
}

export interface WebAuthnCredential {
  id: string;
  /** SPKI PEM of the credential's public key, extracted from the attestation. */
  publicKey: string;
  /** COSE algorithm identifier (e.g. -7 for ES256, -257 for RS256). */
  algorithm?: number;
  counter: number;
  transports?: string[];
  userId: string;
  createdAt: number;
}

export interface RegistrationOptions {
  userId: string;
  username: string;
  displayName?: string;
  excludeCredentials?: string[];
}

export interface AuthenticationOptions {
  userId?: string;
  allowCredentials?: string[];
}

const DEFAULT_TIMEOUT = 60000;
const DEFAULT_USER_VERIFICATION = 'preferred';

/**
 * Generate a random challenge for WebAuthn ceremonies.
 */
export function generateChallenge(length = 32): string {
  return randomBytes(length).toString('base64url');
}

/**
 * Generate registration options for navigator.credentials.create().
 */
export function generateRegistrationOptions(
  config: WebAuthnConfig,
  options: RegistrationOptions,
): Record<string, unknown> {
  const challenge = generateChallenge();
  // The user handle must be the real, stable user id so the resulting
  // credential can be linked back to the user record. Previously a random
  // 16 bytes was substituted here, making every credential unattributable.
  const userId = Buffer.from(options.userId).toString('base64url');

  return {
    publicKey: {
      challenge,
      rp: {
        name: config.rpName,
        id: config.rpId,
      },
      user: {
        id: userId,
        name: options.username,
        displayName: options.displayName ?? options.username,
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
      attestation: 'none',
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: config.userVerification ?? DEFAULT_USER_VERIFICATION,
        residentKey: 'preferred',
        requireResidentKey: false,
      },
      excludeCredentials: (options.excludeCredentials ?? []).map((id) => ({
        type: 'public-key',
        id: id,
      })),
    },
    challenge,
  };
}

/**
 * Generate authentication options for navigator.credentials.get().
 */
export function generateAuthenticationOptions(
  config: WebAuthnConfig,
  options: AuthenticationOptions = {},
): Record<string, unknown> {
  const challenge = generateChallenge();

  return {
    publicKey: {
      challenge,
      rpId: config.rpId,
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
      userVerification: config.userVerification ?? DEFAULT_USER_VERIFICATION,
      allowCredentials: (options.allowCredentials ?? []).map((id) => ({
        type: 'public-key',
        id: id,
      })),
    },
    challenge,
  };
}

/**
 * Verify a registration response from the authenticator and extract the
 * credential public key.
 *
 * The attestationObject is CBOR-decoded to obtain authenticatorData, from which
 * the COSE public key is parsed and stored as SPKI PEM so later assertions can
 * be verified against it. Previously the raw attestationObject bytes were stored
 * verbatim in `publicKey`, which is unusable for verification — leaving nothing
 * for `verifyAuthenticationResponse` to check a signature against.
 *
 * Note: this validates the ceremony (type, origin, challenge, rpIdHash, UP flag)
 * and extracts the key. It does not verify the attestation *statement* itself
 * (attestation CA trust chain); with `attestation: 'none'` requested there is
 * nothing to verify, which is the default this helper configures.
 */
export function verifyRegistrationResponse(
  response: any,
  expectedChallenge: string,
  config: WebAuthnConfig,
): WebAuthnCredential | null {
  if (!response || !response.id || !response.response) return null;

  const clientData = resolveClientData(response.response.clientDataJSON);
  if (!clientData) return null;
  const clientDataJSON = clientData.json;

  if (clientDataJSON.type !== 'webauthn.create') return null;
  if (clientDataJSON.origin !== config.origin) return null;

  const challenge = extractChallenge(clientDataJSON.challenge);
  if (challenge !== expectedChallenge) return null;

  const attestationObject = toBuffer(response.response.attestationObject);
  if (!attestationObject) return null;

  let authData: Buffer | null = null;
  try {
    const decoded = decodeCbor(attestationObject);
    if (decoded instanceof Map) {
      authData = toBuffer(decoded.get('authData'));
    }
  } catch {
    return null;
  }
  if (!authData) return null;

  // Validate rpIdHash and that the user was present (UP flag, bit 0).
  const expectedRpIdHash = createHash('sha256').update(config.rpId).digest();
  if (authData.length < 37 || !authData.subarray(0, 32).equals(expectedRpIdHash)) return null;
  if ((authData[32] & 0x01) === 0) return null;

  const cose = parseCredentialPublicKey(authData);
  if (!cose) return null;
  const pubKey = coseKeyToPublicKey(cose);
  const alg = coseAlgFromKey(cose);
  if (!pubKey || !alg) return null;

  return {
    id: response.id,
    publicKey: pubKey.export({ type: 'spki', format: 'pem' }).toString(),
    algorithm: cose.get(3) as number,
    counter: parseCounter(authData),
    transports: response.response.getTransports?.() ?? [],
    userId: response.response.userHandle ?? '',
    createdAt: Date.now(),
  };
}

/**
 * Verify an authentication (assertion) response from the authenticator.
 *
 * This now performs the real WebAuthn assertion check: it verifies the
 * signature over `authenticatorData || SHA-256(clientDataJSON)` using the
 * stored credential public key, in addition to validating the ceremony
 * (type, origin, challenge, credential id, rpIdHash, UP flag, signature
 * counter). Previously it only string-compared clientData fields and the
 * counter — so anyone who learned a credential id and challenge could forge
 * an assertion object and authenticate.
 *
 * Returns the new signature counter on success (to be persisted), or false.
 */
export function verifyAuthenticationResponse(
  response: any,
  expectedChallenge: string,
  credential: WebAuthnCredential,
  config: WebAuthnConfig,
): boolean {
  if (!response || !response.id || !response.response) return false;

  const clientData = resolveClientData(response.response.clientDataJSON);
  if (!clientData || !clientData.raw) return false;
  const clientDataRaw = clientData.raw;
  const clientDataJSON = clientData.json;

  if (clientDataJSON.type !== 'webauthn.get') return false;
  if (clientDataJSON.origin !== config.origin) return false;

  const challenge = extractChallenge(clientDataJSON.challenge);
  if (challenge !== expectedChallenge) return false;

  if (response.id !== credential.id) return false;
  if (!credential.publicKey) return false;

  const authData = toBuffer(response.response.authenticatorData);
  const signature = toBuffer(response.response.signature);
  if (!authData || !signature) return false;

  // rpIdHash and user-presence checks.
  const expectedRpIdHash = createHash('sha256').update(config.rpId).digest();
  if (authData.length < 37 || !authData.subarray(0, 32).equals(expectedRpIdHash)) return false;
  if ((authData[32] & 0x01) === 0) return false;

  // Reconstruct the signed data and verify the signature against the stored key.
  const hash = hashForAlgorithm(credential.algorithm);
  const signedData = Buffer.concat([authData, createHash('sha256').update(clientDataRaw).digest()]);

  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(credential.publicKey);
  } catch {
    return false;
  }

  let valid: boolean;
  try {
    const verify = createVerify(hash);
    verify.update(signedData);
    verify.end();
    valid = verify.verify(publicKey, signature);
  } catch {
    return false;
  }
  if (!valid) return false;

  // Counter check: a non-zero stored/received counter must strictly increase.
  const counter = parseCounter(authData);
  if (counter !== 0 && counter <= credential.counter) return false;

  return true;
}

/**
 * Generate conditional UI mediation options.
 * This enables autofill-based passkey prompts in the browser.
 */
export function getConditionalUIOptions(config: WebAuthnConfig): Record<string, unknown> {
  return {
    publicKey: {
      challenge: generateChallenge(),
      rpId: config.rpId,
      userVerification: config.userVerification ?? DEFAULT_USER_VERIFICATION,
      mediation: 'conditional',
    },
  };
}

/**
 * Check if the current browser supports WebAuthn.
 */
export function isWebAuthnSupported(): boolean {
  return typeof window !== 'undefined' &&
    'PublicKeyCredential' in window &&
    typeof window.PublicKeyCredential !== 'undefined';
}

/**
 * Check if the current browser supports conditional UI (autofill).
 */
export async function isConditionalUISupported(): Promise<boolean> {
  if (!isWebAuthnSupported()) return false;
  try {
    const anyPKC = window.PublicKeyCredential as any;
    return typeof anyPKC.isConditionalMediationAvailable === 'function' &&
      await anyPKC.isConditionalMediationAvailable();
  } catch {
    return false;
  }
}

/** Map a stored COSE algorithm id to the Node hash name used for verification. */
function hashForAlgorithm(alg: number | undefined): string {
  switch (alg) {
    case -35: case -258: return 'sha384'; // ES384 / RS384
    case -36: case -259: return 'sha512'; // ES512 / RS512
    default: return 'sha256'; // ES256 / RS256 (and unknown → SHA-256)
  }
}

function extractChallenge(challenge: any): string {
  if (typeof challenge === 'string') return challenge;
  if (challenge instanceof ArrayBuffer) {
    return new TextDecoder().decode(challenge);
  }
  return String(challenge);
}

function parseCounter(authData: any): number {
  if (!authData) return 0;
  try {
    const buf = authData instanceof ArrayBuffer ? new Uint8Array(authData) : authData;
    if (buf.length < 37) return 0;
    return ((buf[33] << 24) | (buf[34] << 16) | (buf[35] << 8) | buf[36]) >>> 0;
  } catch {
    return 0;
  }
}
