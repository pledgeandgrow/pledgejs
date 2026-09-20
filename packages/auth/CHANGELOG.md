# pledgestack-auth

## 1.0.0-rc.0

### Major Changes

- First 1.0 release candidate. All public PledgeStack packages are now released together at one version (changesets `fixed` group) and published to npm with the `rc` dist-tag. The package ships bundled ESM that loads in plain Node, TypeScript declarations, a README and an MIT license file.

### Patch Changes

- WebAuthn: registration and authentication reject responses without the user-verified (UV) flag when `userVerification` is `required`.
- WebAuthn: `verifyRegistrationResponse` stores the real user id on the credential (new `options.userId`, falling back to the decoded `userHandle`).
