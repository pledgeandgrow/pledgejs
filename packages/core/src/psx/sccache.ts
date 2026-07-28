/**
 * #214 — Incremental Compilation Cache.
 *
 * sccache integration for Rust addon compilation, cache sharing
 * across CI and local builds, automatic cache management.
 *
 * Provides:
 * - sccache detection and configuration
 * - Cache statistics tracking
 * - Automatic RUSTC_WRAPPER setup
 * - CI cache key generation
 * - Cache size management and cleanup
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execSync, exec } from 'node:child_process';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SccacheConfig {
  /** Whether sccache is enabled (default: true if installed) */
  enabled?: boolean;
  /** Maximum cache size in bytes (default: 10GB) */
  maxSize?: number;
  /** Cache directory (default: platform-specific) */
  cacheDir?: string;
  /** Whether to use shared cache (e.g., S3, GCS) */
  sharedCache?: {
    type: 's3' | 'gcs' | 'redis' | 'azure';
    endpoint?: string;
    bucket?: string;
    prefix?: string;
  };
  /** Whether to show cache statistics after build */
  showStats?: boolean;
}

export interface SccacheStats {
  cacheSizeBytes: number;
  maxCacheSizeBytes: number;
  compiledItems: number;
  cacheHits: number;
  cacheMisses: number;
  hitRate: number;
  errors: number;
  nonCacheable: number;
  nonCacheableCalls: number;
}

export interface CacheKeyInfo {
  key: string;
  rustVersion: string;
  cargoLockHash: string;
  sourceHash: string;
  featuresHash: string;
  platform: string;
}

// ---------------------------------------------------------------------------
// Sccache Manager
// ---------------------------------------------------------------------------

export class SccacheManager extends EventEmitter {
  private config: Omit<Required<SccacheConfig>, 'sharedCache'> & { sharedCache?: SccacheConfig['sharedCache'] };
  private isInstalled = false;
  private isRunning = false;

  constructor(config: SccacheConfig = {}) {
    super();
    this.config = {
      enabled: config.enabled ?? true,
      maxSize: config.maxSize ?? 10 * 1024 * 1024 * 1024, // 10GB
      cacheDir: config.cacheDir ?? this.getDefaultCacheDir(),
      sharedCache: config.sharedCache as { type: 's3' | 'gcs' | 'redis' | 'azure'; endpoint?: string; bucket?: string; prefix?: string } | undefined,
      showStats: config.showStats ?? true,
    };
  }

