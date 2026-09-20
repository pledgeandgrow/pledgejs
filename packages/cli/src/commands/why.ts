/**
 * pledge why — Trace why a module is included in a bundle.
 *
 * Goal #235: Analyzes the build output's import graph to explain why
 * a specific module is in the bundle. Shows the full import chain
 * from entry point to the target module, detects circular dependencies,
 * and highlights tree-shaking opportunities.
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, extname, posix } from 'node:path';
import type { PledgeConfig } from 'pledgestack-shared';

interface ImportNode {
  /** Module file path (absolute) */
  path: string;
  /** Modules that import this module */
  importers: Set<string>;
  /** Modules that this module imports */
  imports: Set<string>;
  /** Whether this module is an entry point */
  isEntry: boolean;
  /** Size in bytes (if known) */
  size?: number;
}

/**
 * Builds an import graph from the build output directory.
 * Scans .js/.mjs files for import/export statements.
 */
async function buildImportGraph(outDir: string, rootDir: string): Promise<Map<string, ImportNode>> {
  const graph = new Map<string, ImportNode>();
  const files: string[] = [];

  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (/\.(js|mjs)$/.test(entry.name)) {
        files.push(fullPath);
      }
    }
  }

  if (!existsSync(outDir)) return graph;
  await walk(outDir);

  // Parse each file for imports
  for (const filePath of files) {
    const relPath = relative(rootDir, filePath).replace(/\\/g, '/');

    if (!graph.has(relPath)) {
      graph.set(relPath, {
        path: relPath,
        importers: new Set(),
        imports: new Set(),
        isEntry: false,
      });
    }

    const node = graph.get(relPath)!;

    // Mark entry points
    if (filePath.includes('client.js') || filePath.includes('server.js') || relPath.endsWith('entry.js')) {
      node.isEntry = true;
    }

    // Parse imports
    try {
      const content = await readFile(filePath, 'utf-8');
      node.size = content.length;

      // Match ES module imports
      const importRegex = /(?:import\s+(?:[^'"]+\s+from\s+)?|export\s+(?:[^'"]+\s+from\s+)?)['"]([^'"]+)['"]/g;
      let match: RegExpExecArray | null;
      while ((match = importRegex.exec(content)) !== null) {
        const importPath = match[1];
        const resolved = resolveImportPath(importPath, filePath, rootDir);
        if (resolved) {
          node.imports.add(resolved);

          if (!graph.has(resolved)) {
            graph.set(resolved, {
              path: resolved,
              importers: new Set(),
              imports: new Set(),
              isEntry: false,
            });
          }
          graph.get(resolved)!.importers.add(relPath);
        }
      }

      // Match dynamic imports
      const dynamicImportRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
      while ((match = dynamicImportRegex.exec(content)) !== null) {
        const importPath = match[1];
        const resolved = resolveImportPath(importPath, filePath, rootDir);
        if (resolved) {
          node.imports.add(resolved);
          if (!graph.has(resolved)) {
            graph.set(resolved, {
              path: resolved,
              importers: new Set(),
              imports: new Set(),
              isEntry: false,
            });
          }
          graph.get(resolved)!.importers.add(relPath);
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return graph;
}

/**
 * Resolves an import path to a relative project path.
 */
export function resolveImportPath(importPath: string, fromFile: string, rootDir: string): string | null {
  // Skip node_modules and bare specifiers
  if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
    // Map known packages to node_modules paths
    if (importPath.startsWith('pledgestack')) {
      return `node_modules/${importPath}/index.js`;
    }
    if (importPath.startsWith('react')) {
      return `node_modules/${importPath}`;
    }
    return null;
  }

  // Resolve relative paths
  let resolved: string;
  if (importPath.startsWith('/')) {
    resolved = importPath.slice(1);
  } else {
    const fromDir = relative(rootDir, fromFile).replace(/\\/g, '/').split('/').slice(0, -1).join('/');
    // posix.normalize collapses every `./` and `../` (the old regexes handled only one level).
    resolved = posix.normalize(fromDir ? `${fromDir}/${importPath}` : importPath);
  }

  // Add extension if missing
  if (!extname(resolved)) {
    for (const ext of ['.js', '.mjs', '.ts', '.tsx']) {
      const withExt = `${resolved}${ext}`;
      if (existsSync(join(rootDir, withExt))) return withExt;
    }
    // Try index.js
    const indexPath = `${resolved}/index.js`;
    if (existsSync(join(rootDir, indexPath))) return indexPath;
  }

  return resolved;
}

/**
 * Finds all import chains from entry points to the target module.
 * Uses DFS with cycle detection.
 */
function findImportChains(
  graph: Map<string, ImportNode>,
  target: string,
  maxDepth: number = 20,
): string[][] {
  const chains: string[][] = [];
  const entries = [...graph.values()].filter((n) => n.isEntry);

  function dfs(current: string, path: string[], visited: Set<string>) {
    if (path.length > maxDepth) return;
    if (current === target) {
      chains.push([...path]);
      return;
    }
    if (visited.has(current)) return;
    visited.add(current);

    const node = graph.get(current);
    if (!node) return;

    for (const imp of node.imports) {
      dfs(imp, [...path, imp], new Set(visited));
    }
  }

  for (const entry of entries) {
    dfs(entry.path, [entry.path], new Set());
  }

  // Also search from any node that directly imports the target
  // (in case entry points weren't detected)
  const directImporters = [...graph.values()].filter((n) => n.imports.has(target));
  for (const importer of directImporters) {
    if (!importer.isEntry) {
      // Find path from this importer back to an entry
      const reversePath = findPathToEntry(graph, importer.path);
      if (reversePath.length > 0) {
        const fullChain = [...reversePath, target];
        if (!chains.some((c) => JSON.stringify(c) === JSON.stringify(fullChain))) {
          chains.push(fullChain);
        }
      }
    }
  }

  return chains;
}

/**
 * Finds a path from a given node to any entry point (reverse traversal).
 */
function findPathToEntry(graph: Map<string, ImportNode>, start: string): string[] {
  const visited = new Set<string>();
  const queue: { path: string[]; node: string }[] = [{ path: [start], node: start }];

  while (queue.length > 0) {
    const { path, node } = queue.shift()!;
    if (visited.has(node)) continue;
    visited.add(node);

    const graphNode = graph.get(node);
    if (!graphNode) continue;

    if (graphNode.isEntry && path.length > 1) {
      return path;
    }

    for (const importer of graphNode.importers) {
      if (!visited.has(importer)) {
        queue.push({ path: [importer, ...path], node: importer });
      }
    }
  }

  return [start];
}

/**
 * Detects circular dependencies involving the target module.
 */
export function detectCircularDeps(
  graph: Map<string, ImportNode>,
  target: string,
  maxDepth: number = 10,
): string[][] {
  const cycles: string[][] = [];

  function dfs(current: string, path: string[], visited: Set<string>) {
    if (path.length > maxDepth) return;
    if (visited.has(current)) {
      // Found a cycle — extract it
      // `path` already ends with `current` (it was appended on the way in), so
      // slicing from its first occurrence is the whole cycle — concatenating
      // `current` again printed the closing module twice.
      const cycleStart = path.indexOf(current);
      if (cycleStart !== -1) {
        const cycle = path.slice(cycleStart);
        if (cycle.includes(target)) {
          cycles.push(cycle);
        }
      }
      return;
    }

    const newVisited = new Set(visited);
    newVisited.add(current);

    const node = graph.get(current);
    if (!node) return;

    for (const imp of node.imports) {
      dfs(imp, [...path, imp], newVisited);
    }
  }

  dfs(target, [target], new Set());

  // Deduplicate cycles
  const seen = new Set<string>();
  return cycles.filter((c) => {
    // Sort a copy: sorting `c` in place scrambled the cycle that gets printed.
    const key = [...c].sort().join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Formats an import chain for terminal output.
 */
function formatChain(chain: string[], rootDir: string): string {
  return chain.map((m, i) => {
    const indent = '  '.repeat(i);
    const arrow = i > 0 ? '→ ' : '';
    const relPath = relative(rootDir, join(rootDir, m)).replace(/\\/g, '/');
    return `${indent}${arrow}${relPath}`;
  }).join('\n');
}

/**
 * Runs the `pledge why` command.
 */
export async function whyCommand(
  target: string,
  config: PledgeConfig,
): Promise<void> {
  const outDir = join(config.rootDir, config.outDir);

  console.log(`\n  Analyzing why "${target}" is in the bundle...\n`);

  if (!existsSync(outDir)) {
    console.error('  Error: No build output found. Run `pledge build` first.\n');
    process.exit(1);
  }

  // Build import graph
  console.log('  → Building import graph from build output...');
  const graph = await buildImportGraph(outDir, config.rootDir);
  console.log(`  ✓ Found ${graph.size} modules\n`);

  // Normalize target path
  const normalizedTarget = target
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\//, '');

  // Find the target in the graph
  let targetPath = normalizedTarget;
  if (!graph.has(targetPath)) {
    // Try fuzzy match
    const matches = [...graph.keys()].filter((k) => k.includes(normalizedTarget));
    if (matches.length === 1) {
      targetPath = matches[0];
    } else if (matches.length > 1) {
      console.log(`  Multiple matches found for "${target}":`);
      for (const m of matches) {
        console.log(`    • ${m}`);
      }
      console.log('\n  Please specify a more precise path.\n');
      process.exit(1);
    } else {
      console.error(`  Error: Module "${target}" not found in bundle.\n`);
      console.log('  Available modules:');
      for (const m of [...graph.keys()].slice(0, 20)) {
        console.log(`    • ${m}`);
      }
      if (graph.size > 20) {
        console.log(`    ... and ${graph.size - 20} more`);
      }
      console.log();
      process.exit(1);
    }
  }

  const targetNode = graph.get(targetPath)!;

  // Find import chains
  const chains = findImportChains(graph, targetPath);

  // Detect circular deps
  const circularDeps = detectCircularDeps(graph, targetPath);

  // Get direct importers
  const directImporters = [...targetNode.importers];

  // Estimate size
  const estimatedSize = targetNode.size ?? 0;

  // Check if tree-shakeable (no side effects detected if only type imports)
  const treeShakeable = directImporters.length === 0 && !targetNode.isEntry;

  // Output results
  console.log(`  Module: ${targetPath}`);
  console.log(`  Size: ${formatBytes(estimatedSize)}`);
  console.log(`  Direct importers: ${directImporters.length}`);
  console.log(`  Import chains: ${chains.length}`);
  console.log(`  Circular deps: ${circularDeps.length}`);
  console.log();

  if (chains.length > 0) {
    console.log('  ── Import Chains ──────────────────────────────────────\n');
    for (const chain of chains.slice(0, 5)) {
      console.log(formatChain(chain, config.rootDir));
      console.log();
    }
    if (chains.length > 5) {
      console.log(`  ... and ${chains.length - 5} more chains.\n`);
    }
  } else {
    console.log('  ⚠ No import chains found from entry points.');
    console.log('    This module may be dead code or loaded dynamically.\n');
  }

  if (directImporters.length > 0) {
    console.log('  ── Direct Importers ──────────────────────────────────\n');
    for (const importer of directImporters) {
      console.log(`    • ${importer}`);
    }
    console.log();
  }

  if (circularDeps.length > 0) {
    console.log('  ⚠ Circular Dependencies Detected ─────────────────────\n');
    for (const cycle of circularDeps) {
      console.log(`    ${cycle.join(' → ')}`);
    }
    console.log();
  }

  if (treeShakeable) {
    console.log('  ✓ This module appears tree-shakeable (no direct importers).');
    console.log('    Consider removing it or using dynamic import.\n');
  }

  // Tree-shaking suggestions
  if (directImporters.length > 0 && estimatedSize > 10240) {
    console.log('  💡 This module is >10KB. Consider:');
    console.log('    • Using dynamic import() to lazy-load it');
    console.log('    • Splitting it into smaller modules');
    console.log('    • Checking if all exports are used by importers\n');
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}
