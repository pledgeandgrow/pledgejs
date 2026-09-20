# pledgestack-overlay

Development-time UI for PledgeStack: error overlay with structured stack frames, devtools panel (routes, cache, timings), cache inspector and a React component inspector/element picker.

> Part of [PledgeStack](https://github.com/pledgeandgrow/pledgejs). Most applications only need the [`pledgestack`](https://www.npmjs.com/package/pledgestack) package, which bundles this functionality; install this package directly when composing pieces yourself.

## Install

```bash
pnpm add -D pledgestack-overlay react react-dom
```

Requires Node.js >= 20. The package is ESM-only and ships TypeScript declarations.

## Usage

```tsx
import { ErrorOverlay, DevTools } from 'pledgestack-overlay';

export function DevShell({ error }: { error?: Error }) {
  return (
    <>
      {error && (
        <ErrorOverlay
          errors={[{ id: '1', message: error.message, stack: error.stack, timestamp: Date.now(), type: 'runtime', severity: 'error' }]}
        />
      )}
      <DevTools routes={[]} cacheEntries={[]} />
    </>
  );
}
```

## API

- `ErrorOverlay`, `DevTools`, `CacheInspector`, `ComponentInspector`, `ElementPicker`.
- `createDevtoolsMiddleware({ scriptUrl? })` — collects routes/cache entries for the devtools UI; when `scriptUrl` is given it injects that script before `</body>` (development only). Nothing is injected by default.

## Notes

Intended for development builds; do not ship it to production.

## License

MIT
