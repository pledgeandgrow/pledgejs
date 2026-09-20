# pledgestack-state

State management hooks for React: a tiny store with selectors, URL state, cross-tab sync, form state, optimistic updates, derived state, persistence (local/session storage), a global error boundary and devtools.

> Part of [PledgeStack](https://github.com/pledgeandgrow/pledgejs). Most applications only need the [`pledgestack`](https://www.npmjs.com/package/pledgestack) package, which bundles this functionality; install this package directly when composing pieces yourself.

## Install

```bash
pnpm add pledgestack-state react
```

Requires Node.js >= 20. The package is ESM-only and ships TypeScript declarations.

## Usage

```tsx
import { createStore, useStore } from 'pledgestack-state';

const counter = createStore({ initialState: { n: 0 } });

function Counter() {
  // useStore returns [selectedValue, setter]; the store also exposes getState/setState/subscribe/reset.
  const [n] = useStore(counter, (s) => s.n);
  return <button onClick={() => counter.setState((prev) => ({ n: prev.n + 1 }))}>{n}</button>;
}
```

## API

- `createStore`, `useStore`, `applySelectorUpdate`.
- `useUrlState`, `useCrossTabState`, `useFormState`, `useFormStatus`, `useOptimisticState`, `useDerived`.
- `usePersistentState`, `useSessionState`, `GlobalErrorBoundary`, `useGlobalError`, `StateDevtools`.

## License

MIT
