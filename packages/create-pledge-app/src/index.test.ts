import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TEMPLATES,
  FRAMEWORKS,
  parseArgs,
  scaffold,
  generatePackageJson,
  generateTsConfig,
  generateGitignore,
} from './index';

const versions = { pledgestack: '^1.0.0-rc.0', pledgepack: '^0.3.3' };

describe('create-pledge-app parseArgs', () => {
  const parse = (...args: string[]) => parseArgs(['node', 'create-pledge-app', ...args]);

  it('reads the project name, template and framework (long, short and = forms)', () => {
    expect(parse('my-app', '--template', 'blog', '--framework', 'react')).toMatchObject({ name: 'my-app', template: 'blog', framework: 'react' });
    expect(parse('-t', 'api', '-f', 'vue')).toMatchObject({ template: 'api', framework: 'vue' });
    expect(parse('--template=saas', '--framework=svelte')).toMatchObject({ template: 'saas', framework: 'svelte' });
  });

  it('ignores unknown templates/frameworks instead of accepting arbitrary strings', () => {
    const o = parse('app', '--template', '../../etc', '--framework', 'angular');
    expect(o.template).toBeUndefined();
    expect(o.framework).toBeUndefined();
  });

  it('handles --install / --no-install', () => {
    expect(parse('--install').installDeps).toBe(true);
    expect(parse('--no-install').installDeps).toBe(false);
    expect(parse('x').installDeps).toBeUndefined();
  });

  it('exposes every documented template and framework', () => {
    expect([...TEMPLATES]).toEqual(expect.arrayContaining(['default', 'pledge', 'blog', 'api', 'saas', 'portfolio', 'dashboard', 'ecommerce']));
    expect([...FRAMEWORKS]).toEqual(['react', 'vue', 'solid', 'svelte']);
  });
});

describe('create-pledge-app generated config', () => {
  it('react package.json depends on pledgestack (which bundles the renderers) and react 19', () => {
    const pkg = generatePackageJson('My App', versions, 'react') as any;
    expect(pkg.name).toBe('my-app');
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe('module');
    expect(pkg.scripts).toEqual({ dev: 'pledge dev', build: 'pledge build', start: 'pledge start' });
    expect(pkg.dependencies.pledgestack).toBe('^1.0.0-rc.0');
    expect(pkg.dependencies.react).toMatch(/^\^19/);
    expect(pkg.devDependencies.pledgepack).toBe('^0.3.3');
    // Nothing in the generated app may depend on a workspace-only package.
    for (const v of Object.values({ ...pkg.dependencies, ...pkg.devDependencies })) {
      expect(String(v)).not.toMatch(/workspace:/);
    }
    expect(Object.keys(pkg.dependencies).some((d) => d.startsWith('pledgestack-renderer'))).toBe(false);
  });

  it('per-framework dependencies', () => {
    expect((generatePackageJson('a', versions, 'vue') as any).dependencies.vue).toBeDefined();
    expect((generatePackageJson('a', versions, 'solid') as any).dependencies['solid-js']).toBeDefined();
    expect((generatePackageJson('a', versions, 'svelte') as any).dependencies.svelte).toBeDefined();
  });

  it('tsconfig uses the right JSX mode per framework', () => {
    expect(generateTsConfig('react').compilerOptions).toMatchObject({ jsx: 'react-jsx', strict: true });
    expect(generateTsConfig('solid').compilerOptions).toMatchObject({ jsx: 'preserve', jsxImportSource: 'solid-js' });
    expect((generateTsConfig('vue').compilerOptions as Record<string, unknown>).jsx).toBeUndefined();
  });

  it('gitignore excludes build output and env files', () => {
    const g = generateGitignore().split('\n');
    expect(g).toEqual(expect.arrayContaining(['node_modules', '.pledge', '.env', '.env.local']));
  });
});

