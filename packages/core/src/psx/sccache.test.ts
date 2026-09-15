import { describe, it, expect } from 'vitest';
import { SccacheManager, generateGitHubActionsCacheConfig, formatSccacheStats } from './sccache';

describe('PSX Sccache', () => {
  describe('SccacheManager', () => {
    it('creates with default config', () => {
      const manager = new SccacheManager();
      expect(manager).toBeDefined();
    });

    it('returns env vars when enabled', () => {
      const manager = new SccacheManager({ enabled: true });
      // detect() will return false in test env, so env will be empty
      const env = manager.getEnv();
      // RUSTC_WRAPPER is set regardless (config says enabled)
      expect(env.RUSTC_WRAPPER).toBe('sccache');
    });

    it('returns empty env when disabled', () => {
      const manager = new SccacheManager({ enabled: false });
      const env = manager.getEnv();
      expect(Object.keys(env).length).toBe(0);
    });

    it('detects sccache availability', () => {
      const manager = new SccacheManager();
      // In test env, sccache is likely not installed
      const result = manager.detect();
      expect(typeof result).toBe('boolean');
    });

    // generateCacheKey spawns `rustc --version` via execSync, which is slow on
    // Windows (subprocess spawn + PATH search). Give it headroom past the
    // 5000ms default so this doesn't flake on cold CI runners.
    it('generates cache key', { timeout: 30000 }, () => {
      const manager = new SccacheManager();
      const key = manager.generateCacheKey('/nonexistent');
      expect(key.key).toContain('psx-');
      expect(key.platform).toContain(process.platform);
    });
  });

  describe('generateGitHubActionsCacheConfig', () => {
    it('generates cache config with key and restore keys', () => {
      const config = generateGitHubActionsCacheConfig('/nonexistent');
      expect(config.cacheKey).toContain('psx-');
      expect(config.restoreKeys.length).toBe(3);
      expect(config.env.RUSTC_WRAPPER).toBe('sccache');
    });
  });

  describe('formatSccacheStats', () => {
    it('formats stats', () => {
      const stats = {
        cacheSizeBytes: 1024 * 1024 * 100,
        maxCacheSizeBytes: 1024 * 1024 * 1024 * 10,
        compiledItems: 500,
        cacheHits: 400,
        cacheMisses: 100,
        hitRate: 80,
        errors: 0,
        nonCacheable: 5,
        nonCacheableCalls: 5,
      };
      const formatted = formatSccacheStats(stats);
      expect(formatted).toContain('sccache Statistics');
      expect(formatted).toContain('400');
      expect(formatted).toContain('80.0%');
    });
  });
});
