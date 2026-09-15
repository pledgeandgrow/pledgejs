/**
 * #290 — Production PSX Profiling.
 *
 * Runtime profiling of Rust functions in production: call frequency,
 * execution time, memory allocation, integration with OpenTelemetry.
 *
 * Provides:
 * - Per-function call frequency and execution time tracking
 * - OpenTelemetry span integration for distributed tracing
 * - Memory allocation tracking per function
 * - Slow function detection and alerting
 * - Profile export in OTLP format
 */

import { performance } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FunctionProfile {
  functionName: string;
  module: string;
  callCount: number;
  totalExecutionTimeMs: number;
  avgExecutionTimeMs: number;
  minExecutionTimeMs: number;
  maxExecutionTimeMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  errorCount: number;
  errorRate: number;
  allocatedBytes: number;
  deallocatedBytes: number;
  netBytes: number;
  lastCalledAt: number;
  isSlow: boolean;
}

export interface ProfileConfig {
  /** Whether profiling is enabled (default: true) */
  enabled?: boolean;
  /** Slow function threshold in ms (default: 100) */
  slowThresholdMs?: number;
  /** Maximum number of samples to keep per function (default: 10,000) */
  maxSamples?: number;
  /** Whether to export to OpenTelemetry (default: false) */
  otelExport?: boolean;
  /** OTLP endpoint URL */
  otelEndpoint?: string;
  /** Service name for OTLP export */
  serviceName?: string;
  /** Sampling rate for profiling (0-1, default: 1) */
  sampleRate?: number;
}

export interface ProfileReport {
  functions: FunctionProfile[];
  totalCalls: number;
  totalErrors: number;
  totalExecutionTimeMs: number;
  slowFunctions: FunctionProfile[];
  timestamp: string;
  duration: number;
}

// ---------------------------------------------------------------------------
// OpenTelemetry span (minimal implementation)
// ---------------------------------------------------------------------------

export interface OtelSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentId?: string;
  startTime: number;
  endTime?: number;
  attributes: Record<string, string | number | boolean>;
  status: 'ok' | 'error';
  events: Array<{ name: string; timestamp: number; attributes?: Record<string, unknown> }>;
}

// ---------------------------------------------------------------------------
// Production Profiler
// ---------------------------------------------------------------------------

export class PsxProductionProfiler extends EventEmitter {
  private config: Required<ProfileConfig>;
  private profiles = new Map<string, FunctionProfile>();
  private samples = new Map<string, number[]>();
  private spans: OtelSpan[] = [];
  private startTime = 0;
  private callCounter = 0;

  constructor(config: ProfileConfig = {}) {
    super();
    this.config = {
      enabled: config.enabled ?? true,
      slowThresholdMs: config.slowThresholdMs ?? 100,
      maxSamples: config.maxSamples ?? 10_000,
      otelExport: config.otelExport ?? false,
      otelEndpoint: config.otelEndpoint ?? 'http://localhost:4318/v1/traces',
      serviceName: config.serviceName ?? 'pledgestack',
      sampleRate: config.sampleRate ?? 1,
    };
  }

  /**
   * Starts profiling.
   */
  start(): void {
    this.startTime = Date.now();
    this.emit('started', { timestamp: this.startTime });
  }

