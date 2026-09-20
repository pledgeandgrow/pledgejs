import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.doUnmock('kysely');
  vi.doUnmock('pg');
  vi.doUnmock('drizzle-orm/node-postgres');
  vi.resetModules();
});

describe('database adapters', () => {
  it('kysely postgres: connect() must not tear the pool down', async () => {
    const destroy = vi.fn(async () => {});
    vi.resetModules();
    vi.doMock('kysely', () => ({
      Kysely: class { destroy = destroy; },
      PostgresDialect: class {},
      sql: () => ({ execute: async () => ({ rows: [{ one: 1 }] }) }),
    }));
    vi.doMock('pg', () => ({ Pool: class {} }));
    const { createKyselyAdapter } = await import('./database');
    const adapter = await createKyselyAdapter({ type: 'postgres', url: 'postgres://x' });
    await adapter.connect();
    expect(destroy).not.toHaveBeenCalled();
    await adapter.disconnect();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('kysely: healthCheck runs SELECT 1 through kysely\'s sql tag and reports failures', async () => {
    let fail = false;
    const execute = vi.fn(async () => {
      if (fail) throw new Error('db down');
      return { rows: [{ one: 1 }] };
    });
    vi.resetModules();
    vi.doMock('kysely', () => ({
      Kysely: class { destroy = async () => {}; },
      PostgresDialect: class {},
      sql: (strings: TemplateStringsArray) => ({ execute, text: strings.join('') }),
    }));
    vi.doMock('pg', () => ({ Pool: class {} }));
    const { createKyselyAdapter } = await import('./database');
    const adapter = await createKyselyAdapter({ type: 'postgres', url: 'postgres://x' });
    expect(await adapter.healthCheck()).toBe(true);
    fail = true;
    expect(await adapter.healthCheck()).toBe(false);
  });

  it('drizzle postgres: connect() returns the pooled client instead of leaking it', async () => {
    const release = vi.fn();
    const pool = { connect: vi.fn(async () => ({ release })), end: vi.fn(async () => {}), query: vi.fn() };
    vi.resetModules();
    vi.doMock('pg', () => ({ Pool: class { constructor() { return pool as never; } } }));
    vi.doMock('drizzle-orm/node-postgres', () => ({ drizzle: () => ({}) }));
    const { createDrizzleAdapter } = await import('./database');
    const adapter = await createDrizzleAdapter({ type: 'postgres', url: 'postgres://x' });
    await adapter.connect();
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
