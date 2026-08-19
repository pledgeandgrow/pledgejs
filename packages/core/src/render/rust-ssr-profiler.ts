/**
 * #244 — SSR profiling in Rust.
 *
 * Per-component render time measurement, flamegraph generation, and
 * performance bottleneck identification during SSR.
 *
 * The Rust profiler:
 * - Instruments each component render with high-precision timers
 * - Tracks component tree depth and render order
 * - Aggregates timing data by component name
 * - Generates flamegraph data compatible with speedscope/Chrome DevTools
 * - Identifies slow components (>16ms threshold for 60fps)
 *
 * Uses NAPI when available, with a JS fallback using performance.now().
 */

import { type ReactNode, type ComponentType } from 'react';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Whether the native Rust profiler is available */
let rustProfilerAvailable: boolean | null = null;
let rustProfilerAddon: Record<string, (...args: unknown[]) => unknown> | null = null;

/**
 * Attempts to load the native Rust SSR profiler.
 */
export function isRustProfilerAvailable(): boolean {
  if (rustProfilerAvailable !== null) return rustProfilerAvailable;
  try {
    const addon = require('../../native/rust-ssr-profiler.node') as Record<string, (...args: unknown[]) => unknown>;
    if (typeof addon.startProfiling === 'function' && typeof addon.stopProfiling === 'function') {
      rustProfilerAddon = addon;
      rustProfilerAvailable = true;
      return true;
    }
  } catch {
    // Addon not compiled
  }
  rustProfilerAvailable = false;
  return false;
}

export interface ProfileFrame {
  /** Component name */
  name: string;
  /** Start time in microseconds (relative to render start) */
  startUs: number;
  /** Duration in microseconds */
  durationUs: number;
  /** Depth in the component tree (0 = root) */
  depth: number;
  /** Whether this component was rendered by Rust or React */
  renderer: 'rust' | 'react';
  /** Children frames */
  children: ProfileFrame[];
  /** Props summary (for debugging) */
  propsSummary?: string;
}

export interface SSRProfileResult {
  /** Total render time in microseconds */
  totalTimeUs: number;
  /** All profile frames in render order */
  frames: ProfileFrame[];
  /** Aggregated timings by component name */
  aggregated: ComponentTiming[];
  /** Slow components (>16ms threshold) */
  slowComponents: ComponentTiming[];
  /** Whether the Rust profiler was used */
  usedRustProfiler: boolean;
  /** Flamegraph data in Chrome DevTools format */
  flamegraph?: FlamegraphData;
  /** Memory usage (if available) */
  memoryUsage?: { heapUsedBytes: number; heapTotalBytes: number; externalBytes: number };
}

export interface ComponentTiming {
  /** Component name */
  name: string;
  /** Number of times rendered */
  renderCount: number;
  /** Total render time in microseconds */
  totalTimeUs: number;
  /** Average render time in microseconds */
  avgTimeUs: number;
  /** Max render time in microseconds */
  maxTimeUs: number;
  /** Min render time in microseconds */
  minTimeUs: number;
  /** Whether it was rendered by Rust or React */
  renderer: 'rust' | 'react';
}

export interface FlamegraphData {
  /** Flamegraph nodes in speedscope format */
  nodes: FlamegraphNode[];
  /** Render order (array of node indices) */
  samples: number[];
  /** Time weights for each sample */
  weights: number[];
  /** Start time in microseconds */
  startUs: number;
  /** End time in microseconds */
  endUs: number;
  /** Total duration in microseconds */
  durationUs: number;
}

export interface FlamegraphNode {
  /** Node name (component name) */
  name: string;
  /** Node value (duration in microseconds) */
  value: number;
  /** Children node indices */
  children: number[];
  /** Depth in the tree */
  depth: number;
  /** Renderer used */
  renderer: 'rust' | 'react';
}

/** Threshold for slow components (16ms = 60fps frame budget) */
const SLOW_THRESHOLD_US = 16_000;

/** Active profiling session */
let activeProfile: {
  frames: ProfileFrame[];
  stack: { frame: ProfileFrame; startTime: bigint }[];
  startTime: bigint;
} | null = null;

