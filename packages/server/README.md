# pledgestack-server

The PledgeStack HTTP runtime: request handler pipeline (routing, middleware, CORS, CSRF, security headers, rate limiting, ETag, compression, server actions), Node and edge servers, health/metrics endpoints, OG image rendering and observability hooks.

> Part of [PledgeStack](https://github.com/pledgeandgrow/pledgejs). Most applications only need the [`pledgestack`](https://www.npmjs.com/package/pledgestack) package, which bundles this functionality; install this package directly when composing pieces yourself.

## Install

```bash
pnpm add pledgestack-server pledgestack-core pledgestack-shared
```

Requires Node.js >= 20. The package is ESM-only and ships TypeScript declarations.

## Usage

```ts
import { startNodeServer } from 'pledgestack-server';

startNodeServer({ config, port: 3000, hostname: '0.0.0.0', isDev: false });
```

## API

- `startNodeServer(options)`, `createEdgeHandler(options)`, `createRequestHandler(options)`.
- `maybeRenderOgResponse` / `tryServeOgImage` — turn `ImageResponse` bodies and `opengraph-image` routes into PNG (native addon or optional `sharp`; otherwise a clear `501`).
- `createMetricsCollector()` — Prometheus exposition (escaped labels) + JSON.
- Security: `security-headers`, `cors`, `rate-limiter`, `trusted-proxy`, DNS-rebinding guard, supply-chain SBOM.

## Notes

Install `sharp` (optional) to enable PNG rendering of Open Graph images and image optimization.

## License

MIT
