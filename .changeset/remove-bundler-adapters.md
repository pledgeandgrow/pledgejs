---
"pledgestack": patch
---

Removed the Rollup, Turbopack, Rsbuild and Webpack bundler adapters.
PledgePack is the default bundler and Vite remains as the pure-JS fallback
for environments where the native PledgePack binary cannot be installed.
`config.bundler` now accepts only `'pledgepack' | 'vite'` — configs using
`'rollup'`, `'turbopack'`, `'rsbuild'` or `'webpack'` fail validation with a
clear error. The removed `pledgestack-bundler-{rollup,turbopack,rsbuild,webpack}`
packages are no longer published; existing releases remain on npm.
