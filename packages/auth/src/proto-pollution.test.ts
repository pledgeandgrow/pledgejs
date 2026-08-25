import { describe, it, expect } from 'vitest';
import { deepSanitize, safeParse, safeMerge } from './proto-pollution';

describe('proto-pollution defenses', () => {
  it('deepSanitize strips __proto__/constructor/prototype keys', () => {
    const dirty = JSON.parse('{"a":1,"__proto__":{"polluted":true},"b":{"constructor":{"x":1}}}');
    const clean = deepSanitize(dirty) as Record<string, unknown>;
    expect(clean.a).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(clean, '__proto__')).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('safeParse does not pollute Object.prototype', () => {
    safeParse('{"__proto__":{"polluted":true}}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('safeMerge ignores dangerous keys', () => {
    const merged = safeMerge({ a: 1 }, JSON.parse('{"__proto__":{"polluted":true},"b":2}'));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(merged.a).toBe(1);
    expect(merged.b).toBe(2);
  });
});
