import { describe, it, expect, vi } from 'vitest';
import { JobQueue } from './queue';

const settle = () => new Promise((r) => setTimeout(r, 30));

describe('JobQueue pruning', () => {
  it('caps retained finished jobs, dropping the oldest first', async () => {
    const q = new JobQueue<number>(1, { maxRetained: 3 });
    q.setHandler(async (j) => j.data);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await q.add(i));
    await settle();
    await settle();
    const s = q.stats();
    expect(s.completed).toBe(3);
    expect(q.get(ids[0]!)).toBeUndefined();
    expect(q.get(ids[5]!)?.status).toBe('completed');
  });

  it('drops finished jobs past retentionMs', async () => {
    vi.useFakeTimers();
    try {
      const q = new JobQueue<number>(1, { retentionMs: 1000 });
      q.setHandler(async (j) => j.data);
      const id = await q.add(1);
      await vi.advanceTimersByTimeAsync(10);
      expect(q.get(id)?.status).toBe('completed');
      vi.advanceTimersByTime(5000);
      await q.add(2); // triggers a processing pass -> prune
      await vi.advanceTimersByTimeAsync(10);
      expect(q.get(id)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
