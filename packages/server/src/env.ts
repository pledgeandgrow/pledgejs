import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const loadedEnv = new Map<string, string>();
let initialized = false;

/**
 * Loads .env, .env.local, .env.development, .env.production files.
 * Populates process.env with the values.
 * Variables with PLEDGE_PUBLIC_ prefix are exposed to the client.
 */
export function loadEnv(rootDir: string, mode: string = process.env.NODE_ENV ?? 'development'): void {
  if (initialized) return;
  initialized = true;

  const envFiles = [
    `.env`,
    `.env.local`,
    `.env.${mode}`,
    `.env.${mode}.local`,
  ];

  for (const file of envFiles) {
    const envPath = join(rootDir, file);
    if (!existsSync(envPath)) continue;

    const content = readFileSync(envPath, 'utf-8');
    parseEnvFile(content);
  }
}

function parseEnvFile(content: string): void {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Remove surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Don't override real process.env values, but let a later (more specific)
    // file override an earlier one: .env < .env.local < .env.<mode> <
    // .env.<mode>.local. Previously the FIRST file to define a key won, so
    // .env silently beat every override file.
    if (!(key in process.env) || loadedEnv.has(key)) {
      process.env[key] = value;
      loadedEnv.set(key, value);
    }
  }
}

/**
 * Returns all public environment variables (PLEDGE_PUBLIC_ prefix).
 * These are safe to expose to the client.
 */
export function getPublicEnv(): Record<string, string> {
  const publicEnv: Record<string, string> = {};
  const prefix = 'PLEDGE_PUBLIC_';

  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith(prefix) && value !== undefined) {
      const clientKey = key.slice(prefix.length);
      publicEnv[clientKey] = value;
    }
  }

  return publicEnv;
}

/**
 * Returns a script tag that injects public env vars into the client.
 * Left angle brackets are unicode-escaped so a PLEDGE_PUBLIC_ value
 * containing a closing script tag cannot break out of the script block.
 * `cspNonce` stamps the request's CSP nonce so the inline script survives
 * a strict script-src policy.
 */
export function getPublicEnvScript(cspNonce?: string): string {
  const publicEnv = getPublicEnv();
  const json = JSON.stringify(publicEnv).replace(/</g, '\\u003c');
  const nonceAttr = cspNonce ? ` nonce="${cspNonce}"` : '';
  return `<script${nonceAttr}>window.__PLEDGE_ENV__ = ${json};</script>`;
}

/**
 * Gets a specific environment variable.
 */
export function env(key: string): string | undefined {
  return process.env[key];
}
