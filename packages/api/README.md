# pledgestack-api

Building blocks for PledgeStack API routes: route wrapper with middleware and rate limiting, request validation, OpenAPI generation, typed responses, uploads, cron/queue helpers and injection-safe sanitizers (SQL, NoSQL, GraphQL, JSON).

> Part of [PledgeStack](https://github.com/pledgeandgrow/pledgejs). Most applications only need the [`pledgestack`](https://www.npmjs.com/package/pledgestack) package, which bundles this functionality; install this package directly when composing pieces yourself.

## Install

```bash
pnpm add pledgestack-api
```

Requires Node.js >= 20. The package is ESM-only and ships TypeScript declarations.

## Usage

```ts
// app/api/items/route.ts
import { defineApiRoute, json, sanitizeMongoQuery } from 'pledgestack-api';

export const GET = defineApiRoute(
  async (req) => json({ items: [], filter: sanitizeMongoQuery(req.query) }),
  { rateLimit: { windowMs: 60_000, max: 100 } },
);
```

## API

- `defineApiRoute(handler, { middleware, rateLimit })` — per-route middleware chain and a fixed-window rate limiter (keyed by the trusted-proxy-resolved client IP; bounded memory).
- `json`, `html`, `text`, `csv`, `xml`, `binary`, `noContent`, `redirect`, `errorResponse` — typed response helpers (`binary` base64-encodes bodies).
- `validateRequest`, `generateOpenAPI`, `apiVersion`, `handleUpload`, `createApiMiddleware`, `composeMiddleware`.
- `sanitizeMongoQuery`, `stripOperators`, `sanitizeProjection`, `hasDangerousOperators` — strip `$where`-style operators and prototype-pollution keys (`__proto__`, `constructor`, `prototype`).
- `QueryBuilder`, `sanitizeSqlInput`, `detectSqlInjection`, GraphQL depth/complexity/introspection guards, `safeJsonParse`, `sanitizeObject`.
- `CronScheduler`, `JobQueue`, `ConnectionPool`.

## Notes

Sanitizers reduce risk but do not replace parameterized queries and schema validation.

## License

MIT
