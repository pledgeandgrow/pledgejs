#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parsePort } from './parse-port';
// Registers all bundled renderer adapters (side-effect) — required by
// dev/build/start commands that render pages.
import './renderers';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string', short: 'p' },
    hostname: { type: 'string', short: 'H' },
    template: { type: 'string', short: 't' },
    framework: { type: 'string', short: 'f' },
    watch: { type: 'boolean', short: 'w' },
    version: { type: 'boolean' },
    verbose: { type: 'boolean', short: 'v' },
    check: { type: 'boolean', short: 'c' },
    'rust-only': { type: 'boolean' },
    'vitest-only': { type: 'boolean' },
    'dead-code': { type: 'boolean' },
    'cross-compile': { type: 'boolean' },
    production: { type: 'boolean' },
    suggestions: { type: 'boolean' },
    psx: { type: 'boolean' },
    compare: { type: 'string' },
    save: { type: 'string' },
    threshold: { type: 'string' },
    edition: { type: 'string' },
    'config-file': { type: 'string' },
    iterations: { type: 'string', short: 'i' },
    concurrency: { type: 'string' },
    force: { type: 'boolean' },
    'skip-install': { type: 'boolean' },
    'skip-codemods': { type: 'boolean' },
    install: { type: 'boolean' },
    'no-install': { type: 'boolean' },
    all: { type: 'boolean' },
    open: { type: 'boolean' },
    optimized: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    target: { type: 'string' },
    branch: { type: 'string' },
    project: { type: 'string' },
    output: { type: 'string', short: 'o' },
    help: { type: 'boolean', short: 'h' },
  },
});

const command = positionals[0];

