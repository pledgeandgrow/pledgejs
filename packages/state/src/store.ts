import { useSyncExternalStore, useCallback, useRef } from 'react';

export interface StoreOptions<T> {
  initialState: T;
  name?: string;
}

export interface Store<T> {
  getState: () => T;
  setState: (updater: T | ((prev: T) => T)) => void;
  subscribe: (listener: () => void) => () => void;
  reset: () => void;
}

export function createStore<T>(options: StoreOptions<T>): Store<T> {
  let state = options.initialState;
  const listeners = new Set<() => void>();

  const notify = () => {
    // Iterate a snapshot so a listener that (un)subscribes during iteration
    // can't mutate the set we're iterating. Isolate each listener's error so
    // one throwing subscriber doesn't prevent the rest from being notified.
    for (const l of [...listeners]) {
      try {
        l();
      } catch {
        // A listener throwing should not break other listeners.
      }
    }
  };

  return {
    getState: () => state,
    setState: (updater) => {
      const next = typeof updater === 'function' ? (updater as (prev: T) => T)(state) : updater;
      // Don't notify subscribers when the value is unchanged — this avoids
      // needless re-renders and useSyncExternalStore "getSnapshot should be
      // cached" churn.
      if (Object.is(next, state)) return;
      state = next;
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset: () => {
      // Shallow-copy initialState on reset so mutations to the live state
      // don't leak back into the stored initial value. Without this, a
      // second reset() after mutating state restores the mutated copy (#45).
      const initial = options.initialState;
      state = (initial && typeof initial === 'object' ? { ...initial } : initial) as T;
      notify();
    },
  };
}

// Identity selector, used as the default when no selector is passed. Kept as
// a stable module-level reference so useStore can detect (via `===`) whether
// the caller selected a derived slice — see setValue below.
function identitySelector<T>(state: T): T {
  return state;
}

// Detect the single top-level property a "simple property accessor" selector
// (e.g. `s => s.user`) reads, by running it against a Proxy of the state. We
// only support the common PledgeStack case of exactly one string-keyed access;
// anything more derived has no general inverse and falls back to null.
function detectSelectorKey<T, S>(selector: (state: T) => S, state: T): string | null {
  const keys = new Set<string | symbol>();
  const proxy = new Proxy(state as object, {
    get(_target, key) {
      keys.add(key);
      return Reflect.get(state as object, key);
    },
  });
  try {
    selector(proxy as unknown as T);
  } catch {
    return null;
  }
  if (keys.size !== 1) return null;
  const [key] = keys;
  return typeof key === 'string' ? key : null;
}

// Pure, React-free core of useStore's setter. Exported so it can be exercised
// directly in tests (the hook itself needs a React renderer). For the identity
// selector the slice IS the whole state, so `next` is merged onto `prev`. For
// a simple property-accessor selector the new value is written back through
// that property — merged into the existing slice when `next` is an object —
// instead of being spread onto the whole state, which would corrupt unrelated
// keys.
export function applySelectorUpdate<T, S>(
  prev: T,
  selector: (state: T) => S,
  updater: S | ((prev: S) => S),
  isIdentity: boolean,
): T {
  const current = selector(prev);
  const next = typeof updater === 'function' ? (updater as (p: S) => S)(current) : updater;
  if (isIdentity) {
    if (next && typeof next === 'object') return { ...(prev as object), ...(next as object) } as T;
    return next as unknown as T;
  }
  const key = detectSelectorKey(selector, prev);
  if (key === null) {
    throw new Error(
      'useStore: setValue could not determine the selected property to update. ' +
        'When using a custom selector, update state via store.setState() instead.',
    );
  }
  const slice = next && typeof next === 'object' ? { ...(current as object), ...(next as object) } : next;
  return { ...(prev as object), [key]: slice } as T;
}

export function useStore<T, S = T>(
  store: Store<T>,
  selector: (state: T) => S = identitySelector as unknown as (state: T) => S,
): [S, (updater: S | ((prev: S) => S)) => void] {
  const selectorRef = useRef(selector);
  selectorRef.current = selector;

  const getSnapshot = useCallback(() => selectorRef.current(store.getState()), [store]);
  const value = useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);

  const isIdentitySelector = selector === (identitySelector as unknown as (state: T) => S);

  const setValue = useCallback(
    (updater: S | ((prev: S) => S)) => {
      store.setState((prev) =>
        applySelectorUpdate(prev, selectorRef.current, updater, isIdentitySelector),
      );
    },
    [store, isIdentitySelector],
  );

  return [value, setValue];
}
