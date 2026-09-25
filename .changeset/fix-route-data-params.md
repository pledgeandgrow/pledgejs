---
"pledgestack": patch
---

Fix `window.__PLEDGE_ROUTE__` emitting empty `params` — the React renderer's
streaming, Rust-SSR, and RSC `wrapHtml` call sites never passed the matched
route's params, so client hydration rebuilt the element tree with `params: {}`
and dynamic routes rendered their not-found state after hydration. All call
sites now pass `{ params, searchParams, pattern }` like Vue/Solid/Svelte.
