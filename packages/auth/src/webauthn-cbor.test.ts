import { describe, it, expect } from 'vitest';
import { decodeCbor } from './webauthn-cbor';

describe('decodeCbor bounds checking', () => {
  it('rejects an array whose declared length exceeds the buffer', () => {
    expect(() => decodeCbor(Buffer.from([0x9a, 0x00, 0xff, 0xff, 0xff]))).toThrow();
  });
  it('rejects a map whose declared length exceeds the buffer', () => {
    expect(() => decodeCbor(Buffer.from([0xba, 0x00, 0xff, 0xff, 0xff]))).toThrow();
  });
  it('rejects a byte string that runs past the end of the buffer', () => {
    expect(() => decodeCbor(Buffer.from([0x45, 0x01, 0x02]))).toThrow();
  });
  it('rejects truncated input', () => {
    expect(() => decodeCbor(Buffer.from([]))).toThrow();
    expect(() => decodeCbor(Buffer.from([0x19, 0x01]))).toThrow();
  });
  it('still decodes valid maps', () => {
    const m = decodeCbor(Buffer.from([0xa1, 0x01, 0x02])) as Map<unknown, unknown>;
    expect(m.get(1)).toBe(2);
  });
});
