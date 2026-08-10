import { describe, it, expect } from 'vitest';
import { getThresholds, collectMetric, WebVitalsMonitor } from './web-vitals';

describe('Web Vitals', () => {
  describe('getThresholds', () => {
    it('returns thresholds for all vital names', () => {
      const thresholds = getThresholds();
      expect(thresholds.CLS).toBeDefined();
      expect(thresholds.LCP).toBeDefined();
      expect(thresholds.FID).toBeDefined();
      expect(thresholds.INP).toBeDefined();
      expect(thresholds.TTFB).toBeDefined();
      expect(thresholds.FCP).toBeDefined();
    });

    it('has good and poor values', () => {
      const thresholds = getThresholds();
      expect(thresholds.LCP.good).toBeLessThan(thresholds.LCP.poor);
      expect(thresholds.CLS.good).toBeLessThan(thresholds.CLS.poor);
    });
  });

  describe('collectMetric', () => {
    it('collects a metric with rating', () => {
      const metric = collectMetric('LCP', 2000);
      expect(metric.name).toBe('LCP');
      expect(metric.value).toBe(2000);
      expect(metric.rating).toBe('good');
    });

    it('assigns needs-improvement for mid-range values', () => {
      const metric = collectMetric('LCP', 3000);
      expect(metric.rating).toBe('needs-improvement');
    });

    it('assigns poor for bad values', () => {
      const metric = collectMetric('LCP', 5000);
      expect(metric.rating).toBe('poor');
    });

    it('generates unique IDs', () => {
      const m1 = collectMetric('FCP', 1000);
      const m2 = collectMetric('FCP', 1000);
      expect(m1.id).not.toBe(m2.id);
    });
  });

  describe('WebVitalsMonitor', () => {
    it('creates a monitor with config', () => {
      const monitor = new WebVitalsMonitor({ batchInterval: 1000 });
      expect(monitor).toBeDefined();
    });

    it('flush does not throw when no metrics collected', () => {
      const monitor = new WebVitalsMonitor({ batchInterval: 999999 });
      // flush should not throw even with no metrics
      expect(() => monitor.flush()).not.toThrow();
    });
  });
});
