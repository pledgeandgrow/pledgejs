/**
 * `pledge search` command — indexes route content and queries the embedded search engine.
 *
 * Usage:
 *   pledge search              # Index all pages
 *   pledge search <query>      # Search the index
 *
 * The search engine itself is in-memory (see pledgestack-core psx/search.ts),
 * so the command persists documents to `.pledge/search-index.json` after
 * indexing and reloads them before querying — otherwise a later `pledge
 * search <query>` process would always see an empty index.
 */

import type { PledgeConfig } from 'pledgestack-shared';
import { scanAppDir, resolveRoutes, searchAddDocument, searchQuery, searchClear, searchDocumentCount, isNativeSearchAvailable } from 'pledgestack-core';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface SearchCommandOptions {
  query?: string;
  index?: boolean;
}

function indexPath(config: PledgeConfig): string {
  return join(config.rootDir, config.outDir, 'search-index.json');
}

async function loadPersistedIndex(config: PledgeConfig): Promise<number> {
  let docs: Record<string, string>;
  try {
    docs = JSON.parse(await readFile(indexPath(config), 'utf-8')) as Record<string, string>;
  } catch {
    return 0;
  }
  let loaded = 0;
  for (const [id, content] of Object.entries(docs)) {
    await searchAddDocument(id, content);
    loaded++;
  }
  return loaded;
}

export async function searchCommand(config: PledgeConfig, opts: SearchCommandOptions): Promise<void> {
  const appDir = join(config.rootDir, config.appDir);

  if (opts.query) {
    // Search mode — hydrate the in-memory index from the persisted file first.
    const loaded = await loadPersistedIndex(config);
    if (loaded === 0) {
      console.log('\n  No search index found.\n');
      console.log('  Run `pledge search` first to index your pages.\n');
      return;
    }
    const results = await searchQuery(opts.query, 20);
    if (results.length === 0) {
      console.log(`\n  No results for "${opts.query}".\n`);
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

  const documents: Record<string, string> = {};
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
        .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
        .replace(/\{[^}]*\}/g, ' ')
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\s+/g, ' ')
        .trim();

      if (textContent.length > 0) {
        await searchAddDocument(route.pattern, textContent);
        documents[route.pattern] = textContent;
        console.log(`  ✓ ${route.pattern}`);
      }
    } catch {
      // Skip files that can't be read
    }
  }

  const count = await searchDocumentCount();

  // Persist so `pledge search <query>` (a separate process) can query it.
  try {
    const path = indexPath(config);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify(documents), 'utf-8');
  } catch {
    // Best-effort — query mode will report "no index" if this fails.
  }

  console.log(`\n  Indexed ${Object.keys(documents).length} pages (${count} documents in index).\n`);
  console.log('  Search with: pledge search <query>\n');
}
