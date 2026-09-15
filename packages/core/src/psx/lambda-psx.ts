// @unconsumed — exported but not used in the request path. See REMAINING-ISSUES.md.

/**
 * #276 — Lambda PSX Support.
 *
 * AWS Lambda layer for .node addons, ARM64 + x86_64 support,
 * provisioned concurrency for Rust addon warm cache, snapstart compatibility.
 *
 * Provides:
 * - Lambda layer generation for .node addons
 * - ARM64 + x86_64 cross-compilation config
 * - Provisioned concurrency configuration
 * - Snapstart compatibility checks
 * - Cold start optimization utilities
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LambdaArchitecture = 'x86_64' | 'arm64';
export type LambdaRuntime = 'nodejs20.x' | 'nodejs18.x' | 'provided.al2023';

export interface LambdaLayerConfig {
  /** Layer name */
  layerName: string;
  /** Architecture */
  architecture: LambdaArchitecture;
  /** Node.js runtime */
  runtime: LambdaRuntime;
  /** Modules to include in the layer */
  modules: string[];
  /** Path to .node addon files */
  addonDir: string;
  /** Whether to enable Snapstart (Java only, but check compatibility) */
  snapstartCompatible?: boolean;
  /** Memory size in MB (default: 512) */
  memorySize?: number;
  /** Timeout in seconds (default: 30) */
  timeout?: number;
  /** Provisioned concurrency (default: 0 = disabled) */
  provisionedConcurrency?: number;
}

export interface LambdaLayerResult {
  layerName: string;
  architecture: LambdaArchitecture;
  zipPath: string;
  sizeBytes: number;
  modules: string[];
  runtime: LambdaRuntime;
}

export interface LambdaFunctionConfig {
  functionName: string;
  handler: string;
  runtime: LambdaRuntime;
  architecture: LambdaArchitecture;
  memorySize: number;
  timeout: number;
  environment: Record<string, string>;
  layers: string[];
  provisionedConcurrency?: number;
}

// ---------------------------------------------------------------------------
// Lambda Layer Generation
// ---------------------------------------------------------------------------

/**
 * Generates the directory structure for a Lambda layer containing .node addons.
 */
export function generateLayerStructure(config: LambdaLayerConfig, outputDir: string): LambdaLayerResult {
  mkdirSync(join(outputDir, 'nodejs', 'node_modules'), { recursive: true });
  mkdirSync(join(outputDir, 'addons'), { recursive: true });

  // Generate package.json for the layer
  const packageJson = {
    name: config.layerName,
    version: '1.0.0',
    description: 'PledgeStack PSX Lambda layer',
    private: true,
  };
  writeFileSync(join(outputDir, 'nodejs', 'package.json'), JSON.stringify(packageJson, null, 2));

  // Generate loader script
  const loader = generateAddonLoader(config.modules);
  writeFileSync(join(outputDir, 'nodejs', 'addon-loader.js'), loader);

  const zipPath = join(outputDir, `${config.layerName}.zip`);

  return {
    layerName: config.layerName,
    architecture: config.architecture,
    zipPath,
    sizeBytes: 0,
    modules: config.modules,
    runtime: config.runtime,
  };
}

/**
 * Generates the addon loader script for Lambda.
 */
export function generateAddonLoader(modules: string[]): string {
  return `// Auto-generated Lambda addon loader
const path = require('path');

const addons = {};
${modules.map(m => `try {
  addons['${m}'] = require(path.join('/opt/addons', '${m}.node'));
} catch (e) {
  console.error('Failed to load addon ${m}:', e.message);
  addons['${m}'] = null;
}`).join('\n')}

module.exports = addons;
module.exports.loadAddon = (name) => {
  if (!addons[name]) {
    throw new Error('Addon "' + name + '" not found or failed to load');
  }
  return addons[name];
};
`;
}

/**
 * Generates the SAM/CloudFormation template for the Lambda function.
 */
