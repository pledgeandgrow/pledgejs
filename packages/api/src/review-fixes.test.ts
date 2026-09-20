import { describe, it, expect, vi } from 'vitest';
import { analyzeQuery, validateQuery } from './graphql-security';
import { sanitizeMongoQuery } from './nosql-injection';
import { handleUpload } from './upload';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('graphql-security', () => {
  it('does not treat __typename as introspection', () => {
    expect(validateQuery('{ user { id __typename } }')).toBeNull();
    expect(analyzeQuery('{ __typename }').hasIntrospection).toBe(false);
    expect(analyzeQuery('{ __schema { types { name } } }').hasIntrospection).toBe(true);
  });
  it('cannot be tricked into under-counting depth with braces inside string literals', () => {
    const q = '{ a(x: "}}}}}}}}}}") { b { c { d { e { f { g { h { i { j { k { l } } } } } } } } } } } }';
    const r = analyzeQuery(q, { maxDepth: 10 });
    expect(r.depth).toBeGreaterThan(10);
    expect(r.allowed).toBe(false);
  });
});

describe('sanitizeMongoQuery', () => {
  it('keeps scalar array elements for explicitly allowed $in', () => {
    const out = sanitizeMongoQuery({ role: { $in: ['admin', 'user'] } }, { allowedOperators: ['$in'] });
    expect(out).toEqual({ role: { $in: ['admin', 'user'] } });
  });
});

describe('handleUpload', () => {
  it('gives same-named files in one request distinct stored names', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pledge-up-'));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const fd = new FormData();
      fd.append('file', new File(['aaa'], 'note.txt', { type: 'text/plain' }));
      fd.append('file', new File(['bbb'], 'note.txt', { type: 'text/plain' }));
      const req = new Request('http://x/upload', { method: 'POST', body: fd });
      const results = await handleUpload(req, { uploadDir: dir });
      expect(new Set(results.map((r) => r.filename)).size).toBe(2);
      expect((await readdir(dir)).length).toBe(2);
    } finally {
      vi.useRealTimers();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

import { JobQueue } from './queue';
import { CronScheduler } from './cron';
import { validateRequest } from './validation';

describe('JobQueue', () => {
  it('does not run a delayed job before its delay elapses, even if another job triggers processing', async () => {
    vi.useFakeTimers();
    try {
      const q = new JobQueue<string>(5);
      const ran: string[] = [];
      q.setHandler(async (job) => { ran.push(job.data); });
      await q.add('delayed', { delay: 10_000 });
      await q.add('immediate');
      await vi.advanceTimersByTimeAsync(100);
      expect(ran).toEqual(['immediate']);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ran).toEqual(['immediate', 'delayed']);
      q.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('processes jobs queued before the handler was set once it is set', async () => {
    const q = new JobQueue<number>();
    const id = await q.add(1);
    const done = new Promise<void>((resolve) => q.setHandler(async () => { resolve(); }));
    await done;
    await new Promise((r) => setTimeout(r, 5));
    expect(q.getStatus(id)).toBe('completed');
    q.close();
  });
});

describe('CronScheduler', () => {
  it('does not reschedule after stop() is called while the handler is running', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2030, 0, 1, 0, 0, 30));
    try {
      let runs = 0;
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const cron = new CronScheduler();
      cron.register({ name: 'j', schedule: '* * * * *', handler: async () => { runs++; await gate; } });
      await vi.advanceTimersByTimeAsync(31_000); // first run starts, blocked on gate
      expect(runs).toBe(1);
      cron.stop('j');
      release();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(runs).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not busy-loop for schedules further out than the 32-bit setTimeout limit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2030, 0, 2, 0, 0, 0));
    try {
      let runs = 0;
      const cron = new CronScheduler();
      cron.register({ name: 'yearly', schedule: '0 0 1 1 *', handler: async () => { runs++; } });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runs).toBe(0);
      cron.stopAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts 7 as Sunday in day-of-week and rejects unparseable fields up front', () => {
    const cron = new CronScheduler({ autoStart: false });
    cron.register({ name: 'sun', schedule: '0 0 * * 7', handler: async () => {} });
    expect(() => cron.start('sun')).not.toThrow();
    cron.stopAll();
    cron.register({ name: 'bad', schedule: '0 0 * * SUN', handler: async () => {} });
    expect(() => cron.start('bad')).toThrow(/invalid cron/i);
  });
});

describe('validateRequest number fields', () => {
  it('rejects empty strings and non-numeric values for number fields', () => {
    const schema = { n: { type: 'number' } };
    expect(validateRequest({ n: '' }, schema).valid).toBe(false);
    expect(validateRequest({ n: '  ' }, schema).valid).toBe(false);
    expect(validateRequest({ n: true }, schema).valid).toBe(false);
    expect(validateRequest({ n: [] }, schema).valid).toBe(false);
    expect(validateRequest({ n: '42' }, schema).valid).toBe(true);
    expect(validateRequest({ n: 42 }, schema).valid).toBe(true);
  });
});

import { ConnectionPool } from './connection-pool';

describe('ConnectionPool', () => {
  const makeFactory = () => {
    let n = 0;
    return {
      created: () => n,
      factory: {
        create: async () => { await new Promise((r) => setTimeout(r, 5)); return { id: ++n }; },
        destroy: async () => {},
        validate: async () => true,
      },
    };
  };

  it('hands concurrent acquirers distinct connections and never exceeds max', async () => {
    const { factory, created } = makeFactory();
    const pool = new ConnectionPool(factory, { min: 0, max: 2, healthChecks: false, acquireTimeout: 0.05 });
    const results = await Promise.allSettled([pool.acquire(), pool.acquire(), pool.acquire()]);
    const ok = results.filter((r): r is PromiseFulfilledResult<{ id: number }> => r.status === 'fulfilled');
    expect(ok.length).toBe(2);
    expect(new Set(ok.map((r) => r.value.id)).size).toBe(2);
    expect(created()).toBe(2);
    expect(pool.getStats().inUse).toBe(2);
    for (const r of ok) await pool.release(r.value);
    await pool.drain();
  });
});
