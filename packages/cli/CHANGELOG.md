# pledgestack

## 1.0.0-rc.0

### Major Changes

- First 1.0 release candidate. All public PledgeStack packages are now released together at one version (changesets `fixed` group) and published to npm with the `rc` dist-tag. The package ships bundled ESM that loads in plain Node, TypeScript declarations, a README and an MIT license file.

### Patch Changes

- `pledge init` now installs dependencies with the detected package manager (pnpm/yarn/bun/npm) and `--skip-install` skips it; a failed install no longer aborts the scaffold.
- `pledge upgrade` no longer has a dead, implicit codemod stage (the Next.js-migration codemods remain available through the explicit `pledge codemod` command); version comparison now understands prerelease tags.
