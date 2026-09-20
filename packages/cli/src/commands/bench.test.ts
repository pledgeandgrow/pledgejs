import { describe, it, expect } from 'vitest';
import { compareToBaseline, parseBaseline } from './bench';

describe('bench baseline comparison', () => {
  const base = [
    { name: 'a', avgTimeMs: 1 },
    { name: 'b', avgTimeMs: 2 },
    { name: 'c', avgTimeMs: 4 },
    { name: 'gone', avgTimeMs: 1 },
  ];

  it('flags regressions, improvements, missing and new entries', () => {
    const report = compareToBaseline(
      [{ name: 'a', avgTimeMs: 1.5 }, { name: 'b', avgTimeMs: 2.05 }, { name: 'c', avgTimeMs: 2 }, { name: 'new', avgTimeMs: 1 }],
      base,
    );
    expect(report.regressions.map((r) => r.name)).toEqual(['a']);
    expect(report.rows.find((r) => r.name === 'b')!.status).toBe('ok');
    expect(report.rows.find((r) => r.name === 'c')!.status).toBe('improvement');
    expect(report.missing).toEqual(['gone']);
    expect(report.added).toEqual(['new']);
  });

  it('honors the threshold', () => {
    const cur = [{ name: 'b', avgTimeMs: 2.2 }];
    expect(compareToBaseline(cur, base, 5).regressions).toHaveLength(1);
    expect(compareToBaseline(cur, base, 15).regressions).toHaveLength(0);
  });

  it('validates baseline files', () => {
    expect(parseBaseline('{"version":1,"results":[{"name":"a","avgTimeMs":1}]}').results).toHaveLength(1);
    expect(() => parseBaseline('nope')).toThrow(/JSON/);
    expect(() => parseBaseline('{}')).toThrow(/results/);
    expect(() => parseBaseline('{"results":[{"name":"a"}]}')).toThrow(/avgTimeMs/);
  });
});
