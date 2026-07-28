import type { PledgeConfig } from './config';

/**
 * Bundler adapter types.
 *
 * PledgeStack supports pluggable bundlers. The default is PledgePack (Rust-based),
 * but users can opt for Vite, Rollup, Turbopack, Rsbuild, or Webpack by installing
 * the corresponding adapter package and setting `bundler` in their pledge.config.ts.
 *
 * ## Usage in pledge.config.ts
 * ```typescript
 * import { defineConfig } from 'pledgestack-shared';
 *
 * export default defineConfig({
 *   bundler: 'vite', // or 'rollup', 'turbopack', 'rsbuild', 'webpack', 'pledgepack' (default)
 * });
 * ```
 *
 * ## Implementing a custom adapter
 * ```typescript
 * import { createBundlerAdapter } from 'pledgestack-shared';
 *
 * export default createBundlerAdapter({
 *   name: 'my-bundler',
 *   build: async (config) => { ... },
 *   startDevServer: async (config) => { ... },
 *   transformFile: async (sourcePath, isDev) => { ... },
 * });
 * ```
 */

/** Which bundler to use for transforms and builds */
export type BundlerType = 'pledgepack' | 'vite' | 'rollup' | 'turbopack' | 'rsbuild' | 'webpack';

/** Result of a build operation */
export interface BuildResult {
  /** Output directory where bundled files were written */
  outDir: string;
  /** Whether the build succeeded */
  success: boolean;
  /** Error message if the build failed */
  error?: string;
  /** Warnings generated during build */
  warnings?: string[];
  /** Duration of the build in milliseconds */
  durationMs?: number;
}

/** Dev server handle returned by startDevServer */
export interface DevServerHandle {
  /** The port the dev server is listening on */
  port: number;
  /** The hostname the dev server is listening on */
  hostname: string;
  /** Stop the dev server */
  stop(): Promise<void>;
  /** Reload a specific module (HMR) */
  reload?(modulePath: string): void;
  /** Reload all modules */
  reloadAll?(): void;
}

/** Options for transforming a single file */
export interface TransformOptions {
  /** Whether we're in dev mode (affects sourcemaps, minification) */
  isDev: boolean;
  /** Port of the dev server (if running) */
  devServerPort?: number;
  /** Cargo configuration for Rust compilation */
  cargoConfig?: PledgeConfig['cargo'];
  /** Project root directory — used for resolving relative paths to the dev server */
  rootDir?: string;
}

/** Result of transforming a file */
export interface TransformResult {
  /** The transformed code as a file:// URL suitable for dynamic import() */
  fileUrl: string;
  /** Whether the transform was served from cache */
  cached?: boolean;
}

/**
 * Bundler adapter interface.
 *
 * Each bundler (PledgePack, Vite, Rollup, Turbopack, Rsbuild, Webpack) implements this interface
 * to provide build, dev server, and transform capabilities.
 */
export interface BundlerAdapter {
  /** The name of the bundler (e.g., 'pledgepack', 'vite') */
  readonly name: BundlerType;

  /**
   * Build the project for production.
   * Transforms all source files, bundles client/server code, and writes output.
   */
  build(config: PledgeConfig): Promise<BuildResult>;

  /**
   * Start a development server with HMR support.
   * Returns a handle to the running server.
   */
  startDevServer(config: PledgeConfig, options: DevServerOptions): Promise<DevServerHandle>;

  /**
   * Transform a single source file (TS/TSX/JSX/PSX/PS) to JavaScript.
   * Returns a file:// URL that can be dynamically imported.
   *
   * In dev mode, this may fetch from the dev server.
   * In production, this reads from the pre-built output.
   */
  transformFile(sourcePath: string, options: TransformOptions): Promise<TransformResult>;

  /**
   * Resolve a source file path to its production bundle path.
   * Used by the module loader to find pre-built modules.
   */
  resolveProductionPath(sourcePath: string, config: PledgeConfig): string;

  /**
   * Clean up any resources (temp files, caches, etc.)
   */
  dispose?(): Promise<void>;
}

/** Options for starting a dev server */
export interface DevServerOptions {
  /** Port for the main SSR server */
  port?: number;
  /** Port for the bundler's dev server (if separate) */
  bundlerPort?: number;
  /** Hostname to listen on */
  hostname?: string;
}

/**
 * Helper to define a bundler adapter with full type safety.
 */
export function createBundlerAdapter(adapter: BundlerAdapter): BundlerAdapter {
  return adapter;
}
