// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const hydrateRoot = vi.fn((_el: Element, _node: unknown) => ({ unmount: vi.fn() }));
const createRoot = vi.fn((_el: Element) => ({ render: vi.fn(), unmount: vi.fn() }));
vi.mock('react-dom/client', () => ({ hydrateRoot: (el: Element, node: unknown) => hydrateRoot(el, node), createRoot: (el: Element) => createRoot(el) }));

import { registerPledgeComponent, initPledgeHydration, rehydratePledges } from './hydrate-pledges';

function pledgeEl(id: string, props: Record<string, unknown>, strategy = 'load'): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-pledge-component', 'Counter');
  el.setAttribute('data-pledge-id', id);
  el.setAttribute('data-pledge-strategy', strategy);
  el.setAttribute('data-pledge-props', JSON.stringify(props));
  document.body.appendChild(el);
  return el;
}

describe('pledge hydration', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    hydrateRoot.mockClear();
    createRoot.mockClear();
    // Reset module-level hydration state left by earlier tests.
    rehydratePledges();
    hydrateRoot.mockClear();
  });

  it('hydrates EVERY instance of a pledged component (they all share one pledge id)', () => {
    registerPledgeComponent('pledge_1', () => null);
    const a = pledgeEl('pledge_1', { n: 1 });
    const b = pledgeEl('pledge_1', { n: 2 });
    initPledgeHydration();
    expect(hydrateRoot).toHaveBeenCalledTimes(2);
    const targets = hydrateRoot.mock.calls.map((c) => c[0]);
    expect(targets).toContain(a);
    expect(targets).toContain(b);
    const props = hydrateRoot.mock.calls.map((c) => (c[1] as { props: { n: number } }).props.n).sort();
    expect(props).toEqual([1, 2]);
  });

  it('does not hydrate the same element twice on rehydrate, and unmounts roots of removed elements', () => {
    registerPledgeComponent('pledge_2', () => null);
    const kept = pledgeEl('pledge_2', { n: 1 });
    const removed = pledgeEl('pledge_2', { n: 2 });
    initPledgeHydration();
    expect(hydrateRoot).toHaveBeenCalledTimes(2);
    const removedRoot = hydrateRoot.mock.results[1].value as { unmount: ReturnType<typeof vi.fn> };

    removed.remove();
    hydrateRoot.mockClear();
    rehydratePledges();

    // The surviving element must not be passed to hydrateRoot a second time
    // (React throws when a container is hydrated twice)...
    expect(hydrateRoot.mock.calls.map((c) => c[0])).not.toContain(kept);
    // ...and the detached element's React root must be released.
    expect(removedRoot.unmount).toHaveBeenCalledTimes(1);
  });
});
