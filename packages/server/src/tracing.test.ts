import { describe, it, expect, vi, afterEach } from 'vitest';
import { initTracing, startSpan, flushTraces, getSpans, getCurrentSpan, setSpanAttribute, runInSpanContext } from './tracing';

afterEach(() => {
  vi.unstubAllGlobals();
  initTracing({ enabled: false });
});

describe('tracing', () => {
  it('honours sampleRate for root spans (documented option was ignored)', () => {
    initTracing({ enabled: true, sampleRate: 0 });
    for (let i = 0; i < 50; i++) startSpan('root').end();
    expect(getSpans()).toHaveLength(0);

    initTracing({ enabled: true, sampleRate: 1 });
    startSpan('root').end();
    expect(getSpans()).toHaveLength(1);
  });

  it('keeps child spans of a sampled parent', () => {
    initTracing({ enabled: true, sampleRate: 1 });
    const parent = startSpan('parent');
    const child = startSpan('child', {}, parent.span);
    child.end();
    parent.end();
    expect(getSpans().map((s) => s.name)).toEqual(['child', 'parent']);
  });

  it('exports service.name as an OTLP resource attribute', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    initTracing({ enabled: true, serviceName: 'billing', exporter: 'otlp', endpoint: 'http://collector/v1/traces', attributes: { env: 'prod' } });
    startSpan('op').end();
    await flushTraces();
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    const attrs = body.resourceSpans[0].resource.attributes as Array<{ key: string; value: { stringValue: string } }>;
    expect(attrs).toContainEqual({ key: 'service.name', value: { stringValue: 'billing' } });
    expect(attrs).toContainEqual({ key: 'env', value: { stringValue: 'prod' } });
  });

  it('reports a rejected OTLP export instead of silently dropping it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    initTracing({ enabled: true, exporter: 'otlp', endpoint: 'http://collector/v1/traces' });
    startSpan('op').end();
    await flushTraces();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('bounds the in-memory span buffer', () => {
    initTracing({ enabled: true, exporter: 'none' });
    for (let i = 0; i < 12000; i++) startSpan('s').end();
    expect(getSpans().length).toBeLessThanOrEqual(10000);
  });
});

describe('tracing async context', () => {
  it('isolates the current span across interleaved async requests', async () => {
    initTracing({ enabled: true });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const seen: Record<string, string | undefined> = {};
    const request = (id: string, d1: number, d2: number) =>
      runInSpanContext(async () => {
        const { end } = startSpan(`req-${id}`);
        await sleep(d1);
        setSpanAttribute('rid', id);
        seen[`${id}-1`] = getCurrentSpan()?.name;
        await sleep(d2);
        seen[`${id}-2`] = getCurrentSpan()?.name;
        end();
      });
    await Promise.all([request('a', 5, 20), request('b', 10, 5), request('c', 1, 10)]);
    for (const id of ['a', 'b', 'c']) {
      expect(seen[`${id}-1`]).toBe(`req-${id}`);
      expect(seen[`${id}-2`]).toBe(`req-${id}`);
    }
    for (const s of getSpans()) expect(s.attributes.rid).toBe(s.name.replace('req-', ''));
  });
});
