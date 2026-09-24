import type { PledgeConfig } from 'pledgestack-shared';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);

interface BenchOptions {
  psx?: boolean;
  iterations?: string;
  concurrency?: string;
  /** Path to a saved baseline results file to compare against */
  compare?: string;
  /** Path to write the current results to (use as a future --compare baseline) */
  save?: string;
  /** Regression threshold, percent slower than baseline (default 10) */
  threshold?: string;
}

export interface BaselineEntry { name: string; avgTimeMs: number; opsPerSec?: number }
export interface BaselineFile { version: 1; results: BaselineEntry[] }

export interface ComparisonRow {
  name: string;
  baselineMs: number;
  currentMs: number;
  /** Positive = slower than baseline, in percent */
  changePct: number;
  status: 'regression' | 'improvement' | 'ok';
}

export interface ComparisonReport {
  rows: ComparisonRow[];
  regressions: ComparisonRow[];
  /** Benchmarks present in the baseline but not in the current run */
  missing: string[];
  /** Benchmarks present now but absent from the baseline */
  added: string[];
}

/** Parse and validate a baseline file's JSON text. Throws on malformed input. */
export function parseBaseline(text: string): BaselineFile {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error('baseline is not valid JSON'); }
  const results = (data as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) throw new Error('baseline is missing a "results" array');
  const out: BaselineEntry[] = [];
  for (const r of results as Array<Record<string, unknown>>) {
    if (typeof r?.name !== 'string' || typeof r.avgTimeMs !== 'number' || !Number.isFinite(r.avgTimeMs)) {
      throw new Error('baseline entries need a string "name" and numeric "avgTimeMs"');
    }
    out.push({ name: r.name, avgTimeMs: r.avgTimeMs, opsPerSec: typeof r.opsPerSec === 'number' ? r.opsPerSec : undefined });
  }
  return { version: 1, results: out };
}

/** Compare current results with a baseline; slower than `thresholdPct` is a regression. */
export function compareToBaseline(
  current: BaselineEntry[],
  baseline: BaselineEntry[],
  thresholdPct = 10,
): ComparisonReport {
  const base = new Map(baseline.map((b) => [b.name, b]));
  const rows: ComparisonRow[] = [];
  const added: string[] = [];
  for (const cur of current) {
    const b = base.get(cur.name);
    if (!b) { added.push(cur.name); continue; }
    base.delete(cur.name);
    const changePct = b.avgTimeMs > 0 ? ((cur.avgTimeMs - b.avgTimeMs) / b.avgTimeMs) * 100 : 0;
    const status = changePct > thresholdPct ? 'regression' : changePct < -thresholdPct ? 'improvement' : 'ok';
    rows.push({ name: cur.name, baselineMs: b.avgTimeMs, currentMs: cur.avgTimeMs, changePct, status });
  }
  return { rows, regressions: rows.filter((r) => r.status === 'regression'), missing: [...base.keys()], added };
}

/**
 * pledge bench — Load test Rust functions.
 *
 * Usage:
 *   pledge bench --psx --save base.json      Save results as a baseline
 *   pledge bench --psx --compare base.json   Compare against a baseline; exit 1 on regressions
 *   pledge bench --psx --compare base.json --threshold 5
 *   pledge bench --psx -i 50000     Custom iteration count
 */
