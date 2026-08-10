/**
 * Layout chain extraction — re-exports the shared implementation.
 *
 * The layout chain logic is framework-agnostic (it walks the route tree),
 * so it lives in pledgestack-shared. This file is kept for backward
 * compatibility with code that imports from the React adapter.
 */

export { getLayoutChain } from 'pledgestack-shared';
