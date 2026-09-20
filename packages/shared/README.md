# pledgestack-shared

Shared types, config helpers and small runtime utilities used by every PledgeStack package: `PledgeConfig` + `defineConfig`, route/render types, the `RendererAdapter` / `BundlerAdapter` interfaces and registry, HTML escaping, crypto helpers and render-security (CSP nonce / SRI).

> Part of [PledgeStack](https://github.com/pledgeandgrow/pledgejs). Most applications only need the [`pledgestack`](https://www.npmjs.com/package/pledgestack) package, which bundles this functionality; install this package directly when composing pieces yourself.

## Install

```bash
pnpm add pledgestack-shared
```

Requires Node.js >= 20. The package is ESM-only and ships TypeScript declarations.

## Usage

```ts
import { defineConfig, escapeHtml, getRendererRegistry } from 'pledgestack-shared';

export default defineConfig({ bundler: 'vite' });
console.log(escapeHtml('<b>'));
console.log(getRendererRegistry().list());
```

## API

- `defineConfig`, `PledgeConfig`, config validation.
- `RendererAdapter`, `RendererRegistry`, `getRendererRegistry()`, `getLayoutChain()`.
- `BundlerAdapter`, `BoundedLRUMap`, transform helpers.
- `escapeHtml`, `escapeJsonForScript`, `applyScriptSecurity`, crypto helpers.

## Notes

Subpath imports (`pledgestack-shared/<module>`) are available for individual modules.

## License

MIT
