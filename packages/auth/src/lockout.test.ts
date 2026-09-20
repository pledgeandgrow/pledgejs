import { describe, it, expect, vi } from 'vitest';
import { AccountLockoutManager } from './index';
import { InMemorySecurityStore } from './security-store';

describe('AccountLockoutManager', () => {
  it('counts concurrent failures (no lost updates)', async () => {
    const m = new AccountLockoutManager({ maxAttempts: 5 });
    // A store that yields between get and set widens the race window.
    await Promise.all(Array.from({ length: 10 }, () => m.recordFailure('alice')));
    expect(await m.remainingAttempts('alice')).toBe(0);
    expect(await m.isLocked('alice')).toBe(true);
  });

  it('counts concurrent failures even with a slow store', async () => {
    const inner = new InMemorySecurityStore();
    const slow = {
      get: async (k: string) => { await new Promise((r) => setTimeout(r, 2)); return inner.get(k); },
      set: (k: string, v: string, t?: number) => inner.set(k, v, t),
      delete: (k: string) => inner.delete(k),
    };
    const m = new AccountLockoutManager({ maxAttempts: 3, store: slow });
    await Promise.all(Array.from({ length: 3 }, () => m.recordFailure('bob')));
    expect(await m.isLocked('bob')).toBe(true);
  });

  it('escalates backoff across successive lockouts (expiry does not reset the counter)', async () => {
    vi.useFakeTimers();
    try {
      const m = new AccountLockoutManager({ maxAttempts: 2, baseLockoutSeconds: 10, maxLockoutSeconds: 1000 });
      await m.recordFailure('c');
      const first = await m.recordFailure('c'); // failures=2 -> 10s
      expect(first.lockedUntil - Date.now()).toBe(10_000);
      vi.advanceTimersByTime(11_000);
      expect(await m.isLocked('c')).toBe(false);
      const second = await m.recordFailure('c'); // failures=3 -> 20s
      expect(second.lockedUntil - Date.now()).toBe(20_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
