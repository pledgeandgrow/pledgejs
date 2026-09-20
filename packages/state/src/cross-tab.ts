import { useState, useEffect, useCallback, useRef } from 'react';

export interface CrossTabOptions {
  /** BroadcastChannel name (default: 'pledgestack-cross-tab') */
  channelName?: string;
  /** Storage key for fallback (default: same as channelName) */
  storageKey?: string;
}

export function useCrossTabState<T>(
  key: string,
  defaultValue: T,
  options: CrossTabOptions = {},
): [T, (value: T | ((prev: T) => T)) => void, () => void] {
  const { channelName = 'pledgestack-cross-tab', storageKey = channelName } = options;
  const channelRef = useRef<BroadcastChannel | null>(null);
  const fullKey = `${storageKey}:${key}`;

  const readValue = useCallback((): T => {
    if (typeof window === 'undefined') return defaultValue;
    try {
      const raw = localStorage.getItem(fullKey);
      return raw ? (JSON.parse(raw) as T) : defaultValue;
    } catch {
      return defaultValue;
    }
  }, [fullKey, defaultValue]);

  const [state, setState] = useState<T>(readValue);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (typeof window === 'undefined') return;

    if ('BroadcastChannel' in window) {
      channelRef.current = new BroadcastChannel(channelName);
      channelRef.current.onmessage = (e: MessageEvent) => {
        if (e.data?.key === key) {
          setState(e.data.value as T);
        }
      };
    }

    const onStorage = (e: StorageEvent) => {
      if (e.key === fullKey && e.newValue !== null) {
        try {
          setState(JSON.parse(e.newValue) as T);
        } catch {
          /* ignore */
        }
      }
    };
    window.addEventListener('storage', onStorage);

    return () => {
      channelRef.current?.close();
      window.removeEventListener('storage', onStorage);
    };
  }, [channelName, fullKey, key]);

  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      // Compute next and do the localStorage/broadcast side effects OUTSIDE the
      // updater — a setState updater must be pure (StrictMode runs it twice).
      const next = typeof value === 'function' ? (value as (p: T) => T)(stateRef.current) : value;
      stateRef.current = next;
      if (typeof window !== 'undefined') {
        try {
          localStorage.setItem(fullKey, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        channelRef.current?.postMessage({ key, value: next });
      }
      setState(next);
    },
    [fullKey, key],
  );

  const clear = useCallback(() => {
    if (typeof window !== 'undefined') {
      try {
        localStorage.removeItem(fullKey);
      } catch {
        /* ignore */
      }
    }
    setState(defaultValue);
  }, [fullKey, defaultValue]);

  return [state, setValue, clear];
}
