/**
 * #279 — Serverless PSX Cold Start Optimization.
 *
 * Lazy-load .node addons on first request, pre-warm critical paths,
 * minimize Lambda initialization, sub-100ms cold start with Rust.
 *
 * Provides:
 * - Lazy addon loading with deferred require
 * - Pre-warm critical paths
 * - Initialization priority queue
 * - Cold start measurement and reporting
 */

import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ColdStartConfig {
  /** Modules to lazy-load */
  modules: string[];
  /** Critical path modules to pre-warm */
  criticalModules?: string[];
  /** Whether to preload critical modules on first import */
  preloadCritical?: boolean;
  /** Max initialization time in ms (default: 5000) */
  maxInitTime?: number;
  /** Whether to track cold start metrics */
  trackMetrics?: boolean;
}

export interface ColdStartMetrics {
  totalColdStartMs: number;
  moduleLoadTimes: Array<{ module: string; loadTimeMs: number; cached: boolean }>;
  criticalPathMs: number;
  addonLoadCount: number;
  cacheHitCount: number;
}

type ModuleLoader = () => unknown | Promise<unknown>;

// ---------------------------------------------------------------------------
// Cold Start Optimizer
// ---------------------------------------------------------------------------

/**
 * Optimizes cold start for serverless PSX by lazy-loading addons
 * and pre-warming critical paths.
 */
export class ColdStartOptimizer extends EventEmitter {
  private config: Required<ColdStartConfig>;
  private moduleCache = new Map<string, unknown>();
  private loadTimes = new Map<string, number>();
  private loadCount = 0;
  private cacheHitCount = 0;
  private cachedModules = new Set<string>();
  private loaders = new Map<string, ModuleLoader>();
  private initialized = false;
  private initStartTime = 0;
  private initEndTime = 0;

  constructor(config: ColdStartConfig) {
    super();
    this.config = {
      modules: config.modules,
      criticalModules: config.criticalModules ?? [],
      preloadCritical: config.preloadCritical ?? true,
      maxInitTime: config.maxInitTime ?? 5000,
      trackMetrics: config.trackMetrics ?? true,
    };
  }

  /**
   * Registers a module loader.
   */
  registerLoader(moduleName: string, loader: ModuleLoader): void {
    this.loaders.set(moduleName, loader);
  }

  /**
   * Initializes the optimizer, pre-loading critical modules.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initStartTime = Date.now();
    this.emit('init-start');

    if (this.config.preloadCritical) {
      await Promise.all(
        this.config.criticalModules.map(m => this.loadModule(m)),
      );
    }

    this.initialized = true;
    this.initEndTime = Date.now();
    this.emit('init-complete', { durationMs: this.initEndTime - this.initStartTime });
  }

  /**
   * Loads a module, using cache if available. Supports both sync and async
   * loaders — async loaders are awaited and the resolved value is cached.
   */
  async loadModule(moduleName: string): Promise<unknown> {
    if (this.moduleCache.has(moduleName)) {
      this.cacheHitCount++;
      this.cachedModules.add(moduleName);
      return this.moduleCache.get(moduleName);
    }

    const loader = this.loaders.get(moduleName);
    if (!loader) {
      throw new Error(`No loader registered for module "${moduleName}"`);
    }

    const startTime = Date.now();
    const result = loader();
    const module = result instanceof Promise ? await result : result;
    const loadTime = Date.now() - startTime;

    this.moduleCache.set(moduleName, module);
    this.loadTimes.set(moduleName, loadTime);
    this.loadCount++;

    this.emit('module-loaded', { module: moduleName, loadTimeMs: loadTime });
    return module;
  }

  /**
   * Gets a module, loading it lazily if needed.
   */
  async get(moduleName: string): Promise<unknown> {
    return this.loadModule(moduleName);
  }

  /**
   * Pre-warms a module without returning it.
   */
  async preWarm(moduleName: string): Promise<void> {
    await this.loadModule(moduleName);
  }

