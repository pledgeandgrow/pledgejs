import { describe, it, expect } from 'vitest';
import { measureFunctionOverhead, benchmarkSerialization, formatOverheadReport } from './napi-bench';

describe('NAPI Overhead Benchmarking', () => {
  describe('measureFunctionOverhead', () => {
    it('measures overhead between NAPI and JS functions', async () => {
      const result = await measureFunctionOverhead(
        'add',
        () => 1 + 2,
        () => 1 + 2,
        { iterations: 100, warmupIterations: 10 },
      );
      expect(result.functionName).toBe('add');
      expect(result.jsOnlyMs).toBeGreaterThan(0);
      expect(result.napiMs).toBeGreaterThan(0);
      expect(result.overheadMs).toBeGreaterThanOrEqual(-0.001);
      expect(result.recommendation).toBeDefined();
    });
  });

  describe('benchmarkSerialization', () => {
    it('benchmarks JSON serialization', async () => {
      const results = await benchmarkSerialization(
        { id: 1, name: 'test' },
        { iterations: 100, warmupIterations: 10 },
      );
      const json = results.find(r => r.format === 'json');
      expect(json).toBeDefined();
      expect(json?.encodeMs).toBeGreaterThan(0);
      expect(json?.decodeMs).toBeGreaterThan(0);
    });

    it('benchmarks raw buffer serialization', async () => {
      const results = await benchmarkSerialization(
        { data: [1, 2, 3] },
        { iterations: 100, warmupIterations: 10 },
      );
      const raw = results.find(r => r.format === 'raw');
      expect(raw).toBeDefined();
      expect(raw?.payloadSizeBytes).toBeGreaterThan(0);
    });

    it('benchmarks PSXB serialization', async () => {
      const results = await benchmarkSerialization(
        { msg: 'hello' },
        { iterations: 100, warmupIterations: 10 },
      );
      const psxb = results.find(r => r.format === 'psxb');
      expect(psxb).toBeDefined();
      expect(psxb?.payloadSizeBytes).toBeGreaterThan(0);
    });
  });

  describe('formatOverheadReport', () => {
    it('formats report', () => {
      const report = {
        results: [{
          functionName: 'add',
          jsOnlyMs: 0.001,
          napiMs: 0.005,
          overheadMs: 0.004,
          overheadPercent: 80,
          serializationMs: 0.002,
          serializationPercent: 40,
          isHotPath: false,
          recommendation: 'OK',
        }],
        serialization: [{
          format: 'json' as const,
          encodeMs: 0.01,
          decodeMs: 0.01,
          totalMs: 0.02,
          payloadSizeBytes: 100,
        }],
        avgOverheadMs: 0.004,
        hotPaths: [],
        timestamp: new Date().toISOString(),
      };
      const formatted = formatOverheadReport(report);
      expect(formatted).toContain('NAPI Overhead Benchmark');
      expect(formatted).toContain('add');
    });
  });
});
