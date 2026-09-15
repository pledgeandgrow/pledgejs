/**
 * Selective hydration — prioritizes visible components for hydration.
 *
 * Item 19 of the PledgeStack roadmap.
 * Extends the pledge system with viewport-aware priority scheduling.
 *
 * Components above the fold are hydrated first (priority: 'high'),
 * components below the fold are hydrated when visible or on idle.
 */

import { useEffect, useState, useRef, type ComponentType, type ReactNode } from 'react';
import { createElement } from 'react';

export type HydrationPriority = 'high' | 'normal' | 'low' | 'lazy';

export interface SelectiveHydrationOptions {
  /** Priority level for hydration scheduling */
  priority?: HydrationPriority;
  /** Estimated height for placeholder (px) — prevents layout shift */
  placeholderHeight?: number;
  /** Whether to use IntersectionObserver for visibility detection */
  observeVisibility?: boolean;
  /** Root margin for IntersectionObserver (default: '200px' for pre-loading) */
  rootMargin?: string;
  /** Whether to hydrate on interaction if not yet hydrated */
  hydrateOnInteraction?: boolean;
  /** Interaction events to trigger hydration (default: ['click', 'focus', 'mousemove']) */
  interactionEvents?: string[];
}

interface HydrationTask {
  id: string;
  component: ComponentType<Record<string, unknown>>;
  props: Record<string, unknown>;
  priority: HydrationPriority;
  element: HTMLElement | null;
  resolve: () => void;
}

const hydrationQueue: HydrationTask[] = [];
let isProcessing = false;

const PRIORITY_WEIGHT: Record<HydrationPriority, number> = {
  high: 0,
  normal: 1,
  low: 2,
  lazy: 3,
};

/**
 * Sorts the hydration queue by priority (high first).
 */
function sortQueue(): void {
  hydrationQueue.sort((a, b) => PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority]);
}

/**
 * Processes the hydration queue — hydrates high-priority tasks first,
 * defers low-priority tasks to requestIdleCallback.
 */
function processQueue(): void {
  if (isProcessing || hydrationQueue.length === 0) return;
  isProcessing = true;

  sortQueue();

  const task = hydrationQueue.shift();
  if (!task) {
    isProcessing = false;
    return;
  }

  // Check if element is still in the DOM
  if (task.element && !document.body.contains(task.element)) {
    isProcessing = false;
    processQueue();
    return;
  }

  task.resolve();

  // Continue processing — high priority immediately, others on idle
  const next = hydrationQueue[0];
  if (next && next.priority === 'high') {
    // Use microtask for high-priority to hydrate ASAP
    queueMicrotask(() => {
      isProcessing = false;
      processQueue();
    });
  } else {
    // Use requestIdleCallback for lower priority
    if ('requestIdleCallback' in window) {
      (window as unknown as { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback(() => {
        isProcessing = false;
        processQueue();
      });
    } else {
      setTimeout(() => {
        isProcessing = false;
        processQueue();
      }, 16);
    }
  }
}

/**
 * Enqueues a hydration task with the given priority.
 */
function enqueueHydration(task: HydrationTask): void {
  hydrationQueue.push(task);
  processQueue();
}

/**
 * Checks if an element is currently in the viewport.
 */
function isInViewport(el: HTMLElement, rootMargin = '0px'): boolean {
  const rect = el.getBoundingClientRect();
  const margin = parseInt(rootMargin, 10) || 0;
  return (
    rect.top + margin < window.innerHeight &&
    rect.bottom - margin > 0 &&
    rect.left + margin < window.innerWidth &&
    rect.right - margin > 0
  );
}

/**
 * SelectiveHydration — a wrapper component that hydrates children
 * based on viewport visibility and priority.
 *
 * Usage:
 *   <SelectiveHydration priority="high">
 *     <HeroSection />
 *   </SelectiveHydration>
 *
 *   <SelectiveHydration priority="lazy" placeholderHeight={400}>
 *     <CommentsSection />
 *   </SelectiveHydration>
 */
export function SelectiveHydration({
  children,
  priority = 'normal',
  placeholderHeight,
  observeVisibility = true,
  rootMargin = '200px',
  hydrateOnInteraction = true,
  interactionEvents = ['click', 'focus', 'touchstart'],
}: {
  children: ReactNode;
} & SelectiveHydrationOptions) {
  const [hydrated, setHydrated] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || hydrated) return;

    // High priority — hydrate immediately if in viewport
    if (priority === 'high') {
      enqueueHydration({
        id: `sel_${Math.random().toString(36).slice(2)}`,
        component: () => null,
        props: {},
        priority,
        element: el,
        resolve: () => setHydrated(true),
      });
      return;
    }

    // Check if already in viewport
    if (observeVisibility && isInViewport(el, rootMargin)) {
      setHydrated(true);
      return;
    }

    // Set up IntersectionObserver for visibility-based hydration
    let observer: IntersectionObserver | null = null;
    if (observeVisibility && 'IntersectionObserver' in window) {
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              setHydrated(true);
              observer?.disconnect();
            }
          }
        },
        { rootMargin, threshold: 0 },
      );
      observer.observe(el);
    }

    // Set up interaction-based hydration
    let interactionHandlers: Array<{ event: string; handler: () => void }> = [];
    if (hydrateOnInteraction) {
      for (const event of interactionEvents) {
        const handler = () => {
          setHydrated(true);
          for (const { event: e, handler: h } of interactionHandlers) {
            el.removeEventListener(e, h);
          }
          observer?.disconnect();
        };
        el.addEventListener(event, handler, { once: true, passive: true });
        interactionHandlers.push({ event, handler });
      }
    }

    return () => {
      observer?.disconnect();
      for (const { event, handler } of interactionHandlers) {
        el.removeEventListener(event, handler);
      }
      interactionHandlers = [];
    };
  }, [hydrated, priority, observeVisibility, rootMargin, hydrateOnInteraction]);

  if (hydrated) {
    return createElement('div', { ref, 'data-selective-hydrated': 'true' }, children);
  }

  const placeholderStyle = placeholderHeight
    ? { minHeight: `${placeholderHeight}px` }
    : {};

  return createElement('div', {
    ref,
    'data-selective-hydration': 'pending',
    'data-priority': priority,
    style: placeholderStyle,
  });
}

/**
 * Hook to get the current hydration priority for a component.
 * Useful for dynamically adjusting priority based on route or user behavior.
 */
export function useHydrationPriority(
  initial: HydrationPriority = 'normal',
): [HydrationPriority, (p: HydrationPriority) => void] {
  const [priority, setPriority] = useState<HydrationPriority>(initial);
  return [priority, setPriority];
}

/**
 * Pre-hydrates all components with the given priority or higher.
 * Useful for route transitions where you want to hydrate above-the-fold content.
 */
export function preHydratePriority(minPriority: HydrationPriority = 'normal'): void {
  const threshold = PRIORITY_WEIGHT[minPriority];
  for (const task of [...hydrationQueue]) {
    if (PRIORITY_WEIGHT[task.priority] <= threshold) {
      task.resolve();
      const idx = hydrationQueue.indexOf(task);
      if (idx >= 0) hydrationQueue.splice(idx, 1);
    }
  }
}

/**
 * Clears the hydration queue (e.g., on route change).
 */
export function clearHydrationQueue(): void {
  hydrationQueue.length = 0;
  isProcessing = false;
}