/**
 * Starts a profiling session.
 * Call before rendering to capture all component timings.
 */
export function startProfiling(): void {
  if (isRustProfilerAvailable() && rustProfilerAddon) {
    rustProfilerAddon.startProfiling();
  }

  activeProfile = {
    frames: [],
    stack: [],
    startTime: process.hrtime.bigint(),
  };
}

/**
 * Stops the profiling session and returns the results.
 * Call after rendering is complete.
 */
export function stopProfiling(): SSRProfileResult {
  const endTime = process.hrtime.bigint();

  if (isRustProfilerAvailable() && rustProfilerAddon) {
    try {
      const result = rustProfilerAddon.stopProfiling() as SSRProfileResult;
      if (result) return result;
    } catch {
      // Fall through to JS
    }
  }

  if (!activeProfile) {
    return {
      totalTimeUs: 0,
      frames: [],
      aggregated: [],
      slowComponents: [],
      usedRustProfiler: false,
    };
  }

  const totalTimeUs = Number(endTime - activeProfile.startTime) / 1000;
  const frames = activeProfile.frames;
  const aggregated = aggregateTimings(frames);
  const slowComponents = aggregated.filter(t => t.totalTimeUs > SLOW_THRESHOLD_US);
  const flamegraph = generateFlamegraph(frames, totalTimeUs);

  const result: SSRProfileResult = {
    totalTimeUs,
    frames,
    aggregated,
    slowComponents,
    usedRustProfiler: false,
    flamegraph,
  };

  activeProfile = null;
  return result;
}

/**
 * Records a component render start. Called by the profiling wrapper.
 */
export function recordRenderStart(name: string, renderer: 'rust' | 'react', propsSummary?: string): void {
  if (!activeProfile) return;

  const frame: ProfileFrame = {
    name,
    startUs: Number(process.hrtime.bigint() - activeProfile.startTime) / 1000,
    durationUs: 0,
    depth: activeProfile.stack.length,
    renderer,
    children: [],
    propsSummary,
  };

  if (activeProfile.stack.length > 0) {
    activeProfile.stack[activeProfile.stack.length - 1].frame.children.push(frame);
  } else {
    activeProfile.frames.push(frame);
  }

  activeProfile.stack.push({ frame, startTime: process.hrtime.bigint() });
}

/**
 * Records a component render end. Called by the profiling wrapper.
 */
export function recordRenderEnd(): void {
  if (!activeProfile || activeProfile.stack.length === 0) return;

  const entry = activeProfile.stack.pop()!;
  entry.frame.durationUs = Number(process.hrtime.bigint() - entry.startTime) / 1000;
}

/**
 * Wraps a component with profiling instrumentation.
 */
export function withProfiling<P extends Record<string, unknown>>(
  component: ComponentType<P>,
  name?: string,
): ComponentType<P> {
  const componentName = name ?? component.displayName ?? component.name ?? 'Anonymous';

  if (typeof component === 'function' && !(component.prototype as { isReactComponent?: boolean }).isReactComponent) {
    // Function component
    const wrapped = (props: P) => {
      recordRenderStart(componentName, 'react', summarizeProps(props));
      try {
        const result = (component as (...args: unknown[]) => ReactNode)(props);
        return result;
      } finally {
        recordRenderEnd();
      }
    };
    (wrapped as unknown as { displayName: string }).displayName = componentName;
    return wrapped as ComponentType<P>;
  }

  return component;
}

/**
 * Aggregates timing data by component name.
 */
function aggregateTimings(frames: ProfileFrame[]): ComponentTiming[] {
  const map = new Map<string, ComponentTiming>();

  function walk(frame: ProfileFrame) {
    const existing = map.get(frame.name);
    if (existing) {
      existing.renderCount++;
      existing.totalTimeUs += frame.durationUs;
      existing.avgTimeUs = existing.totalTimeUs / existing.renderCount;
      existing.maxTimeUs = Math.max(existing.maxTimeUs, frame.durationUs);
      existing.minTimeUs = Math.min(existing.minTimeUs, frame.durationUs);
    } else {
      map.set(frame.name, {
        name: frame.name,
        renderCount: 1,
        totalTimeUs: frame.durationUs,
        avgTimeUs: frame.durationUs,
        maxTimeUs: frame.durationUs,
        minTimeUs: frame.durationUs,
        renderer: frame.renderer,
      });
    }

    for (const child of frame.children) {
      walk(child);
    }
  }

  for (const frame of frames) {
    walk(frame);
  }

  return Array.from(map.values()).sort((a, b) => b.totalTimeUs - a.totalTimeUs);
}

