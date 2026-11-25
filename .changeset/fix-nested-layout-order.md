---
"pledgestack-core": patch
"pledgestack-renderer-react": patch
---

Fix nested `layout.tsx` (e.g. `app/docs/layout.tsx`) dropping the root layout's
`<head>` (inline styles, meta tags). `getLayoutChain()` returns layouts
root-first, but the React renderer and the core render paths (SSR, streaming,
RSC, PPR, Rust SSR, not-found) wrapped the page in that same order, so the root
layout ended up innermost and the nested layout outermost. The root's `<html>`
document was then nested inside the nested layout's markup and its `<head>` was
never hoisted. Layouts are now wrapped innermost-first so the root layout is
outermost, matching the client router and the Vue/Solid/Svelte renderers.
