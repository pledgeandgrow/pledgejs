import { describe, it, expect, vi } from 'vitest';
import { resolve } from 'node:path';
import { safeResolve, isPathSafe } from './path-traversal';
import { ApiKeyRotationManager } from './api-key';
import { verifyJWT } from './jwt';

const b64 = (s: string) => Buffer.from(s).toString('base64url');

describe('verifyJWT malformed input', () => {
  it('returns null (does not throw) for non-object header/payload JSON', () => {
    for (const h of ['null', '42', '"x"', '[]']) {
      expect(verifyJWT(`${b64(h)}.${b64('{}')}.sig`, 'k')).toBeNull();
    }
    expect(verifyJWT(`${b64('{"alg":"RS256","typ":"JWT"}')}.${b64('null')}.sig`, 'k')).toBeNull();
  });
});

describe('path sandbox', () => {
  it('allows names that merely start with two dots', () => {
    const root = resolve('sandbox-root');
    expect(safeResolve(root, '..foo')).toBe(resolve(root, '..foo'));
    expect(isPathSafe(root, '..foo')).toBe(true);
  });
  it('still rejects traversal', () => {
    const root = resolve('sandbox-root');
    expect(() => safeResolve(root, '..', 'x')).toThrow();
    expect(isPathSafe(root, '../x')).toBe(false);
  });
  it.runIf(process.platform === 'win32')('rejects a path on a different drive', () => {
    expect(isPathSafe('C:\\sandbox', 'D:\\evil')).toBe(false);
    expect(() => safeResolve('C:\\sandbox', 'D:\\evil')).toThrow();
  });
});

describe('ApiKeyRotationManager.invalidate', () => {
  it('rejects the key immediately, even within the same millisecond', () => {
    vi.useFakeTimers();
    try {
      const m = new ApiKeyRotationManager({ secret: 's' });
      const k = m.createKey();
      expect(m.invalidate(k.keyId)).toBe(true);
      expect(m.validate(k.fullKey)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

import { OAuthManager } from './oauth';

describe('OAuthManager.initiateAuth redirect validation', () => {
  it('rejects backslash / control-char redirects that browsers treat as protocol-relative', () => {
    const m = new OAuthManager('secret-secret-secret');
    m.registerProvider({
      name: 'p', authorizeUrl: 'https://idp.example/auth', tokenUrl: 'https://idp.example/token',
      clientId: 'c', clientSecret: 's', redirectUri: 'https://app.example/cb', scopes: ['openid'],
    });
    expect(() => m.initiateAuth('p', '/\\evil.example')).toThrow();
    expect(() => m.initiateAuth('p', '/\t/evil.example')).toThrow();
    expect(() => m.initiateAuth('p', '/dashboard')).not.toThrow();
  });
});

import { verifyTOTP } from './totp';
describe('verifyTOTP', () => {
  it('returns false (does not throw) for multi-byte input of the right character length', () => {
    expect(verifyTOTP('JBSWY3DPEHPK3PXP', '12345é')).toBe(false);
  });
});

import { sanitizeInput } from './xss';
describe('sanitizeInput', () => {
  it('cannot be bypassed by nesting a dangerous token inside itself', () => {
    expect(sanitizeInput('jajavascript:vascript:alert(1)')).not.toMatch(/javascript:/i);
    expect(sanitizeInput('<scr<script></script>ipt>alert(1)</scr<script></script>ipt>')).not.toMatch(/<script/i);
  });
});

import { ApiKeyManager } from './api-key-management';
describe('ApiKeyManager.canAccess route scopes', () => {
  it('does not let "/api/*" match sibling paths sharing the prefix', () => {
    const m = new ApiKeyManager('secret');
    const { record } = m.create({ name: 'k', userId: 'u', scopes: { routes: ['/api/*'] } });
    expect(m.canAccess(record, '/api/users', 'GET')).toBe(true);
    expect(m.canAccess(record, '/api', 'GET')).toBe(true);
    expect(m.canAccess(record, '/apiary/secret', 'GET')).toBe(false);
  });
});

import { conditions } from './abac';
import { RBACManager } from './rbac';
describe('ABAC / RBAC hardening', () => {
  it('maxSensitivity denies unknown sensitivity labels', () => {
    const c = conditions.maxSensitivity('internal');
    expect(c({ resource: { sensitivity: 'top-secret' } } as never)).toBe(false);
    expect(c({ resource: { sensitivity: 'public' } } as never)).toBe(true);
  });
  it('ipInRange rejects malformed addresses instead of coercing them', () => {
    const c = conditions.ipInRange('10.0.0.0/8');
    expect(c({ ip: '10.1.2.3' } as never)).toBe(true);
    expect(c({ ip: '10.1.2.' } as never)).toBe(false);
    expect(c({ ip: '10.1.2.999' } as never)).toBe(false);
    expect(conditions.ipInRange('garbage')({ ip: '1.2.3.4' } as never)).toBe(false);
  });
  it('RBAC tolerates circular role inheritance', () => {
    const r = new RBACManager();
    r.defineRole({ name: 'a', inherits: 'b', permissions: ['x'] });
    r.defineRole({ name: 'b', inherits: 'a', permissions: ['y'] });
    expect(r.getRolePermissions('a').sort()).toEqual(['x', 'y']);
  });
});
