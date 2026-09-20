// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { usePersistentState } from './persistence';
import { useCrossTabState } from './cross-tab';
import { useUrlState } from './url-state';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount<T>(useHook: () => T): { result: { current: T }; unmount: () => void } {
  const result = { current: undefined as unknown as T };
  function Probe() {
    result.current = useHook();
    return null;
  }
  const el = document.createElement('div');
  const root = createRoot(el);
  act(() => root.render(<Probe />));
  return { result, unmount: () => act(() => root.unmount()) };
}

describe('functional updates within one tick', () => {
  it('usePersistentState applies both updates', () => {
    const { result } = mount(() => usePersistentState({ key: 'k1', defaultValue: 0 }));
    act(() => {
      result.current[1]((n) => n + 1);
      result.current[1]((n) => n + 1);
    });
    expect(result.current[0]).toBe(2);
    expect(localStorage.getItem('k1')).toBe('2');
  });

  it('useCrossTabState applies both updates', () => {
    const { result } = mount(() => useCrossTabState('k2', 0));
    act(() => {
      result.current[1]((n) => n + 1);
      result.current[1]((n) => n + 1);
    });
    expect(result.current[0]).toBe(2);
  });

  it('useUrlState applies both updates', () => {
    const { result } = mount(() => useUrlState('n', 0));
    act(() => {
      result.current[1]((n) => n + 1);
      result.current[1]((n) => n + 1);
    });
    expect(result.current[0]).toBe(2);
    expect(window.location.search).toContain('n=2');
  });
});

describe('blocked storage', () => {
  it('usePersistentState does not throw when window.localStorage access throws', () => {
    const desc = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('denied', 'SecurityError'); } });
    try {
      expect(() => mount(() => usePersistentState({ key: 'k3', defaultValue: 1 }))).not.toThrow();
    } finally {
      Object.defineProperty(window, 'localStorage', desc);
    }
  });
});
