import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordRender,
  storeCompiledTemplate,
  getCompiledTemplate,
  invalidateTemplate,
  clearAllTemplates,
  getRouteStats,
  isNativeJitTemplatesAvailable,
} from './jit-templates';

describe('JIT Templates', () => {
  beforeEach(() => {
    clearAllTemplates();
  });

  describe('recordRender', () => {
    it('records first render and does not compile immediately', () => {
      const result = recordRender('/test', 12345);
      expect(result.renderCount).toBe(1);
      expect(result.shouldCompile).toBe(false);
    });

    it('triggers compilation after threshold with same template', () => {
      const hash = 99999;
      // Record enough renders to hit threshold
      for (let i = 0; i < 99; i++) {
        recordRender('/profile', hash);
      }
      const result = recordRender('/profile', hash, 100);
      expect(result.renderCount).toBe(100);
      expect(result.shouldCompile).toBe(true);
    });

    it('does not compile when template hash changes', () => {
      for (let i = 0; i < 99; i++) {
        recordRender('/changing', 1000 + i);
      }
      const result = recordRender('/changing', 1099, 100);
      expect(result.shouldCompile).toBe(false);
    });

    it('does not compile again after template is stored', () => {
      const hash = 55555;
      for (let i = 0; i < 100; i++) {
        recordRender('/cached', hash, 100);
      }
      storeCompiledTemplate('/cached', '<compiled>template</compiled>');
      const result = recordRender('/cached', hash, 100);
      expect(result.shouldCompile).toBe(false);
    });
  });

  describe('storeCompiledTemplate / getCompiledTemplate', () => {
    it('stores and retrieves a compiled template', async () => {
      await storeCompiledTemplate('/blog/:slug', '<compiled>blog template</compiled>');
      const template = getCompiledTemplate('/blog/:slug');
      expect(template).toBe('<compiled>blog template</compiled>');
    });

    it('returns null for route without compiled template', () => {
      expect(getCompiledTemplate('/nonexistent')).toBeNull();
    });
  });

  describe('invalidateTemplate', () => {
    it('clears compiled template and resets render count', async () => {
      await storeCompiledTemplate('/test', '<template>');
      recordRender('/test', 1);
      invalidateTemplate('/test');
      expect(getCompiledTemplate('/test')).toBeNull();
      const stats = getRouteStats();
      const stat = stats.find((s) => s.route === '/test');
      expect(stat?.renderCount).toBe(0);
    });
  });

  describe('clearAllTemplates', () => {
    it('clears all profiles and templates', async () => {
      recordRender('/a', 1);
      await storeCompiledTemplate('/a', '<a>');
      recordRender('/b', 2);
      clearAllTemplates();
      expect(getRouteStats()).toEqual([]);
      expect(getCompiledTemplate('/a')).toBeNull();
    });
  });

  describe('getRouteStats', () => {
    it('returns stats for all profiled routes', () => {
      recordRender('/route1', 1);
      recordRender('/route1', 1);
      recordRender('/route2', 2);
      const stats = getRouteStats();
      expect(stats.length).toBe(2);
      const r1 = stats.find((s) => s.route === '/route1');
      expect(r1?.renderCount).toBe(2);
      expect(r1?.hasCompiledTemplate).toBe(false);
    });
  });

  describe('isNativeJitTemplatesAvailable', () => {
    it('returns a boolean', () => {
      expect(typeof isNativeJitTemplatesAvailable()).toBe('boolean');
    });
  });
});
