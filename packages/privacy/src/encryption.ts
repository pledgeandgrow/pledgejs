import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;

export interface EncryptionConfig {
  /** Master encryption key (passphrase — will be derived via scrypt) */
  key: string;
  /** Salt for key derivation (optional — random if not provided) */
  salt?: string;
}

export interface EncryptedPayload {
  /** Base64-encoded ciphertext */
  ciphertext: string;
  /** Base64-encoded IV */
  iv: string;
  /** Base64-encoded auth tag */
  tag: string;
  /** Base64-encoded salt (if key was derived) */
  salt?: string;
}

/**
 * AES-256-GCM encryption for data at rest.
 *
 * Provides authenticated encryption with associated data (AEAD).
 * Use for session store encryption, field-level database encryption,
 * and any sensitive data that needs to be stored encrypted.
 */
export class EncryptionManager {
  private passphrase: string;
  private derivedKey: Buffer;
  private salt: Buffer;

  constructor(config: EncryptionConfig) {
    this.passphrase = config.key;
    this.salt = config.salt
      ? Buffer.from(config.salt, 'base64')
      : randomBytes(SALT_LENGTH);
    this.derivedKey = scryptSync(this.passphrase, this.salt, KEY_LENGTH);
  }

  /**
   * Encrypt a string.
   * The salt used for key derivation is included in the payload so that
   * decryption works across process restarts (a new EncryptionManager with
   * the same passphrase but a different random salt would derive a different
   * key and fail to decrypt).
   */
  encrypt(plaintext: string): EncryptedPayload {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.derivedKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      ciphertext: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      // Persist the salt so decryption works across restarts / instances.
      salt: this.salt.toString('base64'),
    };
  }

  /**
   * Decrypt a payload.
   * Throws if auth tag verification fails (tampered or wrong key).
   * If the payload carries a salt, re-derives the key from that salt so data
   * encrypted with a different random salt (e.g. before a process restart)
   * can still be decrypted with the same passphrase.
   */
  decrypt(payload: EncryptedPayload): string {
    let key = this.derivedKey;
    if (payload.salt) {
      const payloadSalt = Buffer.from(payload.salt, 'base64');
      // Only re-derive if the salt differs from the one used at construction.
      if (!payloadSalt.equals(this.salt)) {
        key = scryptSync(this.passphrase, payloadSalt, KEY_LENGTH);
      }
    }
    const decipher = createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(payload.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }

  /**
   * Encrypt a JSON-serializable object.
   */
  encryptObject(obj: unknown): EncryptedPayload {
    return this.encrypt(JSON.stringify(obj));
  }

  /**
   * Decrypt and parse a JSON object.
   */
  decryptObject<T>(payload: EncryptedPayload): T {
    return JSON.parse(this.decrypt(payload)) as T;
  }

  /**
   * Encrypt a specific field in an object (field-level encryption).
   * Returns a new object with the specified field encrypted.
   */
  encryptField<T extends Record<string, unknown>>(
    obj: T,
    field: keyof T,
  ): T & { [K in `${string & keyof T}__encrypted`]: EncryptedPayload } {
    const value = obj[field];
    if (value === undefined || value === null) return obj as T & Record<string, never>;

    const encrypted = this.encrypt(typeof value === 'string' ? value : JSON.stringify(value));
    const result = { ...obj, [field]: undefined };
    delete result[field];
    return { ...result, [`${String(field)}__encrypted`]: encrypted } as T & { [K in `${string & keyof T}__encrypted`]: EncryptedPayload };
  }

  /**
   * Decrypt a field in an object (reverse of encryptField).
   */
  decryptField<T extends Record<string, unknown>>(
    obj: T,
    field: string,
  ): Record<string, unknown> {
    const encryptedKey = `${field}__encrypted`;
    const payload = obj[encryptedKey] as EncryptedPayload | undefined;
    if (!payload) return obj;

    const decrypted = this.decrypt(payload);
    let value: unknown = decrypted;
    try {
      value = JSON.parse(decrypted);
    } catch {
      // Keep as string
    }

    const result = { ...obj };
    delete result[encryptedKey];
    return { ...result, [field]: value };
  }

  /**
   * Serialize encrypted payload to a single string for storage.
   */
  serialize(payload: EncryptedPayload): string {
    return JSON.stringify(payload);
  }

  /**
   * Deserialize an encrypted payload from a string.
   */
  deserialize(serialized: string): EncryptedPayload {
    return JSON.parse(serialized) as EncryptedPayload;
  }
}