export function generateSamTemplate(config: LambdaFunctionConfig): string {
  const lines: string[] = [
    'AWSTemplateFormatVersion: "2010-09-09"',
    'Transform: AWS::Serverless-2016-10-31',
    '',
    'Resources:',
    `  ${config.functionName}:`,
    '    Type: AWS::Serverless::Function',
    '    Properties:',
    `      Handler: ${config.handler}`,
    `      Runtime: ${config.runtime}`,
    `      MemorySize: ${config.memorySize}`,
    `      Timeout: ${config.timeout}`,
    `      Architectures:`,
    `        - ${config.architecture}`,
    '      Environment:',
    '        Variables:',
  ];

  for (const [key, value] of Object.entries(config.environment)) {
    lines.push(`          ${key}: ${value}`);
  }

  if (config.layers.length > 0) {
    lines.push('      Layers:');
    for (const layer of config.layers) {
      lines.push(`        - ${layer}`);
    }
  }

  if (config.provisionedConcurrency && config.provisionedConcurrency > 0) {
    lines.push(`      ProvisionedConcurrencyConfig:`);
    lines.push(`        ProvisionedConcurrentExecutions: ${config.provisionedConcurrency}`);
  }

  return lines.join('\n');
}

/**
 * Generates the Cargo.toml for cross-compiling to Lambda targets.
 */
export function generateLambdaCargoConfig(
  moduleName: string,
  architecture: LambdaArchitecture,
): string {
  const target = architecture === 'arm64'
    ? 'aarch64-unknown-linux-gnu'
    : 'x86_64-unknown-linux-gnu';

  return `[package]
name = "pledge-${moduleName}-lambda"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
napi = { version = "2", features = ["napi8", "async"] }
napi-derive = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[profile.release]
lto = true
opt-level = 3
strip = true

# Cross-compile target: ${target}
# Build with: cargo build --target ${target} --release
`;
}

// ---------------------------------------------------------------------------
// Snapstart Compatibility
// ---------------------------------------------------------------------------

/**
 * Checks if a module is Snapstart compatible.
 * Snapstart restores from a snapshot, so any initialization that
 * depends on runtime state (sockets, timers, random) must be deferred.
 */
export function checkSnapstartCompatibility(
  rustSource: string,
): { compatible: boolean; issues: string[] } {
  const issues: string[] = [];

  // Check for static initialization that creates sockets/timers
  if (/\bstatic\s+\w+.*=\s*.*(TcpStream|UdpSocket|TcpListener)/.test(rustSource)) {
    issues.push('Static network socket initialization detected — not Snapstart compatible');
  }

  // Check for lazy_static with runtime state
  if (/lazy_static!.*(Timer|Interval|spawn)/.test(rustSource)) {
    issues.push('lazy_static with runtime state detected — defer initialization after restore');
  }

  // Check for std::time::Instant in static context
  if (/\bstatic\s+\w+.*Instant::now/.test(rustSource)) {
    issues.push('Static Instant::now() detected — time will be stale after Snapstart restore');
  }

  // Check for random state initialization
  if (/\bstatic\s+\w+.*thread_rng|OsRng/.test(rustSource)) {
    issues.push('Static RNG initialization detected — entropy may be stale after restore');
  }

  return {
    compatible: issues.length === 0,
    issues,
  };
}

/**
 * Generates a Snapstart-safe initialization wrapper.
 */
export function generateSnapstartWrapper(moduleName: string): string {
  return `// Auto-generated Snapstart-safe wrapper for ${moduleName}
let _addon = null;
let _initialized = false;

function getAddon() {
  if (!_addon) {
    _addon = require('/opt/addons/${moduleName}.node');
  }
  return _addon;
}

function ensureInitialized() {
  if (!_initialized) {
    const addon = getAddon();
    if (typeof addon.init === 'function') {
      addon.init();
    }
    _initialized = true;
  }
}

// Call ensureInitialized on every cold start / restore
exports.handler = async (event) => {
  ensureInitialized();
  const addon = getAddon();
  // Route handling
  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
`;
}

// ---------------------------------------------------------------------------
// Cold Start Optimization
// ---------------------------------------------------------------------------

/**
 * Generates a pre-warming script for provisioned concurrency.
 */
export function generatePrewarmScript(functionName: string, region: string): string {
  return `// Auto-generated pre-warm script for ${functionName}
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const client = new LambdaClient({ region: '${region}' });

async function prewarm() {
  const command = new InvokeCommand({
    FunctionName: '${functionName}',
    InvocationType: 'RequestResponse',
    Payload: JSON.stringify({ _prewarm: true }),
  });
  await client.send(command);
  console.log('Pre-warmed ${functionName}');
}

prewarm().catch(console.error);
`;
}
