---
"pledgestack": patch
"create-pledge-app": patch
---

Fix the `pledge` scaffold template being unusable: its generated
`pledge.config.ts` sets `framework: 'pledge'` (the full-stack React + Rust
backend mode that PledgePack's adapter-pledgestack keys off to scan
`server/api/*.rs`), but `validateConfig` rejected the value, `initRenderer`
crashed on `registry.setDefault('pledge')`, and the RSC path was gated on
`=== 'react'`. `'pledge'` is now a valid config framework and resolves the
React renderer adapter; `pledge storybook` treats it as React too.

Fix `pledge create` doing nothing: it spawned `create-pledge-app`'s library
entry (`dist/index.js`, which only exports `createApp` — never calls it)
instead of its bin entry, so it exited 0 without scaffolding. It now runs
`bin/create-pledge-app.js`, `create-pledge-app` is a real dependency of the
`pledgestack` package so the command works outside the monorepo, and
`--install`/`--no-install` are forwarded (`--no-install` previously crashed
with ERR_PARSE_ARGS_UNKNOWN_OPTION).

Fix dev servers serving stale SSR output after file edits: `startNodeServer`
now watches the project root in dev and calls the request handler's
`invalidate()` (previously unreachable dead code), so page/layout/API edits
are picked up on the next request instead of requiring a restart.

Add missing React `key` props to list renders in the `default`, `pledge`,
`dashboard`, and `ecommerce` templates (they logged "unique key prop"
warnings in dev).
