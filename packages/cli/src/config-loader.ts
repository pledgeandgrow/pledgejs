import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { PledgeConfig, UserConfig } from 'pledgestack-shared';
import { resolveConfig, validateConfig } from 'pledgestack-shared';

/**
 * Loads the pledge.config.ts or pledge.config.js from the project root.
 * Uses jiti for TypeScript config support at runtime.
 * Falls back to default config if no file is found.
 *
 * #233: Environment-aware config — loads environment-specific overrides
 * (pledge.config.development.ts, pledge.config.production.ts, pledge.config.test.ts)
 * and deep-merges them with the base config.
 */
export async function loadConfig(rootDir?: string): Promise<PledgeConfig> {
  const root = rootDir ?? process.cwd();
  const baseConfigPaths = [
    join(root, 'pledgestack.config.ts'),
    join(root, 'pledgestack.config.js'),
    join(root, 'pledge.config.ts'),
    join(root, 'pledge.config.js'),
    join(root, 'pledge.config.mjs'),
  ];

  let baseConfig: UserConfig = {};

  // Load base config
  for (const configPath of baseConfigPaths) {
    if (!existsSync(configPath)) continue;

    try {
      if (configPath.endsWith('.ts')) {
        const { createJiti } = await import('jiti');
        const jiti = createJiti(import.meta.url);
        const mod = await jiti.import(configPath);
        baseConfig = (mod as { default?: UserConfig }).default ?? (mod as UserConfig);
      } else {
        const mod = await import(configPath);
        baseConfig = mod.default ?? mod;
      }
      break;
    } catch {
      continue;
    }
  }

  // #233: Load environment-specific override
  const env = detectEnvironment();
  const envConfig = await loadEnvConfig(root, env);

  // Deep merge: base config + environment override
  const mergedConfig = envConfig
    ? deepMergeConfig(baseConfig, envConfig)
    : baseConfig;

  const resolved = resolveConfig({ ...mergedConfig, rootDir: root });

  // Validate config and throw with helpful error messages if invalid
  const errors = validateConfig(resolved);
  if (errors.length > 0) {
    const msg = errors.map((e) => `  • ${e}`).join('\n');
    throw new Error(`Invalid pledge.config.ts:\n${msg}\n\nSee https://pledgestack.dev/docs/config for valid options.`);
  }

  return resolved;
}

/**
 * Detects the current environment from NODE_ENV or PLEDGE_ENV.
 */
function detectEnvironment(): 'development' | 'production' | 'test' {
  const env = process.env.PLEDGE_ENV ?? process.env.NODE_ENV ?? 'development';
  if (env === 'production') return 'production';
  if (env === 'test') return 'test';
  return 'development';
}

/**
 * Loads an environment-specific config override file.
 */
async function loadEnvConfig(
  root: string,
  env: 'development' | 'production' | 'test',
): Promise<UserConfig | null> {
  const envPaths = [
    join(root, `pledge.config.${env}.ts`),
    join(root, `pledge.config.${env}.js`),
    join(root, `pledge.config.${env}.mjs`),
    join(root, `pledgestack.config.${env}.ts`),
    join(root, `pledgestack.config.${env}.js`),
  ];

  for (const envPath of envPaths) {
    if (!existsSync(envPath)) continue;

    try {
      if (envPath.endsWith('.ts')) {
        const { createJiti } = await import('jiti');
        const jiti = createJiti(import.meta.url);
        const mod = await jiti.import(envPath);
        return (mod as { default?: UserConfig }).default ?? (mod as UserConfig);
      } else {
        const mod = await import(envPath);
        return mod.default ?? mod;
      }
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Deep merges two UserConfig objects. Environment config takes precedence.
 */
function deepMergeConfig(base: UserConfig, env: UserConfig): UserConfig {
  const result: UserConfig = { ...base };

  for (const key of Object.keys(env) as (keyof UserConfig)[]) {
    const baseVal = base[key];
    const envVal = env[key];

    if (baseVal && envVal && typeof baseVal === 'object' && typeof envVal === 'object' && !Array.isArray(baseVal) && !Array.isArray(envVal)) {
      // Deep merge objects (but not arrays — env replaces)
      (result as Record<string, unknown>)[key] = deepMergeConfig(
        baseVal as UserConfig,
        envVal as UserConfig,
      );
    } else if (envVal !== undefined) {
      // Env value takes precedence (including arrays)
      (result as Record<string, unknown>)[key] = envVal;
    }
  }

  return result;
}
