import { watch, type FSWatcher } from 'node:fs';
import { join, relative } from 'node:path';

export interface HMRWatcherOptions {
  /** Directory to watch for changes */
  watchDir: string;
  /** Callback when a file changes */
  onChange: (filePath: string) => void;
  /** Debounce interval in ms (default: 100) */
  debounceMs?: number;
}

export interface HMRWatcher {
  start: () => void;
  stop: () => void;
}

/**
 * Creates a file watcher for HMR in development mode.
 * Watches the app directory for changes to route files, layouts,
 * middleware, and other source files, triggering handler invalidation.
 */
export function createHMRWatcher(options: HMRWatcherOptions): HMRWatcher {
  const { watchDir, onChange, debounceMs = 100 } = options;
  let watcher: FSWatcher | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingChanges = new Set<string>();

  function start() {
    if (watcher) return;

    watcher = watch(watchDir, { recursive: true }, (_event, filename) => {
      if (!filename) return;

      const filePath = join(watchDir, filename);
      const relPath = relative(watchDir, filePath);

      // Only trigger for relevant file types
      if (!isWatchableFile(relPath)) return;

      pendingChanges.add(filePath);

      // Debounce: collect changes and fire once after quiet period
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        for (const path of pendingChanges) {
          onChange(path);
        }
        pendingChanges.clear();
        debounceTimer = null;
      }, debounceMs);
    });

    console.log(`[pledgestack] HMR watching: ${watchDir}`);
  }

  function stop() {
    if (watcher) {
      watcher.close();
      watcher = null;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    pendingChanges.clear();
  }

  return { start, stop };
}

/**
 * Determines if a file should trigger HMR based on its extension.
 * Ignores generated/dependency dirs — in particular `.pledge-cache`, where
 * dev transforms are written; without the exclusion, each transform write
 * would itself trigger invalidation and every request would re-transform.
 */
function isWatchableFile(filename: string): boolean {
  const segments = filename.split(/[\\/]/);
  if (segments.some((s) => IGNORED_DIRS.has(s))) return false;
  const watchableExtensions = [
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.css', '.json', '.html',
    '.psx', '.ps',
  ];
  return watchableExtensions.some((ext) => filename.endsWith(ext));
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.pledge',
  '.pledge-cache',
  'dist',
  'public',
]);
