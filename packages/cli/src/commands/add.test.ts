import { describe, it, expect } from 'vitest';
import { resolveVersionSpec } from './add';

describe('pledge add — resolveVersionSpec', () => {
  it('uses the SUPPORTED_CRATES default when no version is given', () => {
    expect(resolveVersionSpec('uuid')).toContain('version = "1"');
  });

  it('honours name@version', () => {
    expect(resolveVersionSpec('serde_yaml', '0.9')).toBe('"0.9"');
  });

  it('honours the documented full-spec second argument for unknown crates', () => {
    const spec = '{ version = "1.0", features = ["json"] }';
    expect(resolveVersionSpec('my-crate', undefined, spec)).toBe(spec);
  });

  it('returns undefined for an unknown crate without a version', () => {
    expect(resolveVersionSpec('definitely-not-a-known-crate')).toBeUndefined();
  });
});
