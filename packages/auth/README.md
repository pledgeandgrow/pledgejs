# pledgestack-auth

Comprehensive authentication and security suite for PledgeStack — sessions, JWT, OAuth, WebAuthn, TOTP/2FA, SAML SSO, RBAC/ABAC, CSRF, XSS, SSRF, open-redirect protection, and more.

## Table of Contents

- [Session Management](#session-management)
- [Password Hashing](#password-hashing)
- [JWT](#jwt)
- [OAuth 2.1](#oauth-21)
- [WebAuthn](#webauthn)
- [TOTP / 2FA](#totp--2fa)
- [SAML SSO](#saml-sso)
- [RBAC / ABAC](#rbac--abac)
- [API Keys](#api-keys)
- [CSRF Protection](#csrf-protection)
- [XSS Sanitization](#xss-sanitization)
- [SSRF Protection](#ssrf-protection)
- [Open Redirect Protection](#open-redirect-protection)
- [Path Traversal Protection](#path-traversal-protection)
- [Prototype Pollution Protection](#prototype-pollution-protection)
- [ReDoS Protection](#redos-protection)
- [Security Headers](#security-headers)
- [CSP](#csp)
- [CORS](#cors)
- [Audit Logging](#audit-logging)
- [Environment Validation](#environment-validation)

## Session Management

```typescript
import { SessionManager } from 'pledgestack-auth';

const auth = new SessionManager({
  secret: process.env.AUTH_SECRET!,
  cookieName: '__pledge_session',
  ttl: 7 * 24 * 60 * 60, // 7 days
});

// Create session cookie
const cookie = auth.sessionCookie({ userId: user.id, role: 'admin' });

// Verify session
const session = auth.verifyRequest(request);

// Destroy session
auth.destroySession(session);
```

## Password Hashing

```typescript
import { hashPassword, verifyPassword } from 'pledgestack-auth';

const hashed = await hashPassword('mypassword');
const valid = await verifyPassword('mypassword', hashed);
```

## JWT

```typescript
import { signJWT, verifyJWT, decodeJWT, JWKSManager } from 'pledgestack-auth';

// Sign
const token = await signJWT({ userId: '123' }, secret, { expiresIn: '1h' });

// Verify
const payload = await verifyJWT(token, secret);

// Decode (without verification)
const decoded = decodeJWT(token);

// JWKS (for OAuth/OIDC)
const jwks = new JWKSManager();
await jwks.addKey({ kty: 'RSA', key: privateKey, kid: 'key1' });
```

## OAuth 2.1

```typescript
import { createOAuthState, verifyOAuthState, generateToken } from 'pledgestack-auth';

// Generate state for OAuth flow
const state = createOAuthState('https://provider.com/auth');
// After callback:
const valid = verifyOAuthState(state, receivedState);
```

## WebAuthn

```typescript
import { generateChallenge, generateRegistrationOptions, verifyRegistrationResponse } from 'pledgestack-auth';

const challenge = generateChallenge();
const options = generateRegistrationOptions({
  challenge,
  rpName: 'My App',
  userId: '123',
  username: 'user@example.com',
});
// After browser responds:
const verified = await verifyRegistrationResponse(response, expectedChallenge);
```

## TOTP / 2FA

```typescript
import { generateTOTPSecret, verifyTOTP, generateBackupCodes } from 'pledgestack-auth';

const { secret, qrUrl } = generateTOTPSecret('user@example.com', 'My App');
const valid = verifyTOTP(token, secret);
const backupCodes = generateBackupCodes();
```

## SAML SSO

```typescript
import { generateSPMetadata, parseSAMLResponse, verifySAMLSignature } from 'pledgestack-auth';

const metadata = generateSPMetadata({
  entityId: 'https://myapp.com/saml/metadata',
  acsUrl: 'https://myapp.com/saml/acs',
});
const response = parseSAMLResponse(samlXml);
const valid = verifySAMLSignature(response, idpCertificate);
```

## RBAC / ABAC

```typescript
import { RBACManager, COMMON_ROLES, ABACEvaluator } from 'pledgestack-auth';

// RBAC
const rbac = new RBACManager();
rbac.addRole('admin', ['read', 'write', 'delete']);
rbac.addRole('user', ['read']);
rbac.assignRole(userId, 'admin');
const canDelete = rbac.checkPermission(userId, 'delete');

// ABAC
const abac = new ABACEvaluator();
abac.addPolicy({
  effect: 'allow',
  action: 'read',
  resource: 'document:*',
  condition: { 'user.department': 'engineering' },
});
```

## API Keys

```typescript
import { ApiKeyManager, ApiKeyRotationManager } from 'pledgestack-auth';

const keys = new ApiKeyManager();
const { key, hash } = await keys.createKey({ userId: '123', scopes: ['read'] });
const valid = await keys.verifyKey(key);

// Rotation
const rotator = new ApiKeyRotationManager(keys, { rotateEveryDays: 90 });
```

## CSRF Protection

Double-submit cookie pattern plus Origin/`Sec-Fetch-Site` validation as
defense-in-depth. `Sec-Fetch-Site` is only trusted when the browser actually
sends it with an explicit same-origin/same-site/none value — a request that
omits the header entirely (older browsers, non-browser HTTP clients) is
treated as *not* confirmed same-site and falls through to Origin validation,
rather than being assumed safe.

```typescript
import { generateCsrfToken, csrfCookie, validateCsrfToken, createCsrfMiddleware } from 'pledgestack-auth';

// Generate a token and its Set-Cookie header value
const token = generateCsrfToken();
const setCookieHeader = csrfCookie(token);

// Validate the double-submit pair (cookie value vs. header/body value)
const valid = validateCsrfToken(cookieToken, headerToken);

// Middleware — throws a 403 Response if validation fails.
// `allowedOrigins` is required for the Origin-validation layer to reject
// anything; without it, the double-submit cookie check above is the only
// enforced protection.
const middleware = createCsrfMiddleware({
  allowedOrigins: ['https://example.com'],
});
```

## XSS Sanitization

```typescript
import { sanitizeHtml, sanitizeText, sanitizeInput, sanitizeObject } from 'pledgestack-auth';

const clean = sanitizeHtml(userInput);
const text = sanitizeText(input);
const obj = sanitizeObject({ name: userInput, nested: { value: userInput } });
```

## SSRF Protection

```typescript
import { isSafeUrl, createSafeFetch } from 'pledgestack-auth';

// Check URL
const { safe, reason } = await isSafeUrl('http://192.168.1.1/admin');
// { safe: false, reason: 'private IP address' }

// Safe fetch wrapper
const safeFetch = createSafeFetch();
const response = await safeFetch('https://api.example.com/data');
```

## Open Redirect Protection

```typescript
import { validateRedirect, safeRedirect } from 'pledgestack-auth';

// Validate
const safe = validateRedirect('/about'); // → '/about'
const blocked = validateRedirect('http://evil.com'); // → null
const noJs = validateRedirect('javascript:alert(1)'); // → null

// Safe redirect response
const response = safeRedirect('/dashboard', 307, { origin: 'http://localhost:3000' });
```

## Path Traversal Protection

```typescript
import { containsTraversal, safeResolve, createFileSandbox } from 'pledgestack-auth';

containsTraversal('../../../etc/passwd'); // → true
const safe = safeResolve('/public', '../../etc/passwd'); // → '/public/etc/passwd'
const sandbox = createFileSandbox('/public');
const path = sandbox.resolve('images/logo.png');
```

## Prototype Pollution Protection

```typescript
import { deepSanitize, safeParse } from 'pledgestack-auth';

const clean = deepSanitize({ __proto__: { evil: true }, data: 'ok' });
const parsed = safeParse(jsonString);
```

## ReDoS Protection

```typescript
import { analyzeRegex, isSafeRegex, scanForReDoS } from 'pledgestack-auth';

const analysis = analyzeRegex(/^(a+)+$/);
isSafeRegex(/^(a+)+$/); // → false (catastrophic backtracking)
const issues = scanForReDoS(sourceCode);
```

## Security Headers

```typescript
import { generateSecurityHeaders, securityHeadersMiddleware } from 'pledgestack-auth';

const headers = generateSecurityHeaders({
  hsts: true,
  frameGuard: 'DENY',
  contentTypeNosniff: true,
});
```

## CSP

```typescript
import { generateCspHeader, cspMiddleware } from 'pledgestack-auth';

const csp = generateCspHeader({
  'default-src': ["'self'"],
  'script-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'https:'],
});
// → "default-src 'self'; script-src 'self' 'unsafe-inline'; img-src 'self' data: https:"
```

## CORS

```typescript
import { generateCorsHeaders, isPreflightRequest, corsMiddleware } from 'pledgestack-auth';

const headers = generateCorsHeaders({
  origin: 'https://example.com',
  methods: ['GET', 'POST'],
});
```

## Audit Logging

```typescript
import { AuditLogger } from 'pledgestack-auth';

const logger = new AuditLogger({ logFile: './audit.log' });
logger.log({
  action: 'login',
  userId: '123',
  ip: '192.168.1.1',
  timestamp: new Date(),
});
```

## Environment Validation

```typescript
import { validateEnv, createEnvGuard } from 'pledgestack-auth';

const result = validateEnv({
  DATABASE_URL: { required: true, type: 'string' },
  PORT: { required: false, type: 'number', default: 3000 },
});
if (!result.valid) {
  console.error('Missing env vars:', result.errors);
}
```

## Additional Exports

- `generateToken()` — Random tokens for CSRF, OAuth state
- `createOAuthState()` / `verifyOAuthState()` — OAuth flow helpers
- `requireAuth()` / `requireRole()` — Guard helpers for route handlers
- `generateTrustedTypesCSP()` / `createTrustedTypesPolicy()` — Trusted Types support
- `generateCORPHeader()` / `crossOriginMiddleware()` — Cross-Origin Resource Policy
- `generateReferrerPolicy()` / `referrerPolicyMiddleware()` — Referrer-Policy header
- `generatePermissionPolicy()` / `permissionPolicyMiddleware()` — Permissions-Policy header