describe('create-pledge-app scaffold', () => {
  let cwd: string;
  let prev: string;

  beforeEach(async () => {
    prev = process.cwd();
    cwd = await mkdtemp(join(tmpdir(), 'pledge-scaffold-'));
    process.chdir(cwd);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    process.chdir(prev);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  });

  it('scaffolds the default react template with generated project files', async () => {
    await scaffold({ name: 'demo', template: 'default', framework: 'react', installDeps: false });
    const dir = join(cwd, 'demo');
    expect(existsSync(join(dir, 'app', 'page.tsx'))).toBe(true);
    expect(existsSync(join(dir, 'app', 'layout.tsx'))).toBe(true);
    expect(existsSync(join(dir, 'pledge.config.ts'))).toBe(true);
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8'));
    expect(pkg.name).toBe('demo');
    // Offline registry lookup falls back to the "latest" dist-tag rather than failing.
    expect(pkg.dependencies.pledgestack).toBe('latest');
    expect(JSON.parse(await readFile(join(dir, 'tsconfig.json'), 'utf-8')).compilerOptions.jsx).toBe('react-jsx');
    expect(await readFile(join(dir, '.gitignore'), 'utf-8')).toContain('node_modules');
    expect(await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf-8')).toContain('pledgepack');
  });

  it('pins to the latest published version when the registry answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ({ version: String(url).includes('pledgestack') ? '1.0.0-rc.0' : '0.3.3' }),
    })));
    await scaffold({ name: 'pinned', template: 'default', framework: 'react', installDeps: false });
    const pkg = JSON.parse(await readFile(join(cwd, 'pinned', 'package.json'), 'utf-8'));
    expect(pkg.dependencies.pledgestack).toBe('^1.0.0-rc.0');
    expect(pkg.devDependencies.pledgepack).toBe('^0.3.3');
  });

  it('every non-React framework gets its own default template', async () => {
    for (const fw of ['vue', 'solid', 'svelte'] as const) {
      await scaffold({ name: `app-${fw}`, template: 'default', framework: fw, installDeps: false });
      const files = readdirSync(join(cwd, `app-${fw}`, 'app'));
      expect(files.length).toBeGreaterThan(0);
      const pkg = JSON.parse(await readFile(join(cwd, `app-${fw}`, 'package.json'), 'utf-8'));
      expect(Object.keys(pkg.dependencies)).toContain(fw === 'solid' ? 'solid-js' : fw);
    }
  });

  it('falls back to the default template for React-only templates on other frameworks', async () => {
    await scaffold({ name: 'blogvue', template: 'blog', framework: 'vue', installDeps: false });
    expect(vi.mocked(console.warn).mock.calls.flat().join(' ')).toMatch(/only available for React/);
    const vuePage = readdirSync(join(cwd, 'blogvue', 'app'));
    expect(vuePage.some((f) => f.endsWith('.vue'))).toBe(true);
  });

  it('every documented React template scaffolds a non-empty app directory', async () => {
    for (const t of TEMPLATES) {
      await scaffold({ name: `t-${t}`, template: t, framework: 'react', installDeps: false });
      expect(existsSync(join(cwd, `t-${t}`, 'app'))).toBe(true);
      expect(readdirSync(join(cwd, `t-${t}`, 'app')).length).toBeGreaterThan(0);
    }
  });

  it('refuses to overwrite an existing directory', async () => {
    await scaffold({ name: 'dup', template: 'default', framework: 'react', installDeps: false });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(scaffold({ name: 'dup', template: 'default', framework: 'react', installDeps: false })).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
  });
});

import { generatePackageJson as genPkg } from './index';
describe('generatePackageJson name sanitisation', () => {
  const v = { pledgestack: '^1.0.0', pledgepack: '^1.0.0' };
  it('uses only the final path segment and a valid npm name', () => {
    expect(genPkg('../apps/My App', v, 'react').name).toBe('my-app');
    expect(genPkg('C:\\work\\Cool_Site', v, 'react').name).toBe('cool_site');
    expect(genPkg('./.hidden', v, 'react').name).toBe('hidden');
  });
  it('falls back to a default when nothing valid remains', () => {
    expect(genPkg('###', v, 'react').name).toBe('my-pledge-app');
  });
});
