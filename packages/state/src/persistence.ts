import { useState, useEffect, useCallback, useRef } from 'react';

export interface PersistenceOptions<T> {
  /** Storage key */
  key: string;
  /** Default value when nothing is stored */
  defaultValue: T;
  /** Storage type (default: 'localStorage') */
  storage?: 'localStorage' | 'sessionStorage';
  /** Serialize function (default: JSON.stringify) */
  serialize?: (value: T) => string;
  /** Deserialize function (default: JSON.parse) */
  deserialize?: (raw: string) => T;
  /** Hydrate from storage on mount (default: true) */
  hydrate?: boolean;
  /** Called when a persistence write fails (e.g. quota exceeded) so the UI
   * can surface the error instead of silently dropping the user's data. */
  onPersistError?: (error: unknown) => void;
}

export function usePersistentState<T>(options: PersistenceOptions<T>): [T, (value: T | ((prev: T) => T)) => void, () => void] {
  const {
    key,
    defaultValue,
    storage: storageType = 'localStorage',
    serialize = JSON.stringify,
    deserialize = JSON.parse,
    hydrate = true,
    onPersistError,
  } = options;

  const storageRef = useRef<Storage | null>(null);

  if (typeof window !== 'undefined') {
    try {
      storageRef.current = storageType === 'localStorage' ? window.localStorage : window.sessionStorage;
    } catch {
      // Accessing window.localStorage throws SecurityError when storage is
      // blocked (privacy modes, sandboxed iframes) — degrade to in-memory.
      storageRef.current = null;
    }
  }

  const [state, setState] = useState<T>(defaultValue);
  // Hold serialize/deserialize/state in refs so an inline function passed by the
  // caller (a new reference every render) doesn't retrigger the hydration effect
  // and clobber live state each render.
  const serializeRef = useRef(serialize);
  serializeRef.current = serialize;
  const deserializeRef = useRef(deserialize);
  deserializeRef.current = deserialize;
  const stateRef = useRef(state);
  stateRef.current = state;
  const onPersistErrorRef = useRef(onPersistError);
  onPersistErrorRef.current = onPersistError;

  useEffect(() => {
    if (!hydrate || typeof window === 'undefined') return;
    try {
      const raw = storageRef.current?.getItem(key);
      if (raw !== null && raw !== undefined) {
        setState(deserializeRef.current(raw));
      }
    } catch {
      /* ignore */
    }
    // Re-hydrate only when the key or hydrate flag changes — NOT when the
    // deserialize function identity changes.
  }, [key, hydrate]);

  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      // Compute next and persist OUTSIDE the updater (updaters must be pure).
      const next = typeof value === 'function' ? (value as (p: T) => T)(stateRef.current) : value;
      stateRef.current = next;
      if (typeof window !== 'undefined' && storageRef.current) {
        try {
          storageRef.current.setItem(key, serializeRef.current(next));
        } catch (err) {
          // Surface quota / serialization errors (e.g. QuotaExceededError)
          // so the UI can inform the user instead of silently dropping data.
          onPersistErrorRef.current?.(err);
        }
      }
      setState(next);
    },
    [key],
  );

  const clear = useCallback(() => {
    if (typeof window !== 'undefined' && storageRef.current) {
      try {
        storageRef.current.removeItem(key);
      } catch {
        /* ignore */
      }
    }
    setState(defaultValue);
  }, [key, defaultValue]);

  return [state, setValue, clear];
}

export function useSessionState<T>(
  key: string,
  defaultValue: T,
): [T, (value: T | ((prev: T) => T)) => void, () => void] {
  return usePersistentState<T>({ key, defaultValue, storage: 'sessionStorage' });
}
