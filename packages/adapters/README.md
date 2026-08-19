# pledgestack-adapters

Deployment adapters for PledgeStack — Cloudflare Workers, Vercel Edge, Deno Deploy, AWS Lambda, and Netlify.

## Adapters

| Platform | Import | Entry Type |
|----------|--------|------------|
| Cloudflare Workers | `pledgestack-adapters/cloudflare` | `fetch(request, env)` |
| Vercel Edge | `pledgestack-adapters/vercel` | `fetch(request)` |
| Deno Deploy | `pledgestack-adapters/deno` | `Deno.serve(handler)` |
| AWS Lambda | `pledgestack-adapters/lambda` | `handler(event)` |
| Netlify | `pledgestack-adapters/netlify` | `handler(event)` |

## Usage

### Cloudflare Workers

```typescript
import { createCloudflareAdapter } from 'pledgestack-adapters/cloudflare';

const app = createCloudflareAdapter(config);
export default { fetch: app.fetch };
```

### Vercel Edge

```typescript
import { createVercelEdgeHandler } from 'pledgestack-adapters/vercel';
export default createVercelEdgeHandler({ config });
```

### AWS Lambda

```typescript
import { createLambdaHandler } from 'pledgestack-adapters/lambda';
export const handler = createLambdaHandler({ config });
```

`createLambdaHandler` accepts both API Gateway payload format 2.0 (`HttpApi` —
what `generateSAMTemplate()` below wires up by default) and format 1.0 (REST
API / `httpMethod`+`path`), detected automatically per request.

## Edge Bundle Config

PledgePack generates edge-safe bundles. Use `createEdgeConfig(target)` to get the config:

```typescript
import { createEdgeConfig } from 'pledgestack-adapters';
const edgeConfig = createEdgeConfig('cloudflare');
// { excludeNodeBuiltins: ['fs', 'path', ...], polyfills: ['buffer', 'process'], minify: true, sourceMaps: false }
```

### Edge Bundle Options

| Option | Description | Default |
|--------|-------------|---------|
| `excludeNodeBuiltins` | Node.js modules to exclude from edge bundle | `['fs', 'path', 'os', 'child_process', ...]` |
| `polyfills` | Browser polyfills to inject | `['buffer', 'process', 'stream']` |
| `minify` | Minify the bundle | `true` |
| `sourceMaps` | Generate source maps | `false` |

## Edge Security Features

The Cloudflare adapter includes built-in edge security, configured on the same
`PledgeConfig` object you already pass to `createCloudflareAdapter` (there is
no separate second options argument — `createCloudflareAdapter(config)` takes
one):

- **Rate limiting** — token-bucket, per-IP, via `config.rateLimit`
- **Bot detection** — User-Agent heuristics, via `config.botDetection`
- **Geo restrictions** — Block or allow specific countries, via `config.geoRestriction`
- **CSP headers** — Content-Security-Policy injection at the edge (always applied)
- **KV storage** — `createKvAdapter()` for Cloudflare Workers KV as cache backend (via the `env.CACHE` binding)

```typescript
import { createCloudflareAdapter } from 'pledgestack-adapters/cloudflare';

const app = createCloudflareAdapter({
  ...config,
  rateLimit: { maxTokens: 100, refillRate: 10 },
  botDetection: true,
  geoRestriction: { mode: 'block', countries: ['XX'] },
});
export default { fetch: app.fetch };
```

## Vercel Config Generation

```typescript
import { generateVercelConfig } from 'pledgestack-adapters/vercel';
const vercelJson = generateVercelConfig(config);
// Generates vercel.json with edge functions, rewrites, headers
```
