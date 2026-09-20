# pledgestack-renderer-vue

## 1.0.0-rc.0

### Major Changes

- First 1.0 release candidate. All public PledgeStack packages are now released together at one version (changesets `fixed` group) and published to npm with the `rc` dist-tag. The package ships bundled ESM that loads in plain Node, TypeScript declarations, a README and an MIT license file.

### Patch Changes

- Server output now includes `window.__PLEDGE_ROUTE__` and the client script mounts with the server's real params (dynamic routes previously hydrated with empty props).
