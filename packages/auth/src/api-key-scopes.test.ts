import { describe, it, expect } from 'vitest';
import { ApiKeyManager } from './api-key-management';

describe('ApiKeyManager.canAccess resources/permissions scopes', () => {
  const m = new ApiKeyManager('secret');

  it('enforces resource scopes (fail-closed when the resource is not named)', () => {
    const { record } = m.create({ name: 'k', userId: 'u', scopes: { resources: ['reports'] } });
    expect(m.canAccess(record, '/api/x', 'GET', { resource: 'reports' })).toBe(true);
    expect(m.canAccess(record, '/api/x', 'GET', { resource: 'billing' })).toBe(false);
    expect(m.canAccess(record, '/api/x', 'GET')).toBe(false);
  });

  it('enforces permission scopes', () => {
    const { record } = m.create({ name: 'k', userId: 'u', scopes: { permissions: ['read'] } });
    expect(m.canAccess(record, '/a', 'GET', { permission: 'read' })).toBe(true);
    expect(m.canAccess(record, '/a', 'GET', { permission: 'write' })).toBe(false);
    expect(m.canAccess(record, '/a', 'GET')).toBe(false);
  });

  it('supports "*" and leaves unrestricted keys unchanged', () => {
    const star = m.create({ name: 'k', userId: 'u', scopes: { resources: ['*'] } }).record;
    expect(m.canAccess(star, '/a', 'GET', { resource: 'anything' })).toBe(true);
    const open = m.create({ name: 'k', userId: 'u', scopes: {} }).record;
    expect(m.canAccess(open, '/a', 'GET')).toBe(true);
  });
});
