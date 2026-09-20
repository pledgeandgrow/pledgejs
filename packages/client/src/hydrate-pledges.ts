import { hydrateRoot, createRoot } from 'react-dom/client';
import { createElement, type ComponentType } from 'react';
import {
  PLEDGE_MARKER,
  PLEDGE_ID,
  PLEDGE_STRATEGY,
  PLEDGE_PROPS,
  PLEDGE_MEDIA,
  PLEDGE_ROOT_MARGIN,
  PLEDGE_THRESHOLD,
  MANIFEST_SCRIPT_ID,
  type PledgeManifest,
  type PledgeManifestEntry,
} from 'pledgestack-shared';
import { getPledgeRegistry } from './pledge';

/**
 * Client-side pledge hydration runtime.
 *
 * Scans the DOM for elements with `data-pledge-component` attributes
 * and hydrates them according to their strategy:
 *
 * - 'load'    — hydrate immediately
 * - 'visible' — hydrate when scrolled into view (IntersectionObserver)
 * - 'idle'    — hydrate on requestIdleCallback
 * - 'only'    — render from scratch (no SSR content)
 * - 'media'   — hydrate when media query matches
 */

/**
 * Hydration state per DOM element. A pledged component has ONE pledge id for
 * its definition, shared by every instance rendered on the page — keying
 * state by id meant only the first instance ever hydrated. A null value marks
 * an element whose hydration is scheduled (idle / visible / media) but has not
 * happened yet.
 */
const hydratedElements = new Map<HTMLElement, { unmount(): void } | null>();

/** IntersectionObservers for pending 'visible' pledges — disconnected on route change. */
const activeObservers: IntersectionObserver[] = [];

/**
 * Active media-query listeners installed for pending `media`-strategy
 * pledges. Tracked so they can be torn down on route change — otherwise a
 * listener installed for a pledge that never matches (e.g. the user navigates
 * away before the viewport matches the query) leaks forever.
 */
const activeMediaListeners: Array<{ mql: MediaQueryList; handler: () => void }> = [];

/**
 * Component registry — maps pledge IDs to component constructors.
 * Populated by dynamically imported modules via registerPledgeComponent().
 *
 * The primary source of components is the pledge() HOC's own registry
 * (getPledgeRegistry()), which is populated automatically whenever a pledged
 * component module is evaluated on the client. This map is a secondary,
 * explicit registration path. `resolvePledgeComponent` consults both.
 */
const componentRegistry = new Map<string, ComponentType>();

/**
 * Registers a component for pledge hydration.
 */
export function registerPledgeComponent(id: string, Component: ComponentType): void {
  componentRegistry.set(id, Component);
}

/**
 * Resolve the component for a pledge id from either registry. The pledge()
 * HOC registers into getPledgeRegistry() at module-eval time (matching the
 * server's id assignment order), so this is what actually connects a rendered
 * pledge to its client component — previously hydration only consulted
 * `componentRegistry`, which nothing populated, so no pledge ever hydrated.
 */
function resolvePledgeComponent(id: string): ComponentType | undefined {
  const local = componentRegistry.get(id);
  if (local) return local;
  return getPledgeRegistry().get(id)?.Component as ComponentType | undefined;
}

/**
 * Initializes the pledge hydration runtime.
 * Scans the DOM and hydrates all pledged components.
 */
export function initPledgeHydration(): void {
  if (typeof window === 'undefined') return;

  // Load manifest from script tag
  const manifest = loadManifest();
  if (manifest) {
    for (const entry of manifest.pledges) {
      // Every instance of the pledged component (they share the id).
      const selector = `[${PLEDGE_ID}="${entry.id.replace(/["\\]/g, '\\$&')}"]`;
      for (const element of document.querySelectorAll(selector)) {
        if (element instanceof HTMLElement) hydratePledge(entry, element);
      }
    }
  }

  // Also scan DOM directly for pledge markers (fallback)
  scanDomForPledges();
}

/**
 * Loads the pledge manifest from the script tag injected by SSR.
 */
function loadManifest(): PledgeManifest | null {
  const script = document.getElementById(MANIFEST_SCRIPT_ID);
  if (!script?.textContent) return null;

  try {
    return JSON.parse(script.textContent) as PledgeManifest;
  } catch {
    return null;
  }
}

/**
 * Scans the DOM for elements with pledge markers.
 * Used as fallback when manifest is not available.
 */
