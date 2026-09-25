# pledgestack-server

## 0.2.1

### Patch Changes

- pledgestack-auth@0.2.1
- pledgestack-core@0.2.1
- pledgestack-rss@0.2.1
- pledgestack-shared@0.2.1
- pledgestack-sitemap@0.2.1

## 0.2.0

### Major Changes

- First unified release. All public PledgeStack packages are released together at one version (changesets `fixed` group) and published to npm. The package ships bundled ESM that loads in plain Node, TypeScript declarations, a README and an MIT license file.

### Patch Changes

- OG images: `ImageResponse` bodies are now really rendered to PNG (flexbox subset laid out to SVG, rasterized by the native addon or the optional `sharp` package). Without a rasterizer the server answers `501` with an actionable message instead of returning serialized JSX labelled `image/png`.
- Prometheus exposition output quotes and escapes label values and sanitizes metric names.
