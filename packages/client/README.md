# pledgestack-client

Browser runtime for PledgeStack React apps: hydration, the client-side router and prefetching, `pledge()` interactive islands, form/data/offline hooks, web-vitals reporting and the dev error overlay/toolbar.

> Part of [PledgeStack](https://github.com/pledgeandgrow/pledgejs). Most applications only need the [`pledgestack`](https://www.npmjs.com/package/pledgestack) package, which bundles this functionality; install this package directly when composing pieces yourself.

## Install

```bash
pnpm add pledgestack-client react react-dom
```

Requires Node.js >= 20. The package is ESM-only and ships TypeScript declarations.

## Usage

```tsx
import { Link, useRouter } from 'pledgestack-client';

export function Nav() {
  const router = useRouter();
  return <Link href="/about" onClick={() => console.log(router.pathname)}>About</Link>; // router: { pathname, params, query, navigate, back, prefetch, ... }
}
```

## API

- Router: `RouterProvider`, `Link`, `useRouter`, `resolveRouteElement`, prefetching.
- Hydration: `hydrate`, `initPledgeHydration`, `pledge` islands, selective hydration.
- Hooks: form (`useFormStatus`-style), `useActionState`, data, optimistic, offline, web vitals.
- Dev: error overlay, fast refresh, dev toolbar.

## Notes

Most apps use these through the `pledgestack/client` entry of the main package; install this package directly only when composing PledgeStack pieces yourself.

## License

MIT
