# pledgestack-image

## 1.0.0-rc.0

### Major Changes

- First 1.0 release candidate. All public PledgeStack packages are now released together at one version (changesets `fixed` group) and published to npm with the `rc` dist-tag. The package ships bundled ESM that loads in plain Node, TypeScript declarations, a README and an MIT license file.

### Patch Changes

- `generateSizesAttr('fixed')` no longer returns `1px`; `generateResponsiveSrcSet` returns a single-format fallback `srcSet`; blur placeholders are emitted as a quoted, escaped CSS `url()`.
