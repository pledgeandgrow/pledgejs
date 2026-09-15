import type { PledgeConfig } from 'pledgestack-shared';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface BenchOptions {
  psx?: boolean;
  iterations?: string;
  concurrency?: string;
  compare?: boolean;
}

/**
 * pledge bench — Load test Rust functions and compare with TypeScript equivalents.
 *
 * Usage:
 *   pledge bench --psx              Benchmark all Rust NAPI functions
 *   pledge bench --psx --compare    Compare Rust vs TypeScript
 *   pledge bench --psx -i 50000     Custom iteration count
 */
export async function benchCommand(
  _config: PledgeConfig,
  opts?: BenchOptions,
): Promise<void> {
  const { benchmarkFn, formatBenchResult, measureNapiOverhead } = await import('pledgestack-core');

  const iterations = opts?.iterations ? parseInt(opts.iterations, 10) : 10_000;
  const concurrency = opts?.concurrency ? parseInt(opts.concurrency, 10) : 1;

  console.log(bold('\n=== PledgeStack Benchmark ===\n'));
  console.log(`Iterations: ${iterations}  Concurrency: ${concurrency}\n`);

  if (!opts?.psx) {
    console.log(yellow('Use --psx flag to benchmark Rust NAPI functions'));
    console.log(dim('Example: pledge bench --psx --compare\n'));
    return;
  }

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

  if (opts?.compare) {
    console.log(bold('\nComparing Rust vs TypeScript...'));
    console.log(yellow('  Comparison requires TypeScript equivalents to be registered.'));
    console.log(dim('  Use the compareRustVsTs() API for programmatic comparison.\n'));
  }

  console.log(bold(`\nBenchmark complete: ${results.length} function(s) tested`));
}

function red(s: string): string { return `\x1b[31m${s}\x1b[0m`; }
function yellow(s: string): string { return `\x1b[33m${s}\x1b[0m`; }
function bold(s: string): string { return `\x1b[1m${s}\x1b[0m`; }
function dim(s: string): string { return `\x1b[2m${s}\x1b[0m`; }
