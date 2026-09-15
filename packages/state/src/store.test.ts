import { describe, it, expect, vi } from 'vitest';
import { createStore, applySelectorUpdate } from './store';

describe('createStore', () => {
  it('initializes with initial state', () => {
    const store = createStore({ initialState: { count: 0 } });
    expect(store.getState()).toEqual({ count: 0 });
  });

  it('updates state with setState', () => {
    const store = createStore({ initialState: { count: 0 } });
    store.setState({ count: 5 });
    expect(store.getState()).toEqual({ count: 5 });
  });

  it('updates state with function updater', () => {
    const store = createStore({ initialState: { count: 5 } });
    store.setState((prev) => ({ count: prev.count + 3 }));
    expect(store.getState()).toEqual({ count: 8 });
  });

  it('notifies subscribers on state change', () => {
    const store = createStore({ initialState: { count: 0 } });
    const listener = vi.fn();
    store.subscribe(listener);
    store.setState({ count: 1 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops notifications', () => {
    const store = createStore({ initialState: { count: 0 } });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    store.setState({ count: 1 });
    expect(listener).not.toHaveBeenCalled();
  });

  it('reset restores initial state', () => {
    const store = createStore({ initialState: { count: 0 } });
    store.setState({ count: 100 });
    store.reset();
    expect(store.getState()).toEqual({ count: 0 });
  });

  it('reset notifies subscribers', () => {
    const store = createStore({ initialState: { count: 0 } });
    const listener = vi.fn();
    store.subscribe(listener);
    store.reset();
    expect(listener).toHaveBeenCalled();
  });

  it('supports multiple subscribers', () => {
    const store = createStore({ initialState: { count: 0 } });
    const l1 = vi.fn();
    const l2 = vi.fn();
    store.subscribe(l1);
    store.subscribe(l2);
    store.setState({ count: 1 });
    expect(l1).toHaveBeenCalledTimes(1);
    expect(l2).toHaveBeenCalledTimes(1);
  });
});

describe('createStore dedup (#state)', () => {
  it('does not notify subscribers when the value is unchanged', () => {
    const store = createStore({ initialState: { count: 0 } });
    const same = store.getState();
    const listener = vi.fn();
    store.subscribe(listener);
    store.setState(same); // identical reference → no notify
    expect(listener).not.toHaveBeenCalled();
    store.setState({ count: 1 }); // new value → notify
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('applySelectorUpdate (useStore setValue core)', () => {
  it('merges the update onto the whole state for the identity selector', () => {
    const prev = { count: 0, name: 'a' };
    const next = applySelectorUpdate(prev, (s) => s, { count: 5 }, true);
    expect(next).toEqual({ count: 5, name: 'a' });
  });

  it('writes back through a non-identity property selector instead of corrupting the whole state', () => {
    const prev = { user: { name: 'a', age: 1 }, count: 0 };
    const next = applySelectorUpdate(prev, (s) => s.user, { name: 'b' }, false);
    expect(next).toEqual({ user: { name: 'b', age: 1 }, count: 0 });
  });

  it('merges a partial object update into the selected slice, preserving sibling keys', () => {
    const prev = { user: { name: 'a', age: 1 }, count: 0 };
    const next = applySelectorUpdate(
      prev,
      (s) => s.user,
      (u) => ({ name: 'b' }),
      false,
    );
    expect(next).toEqual({ user: { name: 'b', age: 1 }, count: 0 });
  });

  it('replaces the slice with a primitive update', () => {
    const prev = { count: 0, name: 'a' };
    const next = applySelectorUpdate(prev, (s) => s.count, 5, false);
    expect(next).toEqual({ count: 5, name: 'a' });
  });

  it('throws when the selector path cannot be determined', () => {
    const prev = { a: 1, b: 2 };
    expect(() => applySelectorUpdate(prev, (s) => s.a + s.b, 3, false)).toThrow();
  });
});
