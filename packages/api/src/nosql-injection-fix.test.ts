import { describe, it, expect } from 'vitest';
import { sanitizeMongoQuery } from './nosql-injection';

describe('sanitizeMongoQuery — sensitive operators stripped by default', () => {
  it('strips $ne (the classic auth-bypass) by default', () => {
    const out = sanitizeMongoQuery({ password: { $ne: null } });
    // The $ne operator object is stripped, leaving an empty sub-object.
    expect(out).toEqual({ password: {} });
  });

  it('strips $gt/$regex/$in by default', () => {
    const out = sanitizeMongoQuery({ age: { $gt: 0 }, name: { $regex: '.*' }, role: { $in: ['admin'] } });
    expect(out).toEqual({ age: {}, name: {}, role: {} });
  });

  it('keeps plain field equality', () => {
    const out = sanitizeMongoQuery({ email: 'a@b.com', active: true });
    expect(out).toEqual({ email: 'a@b.com', active: true });
  });

  it('allows sensitive operators only when explicitly allowlisted', () => {
    const out = sanitizeMongoQuery({ age: { $gt: 18 } }, { allowedOperators: ['$gt'] });
    expect(out).toEqual({ age: { $gt: 18 } });
  });

  it('still strips dangerous operators even when allowlisted elsewhere', () => {
    const out = sanitizeMongoQuery({ $where: 'return true', age: { $gt: 1 } }, { allowedOperators: ['$gt', '$where'] });
    expect(out).toEqual({ age: { $gt: 1 } });
  });
});
