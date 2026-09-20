# pledgestack-privacy

Privacy and compliance utilities: consent management (HMAC-signed cookies), GDPR/CCPA request handling, PII detection and masking, retention policies, field encryption and transport-security helpers.

> Part of [PledgeStack](https://github.com/pledgeandgrow/pledgejs). Most applications only need the [`pledgestack`](https://www.npmjs.com/package/pledgestack) package, which bundles this functionality; install this package directly when composing pieces yourself.

## Install

```bash
pnpm add pledgestack-privacy
```

Requires Node.js >= 20. The package is ESM-only and ships TypeScript declarations.

## Usage

```ts
import { PIIRedactor } from 'pledgestack-privacy';

const redactor = new PIIRedactor();
console.log(redactor.redactString('Contact jane@example.com'));
console.log(redactor.redactObject({ email: 'jane@example.com', password: 'hunter2' }));
```

## API

- Consent: create/verify signed consent records.
- GDPR / CCPA: export, erasure and opt-out request helpers.
- PII: `PIIRedactor` (`redactString`, `redactObject`) and `defaultRedactor`. Retention: policy evaluation. Encryption: field-level AES-GCM helpers. Transport: HTTPS/HSTS helpers.

## Notes

These helpers support compliance work; they do not make an application compliant on their own.

## License

MIT