/**
 * Generates flamegraph data in speedscope-compatible format.
 */
function generateFlamegraph(frames: ProfileFrame[], totalTimeUs: number): FlamegraphData {
  const nodes: FlamegraphNode[] = [];
  const samples: number[] = [];
  const weights: number[] = [];

  function buildNode(frame: ProfileFrame, depth: number): number {
    const nodeIdx = nodes.length;
    const childIndices: number[] = [];

    for (const child of frame.children) {
      const childIdx = buildNode(child, depth + 1);
      childIndices.push(childIdx);
    }

    nodes.push({
      name: frame.name,
      value: frame.durationUs,
      children: childIndices,
      depth,
      renderer: frame.renderer,
    });

    samples.push(nodeIdx);
    weights.push(frame.durationUs);

    return nodeIdx;
  }

  for (const frame of frames) {
    buildNode(frame, 0);
  }

  return {
    nodes,
    samples,
    weights,
    startUs: 0,
    endUs: totalTimeUs,
    durationUs: totalTimeUs,
  };
}

/**
 * Summarizes props for debugging (truncated to prevent excessive output).
 */
function summarizeProps(props: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children') continue;
    if (value === null || value === undefined) continue;
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    parts.push(`${key}=${str.slice(0, 50)}`);
  }
  return parts.slice(0, 5).join(', ');
}

/**
 * Exports profile data as a speedscope JSON file.
 */
export function exportSpeedscope(profile: SSRProfileResult, name: string = 'SSR Profile'): string {
  if (!profile.flamegraph) {
    return JSON.stringify({ error: 'No flamegraph data available' });
  }

  return JSON.stringify({
    $schema: 'https://www.speedscope.app/file-format-schema.json',
    shared: {
      frames: profile.flamegraph.nodes.map(n => ({ name: n.name })),
    },
    profiles: [
      {
        type: 'sampled',
        name,
        unit: 'microseconds',
        startValue: 0,
        endValue: profile.totalTimeUs,
        samples: profile.flamegraph.samples,
        weights: profile.flamegraph.weights,
      },
    ],
  }, null, 2);
}

/**
 * Exports profile data as a human-readable report.
 */
export function exportReport(profile: SSRProfileResult): string {
  const lines: string[] = [
    '=== SSR Profile Report ===',
    `Total render time: ${(profile.totalTimeUs / 1000).toFixed(2)}ms`,
    `Components rendered: ${profile.aggregated.length}`,
    `Slow components (>16ms): ${profile.slowComponents.length}`,
    '',
    '=== Component Timings (sorted by total time) ===',
  ];

  for (const timing of profile.aggregated.slice(0, 20)) {
    const avg = (timing.avgTimeUs / 1000).toFixed(2);
    const total = (timing.totalTimeUs / 1000).toFixed(2);
    const max = (timing.maxTimeUs / 1000).toFixed(2);
    const flag = timing.totalTimeUs > SLOW_THRESHOLD_US ? ' ⚠️' : '';
    lines.push(
      `  ${timing.name.padEnd(30)} ${timing.renderer.padEnd(6)} renders=${timing.renderCount}  total=${total}ms  avg=${avg}ms  max=${max}ms${flag}`,
    );
  }

  if (profile.slowComponents.length > 0) {
    lines.push('', '=== Slow Components ===');
    for (const slow of profile.slowComponents) {
      lines.push(`  ${slow.name}: ${(slow.totalTimeUs / 1000).toFixed(2)}ms (${slow.renderCount} renders)`);
    }
  }

  return lines.join('\n');
}
