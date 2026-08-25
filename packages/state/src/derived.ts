import { useRef } from 'react';

export interface DerivedOptions {
  /** Dependency equality check function (default: Object.is) */
  isEqual?: (a: unknown, b: unknown) => boolean;
  /** Maximum cache size (default: 1) */
  cacheSize?: number;
}

export function useDerived<T, Args extends unknown[]>(
  compute: (...args: Args) => T,
  deps: Args,
  options: DerivedOptions = {},
): T {
  const { isEqual = Object.is, cacheSize = 1 } = options;
  const cacheRef = useRef<Array<{ deps: Args; value: T }>>([]);

  // The manual isEqual cache IS the memoization. The previous version wrapped
  // this in useMemo with `deps` (a fresh array every render) in the dep list,
  // so useMemo re-ran on every render and the cache never helped.
  for (const entry of cacheRef.current) {
    if (entry.deps.length === deps.length && entry.deps.every((d, i) => isEqual(d, deps[i]))) {
      return entry.value;
    }
  }

  const value = compute(...deps);
  cacheRef.current.unshift({ deps: deps.slice() as Args, value });
  if (cacheRef.current.length > cacheSize) {
    cacheRef.current.length = cacheSize;
  }
  return value;
}
