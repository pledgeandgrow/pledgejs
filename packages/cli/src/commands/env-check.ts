import type { PledgeConfig } from 'pledgestack-shared';
import { validateEnv } from 'pledgestack-shared';

export interface EnvCheckOptions {
  /** Environment to read from (default: process.env) */
  env?: Record<string, string | undefined>;
}

/**
 * `pledge env-check` — validates environment variables against the
 * `envSchema` declared in pledge.config.ts. Same validation `pledge build`
 * and `pledge start` run, exposed standalone so it can be used in CI or
 * before boot.
 */
export async function envCheckCommand(config: PledgeConfig, options: EnvCheckOptions = {}): Promise<void> {
  const schema = config.envSchema;

  if (!schema || Object.keys(schema).length === 0) {
    console.log('\n  No envSchema configured in pledge.config.ts — nothing to validate.\n');
    return;
  }

  console.log('\n  Validating environment variables against envSchema...\n');

  const errors = validateEnv(schema, options.env);

  if (errors.length === 0) {
    console.log(`  \x1b[32m✓\x1b[0m All ${Object.keys(schema).length} environment variable(s) are valid.\n`);
    return;
  }

  for (const error of errors) {
    console.error(`  \x1b[31m✗\x1b[0m ${error}`);
  }
  console.error('');
  process.exit(1);
}
