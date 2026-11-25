# pledgestack-renderer-react

## 0.2.1

### Patch Changes

- c23f513: Fix nested `layout.tsx` (e.g. `app/docs/layout.tsx`) dropping the root layout's
  `<head>` (inline styles, meta tags). `getLayoutChain()` returns layouts
  root-first, but the React renderer and the core render paths (SSR, streaming,
  RSC, PPR, Rust SSR, not-found) wrapped the page in that same order, so the root
  layout ended up innermost and the nested layout outermost. The root's `<html>`
  document was then nested inside the nested layout's markup and its `<head>` was
  never hoisted. Layouts are now wrapped innermost-first so the root layout is
  outermost, matching the client router and the Vue/Solid/Svelte renderers.
  - pledgestack-shared@0.2.1

## 0.2.0

### Major Changes

- First unified release. All public PledgeStack packages are released together at one version (changesets `fixed` group) and published to npm. The package ships bundled ESM that loads in plain Node, TypeScript declarations, a README and an MIT license file.
