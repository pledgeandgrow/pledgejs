/**
 * Incremental Static Regeneration (ISR) cache.
 *
 * Serves a cached rendered page and, once it is older than its `revalidate`
 * window, regenerates it in the background (stale-while-revalidate): the current
 * request still gets the cached HTML immediately, and the next request sees the
 * fresh copy. Keyed by request path.
 *
 * The cache is bounded and uses LRU eviction (Map insertion-order iteration
 * doubles as an LRU ledger once entries are re-touched on access). Stale
 * entries past their revalidate window are also periodically purged so a
 * high-churn site cannot accumulate dead entries up to the cap.
 */

interface IsrEntry {
  html: string;
  renderedAt: number;
  revalidateMs: number;
  revalidating: boolean;
}

const cache = new Map<string, IsrEntry>();

/** Cap on cached paths, to bound memory. */
const MAX_ISR_ENTRIES = 5000;
/** How often to sweep expired entries. */
const SWEEP_INTERVAL_MS = 60_000;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

export interface IsrHit {
  html: string;
  /** True when the entry is older than its revalidate window. */
  stale: boolean;
}

/**
 * Moves `key` to the most-recently-used position in the Map (insertion-order
 * iteration is used as the LRU ledger). Map preserves insertion order and
 * re-insertion on `set` moves an existing key to the end.
 */
function touch(key: string, entry: IsrEntry): void {
  cache.delete(key);
  cache.set(key, entry);
}

export function getIsr(key: string): IsrHit | null {
  const entry = cache.get(key);
  if (!entry) return null;
  touch(key, entry); // LRU: mark as recently used
  return { html: entry.html, stale: Date.now() - entry.renderedAt >= entry.revalidateMs };
}

export function setIsr(key: string, html: string, revalidateSeconds: number): void {
  if (cache.has(key)) {
    cache.delete(key); // re-insert moves to MRU
  } else if (cache.size >= MAX_ISR_ENTRIES) {
    // Evict the least-recently-used entry (first in insertion order).
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, {
    html,
    renderedAt: Date.now(),
    revalidateMs: Math.max(1, revalidateSeconds) * 1000,
    revalidating: false,
  });
}

export function isRevalidating(key: string): boolean {
  return cache.get(key)?.revalidating ?? false;
}

export function markRevalidating(key: string, value: boolean): void {
  const entry = cache.get(key);
  if (entry) entry.revalidating = value;
}

/**
 * Run a regeneration exactly once per stale window, even under concurrent
 * requests (thundering-herd). Returns true if the caller won the race and
 * should perform the regeneration; false if another request is already doing
 * it (the caller should just serve the stale copy).
 */
export function tryStartRevalidation(key: string): boolean {
  const entry = cache.get(key);
  if (!entry) return false;
  if (entry.revalidating) return false;
  entry.revalidating = true;
  return true;
}

/** Invalidate one path (revalidatePath) or the whole cache. */
export function invalidateIsr(key?: string): void {
  if (key) cache.delete(key);
  else cache.clear();
}

/**
 * Removes entries whose revalidate window has elapsed AND that are not
 * currently being regenerated. Stale-but-revalidating entries are kept so a
 * background regeneration can still complete and update them.
 */
export function sweepExpiredIsr(now: number = Date.now()): number {
  let removed = 0;
  for (const [key, entry] of cache) {
    if (!entry.revalidating && now - entry.renderedAt >= entry.revalidateMs * 2) {
      cache.delete(key);
      removed++;
    }
  }
  return removed;
}

/**
 * Starts a background sweep timer. Safe to call multiple times — only one
 * timer is ever active. Call `stopIsrSweep` to stop it (e.g. on shutdown).
 */
export function startIsrSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    try {
      sweepExpiredIsr();
    } catch {
      // Sweep must never throw and kill the timer.
    }
  }, SWEEP_INTERVAL_MS);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
}

export function stopIsrSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
