/**
 * Route tree type re-export for the React renderer.
 * This mirrors the RouteTree from pledgestack-core but without importing it
 * (to avoid circular dependencies).
 */

export interface RouteTreeNode {
  pattern: string;
  segment: string;
  children: RouteTreeNode[];
  route?: import('pledgestack-shared').ResolvedRoute;
  layouts: import('pledgestack-shared').ResolvedRoute[];
  slots?: Record<string, RouteTreeNode>;
}

export interface RouteTree {
  root: RouteTreeNode;
}
