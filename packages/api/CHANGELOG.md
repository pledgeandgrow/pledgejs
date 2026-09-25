# pledgestack-api

## 0.2.1

### Patch Changes

- pledgestack-shared@0.2.1

## 0.2.0

### Major Changes

- First unified release. All public PledgeStack packages are released together at one version (changesets `fixed` group) and published to npm. The package ships bundled ESM that loads in plain Node, TypeScript declarations, a README and an MIT license file.

### Patch Changes

- The per-route rate limiter is bounded: expired buckets are swept and a hard cap evicts the oldest keys, so a flood of distinct client keys can no longer grow memory without limit.
- NoSQL sanitizers (`sanitizeMongoQuery`, `stripOperators`, `sanitizeProjection`, `hasDangerousOperators`) drop `__proto__`, `constructor` and `prototype` keys.
