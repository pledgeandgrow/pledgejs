import { writeFileSync, existsSync, cpSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import prompts from 'prompts';

interface NpmRegistryResponse {
  version: string;
}

/**
 * The npm dist-tag matching this scaffolder's own release channel.
 * When create-pledge-app itself is a prerelease (e.g. 0.3.0-beta.0 → tag "beta"),
 * scaffolded apps must install the matching prerelease framework packages —
 * pinning `latest` would give them an older, incompatible stable release.
 */
function ownChannel(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    const m = pkg.version?.match(/^\d+\.\d+\.\d+-([a-zA-Z]+)/);
    return m?.[1] ?? 'latest';
  } catch {
    return 'latest';
  }
}

async function fetchLatestVersion(pkgName: string, tag = 'latest'): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkgName}/${tag}`);
    if (!res.ok) return null;
    const data = (await res.json()) as NpmRegistryResponse;
    return data.version ?? null;
  } catch {
    return null;
  }
}

async function resolveLatestVersions(): Promise<{ pledgestack: string; pledgepack: string }> {
  const channel = ownChannel();
  // Try the scaffolder's own channel first (e.g. "rc"); if that tag doesn't
  // exist on the registry yet, fall back to "latest" so scaffolding still
  // works before the first prerelease is published.
  const [pledgestackVer, pledgepackVer] = await Promise.all([
    fetchLatestVersion('pledgestack', channel).then((v) => v ?? (channel === 'latest' ? null : fetchLatestVersion('pledgestack'))),
    fetchLatestVersion('pledgepack', channel).then((v) => v ?? (channel === 'latest' ? null : fetchLatestVersion('pledgepack'))),
  ]);

  return {
    pledgestack: pledgestackVer ? `^${pledgestackVer}` : 'latest',
    pledgepack: pledgepackVer ? `^${pledgepackVer}` : 'latest',
  };
}

export const TEMPLATES = ['pledge', 'default', 'blog', 'api', 'saas', 'portfolio', 'dashboard', 'ecommerce'] as const;
export type Template = (typeof TEMPLATES)[number];

export const FRAMEWORKS = ['react', 'vue', 'solid', 'svelte'] as const;
export type Framework = (typeof FRAMEWORKS)[number];

export interface CreateOptions {
  name: string;
  template: Template;
  framework: Framework;
  installDeps: boolean;
}

export function parseArgs(argv: string[]): Partial<CreateOptions> {
  const opts: Partial<CreateOptions> = {};
  const args = argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--template' || arg === '-t') {
      const val = args[i + 1];
      if (val && TEMPLATES.includes(val as Template)) {
        opts.template = val as Template;
        i++;
      }
    } else if (arg.startsWith('--template=')) {
      const val = arg.split('=')[1];
      if (val && TEMPLATES.includes(val as Template)) {
        opts.template = val as Template;
      }
    } else if (arg === '--framework' || arg === '-f') {
      const val = args[i + 1];
      if (val && FRAMEWORKS.includes(val as Framework)) {
        opts.framework = val as Framework;
        i++;
      }
    } else if (arg.startsWith('--framework=')) {
      const val = arg.split('=')[1];
      if (val && FRAMEWORKS.includes(val as Framework)) {
        opts.framework = val as Framework;
      }
    } else if (arg === '--install' || arg === '--no-install') {
      opts.installDeps = arg === '--install';
    } else if (!arg.startsWith('-')) {
      opts.name = arg;
    }
  }

  return opts;
}

export async function createApp(): Promise<void> {
  const cliOpts = parseArgs(process.argv);

  const questions: prompts.PromptObject[] = [];

  if (!cliOpts.name) {
    questions.push({
      type: 'text',
      name: 'name',
      message: 'What is your project named?',
      initial: 'my-pledge-app',
      validate: (val: string) => (val.length > 0 ? true : 'Project name is required'),
    });
  }

  // Framework is asked before template: the content templates (blog, api, saas,
  // portfolio, dashboard, ecommerce) only exist as React source today, so the
  // template question below needs to know the framework to filter its choices —
  // picking e.g. framework=vue + template=blog would otherwise copy React JSX
  // into a project whose package.json/tsconfig.json are generated for Vue.
  if (!cliOpts.framework) {
    questions.push({
      type: 'select',
      name: 'framework',
      message: 'Which UI framework would you like to use?',
      choices: [
        { title: 'React — Most popular, full RSC support', value: 'react' },
        { title: 'Vue — Progressive framework, great DX', value: 'vue' },
        { title: 'Solid — Fine-grained reactivity, blazing fast', value: 'solid' },
        { title: 'Svelte — Compile-time optimizations, small bundles', value: 'svelte' },
      ],
      initial: 0,
    });
  }

  if (!cliOpts.template) {
    questions.push({
      type: 'select',
      name: 'template',
      message: 'Which template would you like to use?',
      choices: (_prev: unknown, values: Partial<CreateOptions>) => {
        const framework = cliOpts.framework ?? values.framework;
        if (framework && framework !== 'react') {
          return [{ title: `Default — Starter app with a single page (${framework})`, value: 'default' }];
        }
        return [
          { title: 'Pledge — Full-stack React + Rust backend (server/ directory, .psx support)', value: 'pledge' },
          { title: 'Default — Starter app with a single page', value: 'default' },
          { title: 'Blog — Blog with static generation and dynamic routes', value: 'blog' },
          { title: 'API — REST API with CRUD routes', value: 'api' },
          { title: 'SaaS Landing — Marketing page with pricing, features, and testimonials', value: 'saas' },
          { title: 'Portfolio — Personal portfolio with projects showcase and contact', value: 'portfolio' },
          { title: 'Dashboard — Admin dashboard with sidebar, stats, charts, and data table', value: 'dashboard' },
          { title: 'E-commerce — Product listing with filters, cart, and checkout UI', value: 'ecommerce' },
        ];
      },
      initial: 0,
    });
  }

  if (cliOpts.installDeps === undefined) {
    questions.push({
      type: 'confirm',
      name: 'installDeps',
      message: 'Install dependencies now?',
      initial: true,
    });
  }

  const response = await prompts(questions, {
    onCancel: () => {
      console.error('\nCancelled.');
      process.exit(1);
    },
  });

  const options: CreateOptions = {
    name: cliOpts.name || response.name,
    template: cliOpts.template || response.template,
    framework: cliOpts.framework || response.framework,
    installDeps: cliOpts.installDeps ?? response.installDeps,
  };

  await scaffold(options);
}

export async function scaffold(options: CreateOptions): Promise<void> {
  const { name, framework, installDeps } = options;
  let { template } = options;
  const targetDir = resolve(process.cwd(), name);

  if (existsSync(targetDir)) {
    console.error(`Directory "${name}" already exists.`);
    process.exit(1);
  }

  // The content templates (blog, api, saas, portfolio, dashboard, ecommerce)
  // only exist as React source. This can still be reached when both --template
  // and --framework are passed as CLI flags (bypassing the interactive prompt's
  // filtering above) — fall back to 'default' rather than copy React JSX into
  // a non-React project.
  if (template !== 'default' && framework !== 'react') {
    console.warn(
      `\n  Template "${template}" is only available for React — it doesn't have a ${framework} version yet.\n` +
      `  Using the "default" template for ${framework} instead.\n`,
    );
    template = 'default';
  }

  console.log(`\nCreating a new PledgeStack app in ${targetDir}\n`);
  console.log(`  Framework: ${framework}\n`);
  console.log(`  Template: ${template}\n`);

  console.log('Resolving latest package versions...\n');
  const versions = await resolveLatestVersions();

  // For non-React frameworks with the default template, use the framework-specific template
  const templateDir = (template === 'default' && framework !== 'react')
    ? getFrameworkTemplateDir(framework)
    : getTemplateDir(template);
  cpSync(templateDir, targetDir, { recursive: true });

  // Stamp the health route with the resolved framework version. App code
  // can't `import { PLEDGE_VERSION } from 'pledgestack'` — the meta package's
  // index pulls server-only deps (node builtins, react-server-dom-webpack)
  // into the client bundle.
  const healthRoute = join(targetDir, 'app', 'api', 'health', 'route.ts');
  if (existsSync(healthRoute)) {
    const resolved = versions.pledgestack.replace(/^[\^~]/, '');
    writeFileSync(
      healthRoute,
      readFileSync(healthRoute, 'utf8').replaceAll('__PLEDGE_VERSION__', resolved),
    );
  }

  writeFileSync(
    join(targetDir, 'package.json'),
    JSON.stringify(generatePackageJson(name, versions, options.framework), null, 2) + '\n',
  );

  writeFileSync(
    join(targetDir, 'tsconfig.json'),
    JSON.stringify(generateTsConfig(options.framework), null, 2) + '\n',
  );

  writeFileSync(
    join(targetDir, '.gitignore'),
    generateGitignore() + '\n',
  );

  writeFileSync(
    join(targetDir, 'pnpm-workspace.yaml'),
    // `allowBuilds` is the pnpm 11+ key; `onlyBuiltDependencies` is what pnpm
    // 10 reads (it ignores `allowBuilds`, and pnpm 11 ignores the legacy key —
    // emitting both makes the generated install work on either major without
    // a manual `approve-builds` step, which would otherwise leave pledgepack's
    // postinstall-downloaded native binary missing and `pledge build` broken).
    "allowBuilds:\n  pledgepack: true\n  esbuild: true\n" +
      "onlyBuiltDependencies:\n  - pledgepack\n  - esbuild\n",
  );

  if (installDeps) {
    console.log('Installing dependencies...\n');
    const pm = detectPackageManager();
    try {
      execSync(`${pm} install`, { cwd: targetDir, stdio: 'inherit' });
    } catch {
      // Only fall back to npm if pnpm didn't partially create node_modules
      if (!existsSync(join(targetDir, 'node_modules'))) {
        try {
          execSync('npm install', { cwd: targetDir, stdio: 'inherit' });
        } catch {
          console.warn(`Failed to install dependencies. Run \`${pm} install\` manually.`);
        }
      } else {
        console.warn(`\n  Dependencies installed but build scripts were ignored.`);
        console.warn(`  Run \`${pm} approve-builds\` to enable pledgepack's native binary.\n`);
      }
    }
  }

  console.log('\nNext steps:\n');
  console.log(`  cd ${name}`);
  if (!installDeps) console.log('  pnpm install');
  console.log('  pnpm dev\n');
}

