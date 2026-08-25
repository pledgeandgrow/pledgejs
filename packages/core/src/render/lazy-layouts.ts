/**
 * Lazy layout rendering — only renders layouts that match the active route segment.
 *
 * Instead of eagerly loading and rendering all layouts in the chain, this module
 * provides utilities to defer layout module loading and rendering until needed.
 * This reduces initial render time for deeply nested routes.
 */

import { createElement, Suspense, lazy, type ReactNode, type ComponentType } from 'react';
import type { RouteMatch, ResolvedRoute } from 'pledgestack-shared';
import type { LayoutModule, LoadingModule, ErrorModule } from '../router/types';
import type { RouteTree } from '../router/types';
import { getLayoutChain } from '../router/router';

/**
 * Creates a lazy layout component that only loads its module when rendered.
 * Uses React.lazy under the hood for code-splitting layouts.
 *
 * Usage:
 *   const LazyLayout = createLazyLayout(() => import('./app/layout.tsx'));
 *   <LazyLayout>{children}</LazyLayout>
 */
export function createLazyLayout(
  loader: () => Promise<{ default: ComponentType<{ children: ReactNode }> }>,
  fallback?: ReactNode,
): ComponentType<{ children: ReactNode }> {
  const LazyComponent = lazy(loader);
  return function LazyLayout({ children }: { children: ReactNode }) {
    return createElement(Suspense, { fallback: fallback ?? null }, createElement(LazyComponent, { children }));
  };
}

/**
 * Filters the layout chain to only include layouts that are on the path
 * to the active route. This prevents rendering sibling layouts that
 * aren't part of the current route hierarchy.
 *
 * For example, given:
 *   app/
 *     layout.tsx
 *     (marketing)/
 *       layout.tsx
 *       about/
 *         page.tsx
 *     (dashboard)/
 *       layout.tsx
 *       settings/
 *         page.tsx
 *
 * When visiting /settings, only app/layout.tsx and (dashboard)/layout.tsx
 * should be rendered — not (marketing)/layout.tsx.
 */
export function getActiveLayouts(match: RouteMatch, tree: RouteTree): ResolvedRoute[] {
  // Returns the layout chain for the matched route (root → matched leaf).
  //
  // NOTE: this module is not currently wired into any render path; the live
  // render paths call getLayoutChain directly. The previous `filePath !==
  // match.route.filePath` filter was a no-op (a layout and a page never share a
  // filePath) and did NOT exclude sibling route-group layouts as its comment
  // claimed — correct route-group-sibling exclusion requires tracking each
  // route's owning group, which the resolved-route model does not yet carry.
  return getLayoutChain(match, tree);
}

/**
 * Builds a lazy element tree where each layout level is wrapped in its own
 * Suspense boundary. This allows partially loaded layouts to render while
 * deeper layouts are still loading.
 *
 * Each layout level renders independently:
 *   <Layout1>
 *     <Suspense fallback={<Layout2Loading />}>
 *       <Layout2>
 *         <Suspense fallback={<PageLoading />}>
 *           <Page />
 *         </Suspense>
 *       </Layout2>
 *     </Suspense>
 *   </Layout1>
 */
export function buildLazyLayoutTree(
  pageElement: ReactNode,
  match: RouteMatch,
  tree: RouteTree,
  modules: Map<string, LayoutModule | LoadingModule | ErrorModule>,
): ReactNode {
  const activeLayouts = getActiveLayouts(match, tree);
  let element = pageElement;

  // Wrap from innermost to outermost
  for (let i = activeLayouts.length - 1; i >= 0; i--) {
    const layout = activeLayouts[i];
    const layoutModule = modules.get(layout.filePath) as LayoutModule | undefined;

    if (layoutModule) {
      let layoutContent: ReactNode = createElement(layoutModule.default, { children: element });

      // Wrap each layout in its own Suspense with its loading.tsx
      if (layout.loadingFilePath) {
        const loadingModule = modules.get(layout.loadingFilePath) as LoadingModule | undefined;
        if (loadingModule) {
          layoutContent = createElement(
            Suspense,
            { fallback: createElement(loadingModule.default, {}) },
            layoutContent,
          );
        }
      }

      element = layoutContent;
    }
  }

  return element;
}
