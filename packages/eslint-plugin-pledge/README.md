# pledgestack-eslint-plugin

ESLint rules for PledgeStack conventions and common security mistakes. Works with ESLint 9 flat config.

> Part of [PledgeStack](https://github.com/pledgeandgrow/pledgejs). Most applications only need the [`pledgestack`](https://www.npmjs.com/package/pledgestack) package, which bundles this functionality; install this package directly when composing pieces yourself.

## Install

```bash
pnpm add -D pledgestack-eslint-plugin eslint
```

Requires Node.js >= 20. The package is ESM-only and ships TypeScript declarations.

## Usage

```js
// eslint.config.js
import pledge from 'pledgestack-eslint-plugin';

export default [
  {
    plugins: { pledge },
    rules: {
      'pledge/no-default-export-in-page': 'error',
      'pledge/no-eval': 'error',
      'pledge/no-dangerously-set-inner-html': 'warn',
    },
  },
];
```

## API

- Conventions: `no-default-export-in-page` and `no-default-export-in-layout` (require a default export), `no-async-in-client-component`, `no-use-client-in-server`.
- Security: `no-eval`, `no-implied-eval`, `no-new-func`, `no-dangerously-set-inner-html`, `no-unsafe-fetch` (dynamic URLs), `no-secrets-in-client` (hard-coded secrets in client files).

## Notes

File-name based rules normalize Windows path separators.

## License

MIT
