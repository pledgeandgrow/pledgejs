# pledgestack-deploy

One-call deployment helpers for PledgeStack builds: generates target config (`wrangler.toml`, `vercel.json`, `netlify.toml`) and drives the provider CLI (`--dry-run` supported).

> Part of [PledgeStack](https://github.com/pledgeandgrow/pledgejs). Most applications only need the [`pledgestack`](https://www.npmjs.com/package/pledgestack) package, which bundles this functionality; install this package directly when composing pieces yourself.

## Install

```bash
pnpm add pledgestack-deploy
```

Requires Node.js >= 20. The package is ESM-only and ships TypeScript declarations.

## Usage

```ts
import { deploy, detectTarget } from 'pledgestack-deploy';

const target = detectTarget(config); // 'cloudflare' | 'vercel' | 'netlify'
const result = await deploy(config, { target, dryRun: true });
console.log(result);
```

## API

- `deploy(config, options)` — builds provider config, then runs the provider CLI unless `dryRun`.
- `detectTarget(config)` — picks a target from config and project files.
- `cloudflareAdapter`, `vercelAdapter`, `netlifyAdapter`, `deployAdapters` — per-provider adapters.

## Notes

Real deploys require the provider CLI (`wrangler`, `vercel`, `netlify`) to be installed and authenticated; tests that need them are skipped when absent.

## License

MIT
