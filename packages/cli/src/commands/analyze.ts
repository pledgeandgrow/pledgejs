import { join } from 'node:path';
import type { PledgeConfig } from 'pledgestack-shared';

interface AnalyzeOptions {
  suggestions?: boolean;
}

/**
 * pledge analyze — Analyzes PSX bundle size and Cargo dependencies.
 *
 * Scans compiled .node addons, reports per-module binary sizes,
 * identifies large crates, and suggests lighter alternatives.
 *
 * With --suggestions flag, shows detailed optimization recommendations.
 */
export async function analyzeCommand(
  config: PledgeConfig,
  opts?: AnalyzeOptions,
): Promise<void> {
  const {
    analyzeBundle,
    formatBundleReport,
    saveBundleReport,
    loadBundleReport,
  } = await import('pledgestack-core');

  // Resolve the native addon directory. In this monorepo it's under
  // packages/core/native; in a real scaffolded project the compiled addons ship
  // inside the installed pledgestack-core package. Try each and use the first
  // that exists (the previous hardcoded monorepo path always reported 0 addons
  // in user projects).
  const { existsSync } = await import('node:fs');
  const nativeCandidates = [
    join(config.rootDir, 'packages', 'core', 'native'),
    join(config.rootDir, 'node_modules', 'pledgestack-core', 'native'),
    join(config.rootDir, 'node_modules', 'pledgestack', 'native'),
  ];
  const nativeDir = nativeCandidates.find((p) => existsSync(p)) ?? nativeCandidates[0];
  const reportPath = join(config.rootDir, '.pledge', 'bundle-report.json');

  // Load previous report for size comparison
  const previousReport = loadBundleReport(reportPath);

  // Run analysis
  const result = analyzeBundle(config.rootDir, nativeDir, previousReport ?? undefined);

  // Print report
  console.log(formatBundleReport(result));

  // Save report for future comparisons
  await saveBundleReport(result, reportPath);
  console.log(`  ${dim('Report saved to')} ${reportPath}\n`);

  // Show detailed suggestions if requested
  if (opts?.suggestions && result.warnings.length > 0) {
    console.log(bold('\n=== Optimization Suggestions ===\n'));
    for (const warning of result.warnings) {
      const icon = warning.severity === 'error' ? red('✗') : warning.severity === 'warning' ? yellow('⚠') : blue('ℹ');
      console.log(`  ${icon} ${bold(warning.addon)}`);
      console.log(`    ${warning.message}`);
      if (warning.suggestion) {
        console.log(`    ${green('→')} ${warning.suggestion}`);
      }
      console.log();
    }
  }

  // Summary
  const totalMB = (result.totalSizeBytes / (1024 * 1024)).toFixed(2);
  console.log(bold(`Total addon size: ${totalMB} MB across ${result.addons.length} addon(s)`));

  if (result.warnings.filter((w) => w.severity === 'error').length > 0) {
    const errors = result.warnings.filter((w) => w.severity === 'error');
    console.log(`\n${red('✗')} ${errors.length} error(s) found`);
    process.exit(1);
  } else if (result.warnings.filter((w) => w.severity === 'warning').length > 0) {
    const warnings = result.warnings.filter((w) => w.severity === 'warning');
    console.log(`\n${yellow('⚠')} ${warnings.length} warning(s) found`);
  } else {
    console.log(`\n${green('✓')} No issues found!`);
  }
}

function red(s: string): string {
  return `\x1b[31m${s}\x1b[0m`;
}
function green(s: string): string {
  return `\x1b[32m${s}\x1b[0m`;
}
function yellow(s: string): string {
  return `\x1b[33m${s}\x1b[0m`;
}
function blue(s: string): string {
  return `\x1b[34m${s}\x1b[0m`;
}
function bold(s: string): string {
  return `\x1b[1m${s}\x1b[0m`;
}
function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}