function getTemplateDir(template: Template): string {
  const __dirname = fileURLToPath(new URL('.', import.meta.url));
  return join(__dirname, '..', 'templates', template);
}

function getFrameworkTemplateDir(framework: Framework): string {
  const __dirname = fileURLToPath(new URL('.', import.meta.url));
  return join(__dirname, '..', 'templates', framework);
}

/** Derive a valid npm package name from a project directory argument (may be a path). */
function toPackageName(input: string): string {
  const last = input.split(/[\\/]/).filter((s) => s && s !== '.' && s !== '..').pop() ?? '';
  const cleaned = last
    .toLowerCase()
    .replace(/[^a-z0-9._~-]+/g, '-')
    .replace(/^[._-]+/, '')
    .replace(/-+$/, '');
  return cleaned || 'my-pledge-app';
}

export function generatePackageJson(name: string, versions: { pledgestack: string; pledgepack: string }, framework: Framework) {
  const base = {
    name: toPackageName(name),
    version: '0.0.1',
    private: true,
    type: 'module',
    scripts: {
      dev: 'pledge dev',
      build: 'pledge build',
      start: 'pledge start',
    },
    devDependencies: {
      pledgepack: versions.pledgepack,
      typescript: '^5.7.0',
      '@types/node': '^22.0.0',
    },
    engines: {
      node: '>=20.0.0',
    },
  };

  switch (framework) {
    case 'react':
      return {
        ...base,
        dependencies: {
          react: '^19.2.0',
          'react-dom': '^19.2.0',
          // Renderer adapters are bundled inside `pledgestack` — no
          // separate `pledgestack-renderer-*` packages are published.
          pledgestack: versions.pledgestack,
        },
        devDependencies: {
          ...base.devDependencies,
          '@types/react': '^19.2.0',
          '@types/react-dom': '^19.2.0',
        },
      };
    case 'vue':
      return {
        ...base,
        dependencies: {
          vue: '^3.5.0',
          pledgestack: versions.pledgestack,
        },
        devDependencies: {
          ...base.devDependencies,
          'vue-tsc': '^2.1.0',
        },
      };
    case 'solid':
      return {
        ...base,
        dependencies: {
          'solid-js': '^1.9.0',
          pledgestack: versions.pledgestack,
        },
        devDependencies: {
          ...base.devDependencies,
        },
      };
    case 'svelte':
      return {
        ...base,
        dependencies: {
          svelte: '^5.0.0',
          pledgestack: versions.pledgestack,
        },
        devDependencies: {
          ...base.devDependencies,
          'svelte-check': '^4.0.0',
        },
      };
  }
}