  /**
   * Pre-warms all registered modules.
   */
  async preWarmAll(): Promise<void> {
    await Promise.all(
      Array.from(this.loaders.keys()).map(m => this.loadModule(m)),
    );
  }

  /**
   * Clears the module cache, forcing reload on next access.
   */
  clearCache(): void {
    this.moduleCache.clear();
    this.loadTimes.clear();
  }

  /**
   * Returns cold start metrics.
   */
  getMetrics(): ColdStartMetrics {
    const moduleLoadTimes = Array.from(this.loadTimes.entries()).map(([module, loadTimeMs]) => ({
      module,
      loadTimeMs,
      cached: this.cachedModules.has(module),
    }));

    const criticalPathMs = this.config.criticalModules.reduce((sum, m) => {
      return sum + (this.loadTimes.get(m) ?? 0);
    }, 0);

    return {
      totalColdStartMs: this.initialized ? this.initEndTime - this.initStartTime : (this.initStartTime ? Date.now() - this.initStartTime : 0),
      moduleLoadTimes,
      criticalPathMs,
      addonLoadCount: this.loadCount,
      cacheHitCount: this.cacheHitCount,
    };
  }

  /**
   * Generates a cold start report.
   */
  generateReport(): string {
    const metrics = this.getMetrics();
    const lines: string[] = [
      '=== Cold Start Report ===',
      `Total cold start: ${metrics.totalColdStartMs}ms`,
      `Critical path: ${metrics.criticalPathMs}ms`,
      `Modules loaded: ${metrics.addonLoadCount}`,
      `Cache hits: ${metrics.cacheHitCount}`,
      '',
      'Module load times:',
    ];

    for (const entry of metrics.moduleLoadTimes) {
      lines.push(`  ${entry.module}: ${entry.loadTimeMs}ms${entry.cached ? ' (cached)' : ''}`);
    }

    return lines.join('\n');
  }

  /**
   * Checks if cold start is within target.
   */
  isWithinTarget(targetMs = 100): boolean {
    return this.getMetrics().totalColdStartMs <= targetMs;
  }
}

// ---------------------------------------------------------------------------
// Lazy Require Wrapper
// ---------------------------------------------------------------------------

/**
 * Creates a lazy-loading proxy for a .node addon.
 * The addon is only loaded on first property access.
 */
export function createLazyAddon(addonPath: string): Record<string, unknown> {
  let addon: Record<string, unknown> | null = null;

  const ensureLoaded = (): Record<string, unknown> => {
    if (!addon) {
      addon = require(addonPath) as Record<string, unknown>;
    }
    return addon;
  };

  return new Proxy({} as Record<string, unknown>, {
    get(_target, prop: string) {
      return ensureLoaded()[prop];
    },
    has(_target, prop: string) {
      return prop in ensureLoaded();
    },
    ownKeys() {
      return Object.keys(ensureLoaded());
    },
    getOwnPropertyDescriptor(_target, prop: string) {
      const obj = ensureLoaded();
      const desc = Object.getOwnPropertyDescriptor(obj, prop);
      if (desc) {
        desc.configurable = true;
      }
      return desc;
    },
  });
}

/**
 * Generates a serverless initialization script.
 */
export function generateInitScript(config: ColdStartConfig): string {
  return `// Auto-generated serverless initialization script
const { ColdStartOptimizer, createLazyAddon } = require('./cold-start');

const optimizer = new ColdStartOptimizer({
  modules: ${JSON.stringify(config.modules)},
  criticalModules: ${JSON.stringify(config.criticalModules ?? [])},
  preloadCritical: ${config.preloadCritical ?? true},
  trackMetrics: ${config.trackMetrics ?? true},
});

${config.modules.map(m =>
  `optimizer.registerLoader('${m}', () => createLazyAddon('/opt/addons/${m}.node'));`,
).join('\n')}

exports.handler = async (event) => {
  await optimizer.initialize();
  // Handler logic here
  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};

exports.getMetrics = () => optimizer.getMetrics();
exports.generateReport = () => optimizer.generateReport();
`;
}
