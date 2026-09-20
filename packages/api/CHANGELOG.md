# pledgestack-api

## 1.0.0-rc.0

### Major Changes

- First 1.0 release candidate. All public PledgeStack packages are now released together at one version (changesets `fixed` group) and published to npm with the `rc` dist-tag. The package ships bundled ESM that loads in plain Node, TypeScript declarations, a README and an MIT license file.

### Patch Changes

- The per-route rate limiter is bounded: expired buckets are swept and a hard cap evicts the oldest keys, so a flood of distinct client keys can no longer grow memory without limit.
- NoSQL sanitizers (`sanitizeMongoQuery`, `stripOperators`, `sanitizeProjection`, `hasDangerousOperators`) drop `__proto__`, `constructor` and `prototype` keys.
