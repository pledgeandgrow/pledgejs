#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { join } from 'node:path';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string', short: 'p' },
    hostname: { type: 'string', short: 'H' },
    template: { type: 'string', short: 't' },
    verbose: { type: 'boolean', short: 'v' },
    check: { type: 'boolean', short: 'c' },
    'rust-only': { type: 'boolean' },
    'vitest-only': { type: 'boolean' },
    fix: { type: 'boolean' },
    'dead-code': { type: 'boolean' },
    'cross-compile': { type: 'boolean' },
    production: { type: 'boolean' },
    suggestions: { type: 'boolean' },
    psx: { type: 'boolean' },
    compare: { type: 'boolean' },
    iterations: { type: 'string', short: 'i' },
    concurrency: { type: 'string' },
    force: { type: 'boolean' },
    'skip-install': { type: 'boolean' },
    'skip-codemods': { type: 'boolean' },
    all: { type: 'boolean' },
    open: { type: 'boolean' },
    output: { type: 'string', short: 'o' },
    help: { type: 'boolean', short: 'h' },
  },
});

const command = positionals[0];

async function main() {
  if (values.help || !command) {
    printHelp();
    process.exit(0);
  }

  const opts = {
    port: values.port ? parseInt(values.port, 10) : undefined,
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
      await createCommand(projectName, {
        template: values.template as 'default' | 'blank' | 'blog' | 'dashboard' | undefined,
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
    case 'fmt': {
      const { fmtCommand } = await import('./commands/fmt');
      await fmtCommand({
        check: values.check as boolean | undefined,
        dir: positionals[1],
      });
      break;
    }
    case 'test': {
      const { testCommand } = await import('./commands/test');
      await testCommand({
        dir: positionals[1],
        rustOnly: values['rust-only'] as boolean | undefined,
        vitestOnly: values['vitest-only'] as boolean | undefined,
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
        fix: values.fix as boolean | undefined,
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
      await addCommand(crateSpec);
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
      const outPath = await writeRouteTypes(config);
      console.log(`\n  ✓ Generated route types at ${outPath}\n`);
      break;
    }
    case 'check-routes': {
      const { scanAppDir, resolveRoutes, detectRouteConflicts, formatRouteConflicts } = await import('pledgestack-core');
      const { loadConfig } = await import('./config-loader');
      const config = await loadConfig();
      const appDir = join(config.rootDir, config.appDir);
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
        port: values.port ? parseInt(values.port as string) : undefined,
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
        compare: values.compare as boolean | undefined,
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
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
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
    upgrade  Check for new versions, run codemods, update deps
    storybook  Set up zero-config Storybook for PledgeStack
    playground Start PSX REPL playground (Rust + TSX in browser)
    search   Index pages and search content (pledge search [query])

  Options:
    -p, --port <number>      Server port (default: 3000)
    -H, --hostname <string>  Server hostname (default: localhost)
    -t, --template <name>    Project template (default, blank, blog)
    -v, --verbose            Show detailed output
    -c, --check              Check formatting without modifying (fmt only)
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
    pledge bench --psx --compare -i 50000
    pledge fmt
    pledge fmt --check
    pledge test
    pledge test --rust-only
    pledge typecheck
    pledge lint
    pledge add sqlx
    pledge add sqlx@0.8
    pledge remove sqlx
    pledge list
    pledge update
    pledge clean
    pledge sync-aliases
    pledge generate-route-types
    pledge check-routes
    pledge init
    pledge init --force
    pledge why app/utils/helpers
    pledge docs
    pledge docs --output docs/api.md
    pledge upgrade
    pledge upgrade --check
    pledge storybook
    pledge storybook --force --all
    pledge playground
    pledge playground --port 8080
    pledge search
    pledge search "react hooks"
  `);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
