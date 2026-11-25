# pledgestack-image

## 0.2.1

### Patch Changes

- pledgestack-shared@0.2.1

## 0.2.0

### Major Changes

- First unified release. All public PledgeStack packages are released together at one version (changesets `fixed` group) and published to npm. The package ships bundled ESM that loads in plain Node, TypeScript declarations, a README and an MIT license file.

### Patch Changes

- `generateSizesAttr('fixed')` no longer returns `1px`; `generateResponsiveSrcSet` returns a single-format fallback `srcSet`; blur placeholders are emitted as a quoted, escaped CSS `url()`.
