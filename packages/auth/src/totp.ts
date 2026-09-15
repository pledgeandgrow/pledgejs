/**
 * TOTP / 2FA support.
 *
 * Provides:
 * - TOTP enrollment with QR code URI generation
 * - TOTP verification with time-based window
 * - Backup code generation and verification
 * - Recovery code management
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { InMemorySecurityStore, type SecurityKeyValueStore } from './security-store';

export interface TOTPConfig {
  /** TOTP secret (base32 encoded) */
  secret: string;
  /** Issuer name (displayed in authenticator app) */
  issuer: string;
  /** Account name (email or username) */
  account: string;
  /** Number of digits (default: 6) */
  digits?: number;
  /** Time step in seconds (default: 30) */
  step?: number;
  /** Hash algorithm (default: 'sha1') */
  algorithm?: 'sha1' | 'sha256' | 'sha512';
}

const DEFAULT_DIGITS = 6;
const DEFAULT_STEP = 30;
const DEFAULT_ALGORITHM = 'sha1';
const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_LENGTH = 8;

const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Base32-encode a buffer (RFC 4648, no padding).
 */
function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_CHARS[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_CHARS[(value << (5 - bits)) & 0x1f];
  }
  return output;
}

/**
 * Generate a random TOTP secret in base32 encoding.
 *
 * The previous implementation emitted only two base32 chars per random byte
 * using overlapping bit slices without advancing the byte index, discarding
 * most of the entropy from `randomBytes(length)`. This now base32-encodes the
 * full random buffer so all `length * 8` bits of entropy are preserved.
 */
export function generateTOTPSecret(length = 20): string {
  return base32Encode(randomBytes(length));
}

/**
 * Decode a base32 string to a Buffer.
 */
function base32Decode(input: string): Buffer {
  const cleaned = input.replace(/=+$/, '').toUpperCase();
  const bytes: number[] = [];
  let buffer = 0;
  let bitsLeft = 0;

  for (const char of cleaned) {
    const value = BASE32_CHARS.indexOf(char);
    if (value === -1) continue;
    buffer = (buffer << 5) | value;
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      bytes.push((buffer >> (bitsLeft - 8)) & 0xff);
      bitsLeft -= 8;
    }
  }

  return Buffer.from(bytes);
}

/**
 * Generate the TOTP code for a given time and secret.
 */
export function generateTOTPCode(
  secret: string,
  time: number = Date.now(),
  config?: Partial<Pick<TOTPConfig, 'digits' | 'step' | 'algorithm'>>,
): string {
  const step = config?.step ?? DEFAULT_STEP;
  const digits = config?.digits ?? DEFAULT_DIGITS;
  const algorithm = config?.algorithm ?? DEFAULT_ALGORITHM;

  const counter = Math.floor(time / 1000 / step);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const key = base32Decode(secret);
  const hmac = createHmac(algorithm, key).update(counterBuffer).digest();

  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const otp = code % Math.pow(10, digits);
  return otp.toString().padStart(digits, '0');
}

/**
 * Verify a TOTP code against the current time window.
 * Allows a configurable window of time steps before and after.
 *
 * NOTE: this function is pure — it does not track consumed codes. To prevent
 * replay attacks (RFC 6238 §5.2), wrap it with `TotpReplayGuard.verify`
 * which tracks the last successfully used (counter, code) pair per user.
 */
export function verifyTOTP(
  secret: string,
  token: string,
  time: number = Date.now(),
  window = 1,
  config?: Partial<Pick<TOTPConfig, 'digits' | 'step' | 'algorithm'>>,
): boolean {
  const step = config?.step ?? DEFAULT_STEP;
  const digits = config?.digits ?? DEFAULT_DIGITS;

  if (token.length !== digits) return false;

  for (let i = -window; i <= window; i++) {
    const expectedCode = generateTOTPCode(secret, time + i * step * 1000, config);
    if (timingSafeEqual(Buffer.from(token), Buffer.from(expectedCode))) {
      return true;
    }
  }

  return false;
}

/**
 * Replay guard for TOTP verification (RFC 6238 §5.2: "the verifier MUST reject
 * attempts to reuse a successfully used TOTP").
 *
 * Tracks the last successfully used (counter, code) pair per secret. A code
 * that was already accepted within the same time window is rejected.
 * In-memory by default; for multi-instance deployments, back this with a
 * shared SecurityKeyValueStore (Redis, KV).
 */
export class TotpReplayGuard {
  private store: SecurityKeyValueStore;

  constructor(store?: SecurityKeyValueStore) {
    this.store = store ?? new InMemorySecurityStore();
  }

