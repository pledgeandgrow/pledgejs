import { writeFileSync, existsSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import prompts from 'prompts';

interface NpmRegistryResponse {
  version: string;
}

async function fetchLatestVersion(pkgName: string): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkgName}/latest`);
    if (!res.ok) return null;
    const data = (await res.json()) as NpmRegistryResponse;
    return data.version ?? null;
  } catch {
    return null;
  }
}

async function resolveLatestVersions(): Promise<{ pledgestack: string; pledgepack: string }> {
  const [pledgestackVer, pledgepackVer] = await Promise.all([
    fetchLatestVersion('pledgestack'),
    fetchLatestVersion('pledgepack'),
  ]);

  return {
    pledgestack: pledgestackVer ? `^${pledgestackVer}` : 'latest',
    pledgepack: pledgepackVer ? `^${pledgepackVer}` : 'latest',
  };
}

const TEMPLATES = ['default', 'blog', 'api', 'saas', 'portfolio', 'dashboard', 'ecommerce'] as const;
type Template = (typeof TEMPLATES)[number];

interface CreateOptions {
  name: string;
  template: Template;
  installDeps: boolean;
}

function parseArgs(argv: string[]): Partial<CreateOptions> {
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

  if (!cliOpts.template) {
    questions.push({
      type: 'select',
      name: 'template',
      message: 'Which template would you like to use?',
      choices: [
        { title: 'Default — Starter app with a single page', value: 'default' },
        { title: 'Blog — Blog with static generation and dynamic routes', value: 'blog' },
        { title: 'API — REST API with CRUD routes', value: 'api' },
        { title: 'SaaS Landing — Marketing page with pricing, features, and testimonials', value: 'saas' },
        { title: 'Portfolio — Personal portfolio with projects showcase and contact', value: 'portfolio' },
        { title: 'Dashboard — Admin dashboard with sidebar, stats, charts, and data table', value: 'dashboard' },
        { title: 'E-commerce — Product listing with filters, cart, and checkout UI', value: 'ecommerce' },
      ],
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

  const response = await prompts(questions);

  const options: CreateOptions = {
    name: cliOpts.name || response.name,
    template: cliOpts.template || response.template,
    installDeps: cliOpts.installDeps ?? response.installDeps,
  };

  await scaffold(options);
}

async function scaffold(options: CreateOptions): Promise<void> {
  const { name, template, installDeps } = options;
  const targetDir = resolve(process.cwd(), name);

  if (existsSync(targetDir)) {
    console.error(`Directory "${name}" already exists.`);
    process.exit(1);
  }

  console.log(`\nCreating a new PledgeStack app in ${targetDir}\n`);

  console.log('Resolving latest package versions...\n');
  const versions = await resolveLatestVersions();

  const templateDir = getTemplateDir(template);
  cpSync(templateDir, targetDir, { recursive: true });

  writeFileSync(
    join(targetDir, 'package.json'),
    JSON.stringify(generatePackageJson(name, versions), null, 2) + '\n',
  );

  writeFileSync(
    join(targetDir, 'tsconfig.json'),
    JSON.stringify(generateTsConfig(), null, 2) + '\n',
  );

  writeFileSync(
    join(targetDir, '.gitignore'),
    generateGitignore() + '\n',
  );

  writeFileSync(
    join(targetDir, 'pnpm-workspace.yaml'),
    "allowBuilds:\n  pledgepack: true\n  esbuild: true\nminimumReleaseAgeExclude:\n  - pledgepack\n  - pledgestack-core\n  - pledgestack-shared\n  - pledgestack-server\n  - pledgestack-cli\n",
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

function generatePackageJson(name: string, versions: { pledgestack: string; pledgepack: string }) {
  return {
    name: name.toLowerCase().replace(/\s+/g, '-'),
    version: '0.0.1',
    private: true,
    type: 'module',
    scripts: {
      dev: 'pledge dev',
      build: 'pledge build',
      start: 'pledge start',
    },
    dependencies: {
      react: '^19.2.0',
      'react-dom': '^19.2.0',
      pledgestack: versions.pledgestack,
    },
    devDependencies: {
      pledgepack: versions.pledgepack,
      typescript: '^5.7.0',
      '@types/react': '^19.2.0',
      '@types/react-dom': '^19.2.0',
      '@types/node': '^22.0.0',
    },
    engines: {
      node: '>=20.0.0',
    },
  };
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

function generateTsConfig() {
  return {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      jsx: 'react-jsx',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      resolveJsonModule: true,
      isolatedModules: true,
    },
    include: ['app', 'pledge.config.ts'],
  };
}

function generateGitignore(): string {
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
