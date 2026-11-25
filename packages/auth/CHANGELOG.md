# pledgestack-auth

## 0.2.1

### Patch Changes

- pledgestack-shared@0.2.1

## 0.2.0

### Major Changes

- First unified release. All public PledgeStack packages are released together at one version (changesets `fixed` group) and published to npm. The package ships bundled ESM that loads in plain Node, TypeScript declarations, a README and an MIT license file.

### Patch Changes

- WebAuthn: registration and authentication reject responses without the user-verified (UV) flag when `userVerification` is `required`.
- WebAuthn: `verifyRegistrationResponse` stores the real user id on the credential (new `options.userId`, falling back to the decoded `userHandle`).