function scanDomForPledges(): void {
  const elements = document.querySelectorAll(`[${PLEDGE_MARKER}]`);
  for (const el of elements) {
    if (!(el instanceof HTMLElement)) continue;

    const id = el.getAttribute(PLEDGE_ID);
    if (!id || hydratedElements.has(el)) continue;

    const entry: PledgeManifestEntry = {
      id,
      componentPath: '',
      exportName: 'default',
      strategy: el.getAttribute(PLEDGE_STRATEGY) as PledgeManifestEntry['strategy'],
      props: el.getAttribute(PLEDGE_PROPS) ?? '{}',
      mediaQuery: el.getAttribute(PLEDGE_MEDIA) ?? undefined,
      rootMargin: el.getAttribute(PLEDGE_ROOT_MARGIN) ?? undefined,
      threshold: el.getAttribute(PLEDGE_THRESHOLD)
        ? Number(el.getAttribute(PLEDGE_THRESHOLD))
        : undefined,
    };

    hydratePledge(entry, el);
  }
}

/**
 * Hydrates a single pledge based on its strategy.
 */
function hydratePledge(entry: PledgeManifestEntry, element: HTMLElement): void {
  if (hydratedElements.has(element)) return;

  const Component = resolvePledgeComponent(entry.id);
  if (!Component) {
    // Component not registered on the client (its module wasn't imported).
    return;
  }

  let props: Record<string, unknown>;
  try {
    // Each instance carries its own serialised props on its element.
    props = JSON.parse(element.getAttribute(PLEDGE_PROPS) ?? entry.props) as Record<string, unknown>;
  } catch {
    return;
  }

  // Mark as scheduled right away so a second scan cannot schedule it again.
  hydratedElements.set(element, null);

  const doHydrate = () => {
    // Skip if this element was already hydrated, or was removed from the page
    // (e.g. by a route change) while its hydration was pending.
    if (hydratedElements.get(element) !== null || !element.isConnected) return;

    if (entry.strategy === 'only') {
      // No SSR content — create fresh root
      element.innerHTML = '';
      const root = createRoot(element);
      root.render(createElement(Component, props));
      hydratedElements.set(element, root);
    } else {
      // Hydrate existing SSR content
      hydratedElements.set(element, hydrateRoot(element, createElement(Component, props)));
    }
  };

  switch (entry.strategy) {
    case 'load':
      doHydrate();
      break;

    case 'idle':
      if ('requestIdleCallback' in window) {
        (window as { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback(doHydrate);
      } else {
        setTimeout(doHydrate, 1);
      }
      break;

    case 'visible': {
      const observer = new IntersectionObserver(
        (entries) => {
          for (const obsEntry of entries) {
            if (obsEntry.isIntersecting) {
              doHydrate();
              observer.disconnect();
            }
          }
        },
        {
          rootMargin: entry.rootMargin ?? '0px',
          threshold: entry.threshold ?? 0,
        },
      );
      observer.observe(element);
      activeObservers.push(observer);
      break;
    }

    case 'media': {
      if (!entry.mediaQuery) {
        doHydrate();
        break;
      }
      const mql = window.matchMedia(entry.mediaQuery);
      if (mql.matches) {
        doHydrate();
      } else {
        const handler = () => {
          if (mql.matches) {
            doHydrate();
            mql.removeEventListener('change', handler);
            const idx = activeMediaListeners.findIndex((l) => l.mql === mql && l.handler === handler);
            if (idx >= 0) activeMediaListeners.splice(idx, 1);
          }
        };
        mql.addEventListener('change', handler);
        activeMediaListeners.push({ mql, handler });
      }
      break;
    }

    case 'only':
      doHydrate();
      break;

    default:
      doHydrate();
  }
}

/**
 * Re-hydrates all pledges on the page.
 * Called after page transitions to hydrate new content.
 *
 * Tears down any pending media-query listeners from the previous page so they
 * do not leak across route changes.
 */
export function rehydratePledges(): void {
  for (const { mql, handler } of activeMediaListeners) {
    mql.removeEventListener('change', handler);
  }
  activeMediaListeners.length = 0;
  for (const observer of activeObservers) observer.disconnect();
  activeObservers.length = 0;

  // Release React roots whose elements left the page. Elements that are still
  // connected (e.g. inside a persistent layout) stay hydrated — hydrating a
  // container that already has a root throws in React.
  // Pending (never-hydrated) elements are forgotten too: their observers and
  // media listeners were just torn down, so the scan below re-schedules them.
  for (const [element, root] of hydratedElements) {
    if (!element.isConnected || root === null) {
      root?.unmount();
      hydratedElements.delete(element);
    }
  }
  scanDomForPledges();
}
