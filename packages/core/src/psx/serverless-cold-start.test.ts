import { describe, it, expect, beforeEach } from 'vitest';
import { ColdStartOptimizer, createLazyAddon, generateInitScript } from './serverless-cold-start';

describe('Serverless Cold Start Optimization (#279)', () => {
  let optimizer: ColdStartOptimizer;

  beforeEach(() => {
    optimizer = new ColdStartOptimizer({
      modules: ['mod1', 'mod2'],
      criticalModules: ['mod1'],
    });
  });

  describe('module loading', () => {
    it('loads modules on demand', async () => {
      let loaded = false;
      optimizer.registerLoader('mod1', () => { loaded = true; return { fn: () => 42 }; });
      const mod = await optimizer.get('mod1');
      expect(loaded).toBe(true);
      expect((mod as { fn: () => number }).fn()).toBe(42);
    });

    it('caches loaded modules', async () => {
      let loadCount = 0;
      optimizer.registerLoader('mod1', () => { loadCount++; return {}; });
      await optimizer.get('mod1');
      await optimizer.get('mod1');
      expect(loadCount).toBe(1);
    });

    it('throws for unregistered module', async () => {
      await expect(optimizer.get('unknown')).rejects.toThrow('No loader registered');
    });

    it('supports async loaders', async () => {
      optimizer.registerLoader('mod1', async () => {
        return { value: 99 };
      });
      const mod = await optimizer.get('mod1');
      expect((mod as { value: number }).value).toBe(99);
    });
  });

  describe('initialization', () => {
    it('preloads critical modules', async () => {
      let criticalLoaded = false;
      optimizer.registerLoader('mod1', () => { criticalLoaded = true; return {}; });
      await optimizer.initialize();
      expect(criticalLoaded).toBe(true);
    });

    it('only initializes once', async () => {
      let initCount = 0;
      optimizer.registerLoader('mod1', () => { initCount++; return {}; });
      await optimizer.initialize();
      await optimizer.initialize();
      expect(initCount).toBe(1);
    });
  });

  describe('preWarm', () => {
    it('pre-warms a specific module', async () => {
      let loaded = false;
      optimizer.registerLoader('mod1', () => { loaded = true; return {}; });
      await optimizer.preWarm('mod1');
      expect(loaded).toBe(true);
    });

    it('pre-warms all modules', async () => {
      let count = 0;
      optimizer.registerLoader('mod1', () => { count++; return {}; });
      optimizer.registerLoader('mod2', () => { count++; return {}; });
      await optimizer.preWarmAll();
      expect(count).toBe(2);
    });
  });

  describe('metrics', () => {
    it('tracks load metrics', async () => {
      optimizer.registerLoader('mod1', () => ({ value: 42 }));
      await optimizer.get('mod1');
      const metrics = optimizer.getMetrics();
      expect(metrics.addonLoadCount).toBe(1);
      expect(metrics.moduleLoadTimes.length).toBe(1);
    });

    it('tracks cache hits', async () => {
      optimizer.registerLoader('mod1', () => ({ value: 42 }));
      await optimizer.get('mod1');
      await optimizer.get('mod1');
      const metrics = optimizer.getMetrics();
      expect(metrics.cacheHitCount).toBe(1);
    });

    it('marks modules as cached on second access', async () => {
      optimizer.registerLoader('mod1', () => ({ value: 42 }));
      await optimizer.get('mod1');
      await optimizer.get('mod1');
      const metrics = optimizer.getMetrics();
      expect(metrics.moduleLoadTimes[0].cached).toBe(true);
    });

    it('generates report', async () => {
      optimizer.registerLoader('mod1', () => ({ value: 42 }));
      await optimizer.get('mod1');
      const report = optimizer.generateReport();
      expect(report).toContain('Cold Start Report');
      expect(report).toContain('mod1');
    });
  });

  describe('clearCache', () => {
    it('clears cache forcing reload', async () => {
      let loadCount = 0;
      optimizer.registerLoader('mod1', () => { loadCount++; return {}; });
      await optimizer.get('mod1');
      optimizer.clearCache();
      await optimizer.get('mod1');
      expect(loadCount).toBe(2);
    });
  });

  describe('createLazyAddon', () => {
    it('creates a lazy proxy', () => {
      const addon = createLazyAddon('node:path');
      expect(typeof addon).toBe('object');
    });
  });

  describe('generateInitScript', () => {
    it('generates init script with modules', () => {
      const script = generateInitScript({
        modules: ['mod1', 'mod2'],
        criticalModules: ['mod1'],
      });
      expect(script).toContain('mod1');
      expect(script).toContain('ColdStartOptimizer');
      expect(script).toContain('handler');
    });
  });
});
