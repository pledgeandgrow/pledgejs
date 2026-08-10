import { describe, it, expect } from 'vitest';
import { ReadonlyURLSearchParams } from './router';

describe('ReadonlyURLSearchParams', () => {
  it('get returns value for existing key', () => {
    const params = new ReadonlyURLSearchParams({ foo: 'bar', baz: 'qux' });
    expect(params.get('foo')).toBe('bar');
    expect(params.get('baz')).toBe('qux');
  });

  it('get returns null for missing key', () => {
    const params = new ReadonlyURLSearchParams({ foo: 'bar' });
    expect(params.get('missing')).toBeNull();
  });

  it('has returns true for existing key', () => {
    const params = new ReadonlyURLSearchParams({ foo: 'bar' });
    expect(params.has('foo')).toBe(true);
    expect(params.has('missing')).toBe(false);
  });

  it('getAll returns array with single value', () => {
    const params = new ReadonlyURLSearchParams({ foo: 'bar' });
    expect(params.getAll('foo')).toEqual(['bar']);
    expect(params.getAll('missing')).toEqual([]);
  });

  it('entries returns key-value pairs', () => {
    const params = new ReadonlyURLSearchParams({ a: '1', b: '2' });
    const entries = [...params.entries()];
    expect(entries).toEqual([['a', '1'], ['b', '2']]);
  });

  it('keys returns key iterator', () => {
    const params = new ReadonlyURLSearchParams({ a: '1', b: '2' });
    expect([...params.keys()]).toEqual(['a', 'b']);
  });

  it('values returns value iterator', () => {
    const params = new ReadonlyURLSearchParams({ a: '1', b: '2' });
    expect([...params.values()]).toEqual(['1', '2']);
  });

  it('forEach iterates over all entries', () => {
    const params = new ReadonlyURLSearchParams({ a: '1', b: '2' });
    const result: Record<string, string> = {};
    params.forEach((value, key) => { result[key] = value; });
    expect(result).toEqual({ a: '1', b: '2' });
  });

  it('size returns number of params', () => {
    const params = new ReadonlyURLSearchParams({ a: '1', b: '2', c: '3' });
    expect(params.size).toBe(3);
  });

  it('toString returns URL-encoded string', () => {
    const params = new ReadonlyURLSearchParams({ foo: 'bar', baz: 'qux' });
    expect(params.toString()).toBe('foo=bar&baz=qux');
  });

  it('handles empty params', () => {
    const params = new ReadonlyURLSearchParams({});
    expect(params.size).toBe(0);
    expect(params.get('anything')).toBeNull();
    expect(params.toString()).toBe('');
  });
});
