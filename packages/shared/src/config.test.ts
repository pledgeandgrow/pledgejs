import { describe, it, expect } from 'vitest';
import * as configModule from './config';
const { validateConfig, resolveConfig, DEFAULT_CONFIG } = configModule;

// Debug: log what's available
console.log('configModule keys:', Object.keys(configModule));
console.log('validateConfig type:', typeof validateConfig);
console.log('resolveConfig type:', typeof resolveConfig);

describe('validateConfig', () => {
  it('returns no errors for default config', () => {
    const config = resolveConfig({});
    const errors = validateConfig(config);
    expect(errors).toEqual([]);
  });

  it('returns no errors for valid config', () => {
    const config = resolveConfig({
      rootDir: '/project',
      appDir: 'app',
      framework: 'react',
      output: 'standalone',
      defaultRuntime: 'node',
    });
    const errors = validateConfig(config);
    expect(errors).toEqual([]);
  });

  it('detects invalid defaultRuntime', () => {
    const config = { ...DEFAULT_CONFIG, defaultRuntime: 'invalid' as any };
    const errors = validateConfig(config);
    expect(errors.some((e) => e.includes('defaultRuntime'))).toBe(true);
  });

  it('detects invalid output mode', () => {
    const config = { ...DEFAULT_CONFIG, output: 'invalid' as any };
    const errors = validateConfig(config);
    expect(errors.some((e) => e.includes('output'))).toBe(true);
  });

  it('detects invalid framework', () => {
    const config = { ...DEFAULT_CONFIG, framework: 'angular' as any };
    const errors = validateConfig(config);
    expect(errors.some((e) => e.includes('framework'))).toBe(true);
  });

  it('detects invalid bundler', () => {
    const config = { ...DEFAULT_CONFIG, bundler: 'parcel' as any };
    const errors = validateConfig(config);
    expect(errors.some((e) => e.includes('bundler'))).toBe(true);
  });

  it('detects non-boolean rsc', () => {
    const config = { ...DEFAULT_CONFIG, rsc: 'yes' as any };
    const errors = validateConfig(config);
    expect(errors.some((e) => e.includes('rsc'))).toBe(true);
  });

  it('detects invalid siteUrl', () => {
    const config = { ...DEFAULT_CONFIG, siteUrl: 'not-a-url' };
    const errors = validateConfig(config);
    expect(errors.some((e) => e.includes('siteUrl'))).toBe(true);
  });

  it('accepts valid siteUrl', () => {
    const config = { ...DEFAULT_CONFIG, siteUrl: 'https://example.com' };
    const errors = validateConfig(config);
    expect(errors.some((e) => e.includes('siteUrl'))).toBe(false);
  });

  it('detects invalid rateLimit config', () => {
    const config = { ...DEFAULT_CONFIG, rateLimit: { maxTokens: -1 } as any };
    const errors = validateConfig(config);
    expect(errors.some((e) => e.includes('maxTokens'))).toBe(true);
  });

  it('detects invalid plugins array', () => {
    const config = { ...DEFAULT_CONFIG, plugins: 'not-an-array' as any };
    const errors = validateConfig(config);
    expect(errors.some((e) => e.includes('plugins'))).toBe(true);
  });

  it('detects plugin without name', () => {
    const config = { ...DEFAULT_CONFIG, plugins: [{ hook: () => {} }] as any };
    const errors = validateConfig(config);
    expect(errors.some((e) => e.includes('name'))).toBe(true);
  });

  it('detects empty rootDir', () => {
    const config = { ...DEFAULT_CONFIG, rootDir: '' };
    const errors = validateConfig(config);
    expect(errors.some((e) => e.includes('rootDir'))).toBe(true);
  });

  it('detects multiple errors', () => {
    const config = {
      ...DEFAULT_CONFIG,
      rootDir: '',
      defaultRuntime: 'invalid' as any,
      output: 'invalid' as any,
    };
    const errors = validateConfig(config);
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});