  private key(secret: string): string {
    return `totp:replay:${createHash('sha256').update(secret).digest('hex')}`;
  }

  /**
   * Verify a TOTP code and record it as consumed if valid.
   * Returns true only if the code is valid AND has not been used before.
   */
  async verify(
    secret: string,
    token: string,
    time: number = Date.now(),
    window = 1,
    config?: Partial<Pick<TOTPConfig, 'digits' | 'step' | 'algorithm'>>,
  ): Promise<boolean> {
    const step = config?.step ?? DEFAULT_STEP;
    if (!verifyTOTP(secret, token, time, window, config)) return false;

    const counter = Math.floor(time / 1000 / step);
    const storeKey = this.key(secret);
    const raw = await this.store.get(storeKey);
    let lastUsed: { counter: number; code: string } | null = null;
    if (raw) {
      try {
        lastUsed = JSON.parse(raw) as { counter: number; code: string };
      } catch {
        lastUsed = null;
      }
    }
    // Reject if the same code was already used in the same or adjacent counter window.
    if (
      lastUsed &&
      Math.abs(lastUsed.counter - counter) <= window &&
      lastUsed.code === token
    ) {
      return false;
    }

    // Record for slightly longer than the acceptance window so an adjacent
    // window's code can't be replayed either.
    const ttlMs = (window + 1) * step * 1000 * 2;
    await this.store.set(storeKey, JSON.stringify({ counter, code: token }), ttlMs);
    return true;
  }

  /** Clear replay state for a given secret (e.g., on re-enrollment). */
  async clear(secret: string): Promise<void> {
    await this.store.delete(this.key(secret));
  }
}

/**
 * Generate the otpauth:// URI for QR code enrollment.
 */
export function generateTOTPURI(config: TOTPConfig): string {
  const issuer = encodeURIComponent(config.issuer);
  const account = encodeURIComponent(config.account);
  const secret = config.secret.replace(/\s/g, '');
  const digits = config.digits ?? DEFAULT_DIGITS;
  const step = config.step ?? DEFAULT_STEP;
  const algorithm = config.algorithm ?? DEFAULT_ALGORITHM;

  const params = new URLSearchParams({
    secret,
    issuer: config.issuer,
    algorithm,
    digits: String(digits),
    period: String(step),
  });

  return `otpauth://totp/${issuer}:${account}?${params}`;
}

/**
 * TOTP enrollment result.
 */
export interface TOTPEnrollment {
  secret: string;
  uri: string;
  backupCodes: string[];
}

/**
 * Enroll a new TOTP device — generates secret, URI, and backup codes.
 */
export function enrollTOTP(issuer: string, account: string): TOTPEnrollment {
  const secret = generateTOTPSecret();
  const uri = generateTOTPURI({ secret, issuer, account });
  const backupCodes = generateBackupCodes();
  return { secret, uri, backupCodes };
}

/**
 * Generate backup/recovery codes.
 */
export function generateBackupCodes(count = BACKUP_CODE_COUNT, length = BACKUP_CODE_LENGTH): string[] {
  const codes: string[] = [];
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  for (let i = 0; i < count; i++) {
    const bytes = randomBytes(length);
    let code = '';
    for (let j = 0; j < length; j++) {
      code += chars[bytes[j] % chars.length];
    }
    codes.push(code);
  }
  return codes;
}

/**
 * Verify a backup code against a list (case-insensitive).
 * Returns the index of the used code, or -1 if not found.
 *
 * Iterates through ALL codes before returning to avoid a timing side-channel
 * that would leak the match position (and thus which backup code was used).
 */
export function verifyBackupCode(input: string, codes: string[]): number {
  const normalized = input.trim().toUpperCase();
  const inputBuf = Buffer.from(normalized);
  let matchIndex = -1;
  for (let i = 0; i < codes.length; i++) {
    const codeBuf = Buffer.from(codes[i].toUpperCase());
    if (inputBuf.length === codeBuf.length && timingSafeEqual(inputBuf, codeBuf)) {
      matchIndex = i;
      // Do NOT early-return — continue the loop to keep timing constant.
    }
  }
  return matchIndex;
}

/**
 * Consume a backup code — removes it from the list.
 * Returns a new array without the consumed code.
 */
export function consumeBackupCode(input: string, codes: string[]): { remaining: string[]; consumed: boolean } {
  const index = verifyBackupCode(input, codes);
  if (index === -1) {
    return { remaining: codes, consumed: false };
  }
  return {
    remaining: codes.filter((_, i) => i !== index),
    consumed: true,
  };
}
