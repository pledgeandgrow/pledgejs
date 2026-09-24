# pledgestack-bundler-webpack

## 0.2.0

### Major Changes

- First unified release. All public PledgeStack packages are released together at one version (changesets `fixed` group) and published to npm. The package ships bundled ESM that loads in plain Node, TypeScript declarations, a README and an MIT license file.

### Patch Changes

- `reloadAll()` sends the webpack-dev-server `content-changed` message (`full-reload` is Vite-only). See docs/limitations.md for the status of HMR across bundlers.
