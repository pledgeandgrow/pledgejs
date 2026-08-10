import { describe, it, expect, vi } from 'vitest';
import { createStore } from './store';

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
