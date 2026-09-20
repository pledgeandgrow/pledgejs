import { describe, it, expect } from 'vitest';
import { parsePort } from './parse-port';

describe('parsePort', () => {
  it('accepts valid ports and undefined', () => {
    expect(parsePort(undefined)).toBeUndefined();
    expect(parsePort('3000')).toBe(3000);
    expect(parsePort('0')).toBe(0);
    expect(parsePort('65535')).toBe(65535);
  });

  it('rejects garbage instead of returning NaN', () => {
    for (const bad of ['abc', '', '80abc', '-1', '65536', '3000.5', '1e3']) {
      expect(() => parsePort(bad)).toThrow(/Invalid --port/);
    }
  });
});