  /**
   * Records a function call with execution time and optional memory info.
   */
  recordCall(
    functionName: string,
    module: string,
    executionTimeMs: number,
    options?: {
      error?: boolean;
      allocatedBytes?: number;
      deallocatedBytes?: number;
      traceId?: string;
      spanId?: string;
      parentId?: string;
      attributes?: Record<string, string | number | boolean>;
    },
  ): void {
    if (!this.config.enabled) return;

    // Sampling
    if (this.config.sampleRate < 1 && Math.random() > this.config.sampleRate) return;

    this.callCounter++;
    const key = `${module}:${functionName}`;

    let profile = this.profiles.get(key);
    if (!profile) {
      profile = {
        functionName,
        module,
        callCount: 0,
        totalExecutionTimeMs: 0,
        avgExecutionTimeMs: 0,
        minExecutionTimeMs: Infinity,
        maxExecutionTimeMs: 0,
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
        errorCount: 0,
        errorRate: 0,
        allocatedBytes: 0,
        deallocatedBytes: 0,
        netBytes: 0,
        lastCalledAt: 0,
        isSlow: false,
      };
      this.profiles.set(key, profile);
    }

    profile.callCount++;
    profile.totalExecutionTimeMs += executionTimeMs;
    profile.avgExecutionTimeMs = profile.totalExecutionTimeMs / profile.callCount;
    profile.minExecutionTimeMs = Math.min(profile.minExecutionTimeMs, executionTimeMs);
    profile.maxExecutionTimeMs = Math.max(profile.maxExecutionTimeMs, executionTimeMs);
    profile.lastCalledAt = Date.now();
    profile.isSlow = executionTimeMs > this.config.slowThresholdMs;

    if (options?.error) {
      profile.errorCount++;
      profile.errorRate = profile.errorCount / profile.callCount;
    }

    if (options?.allocatedBytes) {
      profile.allocatedBytes += options.allocatedBytes;
    }
    if (options?.deallocatedBytes) {
      profile.deallocatedBytes += options.deallocatedBytes;
    }
    profile.netBytes = profile.allocatedBytes - profile.deallocatedBytes;

    // Track samples for percentile calculation
    let samples = this.samples.get(key);
    if (!samples) {
      samples = [];
      this.samples.set(key, samples);
    }
    samples.push(executionTimeMs);
    if (samples.length > this.config.maxSamples) {
      samples.shift();
    }

    // Update percentiles
    if (samples.length >= 10) {
      const sorted = [...samples].sort((a, b) => a - b);
      profile.p50Ms = sorted[Math.floor(sorted.length * 0.5)];
      profile.p95Ms = sorted[Math.floor(sorted.length * 0.95)];
      profile.p99Ms = sorted[Math.floor(sorted.length * 0.99)];
    }

    // Create OTel span if enabled
    if (this.config.otelExport && options?.traceId) {
      this.spans.push({
        name: `${module}.${functionName}`,
        traceId: options.traceId,
        spanId: options.spanId ?? this.generateSpanId(),
        parentId: options.parentId,
        startTime: performance.now() - executionTimeMs,
        endTime: performance.now(),
        attributes: {
          'psx.module': module,
          'psx.function': functionName,
          'psx.execution_time_ms': executionTimeMs,
          'psx.slow': profile.isSlow,
          ...options.attributes,
        },
        status: options?.error ? 'error' : 'ok',
        events: options?.error ? [{ name: 'exception', timestamp: Date.now() }] : [],
      });
    }

    // Emit events
    this.emit('call', { functionName, module, executionTimeMs, isSlow: profile.isSlow });
    if (profile.isSlow) {
      this.emit('slow-call', { functionName, module, executionTimeMs, threshold: this.config.slowThresholdMs });
    }
  }

  /**
   * Wraps a function with automatic profiling.
   */
  profile<T extends (...args: unknown[]) => unknown | Promise<unknown>>(
    fn: T,
    functionName: string,
    module: string,
  ): T {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- capture for closure
    const profiler = this;
    return (async function (...args: unknown[]) {
      const start = performance.now();
      try {
        const result = await fn(...args);
        const elapsed = performance.now() - start;
        profiler.recordCall(functionName, module, elapsed);
        return result;
      } catch (err) {
        const elapsed = performance.now() - start;
        profiler.recordCall(functionName, module, elapsed, { error: true });
        throw err;
      }
    }) as T;
  }

  /**
   * Gets the profile for a specific function.
   */
  getFunctionProfile(module: string, functionName: string): FunctionProfile | undefined {
    return this.profiles.get(`${module}:${functionName}`);
  }

  /**
   * Gets all function profiles.
   */
  getAllProfiles(): FunctionProfile[] {
    return Array.from(this.profiles.values());
  }

  /**
   * Gets all slow functions.
   */
  getSlowFunctions(): FunctionProfile[] {
    return this.getAllProfiles().filter(p => p.isSlow);
  }

