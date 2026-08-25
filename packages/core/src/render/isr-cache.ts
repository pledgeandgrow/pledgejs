/**
 * Incremental Static Regeneration (ISR) cache.
 *
 * Serves a cached rendered page and, once it is older than its `revalidate`
 * window, regenerates it in the background (stale-while-revalidate): the current
 * request still gets the cached HTML immediately, and the next request sees the
 * fresh copy. Keyed by request path.
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

export interface IsrHit {
  html: string;
  /** True when the entry is older than its revalidate window. */
  stale: boolean;
}

export function getIsr(key: string): IsrHit | null {
  const entry = cache.get(key);
  if (!entry) return null;
  return { html: entry.html, stale: Date.now() - entry.renderedAt >= entry.revalidateMs };
}

export function setIsr(key: string, html: string, revalidateSeconds: number): void {
  if (!cache.has(key) && cache.size >= MAX_ISR_ENTRIES) {
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

/** Invalidate one path (revalidatePath) or the whole cache. */
export function invalidateIsr(key?: string): void {
  if (key) cache.delete(key);
  else cache.clear();
}