function detectPackageManager(): 'pnpm' | 'npm' | 'yarn' {
  const userAgent = process.env.npm_config_user_agent ?? '';
  if (userAgent.startsWith('pnpm')) return 'pnpm';
  if (userAgent.startsWith('yarn')) return 'yarn';
  // Prefer pnpm if installed, even when scaffolded via npx (faster installs)
  try {
    execSync('pnpm --version', { stdio: ['ignore', 'ignore', 'ignore'] });
    return 'pnpm';
  } catch {
    return 'npm';
  }
}

export function generateTsConfig(framework: Framework) {
  const base = {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      resolveJsonModule: true,
      isolatedModules: true,
    },
    include: ['app', 'pledge.config.ts'],
  };

  switch (framework) {
    case 'react':
      return { ...base, compilerOptions: { ...base.compilerOptions, jsx: 'react-jsx' } };
    case 'solid':
      return { ...base, compilerOptions: { ...base.compilerOptions, jsx: 'preserve', jsxImportSource: 'solid-js' } };
    case 'vue':
    case 'svelte':
      return base;
  }
}

export function generateGitignore(): string {
  return [
    'node_modules',
    '.pledge',
    'dist',
    '.env',
    '.env.local',
    '*.log',
    '.DS_Store',
  ].join('\n');
}
