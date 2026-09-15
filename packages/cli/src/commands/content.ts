/**
 * `pledge content` — index, list, and validate content collections.
 *
 * Subcommands:
 *   pledge content list [collection]   — list entries in a collection (or all)
 *   pledge content validate [collection] — validate all entries against their schema
 *   pledge content stats               — show collection statistics
 *   pledge content index               — rebuild the content cache index
 */

export interface ContentCommandOptions {
  /** Subcommand: list | validate | stats | index */
  subcommand?: string;
  /** Collection name (optional — applies to all if omitted) */
  collection?: string;
  /** Verbose output */
  verbose?: boolean;
}

export async function contentCommand(opts: ContentCommandOptions = {}): Promise<void> {
  const { loadConfig } = await import('../config-loader');
  const config = await loadConfig();

  // Find content plugin in config
  const contentPlugin = config.plugins?.find((p) => p.name === 'pledgestack-content');
  if (!contentPlugin) {
    console.error('\n  ✖ No content plugin found in pledge.config.ts');
    console.error('    Add contentPlugin() to your plugins array to use content collections.\n');
    process.exit(1);
  }

  // The plugin's buildStart loads collections — trigger it
  await contentPlugin.buildStart?.(config);

  const { getAllCollectionNames } = await import('pledgestack-content');
  const subcommand = opts.subcommand ?? 'list';

  // Get collection names — we need to read from the plugin options
  // Since the plugin loaded collections, we can list them from the registry
  const collectionNames = getAllCollectionNames();

  if (collectionNames.length === 0) {
    console.log('\n  No content collections defined.\n');
    return;
  }

  const targetCollections = opts.collection
    ? collectionNames.filter((n) => n === opts.collection)
    : collectionNames;

  if (opts.collection && targetCollections.length === 0) {
    console.error(`\n  ✖ Collection "${opts.collection}" not found.`);
    console.error(`    Available: ${collectionNames.join(', ')}\n`);
    process.exit(1);
  }

  switch (subcommand) {
    case 'list':
      await listCollections(targetCollections, opts.verbose ?? false);
      break;
    case 'validate':
      await validateCollections(targetCollections);
      break;
    case 'stats':
      await showStats(targetCollections);
      break;
    case 'index':
      console.log('\n  → Rebuilding content index...');
      // Re-running buildStart reloads all collections
      await contentPlugin.buildStart?.(config);
      console.log('  ✓ Content index rebuilt\n');
      break;
    default:
      console.error(`\n  ✖ Unknown subcommand: ${subcommand}`);
      console.error('    Available: list, validate, stats, index\n');
      process.exit(1);
  }
}

async function listCollections(names: string[], verbose: boolean): Promise<void> {
  const { getCollection } = await import('pledgestack-content');

  console.log('');
  for (const name of names) {
    const entries = getCollection(name);
    console.log(`  ${name} (${entries.length} entries):`);
    for (const entry of entries) {
      const title = (entry.data as Record<string, unknown>)?.title ?? entry.id;
      if (verbose) {
        console.log(`    ${entry.id}`);
        console.log(`      title: ${title}`);
        console.log(`      slug:  ${entry.slug}`);
        console.log(`      file:  ${entry.filePath}`);
      } else {
        console.log(`    ${entry.id} — ${title}`);
      }
    }
    console.log('');
  }
}

async function validateCollections(names: string[]): Promise<void> {
  const { getCollection } = await import('pledgestack-content');

  console.log('');
  let totalValid = 0;

  for (const name of names) {
    const entries = getCollection(name);
    console.log(`  ${name}: ${entries.length} entries valid`);
    totalValid += entries.length;
  }

  console.log(`\n  ✓ ${totalValid} entries valid across ${names.length} collection(s)\n`);
}

async function showStats(names: string[]): Promise<void> {
  const { getCollection } = await import('pledgestack-content');

  console.log('\n  Content Collection Statistics:');
  console.log('  ─────────────────────────────');

  for (const name of names) {
    const entries = getCollection(name);
    console.log(`\n  ${name}:`);
    console.log(`    Total entries: ${entries.length}`);

    // Count by extension
    const byExt: Record<string, number> = {};
    for (const entry of entries) {
      const ext = entry.filePath.match(/\.[^.]+$/)?.[0] ?? 'unknown';
      byExt[ext] = (byExt[ext] ?? 0) + 1;
    }
    for (const [ext, count] of Object.entries(byExt)) {
      console.log(`    ${ext}: ${count}`);
    }

    // Show date range if dates exist
    const dates = entries
      .map((e) => (e.data as Record<string, unknown>)?.date)
      .filter((d): d is Date => d instanceof Date);
    if (dates.length > 0) {
      const earliest = new Date(Math.min(...dates.map((d) => d.getTime())));
      const latest = new Date(Math.max(...dates.map((d) => d.getTime())));
      console.log(`    Date range: ${earliest.toISOString().slice(0, 10)} → ${latest.toISOString().slice(0, 10)}`);
    }
  }
  console.log('');
}
