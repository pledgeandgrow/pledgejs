# pledgestack-core

The framework core: file-system route scanning and resolution, route tree and matching, SSR/SSG/RSC/PPR rendering pipeline, caches (fetch, ISR, persistent, remote), deployment helpers and the PSX (Rust + TSX) toolchain.

> Part of [PledgeStack](https://github.com/pledgeandgrow/pledgejs). Most applications only need the [`pledgestack`](https://www.npmjs.com/package/pledgestack) package, which bundles this functionality; install this package directly when composing pieces yourself.

## Install

```bash
pnpm add pledgestack-core pledgestack-shared react react-dom
```

Requires Node.js >= 20. The package is ESM-only and ships TypeScript declarations.

## Usage

```ts
import { scanAppDir, resolveRoutes, matchRoute } from 'pledgestack-core';
import type { PledgeConfig } from 'pledgestack-shared';

declare const config: PledgeConfig;
const files = await scanAppDir('app');
const routes = resolveRoutes(files, config);
const match = matchRoute('/blog/hello', routes); // RouteMatch | null
```

## API

- Entries: `pledgestack-core` (everything), `/router`, `/render`, `/fs`.
- Routing: `scanAppDir`, `resolveRoutes`, `matchRoute`, `detectRouteConflicts`, route types generation.
- Rendering: streaming SSR, RSC flight payloads, PPR shells, static export, ISR cache (`revalidatePath`), OG image SVG rendering.
- PSX integrations: SQLx, Redis, auth, crypto, jobs, cron, email, HTTP, WebSocket, tracing, Sea-ORM and ML wrappers with JS fallbacks (see docs/limitations.md).

## Notes

Native Rust addons are optional and are not shipped in the npm package; every native path has a JavaScript fallback or fails with an actionable error. `SeaOrmDatabase` and `MlModel` require a user-supplied `driver` / `executor`.

## License

MIT
