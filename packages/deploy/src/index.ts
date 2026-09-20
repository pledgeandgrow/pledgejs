/**
 * Deploy adapters for PledgeStack.
 *
 * One-command deploy to Cloudflare Pages, Vercel, or Netlify.
 * Wraps `pledge build` + platform-specific upload in a single `pledge deploy` call.
 *
 * Usage:
 *   pledge deploy              # auto-detect platform, or use config.deploy.target
 *   pledge deploy --target cloudflare
 *   pledge deploy --target vercel
 *   pledge deploy --dry-run     # build only, don't upload
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PledgeConfig } from 'pledgestack-shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeployTarget = 'cloudflare' | 'vercel' | 'netlify' | 'auto';

export interface DeployOptions {
  /** Target platform (default: 'auto' — detect from config or lockfile) */
  target?: DeployTarget;
  /** Dry run — build and validate without uploading (default: false) */
  dryRun?: boolean;
  /** Project name override (default: package.json name or directory name) */
  project?: string;
  /** Production branch (default: 'main') */
  branch?: string;
  /** Verbose output (default: false) */
  verbose?: boolean;
}

export interface DeployResult {
  success: boolean;
  target: DeployTarget;
  url?: string;
  message: string;
  durationMs: number;
}

export interface DeployAdapter {
  /** Platform name */
  name: string;
  /** Detect if this platform is configured (e.g. wrangler.toml exists) */
  detect(config: PledgeConfig): boolean;
  /** Deploy the build output to the platform */
  deploy(config: PledgeConfig, options: DeployOptions): Promise<DeployResult>;
  /** Generate the platform config file (wrangler.toml, vercel.json, netlify.toml) */
  generateConfig(config: PledgeConfig): string;
}

/**
 * Project/site/branch names are interpolated into a shell command line
 * (`npx wrangler ... --branch="..."`). Branch names in particular come from
 * CI (attacker-controlled on pull requests), so only a conservative allowlist
 * of characters is accepted.
 */
const SAFE_ARG = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

