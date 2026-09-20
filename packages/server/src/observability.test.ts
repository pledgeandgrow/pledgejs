import { describe, it, expect, vi, afterEach } from 'vitest';
import { logger, configureLogger, profileRequest, startProfileSpan, getCurrentProfile } from './observability';

/** Captures what the logger writes to stdout as parsed JSON lines. */
function captureStdout() {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as never);
  return { lines, restore: () => spy.mockRestore(), json: () => lines.map((l) => JSON.parse(l)) };
}

afterEach(() => {
  configureLogger({});
  vi.restoreAllMocks();
});

describe('logger', () => {
  it('serialises Error values instead of logging {}', () => {
    configureLogger({ prettyPrint: false, otelCompatible: false });
    const out = captureStdout();
    logger.info('failed', { error: new Error('boom') });
    out.restore();
    const entry = out.json()[0];
    expect(entry.error.message).toBe('boom');
    expect(entry.error.name).toBe('Error');
  });

  it('redacts secrets nested inside arrays', () => {
    configureLogger({ prettyPrint: false, otelCompatible: false });
    const out = captureStdout();
    logger.info('req', { users: [{ name: 'a', password: 'hunter2' }] });
    out.restore();
    expect(out.lines[0]).not.toContain('hunter2');
    expect(out.json()[0].users[0].name).toBe('a');
  });

  it('survives circular context objects', () => {
    configureLogger({ prettyPrint: false, otelCompatible: false });
    const out = captureStdout();
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(() => logger.info('cycle', { a })).not.toThrow();
    out.restore();
    expect(out.json()[0].message).toBe('cycle');
  });

  it('does not let context keys overwrite the message or level', () => {
    configureLogger({ prettyPrint: false, otelCompatible: false });
    const out = captureStdout();
    logger.info('the real message', { message: 'from context', level: 'debug', timestamp: 'nope' });
    out.restore();
    const entry = out.json()[0];
    expect(entry.message).toBe('the real message');
    expect(entry.level).toBe('info');
    expect(entry.timestamp).not.toBe('nope');
  });
});

describe('profileRequest', () => {
  it('measures async handlers to completion', async () => {
    configureLogger({ prettyPrint: false, otelCompatible: false });
    let seen: ReturnType<typeof getCurrentProfile> = null;
    await profileRequest('/slow', 'GET', async () => {
      seen = getCurrentProfile();
      const span = startProfileSpan('query', 'data');
      await new Promise((r) => setTimeout(r, 30));
      span.end();
    });
    // Let the completion hook run.
    await new Promise((r) => setTimeout(r, 0));
    expect(seen!.totalDuration).toBeGreaterThanOrEqual(25);
    expect(seen!.dataFetchTime).toBeGreaterThanOrEqual(25);
  });
});