async function main() {
  if (values.version) {
    await printVersion();
    process.exit(0);
  }
  if (values.help || !command) {
    printHelp();
    process.exit(0);
  }

  const opts = {
    port: parsePort(values.port),
    hostname: values.hostname,
  };

  switch (command) {
    case 'dev': {
      const { devCommand } = await import('./commands/dev');
      await devCommand(opts);
      break;
    }
    case 'build': {
      const { buildCommand } = await import('./commands/build');
      await buildCommand({ crossCompile: values['cross-compile'] as boolean | undefined });
      break;
    }
    case 'start': {
      const { startCommand } = await import('./commands/start');
      await startCommand(opts);
      break;
    }
    case 'create': {
      const { createCommand } = await import('./commands/create');
      const projectName = positionals[1];
      if (!projectName) {
        console.error('Error: Project name is required');
        console.error('Usage: pledge create <project-name>');
        process.exit(1);
      }
      // `pledge create` scaffolds a React project. Non-React frameworks are
      // scaffolded by the separate multi-framework tool; point users there
      // rather than silently ignoring --framework (or crashing on the flag).
      const framework = (values.framework as string | undefined)?.toLowerCase();
      if (framework && framework !== 'react') {
        console.error(`\`pledge create\` scaffolds React projects. For a ${framework} starter, run:`);
        console.error(`  npm create pledge-app@latest ${projectName} -- --framework ${framework}`);
        process.exit(1);
      }
      await createCommand(projectName, {
        template: values.template as string | undefined,
        // The guard above already rejected non-React frameworks; pass 'react'
        // explicitly so create-pledge-app doesn't ask interactively.
        framework: 'react',
        install: values['no-install'] ? false : values.install ? true : undefined,
      });
      break;
    }
    case 'info': {
      const { infoCommand } = await import('./commands/info');
      await infoCommand({ verbose: values.verbose });
      break;
    }
    case 'doctor': {
      const { doctorCommand } = await import('./commands/doctor');
      const { loadConfig } = await import('./config-loader');
      const config = await loadConfig();
      await doctorCommand(config, { production: values.production as boolean | undefined });
      break;
    }
    case 'env-check': {
      const { envCheckCommand } = await import('./commands/env-check');
      const { loadConfig } = await import('./config-loader');
      const config = await loadConfig();
      await envCheckCommand(config);
      break;
    }
    case 'fmt': {
      const { fmtCommand } = await import('./commands/fmt');
      await fmtCommand({
        check: values.check as boolean | undefined,
        dir: positionals[1],
        edition: values.edition as string | undefined,
        configFile: values['config-file'] as string | undefined,
      });
      break;
    }
    case 'test': {
      const { testCommand } = await import('./commands/test');
      await testCommand({
        dir: positionals[1],
        rustOnly: values['rust-only'] as boolean | undefined,
        vitestOnly: values['vitest-only'] as boolean | undefined,
        watch: values.watch as boolean | undefined,
      });
      break;
    }
    case 'typecheck': {
      const { typecheckCommand } = await import('./commands/typecheck');
      await typecheckCommand({ dir: positionals[1] });
      break;
    }
    case 'lint': {
      const { lintCommand } = await import('./commands/lint');
      await lintCommand({
        dir: positionals[1],
        deadCode: values['dead-code'] as boolean | undefined,
      });
      break;
    }
    case 'add': {
      const { addCommand } = await import('./commands/add');
      const crateSpec = positionals[1];
      if (!crateSpec) {
        console.error('Error: Crate name is required');
        console.error('Usage: pledge add <crate>[@version]');
        process.exit(1);
      }
      await addCommand(crateSpec, { version: positionals[2] });
      break;
    }
    case 'remove': {
      const { removeCommand } = await import('./commands/add');
      const crateName = positionals[1];
      if (!crateName) {
        console.error('Error: Crate name is required');
        console.error('Usage: pledge remove <crate>');
        process.exit(1);
      }
      await removeCommand(crateName);
      break;
    }
    case 'list': {
      const { listCommand } = await import('./commands/add');
      await listCommand();
      break;
    }
    case 'update': {
      const { updateCommand } = await import('./commands/add');
      await updateCommand(positionals[1]);
      break;
    }
    case 'clean': {
      const { cleanCommand } = await import('./commands/clean');
      const { loadConfig } = await import('./config-loader');
      const config = await loadConfig();
      await cleanCommand(config, { verbose: values.verbose });
      break;
    }
    case 'sync-aliases': {
      const { syncAliasesCommand } = await import('./commands/sync-aliases');
      const { loadConfig } = await import('./config-loader');
      const config = await loadConfig();
      await syncAliasesCommand(config);
      break;
    }
    case 'generate-route-types': {
      const { writeRouteTypes } = await import('pledgestack-core');
      const { loadConfig } = await import('./config-loader');
      const config = await loadConfig();
      if (!existsSync(join(config.rootDir, config.appDir))) {
        console.error(`\n  Error: App directory not found at ${join(config.rootDir, config.appDir)}`);
        console.error('  Run this command in a PledgeStack app, or set appDir in pledge.config.ts.\n');
        process.exit(1);
      }
      const outPath = await writeRouteTypes(config);
      console.log(`\n  ✓ Generated route types at ${outPath}\n`);
      break;
    }
    case 'check-routes': {
      const { scanAppDir, resolveRoutes, detectRouteConflicts, formatRouteConflicts } = await import('pledgestack-core');
      const { loadConfig } = await import('./config-loader');
      const config = await loadConfig();
      const appDir = join(config.rootDir, config.appDir);
      if (!existsSync(appDir)) {
        console.error(`\n  Error: App directory not found at ${appDir}`);
        console.error('  Run this command in a PledgeStack app, or set appDir in pledge.config.ts.\n');
        process.exit(1);
      }
      const files = await scanAppDir(appDir);
      const routes = resolveRoutes(files, config);
      const conflicts = detectRouteConflicts(routes);
      console.log(formatRouteConflicts(conflicts));
      if (conflicts.length > 0) process.exit(1);
      break;
    }
    case 'init': {
      const { initCommand } = await import('./commands/init');
      await initCommand({
        force: values.force as boolean | undefined,
        skipInstall: values['skip-install'] as boolean | undefined,
      });
      break;
    }
    case 'why': {
      const { whyCommand } = await import('./commands/why');
      const { loadConfig } = await import('./config-loader');
      const config = await loadConfig();
      const target = positionals[1];
      if (!target) {
        console.error('Error: Module path is required');
        console.error('Usage: pledge why <module-path>');
        process.exit(1);
      }
      await whyCommand(target, config);
      break;
    }
    case 'docs': {
      const { docsCommand } = await import('./commands/docs');
      const { loadConfig } = await import('./config-loader');
      const config = await loadConfig();
      await docsCommand(config, { output: values.output as string | undefined });
      break;
    }
    case 'upgrade': {
      const { upgradeCommand } = await import('./commands/upgrade');
      await upgradeCommand({
        check: values.check as boolean | undefined,
        skipCodemods: values['skip-codemods'] as boolean | undefined,
        skipInstall: values['skip-install'] as boolean | undefined,
        force: values.force as boolean | undefined,
      });
      break;
    }
    case 'storybook': {
      const { storybookCommand } = await import('./commands/storybook');
      await storybookCommand({
        force: values.force as boolean | undefined,
        all: values.all as boolean | undefined,
      });
      break;
    }
    case 'playground': {
      const { playgroundCommand } = await import('./commands/playground');
      await playgroundCommand({
        port: opts.port,
        open: values['open'] as boolean | undefined,
      });
      break;
    }
    case 'analyze': {
      const { analyzeCommand } = await import('./commands/analyze');
      const { loadConfig } = await import('./config-loader');
      const config = await loadConfig();
      await analyzeCommand(config, {
        suggestions: values.suggestions as boolean | undefined,
      });
      break;
    }
    case 'bench': {
      const { benchCommand } = await import('./commands/bench');
      const { loadConfig } = await import('./config-loader');
      const config = await loadConfig();
      await benchCommand(config, {
        psx: values.psx as boolean | undefined,
        iterations: values.iterations as string | undefined,
        concurrency: values.concurrency as string | undefined,
        compare: values.compare as string | undefined,
        save: values.save as string | undefined,
        threshold: values.threshold as string | undefined,
      });
      break;
    }
    case 'search': {
      const { searchCommand } = await import('./commands/search');
      const { loadConfig } = await import('./config-loader');
      const config = await loadConfig();
      await searchCommand(config, {
        query: positionals[1],
        index: !positionals[1],
      });
      break;
    }
    case 'codemod': {
      const { runCodemod, listCodemods } = await import('./commands/codemod');
      const codemodName = positionals[1];
      if (!codemodName) {
        // List available codemods if no name provided
        const codemods = listCodemods();
        console.log('\n  Available codemods:');
        for (const c of codemods) {
          console.log(`    ${c.name} — ${c.description}`);
        }
        console.log('\n  Usage: pledge codemod <name> <path>\n');
        break;
      }
      const targetPath = positionals[2] ?? '.';
      await runCodemod({ name: codemodName, path: targetPath, dryRun: Boolean(values['dry-run'] || values.check) });
      break;
    }
    case 'docker': {
      const { generateDockerfile, generateDockerIgnore, generateDockerCompose, generateOptimizedDockerfile, generateOptimizedDockerCompose } = await import('./commands/docker');
      const subcommand = positionals[1] ?? 'generate';
      const optimized = Boolean(values.optimized);
      if (subcommand === 'compose') {
        if (optimized) {
          await generateOptimizedDockerCompose({ port: opts.port });
        } else {
          await generateDockerCompose({ port: opts.port });
        }
        console.log('  ✓ docker-compose.yml generated');
      } else if (subcommand === 'ignore') {
        await generateDockerIgnore();
        console.log('  ✓ .dockerignore generated');
      } else if (optimized) {
        const outFile = (values.output as string | undefined) ?? 'Dockerfile';
        await generateOptimizedDockerfile({ port: opts.port }, outFile);
        console.log(`  ✓ ${outFile} generated (Rust-addon-optimized multi-stage build)`);
      } else {
        await generateDockerfile({ port: opts.port, output: values.output as string | undefined });
        console.log('  ✓ Dockerfile generated');
      }
      break;
    }
    case 'deploy': {
      const { deploy } = await import('pledgestack-deploy');
      const { loadConfig } = await import('./config-loader');
      const config = await loadConfig();
      const target = values.target as 'cloudflare' | 'vercel' | 'netlify' | 'auto' | undefined;
      const result = await deploy(config, {
        target,
        dryRun: values['dry-run'] as boolean | undefined,
        branch: values.branch as string | undefined,
        project: values.project as string | undefined,
        verbose: values.verbose as boolean | undefined,
      });
      if (!result.success) {
        console.error(`\n  ✖ ${result.message}`);
        process.exit(1);
      }
      console.log(`\n  ✓ ${result.message}`);
      if (result.url) console.log(`  → ${result.url}`);
      console.log(`  (${result.durationMs}ms)\n`);
      break;
    }
    case 'content': {
      const { contentCommand } = await import('./commands/content');
      await contentCommand({
        subcommand: positionals[1],
        collection: positionals[2],
        verbose: values.verbose as boolean | undefined,
      });
      break;
    }
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

async function printVersion() {
  try {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const pkgPath = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf-8')) as { version?: string };
    console.log(pkg.version ?? 'unknown');
  } catch {
    console.log('unknown');
  }
}

function printHelp() {
  console.log(`
  PledgeStack — A full-stack React framework

  Usage:
    pledge <command> [options]

  Commands:
    dev      Start the development server
    build    Build for production
    start    Start the production server
    create   Scaffold a new PledgeStack project
    info     Print project diagnostics
    doctor   Diagnose and fix common issues (--production for prod checks)
    env-check  Validate environment variables against envSchema in pledge.config.ts
    analyze  Analyze PSX bundle size and Cargo dependencies
    bench    Benchmark Rust NAPI functions (pledge bench --psx)
    fmt      Format Rust code in .psx/.ps files
    test     Run Rust and Vitest tests
    typecheck  Run TypeScript type checking (tsc --noEmit)
    lint     Lint .psx/.ps files for common issues
    add      Add a Rust crate (pledge add sqlx@0.8)
    remove   Remove a Rust crate
    list     List installed Rust crates
    update   Update Rust crates to latest compatible versions
    clean    Remove all generated artifacts (.pledge, .pledge-cache, target)
    sync-aliases  Sync tsconfig.json path aliases from pledge.config.ts
    generate-route-types  Generate __pledge_route_types.d.ts from file-based router
    check-routes  Detect route conflicts and ambiguous patterns
    init     Add PledgeStack to an existing project (detects Next.js, Vite, CRA)
    why      Trace why a module is in the bundle (import chains, circular deps)
    docs     Generate API documentation from TypeScript source
    upgrade  Check for new versions and update deps
    storybook  Set up zero-config Storybook for PledgeStack
    playground Start PSX REPL playground (Rust + TSX in browser)
    search   Index pages and search content (pledge search [query])
    codemod  Run code transformations (pledge codemod <name> <path>)
    docker   Generate Dockerfile, .dockerignore, docker-compose.yml
    deploy   Build and deploy to Cloudflare Pages, Vercel, or Netlify
    content  Index, list, and validate content collections

  Options:
    -p, --port <number>      Server port (default: 3000)
    -H, --hostname <string>  Server hostname (default: localhost)
    -t, --template <name>    Project template (default, blank, blog)
    -f, --framework <name>   Project framework for create (react)
    -w, --watch              Re-run tests on change (test only)
    -v, --verbose            Show detailed output
    -c, --check              Check formatting without modifying (fmt only)
    --edition <year>         Rust edition for rustfmt (fmt only; default: from rustfmt.toml, else 2021)
    --config-file <path>     rustfmt config file (fmt only; default: rustfmt.toml/.rustfmt.toml discovered upward)
    --save <file>            Save bench results as a baseline (bench only)
    --compare <file>         Compare bench results to a baseline; exit 1 on regressions (bench only)
    --threshold <percent>    Regression threshold for --compare (default: 10)
    --version                Print the pledge CLI version
    -h, --help               Show this help message

  Examples:
    pledge dev
    pledge dev --port 8080
    pledge build
    pledge start
    pledge create my-app
    pledge create my-blog --template blog
    pledge info --verbose
    pledge doctor
    pledge doctor --production
    pledge analyze
    pledge analyze --suggestions
    pledge bench --psx
    pledge bench --psx --save base.json
    pledge bench --psx --compare base.json --threshold 10
    pledge fmt
    pledge fmt --check
    pledge test
    pledge test --rust-only
    pledge typecheck
    pledge lint
    pledge add sqlx
    pledge add sqlx@0.8
    pledge add my-crate '{ version = "1.0", features = ["json"] }'
    pledge remove sqlx
    pledge list
    pledge update
    pledge clean
    pledge sync-aliases
    pledge generate-route-types
    pledge check-routes
    pledge init
    pledge init --force
    pledge init --skip-install    (scaffold only; do not run the package manager)
    pledge why app/utils/helpers
    pledge docs
    pledge docs --output docs/api.md
    pledge upgrade
    pledge upgrade --check
    pledge upgrade --skip-install
    pledge storybook
    pledge storybook --force --all
    pledge playground
    pledge playground --port 8080
    pledge search
    pledge search "react hooks"
    pledge codemod
    pledge codemod pledgejs-to-pledgestack src/
    pledge codemod next-to-pledge src/ --dry-run   (report changes, write nothing)
    pledge docker
    pledge docker --optimized     (Rust-addon-aware multi-stage build)
    pledge docker compose
    pledge docker ignore
    pledge deploy                  (auto-detect platform)
    pledge deploy --target cloudflare
    pledge deploy --target vercel
    pledge deploy --dry-run        (build only, don't upload)
    pledge deploy --project myapp  (specify project/site name)
  `);
}

main().catch((err) => {
  // Print a one-line message for expected failures (bad flags, missing files);
  // set PLEDGE_DEBUG=1 for the full stack.
  console.error(err instanceof Error && !process.env.PLEDGE_DEBUG ? `Error: ${err.message}` : err);
  process.exit(1);
});