export async function benchCommand(
  _config: PledgeConfig,
  opts?: BenchOptions,
): Promise<void> {
  const { benchmarkFn, formatBenchResult, measureNapiOverhead } = await import('pledgestack-core');

  const iterations = opts?.iterations ? parseInt(opts.iterations, 10) : 10_000;
  const concurrency = opts?.concurrency ? parseInt(opts.concurrency, 10) : 1;

  if (!opts?.psx) {
    console.log(bold('\n=== PledgeStack Benchmark ===\n'));
    console.log(yellow('Use --psx flag to benchmark Rust NAPI functions'));
    console.log(dim('Example: pledge bench --psx --save base.json\n'));
    return;
  }

  console.log(bold('\n=== PledgeStack Benchmark ===\n'));
  console.log(`Iterations: ${iterations}  Concurrency: ${concurrency}\n`);

  // Try to load native addons
  let rustAddon: Record<string, unknown> | null = null;
  try {
    rustAddon = require('../../core/native/rust-bench.node');
  } catch {
    try {
      rustAddon = require('@pledgestack/core/native/rust-bench.node');
    } catch {
      rustAddon = null;
    }
  }

  const results: Array<{ name: string; result: unknown }> = [];

  if (rustAddon) {
    const addon: Record<string, unknown> = rustAddon;

    // NAPI overhead measurement
    console.log(bold('Measuring NAPI boundary overhead...'));
    if (typeof addon.noop === 'function') {
      const overhead = await measureNapiOverhead(addon.noop as () => void, { iterations });
      console.log(`  NAPI overhead: ${overhead.overheadMs.toFixed(4)}ms per call (${overhead.overheadPercent.toFixed(1)}%)`);
      console.log(`  Rust noop: ${overhead.rustResult.avgTimeMs.toFixed(4)}ms  JS noop: ${overhead.tsResult.avgTimeMs.toFixed(4)}ms\n`);
    }

    // Benchmark each function in the addon
    console.log(bold('Benchmarking Rust functions:'));
    console.log('  ' + ['Name'.padEnd(35), 'avg'.padStart(12), 'median'.padStart(12), 'p95'.padStart(12), 'p99'.padStart(12), 'ops/s'.padStart(15)].join('  '));
    console.log('  ' + '-'.repeat(100));

    for (const [name, fn] of Object.entries(addon)) {
      if (typeof fn !== 'function') continue;
      if (name.startsWith('_')) continue;

      try {
        const result = await benchmarkFn(`rust.${name}`, fn as () => unknown, { iterations, concurrency });
        console.log('  ' + formatBenchResult(result));
        results.push({ name, result });
      } catch (err) {
        console.log(`  ${red('✗')} rust.${name} — ${(err as Error).message}`);
      }
    }
  } else {
    // No native rust-bench addon — benchmark the JS fallback implementations
    // of the PSX accelerated modules instead of exiting. These are the exact
    // code paths that run in production when the native addons aren't
    // compiled, so the numbers reflect real deployment behavior.
    console.log(yellow('Native rust-bench addon not found — benchmarking JS fallback implementations.'));
    console.log(dim('These are the code paths used when native addons are not compiled.'));
    console.log(dim('To benchmark the native addons, compile them first: pledge build\n'));

    const core = await import('pledgestack-core');
    const benchPayload = Buffer.alloc(1024, 0x61);

    const jsSuites: Array<{ name: string; fn: () => unknown }> = [
      { name: 'kvSet (1KB)', fn: () => core.kvSet('bench:key', benchPayload) },
      { name: 'kvGet (1KB)', fn: () => core.kvGet('bench:key') },
      { name: 'checkRateLimit', fn: () => core.checkRateLimit('bench:rl', 1000, 100) },
      { name: 'recordRender', fn: () => core.recordRender('/bench/:x', 12345) },
      { name: 'getCompiledTemplate', fn: () => core.getCompiledTemplate('/bench/:x') },
      { name: 'gzipCompress (1KB)', fn: () => core.gzipCompress(benchPayload) },
      { name: 'searchAddDocument', fn: () => core.searchAddDocument('bench:doc', 'benchmark document content for search indexing') },
      { name: 'searchQuery', fn: () => core.searchQuery('benchmark', 10) },
    ];

    console.log(bold('Benchmarking JS fallback implementations:'));
    console.log('  ' + ['Name'.padEnd(35), 'avg'.padStart(12), 'median'.padStart(12), 'p95'.padStart(12), 'p99'.padStart(12), 'ops/s'.padStart(15)].join('  '));
    console.log('  ' + '-'.repeat(100));

    // Warm up the async kv/store state so benchmarks measure steady state.
    await core.kvSet('bench:key', benchPayload).catch(() => {});
    await core.searchAddDocument('bench:doc', 'benchmark document content for search indexing').catch(() => {});

    for (const suite of jsSuites) {
      try {
        const result = await benchmarkFn(`js.${suite.name}`, suite.fn as () => unknown, { iterations, concurrency });
        console.log('  ' + formatBenchResult(result));
        results.push({ name: suite.name, result });
      } catch (err) {
        console.log(`  ${red('✗')} js.${suite.name} — ${(err as Error).message}`);
      }
    }
  }

  const current: BaselineEntry[] = results.map(({ result }) => {
    const r = result as { name: string; avgTimeMs: number; opsPerSec?: number };
    return { name: r.name, avgTimeMs: r.avgTimeMs, opsPerSec: r.opsPerSec };
  });

  if (opts?.save) {
    const file: BaselineFile = { version: 1, results: current };
    await mkdir(dirname(opts.save), { recursive: true });
    await writeFile(opts.save, JSON.stringify(file, null, 2) + '\n', 'utf-8');
    console.log(dim(`\nBaseline saved to ${opts.save}`));
  }

  if (opts?.compare) {
    const threshold = opts.threshold ? parseFloat(opts.threshold) : 10;
    if (!Number.isFinite(threshold) || threshold < 0) {
      console.log(red(`\nInvalid --threshold "${opts.threshold}"`));
      process.exitCode = 1;
      return;
    }
    console.log(bold(`\nComparing against baseline ${opts.compare} (regression > ${threshold}% slower)...`));
    let baseline: BaselineFile;
    try {
      baseline = parseBaseline(await readFile(opts.compare, 'utf-8'));
    } catch (err) {
      console.log(red(`  Cannot read baseline: ${(err as Error).message}`));
      process.exitCode = 1;
      return;
    }
    const report = compareToBaseline(current, baseline.results, threshold);
    for (const row of report.rows) {
      const sign = row.changePct >= 0 ? '+' : '';
      const mark = row.status === 'regression' ? red('REGRESSION') : row.status === 'improvement' ? green('improved') : dim('ok');
      console.log(`  ${row.name.padEnd(35)}  ${row.baselineMs.toFixed(4)}ms -> ${row.currentMs.toFixed(4)}ms  ${(sign + row.changePct.toFixed(1) + '%').padStart(9)}  ${mark}`);
    }
    for (const n of report.missing) console.log(yellow(`  missing from this run: ${n}`));
    for (const n of report.added) console.log(dim(`  new (not in baseline): ${n}`));
    if (report.regressions.length > 0) {
      console.log(red(`\n${report.regressions.length} regression(s) detected.`));
      process.exitCode = 1;
    } else {
      console.log(green('\nNo regressions.'));
    }
  }

  console.log(bold(`\nBenchmark complete: ${results.length} function(s) tested`));
}

function red(s: string): string { return `\x1b[31m${s}\x1b[0m`; }
function green(s: string): string { return `\x1b[32m${s}\x1b[0m`; }
function yellow(s: string): string { return `\x1b[33m${s}\x1b[0m`; }
function bold(s: string): string { return `\x1b[1m${s}\x1b[0m`; }
function dim(s: string): string { return `\x1b[2m${s}\x1b[0m`; }
