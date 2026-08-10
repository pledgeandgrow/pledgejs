import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { clearCache, getCacheStats, stopCacheCleanup, unstable_cache } from './fetch-cache';

describe('Fetch Cache LRU Eviction', () => {
  beforeEach(() => {
    clearCache();
  });

  afterEach(() => {
    stopCacheCleanup();
  });

  it('tracks cache size in stats', async () => {
    const fn1 = unstable_cache(async () => Math.random(), ['key1'], { revalidate: 60 });
    await fn1();
    const stats = getCacheStats();
    expect(stats.size).toBe(1);
  });

  it('clearCache resets all state', async () => {
    const fn = unstable_cache(async () => Math.random(), ['key'], { revalidate: 60 });
    await fn();
    expect(getCacheStats().size).toBe(1);
    clearCache();
    expect(getCacheStats().size).toBe(0);
  });

  it('deduplicates identical calls', async () => {
    let callCount = 0;
    const fn = unstable_cache(async () => {
      callCount++;
      return callCount;
    }, ['dedup'], { revalidate: 60 });

    const result1 = await fn();
    const result2 = await fn();
    // Second call should return cached value
    expect(result1).toBe(result2);
    expect(callCount).toBe(1);
  });
});