  /**
   * Checks if sccache is installed and available.
   */
  detect(): boolean {
    try {
      execSync('sccache --version', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      this.isInstalled = true;
      return true;
    } catch {
      this.isInstalled = false;
      return false;
    }
  }

  /**
   * Starts the sccache server.
   */
  async start(): Promise<boolean> {
    if (!this.config.enabled) return false;
    if (!this.detect()) {
      this.emit('warning', 'sccache not installed — run: cargo install sccache');
      return false;
    }

    return new Promise((resolve) => {
      exec('sccache --start-server', (err) => {
        if (err) {
          // Server might already be running
          this.isRunning = true;
          resolve(true);
        } else {
          this.isRunning = true;
          this.emit('started', { cacheDir: this.config.cacheDir });
          resolve(true);
        }
      });
    });
  }

  /**
   * Stops the sccache server.
   */
  async stop(): Promise<void> {
    if (!this.isInstalled) return;
    return new Promise((resolve) => {
      exec('sccache --stop-server', () => {
        this.isRunning = false;
        this.emit('stopped');
        resolve();
      });
    });
  }

  /**
   * Returns the environment variables needed to use sccache.
   */
  getEnv(): Record<string, string> {
    if (!this.config.enabled) return {};

    const env: Record<string, string> = {
      RUSTC_WRAPPER: 'sccache',
      SCCACHE_DIR: this.config.cacheDir,
    };

    if (this.config.sharedCache) {
      const sc = this.config.sharedCache;
      if (sc.type === 's3') {
        env['SCCACHE_BUCKET'] = sc.bucket ?? '';
        if (sc.endpoint) env['SCCACHE_ENDPOINT'] = sc.endpoint;
        if (sc.prefix) env['SCCACHE_S3_KEY_PREFIX'] = sc.prefix;
      } else if (sc.type === 'gcs') {
        env['SCCACHE_GCS_BUCKET'] = sc.bucket ?? '';
        if (sc.prefix) env['SCCACHE_GCS_KEY_PREFIX'] = sc.prefix;
      } else if (sc.type === 'redis') {
        env['SCCACHE_REDIS'] = sc.endpoint ?? '';
      }
    }

    return env;
  }

  /**
   * Retrieves sccache statistics.
   */
  getStats(): SccacheStats | null {
    if (!this.isInstalled) return null;

    try {
      const output = execSync('sccache --show-stats --stats-format json', {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });

      const data = JSON.parse(output);
      const compiled = (data.stats.compiled ?? 0) as number;
      const hits = (data.stats.cache_hits ?? 0) as number;
      const misses = (data.stats.cache_misses ?? 0) as number;

      return {
        cacheSizeBytes: data.cache_size ?? 0,
        maxCacheSizeBytes: this.config.maxSize,
        compiledItems: compiled,
        cacheHits: hits,
        cacheMisses: misses,
        hitRate: compiled > 0 ? (hits / compiled) * 100 : 0,
        errors: data.stats.errors ?? 0,
        nonCacheable: data.stats.non_cacheable ?? 0,
        nonCacheableCalls: data.stats.non_cacheable_calls ?? 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * Resets the cache (zeroes all statistics).
   */
  resetStats(): void {
    if (!this.isInstalled) return;
    try {
      execSync('sccache --zero-stats', { stdio: ['ignore', 'pipe', 'ignore'] });
      this.emit('stats:reset');
    } catch {
      // Ignore errors
    }
  }

  /**
   * Clears the entire cache.
   */
  clearCache(): void {
    if (!this.isInstalled) return;
    try {
      execSync('sccache --wipe', { stdio: ['ignore', 'pipe', 'ignore'] });
      this.emit('cache:cleared');
    } catch {
      // Ignore errors
    }
  }

  /**
   * Generates a CI cache key based on project state.
   */
  generateCacheKey(projectRoot: string): CacheKeyInfo {
    const cargoLockPath = join(projectRoot, 'Cargo.lock');
    const cargoTomlPath = join(projectRoot, 'packages', 'core', 'native', 'Cargo.toml');
    const sourceDir = join(projectRoot, 'packages', 'core', 'native', 'src');

    // Get Rust version
    let rustVersion = 'unknown';
    try {
      rustVersion = execSync('rustc --version', { encoding: 'utf-8' }).trim();
    } catch {
      // Ignore
    }

    // Hash Cargo.lock
    const cargoLockHash = existsSync(cargoLockPath)
      ? this.hashFile(cargoLockPath)
      : 'no-lock';

    // Hash Cargo.toml
    const cargoTomlHash = existsSync(cargoTomlPath)
      ? this.hashFile(cargoTomlPath)
      : 'no-toml';

    // Hash source files (cross-platform: use Node.js instead of shell `find`)
    let sourceHash = 'no-source';
    try {
      if (existsSync(sourceDir)) {
        const rsFiles = this.collectRsFiles(sourceDir);
        const output = rsFiles.map(f => readFileSync(f, 'utf-8')).join('');
        sourceHash = this.hashString(output);
      }
    } catch {
      // Ignore
    }

    // Platform
    const platform = `${process.platform}-${process.arch}`;

    // Combined key
    const key = `psx-${platform}-${rustVersion}-${cargoLockHash}-${cargoTomlHash}-${sourceHash}`;

    return {
      key,
      rustVersion,
      cargoLockHash,
      sourceHash,
      featuresHash: cargoTomlHash,
      platform,
    };
  }

  /**
   * Writes a CI cache configuration file.
   */
  writeCacheConfig(outputPath: string): void {
    const config = {
      sccache: {
        enabled: this.config.enabled,
        maxSize: this.config.maxSize,
        cacheDir: this.config.cacheDir,
        sharedCache: this.config.sharedCache,
      },
      env: this.getEnv(),
    };
    writeFileSync(outputPath, JSON.stringify(config, null, 2), 'utf-8');
  }

  /**
   * Returns the default cache directory for the platform.
   */
  private getDefaultCacheDir(): string {
    if (process.platform === 'win32') {
      return join(process.env.LOCALAPPDATA ?? 'C:\\AppData', 'sccache');
    }
    return join(process.env.HOME ?? '/tmp', '.cache', 'sccache');
  }

  /**
   * Hashes a file using a simple hash.
   */
  private hashFile(filePath: string): string {
    const content = readFileSync(filePath, 'utf-8');
    return this.hashString(content);
  }

  /**
   * Hashes a string using a simple hash.
   */
  private hashString(s: string): string {
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
      const char = s.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }

  /**
   * Returns whether sccache is installed and running.
   */
  isAvailable(): boolean {
    return this.isInstalled && this.isRunning;
  }

  /**
   * Recursively collects all .rs files in a directory (cross-platform).
   */
  private collectRsFiles(dir: string): string[] {
    const results: string[] = [];
    if (!existsSync(dir)) return results;
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        results.push(...this.collectRsFiles(fullPath));
      } else if (entry.endsWith('.rs')) {
        results.push(fullPath);
      }
    }
    return results.sort();
  }
}

// ---------------------------------------------------------------------------
// CI Cache Configuration
// ---------------------------------------------------------------------------

/**
 * Generates a GitHub Actions cache configuration for sccache.
 */
export function generateGitHubActionsCacheConfig(projectRoot: string): {
  cacheKey: string;
  restoreKeys: string[];
  path: string;
  env: Record<string, string>;
} {
  const manager = new SccacheManager();
  const keyInfo = manager.generateCacheKey(projectRoot);

  return {
    cacheKey: keyInfo.key,
    restoreKeys: [
      `psx-${keyInfo.platform}-${keyInfo.rustVersion}-${keyInfo.cargoLockHash}-`,
      `psx-${keyInfo.platform}-${keyInfo.rustVersion}-`,
      `psx-${keyInfo.platform}-`,
    ],
    path: manager.getEnv().SCCACHE_DIR ?? '',
    env: manager.getEnv(),
  };
}

/**
 * Generates a GitLab CI cache configuration for sccache.
 */
export function generateGitLabCacheConfig(projectRoot: string): {
  key: string;
  paths: string[];
  env: Record<string, string>;
} {
  const manager = new SccacheManager();
  const keyInfo = manager.generateCacheKey(projectRoot);

  return {
    key: keyInfo.key,
    paths: [manager.getEnv().SCCACHE_DIR ?? ''],
    env: manager.getEnv(),
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatSccacheStats(stats: SccacheStats): string {
  const lines: string[] = [
    '\n=== sccache Statistics ===\n',
    `Cache size: ${formatBytes(stats.cacheSizeBytes)} / ${formatBytes(stats.maxCacheSizeBytes)}`,
    `Compiled items: ${stats.compiledItems}`,
    `Cache hits: ${green(stats.cacheHits.toString())}`,
    `Cache misses: ${yellow(stats.cacheMisses.toString())}`,
    `Hit rate: ${stats.hitRate.toFixed(1)}%`,
    `Errors: ${stats.errors}`,
    `Non-cacheable: ${stats.nonCacheable}`,
  ];
  return lines.join('\n');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function green(s: string): string { return `\x1b[32m${s}\x1b[0m`; }
function yellow(s: string): string { return `\x1b[33m${s}\x1b[0m`; }
