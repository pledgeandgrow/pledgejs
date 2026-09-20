import { describe, it, expect, vi, afterEach } from 'vitest';
import { CronScheduler } from './cron';

afterEach(() => vi.useRealTimers());

/** Runs a cron schedule under fake timers and returns the first firing instant. */
function firstFire(schedule: string, timezone: string | undefined, start: string): string {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(start));
  let fired: string | null = null;
  const c = new CronScheduler(timezone ? { timezone } : {});
  c.register({ name: 'j', schedule, handler: async () => { fired = new Date().toISOString(); c.stopAll(); } });
  vi.advanceTimersByTime(400 * 24 * 60 * 60 * 1000);
  c.stopAll();
  return fired ?? 'never';
}

describe('CronScheduler timezone', () => {
  it('defaults to UTC', () => {
    expect(firstFire('0 2 * * *', undefined, '2025-01-10T00:00:00Z')).toBe('2025-01-10T02:00:00.000Z');
  });

  it('evaluates the expression in the given timezone (winter, EST = UTC-5)', () => {
    expect(firstFire('0 2 * * *', 'America/New_York', '2025-01-10T00:00:00Z')).toBe('2025-01-10T07:00:00.000Z');
  });

  it('honors DST (summer, EDT = UTC-4)', () => {
    expect(firstFire('0 2 * * *', 'America/New_York', '2025-07-10T00:00:00Z')).toBe('2025-07-10T06:00:00.000Z');
  });

  it('handles positive offsets (Asia/Tokyo, UTC+9)', () => {
    expect(firstFire('30 9 * * *', 'Asia/Tokyo', '2025-01-10T00:00:00Z')).toBe('2025-01-10T00:30:00.000Z');
  });

  it('rejects an unknown timezone with a clear error', () => {
    expect(() => new CronScheduler({ timezone: 'Mars/Olympus' })).toThrow(/Invalid cron timezone/);
  });
});
