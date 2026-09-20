import { describe, it, expect } from 'vitest';
import { ConnectionPool } from './connection-pool';

function makePool() {
  const destroyed: number[] = [];
  let n = 0;
  const pool = new ConnectionPool<number>(
    { create: async () => ++n, destroy: async (c) => { destroyed.push(c); }, validate: async () => true },
    { min: 0, max: 3, healthChecks: false },
  );
  return { pool, destroyed };
}

describe('ConnectionPool.drain', () => {
  it('waits for in-use connections to be released before resolving', async () => {
    const { pool, destroyed } = makePool();
    const busy = await pool.acquire();
    const idle = await pool.acquire();
    await pool.release(idle);

    let drained = false;
    const p = pool.drain().then(() => { drained = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(drained).toBe(false);
    expect(destroyed).toEqual([idle]); // only the idle one so far
    expect(pool.getStats().inUse).toBe(1);

    await pool.release(busy);
    await p;
    expect(drained).toBe(true);
    expect(destroyed.sort()).toEqual([busy, idle].sort());
    expect(pool.getStats().total).toBe(0);
  });

  it('force-closes stragglers after the drain timeout', async () => {
    const { pool, destroyed } = makePool();
    const busy = await pool.acquire();
    await pool.drain(30);
    expect(destroyed).toEqual([busy]);
  });
});
