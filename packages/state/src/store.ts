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

  return {
    getState: () => state,
    setState: (updater) => {
      const next = typeof updater === 'function' ? (updater as (prev: T) => T)(state) : updater;
      // Don't notify subscribers when the value is unchanged — this avoids
      // needless re-renders and useSyncExternalStore "getSnapshot should be
      // cached" churn.
      if (Object.is(next, state)) return;
      state = next;
      listeners.forEach((l) => l());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset: () => {
      state = options.initialState;
      listeners.forEach((l) => l());
    },
  };
}

// Identity selector, used as the default when no selector is passed. Kept as
// a stable module-level reference so useStore can detect (via `===`) whether
// the caller selected a derived slice — see setValue below.
function identitySelector<T>(state: T): T {
  return state;
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
      store.setState((prev) => {
        const current = selectorRef.current(prev);
        const next = typeof updater === 'function' ? (updater as (p: S) => S)(current) : updater;
        // Only the identity selector's slice IS the whole state, so it's the
        // only case where writing `next` back as the new state is correct.
        // A derived selector (e.g. `s => s.foo`) has no general inverse —
        // merging `next` onto `prev` would silently corrupt unrelated keys —
        // so callers with a custom selector must update via `store.setState`
        // directly instead of this hook's setter.
        if (!isIdentitySelector) {
          throw new Error(
            'useStore: setValue is only supported with the default (identity) selector. ' +
              'When using a custom selector, update state via store.setState() instead.',
          );
        }
        return next as unknown as T;
      });
    },
    [store, isIdentitySelector],
  );

  return [value, setValue];
}
