// Re-export shared (MiddlewareResult comes from here)
export * from 'pledgestack-shared';
// Re-export core
export * from 'pledgestack-core';
// core/src/router/types.ts independently re-declares a handful of symbols
// that also live in pledgestack-shared (HeadMetadata, RouteTree, RouteTreeNode,
// getLayoutChain) for its own internal React-shaped usage. The two star
// exports above make those names ambiguous; explicit re-exports here win over
// `export *` ambiguity per ES module semantics, so the CLI's public API
// resolves to shared's framework-agnostic versions rather than core's
// internal ones.
export type { HeadMetadata, RouteTree, RouteTreeNode } from 'pledgestack-shared';
export { getLayoutChain } from 'pledgestack-shared';
// pledgestack-shared also exports a plain `escapeHtml` (used internally by
// og/seo/sitemap/rss/renderer-* for simple display escaping). pledgestack-core
// exports its own `escapeHtml` too, from rust-html.ts — same output, but
// dispatches to the SIMD-accelerated Rust addon when compiled, falling back to
// the same plain JS escaping otherwise. Prefer core's for the CLI's public API.
export { escapeHtml } from 'pledgestack-core';
export * from './config-loader';
export * from './tailwind';
// Re-export docker commands explicitly (core already exports generateDockerfile/generateDockerCompose)
export { generateDockerIgnore, type DockerfileOptions } from './commands/docker';
