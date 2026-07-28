/**
 * `pledge search` command — indexes route content and queries the embedded search engine.
 *
 * Usage:
 *   pledge search              # Index all pages
 *   pledge search <query>      # Search the index
 */

import type { PledgeConfig } from 'pledgestack-shared';
import { scanAppDir, resolveRoutes, searchAddDocument, searchQuery, searchClear, searchDocumentCount, isNativeSearchAvailable } from 'pledgestack-core';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface SearchCommandOptions {
  query?: string;
  index?: boolean;
}

export async function searchCommand(config: PledgeConfig, opts: SearchCommandOptions): Promise<void> {
  const appDir = join(config.rootDir, config.appDir);

  if (opts.query) {
    // Search mode
    const results = await searchQuery(opts.query, 20);
    if (results.length === 0) {
      console.log('\n  No results found.\n');
      console.log('  Run `pledge search` first to index your pages.\n');
      return;
    }
    console.log(`\n  Search results for "${opts.query}" (${results.length}):\n`);
    for (const result of results) {
      console.log(`  ${result.score.toFixed(1)}  ${result.id}`);
    }
    console.log('');
    return;
  }

  // Index mode
  console.log('\n  Indexing pages for search...\n');

  const native = isNativeSearchAvailable();
  console.log(`  Engine: ${native ? 'native (rust-search)' : 'fallback (JS inverted index)'}\n`);

  await searchClear();

  const files = await scanAppDir(appDir);
  const routes = resolveRoutes(files, config);

  let indexed = 0;
  for (const route of routes) {
    if (!route.filePath || route.isLayout || route.isErrorBoundary || route.isLoading || route.isNotFound) continue;
    // Skip API routes (route.ts/route.js files)
    if (/\broute\.(ts|js|tsx|jsx)$/.test(route.filePath)) continue;
    try {
      const content = await readFile(route.filePath, 'utf-8');
      // Extract text content from the file (strip imports, JSX, etc.)
      const textContent = content
        .replace(/import\s+.*?from\s+['"].*?['"];?/g, '')
        .replace(/export\s+(?:default|const|function|class)\s+/g, '')
        .replace(/<[\/]?[a-zA-Z][^>]*>/g, ' ')
        .replace(/\{[^}]*\}/g, ' ')
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\s+/g, ' ')
        .trim();

      if (textContent.length > 0) {
        await searchAddDocument(route.pattern, textContent);
        indexed++;
        console.log(`  ✓ ${route.pattern}`);
      }
    } catch {
      // Skip files that can't be read
    }
  }

  const count = await searchDocumentCount();
  console.log(`\n  Indexed ${indexed} pages (${count} documents in index).\n`);
  console.log('  Search with: pledge search <query>\n');
}
