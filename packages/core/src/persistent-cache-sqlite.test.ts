import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: string[] = [];
const rows = new Map<string, unknown>();

// Faithful subset of the better-sqlite3 API: Database has prepare()/exec()/close()
// but NO top-level run()/get()/all() — those live on prepared statements.
vi.mock('better-sqlite3', () => {
  class FakeDatabase {
    constructor(public path: string) {}
    prepare(sql: string) {
      return {
        run: (...params: unknown[]) => { calls.push(sql.trim().split(/\s+/).slice(0, 3).join(' ')); void params; return { changes: 0 }; },
        get: (...params: unknown[]) => rows.get(String(params[0])),
        all: () => [],
      };
    }
    exec(sql: string) { calls.push(sql.trim().split(/\s+/).slice(0, 3).join(' ')); }
    close() {}
  }
  return { default: FakeDatabase };
});

import { initPersistentCache, setPersistentEntry, closePersistentCache } from './persistent-cache';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('persistent cache SQLite backend', () => {
  beforeEach(() => { calls.length = 0; });

  it('actually uses the SQLite database (does not silently fall back to memory)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pledge-pc-'));
    try {
      await initPersistentCache({ dbPath: join(dir, 'nested', 'cache.db') });
      expect(calls.some((c) => c.startsWith('CREATE TABLE'))).toBe(true);
      setPersistentEntry('k', { url: 'http://x', data: 'd', status: 200, headers: {}, timestamp: Date.now(), tags: ['t'] });
      expect(calls.some((c) => c.startsWith('INSERT OR REPLACE'))).toBe(true);
    } finally {
      closePersistentCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
