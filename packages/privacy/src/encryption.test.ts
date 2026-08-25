import { describe, it, expect } from 'vitest';
import { EncryptionManager } from './encryption';

describe('EncryptionManager (AES-256-GCM)', () => {
  it('round-trips plaintext', () => {
    const mgr = new EncryptionManager({ key: 'a-strong-passphrase-value' });
    const payload = mgr.encrypt('sensitive data');
    expect(payload.ciphertext).not.toContain('sensitive');
    expect(mgr.decrypt(payload)).toBe('sensitive data');
  });

  it('produces a fresh IV per encryption (same plaintext → different ciphertext)', () => {
    const mgr = new EncryptionManager({ key: 'a-strong-passphrase-value' });
    const a = mgr.encrypt('same');
    const b = mgr.encrypt('same');
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
  });

  it('rejects a tampered ciphertext (auth tag verification)', () => {
    const mgr = new EncryptionManager({ key: 'a-strong-passphrase-value' });
    const payload = mgr.encrypt('hello');
    const tampered = { ...payload, ciphertext: Buffer.from('deadbeef', 'hex').toString('base64') };
    expect(() => mgr.decrypt(tampered)).toThrow();
  });

  it('cannot decrypt with the wrong key', () => {
    const a = new EncryptionManager({ key: 'key-number-one-value-here' });
    const b = new EncryptionManager({ key: 'a-different-key-entirely!' });
    const payload = a.encrypt('secret');
    expect(() => b.decrypt(payload)).toThrow();
  });
});