function validateDeployArgs(config: PledgeConfig, options: DeployOptions): string | null {
  const project = options.project ?? config.rootDir.split(/[\\/]/).pop() ?? 'pledgestack-app';
  if (!SAFE_ARG.test(project)) {
    return `Invalid project name "${project}": use letters, digits, ".", "_", "-" (pass --project to override)`;
  }
  if (options.branch !== undefined && !SAFE_ARG.test(options.branch)) {
    return `Invalid branch name "${options.branch}": use letters, digits, ".", "_", "-", "/"`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cloudflare Pages Adapter
// ---------------------------------------------------------------------------

export const cloudflareAdapter: DeployAdapter = {
  name: 'cloudflare',

  detect(config) {
    return (
      existsSync(join(config.rootDir, 'wrangler.toml')) ||
      existsSync(join(config.rootDir, 'wrangler.jsonc')) ||
      config.pledgepack?.edge?.target === 'cloudflare'
    );
  },

  generateConfig(config) {
    const outDir = config.outDir ?? '.pledge';
    return `name = "${config.rootDir.split(/[\\/]/).pop() ?? 'pledgestack-app'}"
compatibility_date = "2024-09-23"
pages_build_output_dir = "${outDir}/public"

[build]
command = "pledge build"
output_dir = "${outDir}/public"

[vars]
NODE_VERSION = "20"
`;
  },

  async deploy(config, options) {
    const start = Date.now();
    const argError = validateDeployArgs(config, options);
    if (argError) return { success: false, target: 'cloudflare', message: argError, durationMs: Date.now() - start };
    const outDir = join(config.rootDir, config.outDir ?? '.pledge', 'public');
    const projectName = options.project ?? config.rootDir.split(/[\\/]/).pop() ?? 'pledgestack-app';

    // Ensure wrangler.toml exists
    const wranglerPath = join(config.rootDir, 'wrangler.toml');
    if (!existsSync(wranglerPath)) {
      console.log('  → Generating wrangler.toml...');
      const { writeFileSync } = await import('node:fs');
      writeFileSync(wranglerPath, this.generateConfig(config));
      console.log('  ✓ wrangler.toml generated');
    }

    if (options.dryRun) {
      return {
        success: true,
        target: 'cloudflare',
        message: `Dry run: would deploy ${outDir} to Cloudflare Pages project "${projectName}"`,
        durationMs: Date.now() - start,
      };
    }

    // Run wrangler pages deploy
    console.log(`  → Deploying to Cloudflare Pages (project: ${projectName})...`);

    const { execSync } = await import('node:child_process');
    try {
      const cmd = `npx wrangler pages deploy "${outDir}" --project-name="${projectName}"${options.branch ? ` --branch="${options.branch}"` : ''}`;
      if (options.verbose) console.log(`  $ ${cmd}`);

      const output = execSync(cmd, {
        cwd: config.rootDir,
        stdio: 'pipe',
        encoding: 'utf-8',
        env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID ?? '' },
      });

      // Extract the deployment URL from wrangler output
      const urlMatch = output.match(/https:\/\/[^\s]+\.pages\.dev/);
      const url = urlMatch ? urlMatch[0] : undefined;

      console.log(`  ✓ Deployed to Cloudflare Pages${url ? `: ${url}` : ''}`);

      return {
        success: true,
        target: 'cloudflare',
        url,
        message: `Deployed to Cloudflare Pages project "${projectName}"`,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        target: 'cloudflare',
        message: `Cloudflare deploy failed: ${message}`,
        durationMs: Date.now() - start,
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Vercel Adapter
// ---------------------------------------------------------------------------

export const vercelAdapter: DeployAdapter = {
  name: 'vercel',

  detect(config) {
    return (
      existsSync(join(config.rootDir, 'vercel.json')) ||
      config.pledgepack?.edge?.target === 'vercel'
    );
  },

  generateConfig(config) {
    const outDir = config.outDir ?? '.pledge';
    return JSON.stringify({
      buildCommand: 'pledge build',
      outputDirectory: `${outDir}/public`,
      framework: 'pledgestack',
      redirects: [{ source: '/(.*)', destination: '/api/ssr', permanent: false }],
    }, null, 2);
  },

  async deploy(config, options) {
    const start = Date.now();
    const argError = validateDeployArgs(config, options);
    if (argError) return { success: false, target: 'vercel', message: argError, durationMs: Date.now() - start };

    if (options.dryRun) {
      return {
        success: true,
        target: 'vercel',
        message: 'Dry run: would deploy to Vercel',
        durationMs: Date.now() - start,
      };
    }

    const { execSync } = await import('node:child_process');
    try {
      const projectName = options.project ?? config.rootDir.split(/[\\/]/).pop() ?? 'pledgestack-app';
      console.log(`  → Deploying to Vercel (project: ${projectName})...`);
      const projectFlag = `--name="${projectName}"`;
      const output = execSync(`npx vercel --prod --yes ${projectFlag}`, {
        cwd: config.rootDir,
        stdio: 'pipe',
        encoding: 'utf-8',
      });

      const urlMatch = output.match(/https:\/\/[^\s]+\.vercel\.app/);
      const url = urlMatch ? urlMatch[0] : undefined;
      console.log(`  ✓ Deployed to Vercel (project: ${projectName})${url ? `: ${url}` : ''}`);

      return {
        success: true,
        target: 'vercel',
        url,
        message: `Deployed to Vercel project "${projectName}"`,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        target: 'vercel',
        message: `Vercel deploy failed: ${message}`,
        durationMs: Date.now() - start,
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Netlify Adapter
// ---------------------------------------------------------------------------

export const netlifyAdapter: DeployAdapter = {
  name: 'netlify',

  detect(config) {
    return (
      existsSync(join(config.rootDir, 'netlify.toml')) ||
      config.pledgepack?.edge?.target === 'netlify'
    );
  },

  generateConfig(config) {
    const outDir = config.outDir ?? '.pledge';
    return `[build]
command = "pledge build"
publish = "${outDir}/public"

[build.environment]
NODE_VERSION = "20"

[[redirects]]
from = "/*"
to = "/.netlify/functions/ssr"
status = 200
`;
  },

  async deploy(config, options) {
    const start = Date.now();
    const argError = validateDeployArgs(config, options);
    if (argError) return { success: false, target: 'netlify', message: argError, durationMs: Date.now() - start };

    if (options.dryRun) {
      return {
        success: true,
        target: 'netlify',
        message: 'Dry run: would deploy to Netlify',
        durationMs: Date.now() - start,
      };
    }

    const { execSync } = await import('node:child_process');
    try {
      const projectName = options.project ?? config.rootDir.split(/[\\/]/).pop() ?? 'pledgestack-app';
      console.log(`  → Deploying to Netlify (site: ${projectName})...`);
      const siteFlag = `--site="${projectName}"`;
      const output = execSync(`npx netlify deploy --prod --dir=.pledge/public ${siteFlag}`, {
        cwd: config.rootDir,
        stdio: 'pipe',
        encoding: 'utf-8',
      });

      const urlMatch = output.match(/https:\/\/[^\s]+\.netlify\.app/);
      const url = urlMatch ? urlMatch[0] : undefined;
      console.log(`  ✓ Deployed to Netlify (site: ${projectName})${url ? `: ${url}` : ''}`);

      return {
        success: true,
        target: 'netlify',
        url,
        message: `Deployed to Netlify site "${projectName}"`,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        target: 'netlify',
        message: `Netlify deploy failed: ${message}`,
        durationMs: Date.now() - start,
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Registry + Auto-detection
// ---------------------------------------------------------------------------

export const deployAdapters: Record<string, DeployAdapter> = {
  cloudflare: cloudflareAdapter,
  vercel: vercelAdapter,
  netlify: netlifyAdapter,
};

/**
 * Auto-detect the deploy target from config and project files.
 * Priority: config.pledgepack.edge.target > wrangler.toml > vercel.json > netlify.toml > cloudflare (default)
 */
export function detectTarget(config: PledgeConfig): DeployTarget {
  // Check config — map edge target to a supported deploy target
  const edgeTarget = config.pledgepack?.edge?.target;
  if (edgeTarget === 'cloudflare' || edgeTarget === 'vercel' || edgeTarget === 'netlify') {
    return edgeTarget;
  }

  // Check for platform config files
  for (const [name, adapter] of Object.entries(deployAdapters)) {
    if (adapter.detect(config)) return name as DeployTarget;
  }

  // Default to cloudflare (best edge story)
  return 'cloudflare';
}

/**
 * Main deploy entry point. Builds the project and deploys to the target platform.
 */
export async function deploy(
  config: PledgeConfig,
  options: DeployOptions = {},
): Promise<DeployResult> {
  const start = Date.now();
  const target = options.target === 'auto' || !options.target
    ? detectTarget(config)
    : options.target;

  const adapter = deployAdapters[target];
  if (!adapter) {
    return {
      success: false,
      target,
      message: `Unknown deploy target: ${target}. Supported: cloudflare, vercel, netlify`,
      durationMs: Date.now() - start,
    };
  }

  // Step 1: Build
  console.log('\n  PledgeStack — Building for deployment...\n');
  const { execSync } = await import('node:child_process');
  try {
    execSync('pledge build', {
      cwd: config.rootDir,
      stdio: options.verbose ? 'inherit' : 'pipe',
      encoding: 'utf-8',
    });
    console.log('  ✓ Build complete\n');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      target,
      message: `Build failed: ${message}`,
      durationMs: Date.now() - start,
    };
  }

  // Step 2: Deploy
  console.log(`  → Deploying to ${adapter.name}...`);
  return adapter.deploy(config, options);
}