  /**
   * Generates a full profile report.
   */
  generateReport(): ProfileReport {
    const functions = this.getAllProfiles().sort((a, b) => b.totalExecutionTimeMs - a.totalExecutionTimeMs);
    const totalCalls = functions.reduce((sum, f) => sum + f.callCount, 0);
    const totalErrors = functions.reduce((sum, f) => sum + f.errorCount, 0);
    const totalTime = functions.reduce((sum, f) => sum + f.totalExecutionTimeMs, 0);
    const slowFunctions = functions.filter(f => f.isSlow);

    return {
      functions,
      totalCalls,
      totalErrors,
      totalExecutionTimeMs: totalTime,
      slowFunctions,
      timestamp: new Date().toISOString(),
      duration: Date.now() - this.startTime,
    };
  }

  /**
   * Exports spans in OTLP JSON format.
   */
  exportOtelSpans(outputPath?: string): string {
    const otlpPayload = {
      resourceSpans: [{
        resource: {
          attributes: [{
            key: 'service.name',
            value: { stringValue: this.config.serviceName },
          }],
        },
        scopeSpans: [{
          spans: this.spans.map(span => ({
            traceId: span.traceId,
            spanId: span.spanId,
            parentSpanId: span.parentId,
            name: span.name,
            startTimeUnixNano: Math.floor(span.startTime * 1_000_000).toString(),
            endTimeUnixNano: span.endTime ? Math.floor(span.endTime * 1_000_000).toString() : '0',
            status: { code: span.status === 'ok' ? 1 : 2 },
            attributes: Object.entries(span.attributes).map(([k, v]) => ({
              key: k,
              value: typeof v === 'string' ? { stringValue: v } : typeof v === 'number' ? { doubleValue: v } : { boolValue: v },
            })),
          })),
        }],
      }],
    };

    const json = JSON.stringify(otlpPayload, null, 2);
    if (outputPath) {
      writeFileSync(outputPath, json, 'utf-8');
    }
    return json;
  }

  /**
   * Resets all profiling data.
   */
  reset(): void {
    this.profiles.clear();
    this.samples.clear();
    this.spans = [];
    this.callCounter = 0;
    this.startTime = Date.now();
  }

  private generateSpanId(): string {
    return Math.random().toString(16).slice(2, 18).padStart(16, '0');
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let defaultProfiler: PsxProductionProfiler | null = null;

export function getProductionProfiler(config?: ProfileConfig): PsxProductionProfiler {
  if (!defaultProfiler) {
    defaultProfiler = new PsxProductionProfiler(config);
  }
  return defaultProfiler;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatProfileReport(report: ProfileReport): string {
  const lines: string[] = [
    '\n=== PSX Production Profile ===\n',
    `Duration: ${(report.duration / 1000).toFixed(1)}s`,
    `Total calls: ${report.totalCalls}`,
    `Total errors: ${report.totalErrors}`,
    `Total execution time: ${report.totalExecutionTimeMs.toFixed(1)}ms\n`,
    'Function Profiles (sorted by total time):',
    '  ' + ['Function'.padEnd(25), 'Calls'.padStart(8), 'Avg'.padStart(10), 'P95'.padStart(10), 'P99'.padStart(10), 'Errors'.padStart(8)].join('  '),
    '  ' + '-'.repeat(75),
  ];

  for (const fn of report.functions.slice(0, 20)) {
    const icon = fn.isSlow ? yellow('⚠') : ' ';
    lines.push(`  ${icon} ${(fn.module + '.' + fn.functionName).slice(0, 23).padEnd(23)} ${fn.callCount.toString().padStart(8)} ${fn.avgExecutionTimeMs.toFixed(2).padStart(8)}ms ${fn.p95Ms.toFixed(2).padStart(8)}ms ${fn.p99Ms.toFixed(2).padStart(8)}ms ${fn.errorCount.toString().padStart(8)}`);
  }

  if (report.slowFunctions.length > 0) {
    lines.push(`\n${yellow('⚠')} Slow Functions (>${100}ms avg):`);
    for (const fn of report.slowFunctions) {
      lines.push(`  ${fn.module}.${fn.functionName}: avg ${fn.avgExecutionTimeMs.toFixed(1)}ms, p99 ${fn.p99Ms.toFixed(1)}ms`);
    }
  }

  return lines.join('\n');
}

function yellow(s: string): string { return `\x1b[33m${s}\x1b[0m`; }
