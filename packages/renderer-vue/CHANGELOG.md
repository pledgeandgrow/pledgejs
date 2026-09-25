# pledgestack-renderer-vue

## 0.2.1

### Patch Changes

- pledgestack-shared@0.2.1

## 0.2.0

### Major Changes

- First unified release. All public PledgeStack packages are released together at one version (changesets `fixed` group) and published to npm. The package ships bundled ESM that loads in plain Node, TypeScript declarations, a README and an MIT license file.

### Patch Changes

- Server output now includes `window.__PLEDGE_ROUTE__` and the client script mounts with the server's real params (dynamic routes previously hydrated with empty props).
