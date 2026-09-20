import { describe, it, expect } from 'vitest';
import { ImageResponse, ogMetaTags } from './index';

const el = (type: string, props: Record<string, unknown> = {}, children?: unknown) => ({
  type,
  props: children === undefined ? props : { ...props, children },
});

describe('ImageResponse', () => {
  it('is a Response carrying the serialized element tree and rendering markers', async () => {
    const res = new ImageResponse(el('div', { style: { fontSize: 60 } }, 'Hello'), { width: 800, height: 400 });
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-pledge-og')).toBe('true');
    // Un-rendered until the server rasterizes it — the body is JSON, not PNG bytes.
    expect(res.headers.get('x-pledge-og-rendered')).toBe('false');
    expect(res.headers.get('x-pledge-og-width')).toBe('800');
    expect(res.headers.get('x-pledge-og-height')).toBe('400');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');

    const body = JSON.parse(await res.text());
    expect(body.width).toBe(800);
    expect(body.height).toBe(400);
    expect(body.element).toEqual({ type: 'div', props: { style: { fontSize: 60 }, children: 'Hello' } });
  });

  it('defaults to 1200x630 with a one-day cache TTL', () => {
    const res = new ImageResponse(el('div'));
    expect(res.headers.get('x-pledge-og-width')).toBe('1200');
    expect(res.headers.get('x-pledge-og-height')).toBe('630');
    expect(res.headers.get('cache-control')).toContain('max-age=86400');
    expect(res.headers.get('cache-control')).toContain('s-maxage=86400');
  });

  it('honours status, cacheTtl and extra headers', () => {
    const res = new ImageResponse(el('div'), { status: 201, cacheTtl: 60, headers: { 'X-Custom': '1' } });
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toContain('max-age=60');
    expect(res.headers.get('x-custom')).toBe('1');
  });

  it('serializes nested children, arrays and numbers; drops functions', async () => {
    const tree = el('div', { onClick: () => {}, id: 'root' }, [
      el('span', {}, 'a'),
      el('p', {}, 42),
      null,
      'text',
    ]);
    const body = JSON.parse(await new ImageResponse(tree).text());
    expect(body.element.props.id).toBe('root');
    expect(body.element.props.onClick).toBeUndefined();
    expect(body.element.props.children).toEqual([
      { type: 'span', props: { children: 'a' } },
      { type: 'p', props: { children: 42 } },
      null,
      'text',
    ]);
  });

  it('expands function components by calling them with their props', async () => {
    const Card = (props: { title: string }) => el('div', { style: { color: 'red' } }, props.title);
    const body = JSON.parse(await new ImageResponse({ type: Card, props: { title: 'Hi' } }).text());
    expect(body.element).toEqual({ type: 'div', props: { style: { color: 'red' }, children: 'Hi' } });
  });

  it('flattens fragments (symbol types) into their children', async () => {
    const Fragment = Symbol.for('react.fragment');
    const tree = el('div', {}, { type: Fragment, props: { children: [el('b', {}, 'x'), el('i', {}, 'y')] } });
    const body = JSON.parse(await new ImageResponse(tree).text());
    expect(body.element.props.children).toEqual([
      { type: 'b', props: { children: 'x' } },
      { type: 'i', props: { children: 'y' } },
    ]);
  });

  it('a throwing component degrades to an empty box instead of failing the image', async () => {
    const Boom = () => { throw new Error('no hooks here'); };
    const body = JSON.parse(await new ImageResponse({ type: Boom, props: {} }).text());
    expect(body.element).toEqual({ type: 'div', props: {} });
  });

  it('caps recursion depth for pathological trees instead of overflowing the stack', async () => {
    let tree: unknown = 'leaf';
    for (let i = 0; i < 500; i++) tree = el('div', {}, tree);
    const res = new ImageResponse(tree);
    expect(await res.text()).toContain('[max depth exceeded]');
  });

  it('records the fonts requested (name/weight/style) without their bytes', async () => {
    const res = new ImageResponse(el('div'), { fonts: [{ name: 'Inter', data: new ArrayBuffer(8), weight: 700 }] });
    const body = JSON.parse(await res.text());
    expect(body.fonts).toEqual([{ name: 'Inter', weight: 700, style: 'normal' }]);
  });
});

describe('ogMetaTags', () => {
  it('always emits og:title, og:type and the twitter card defaults', () => {
    const tags = ogMetaTags({ title: 'Hello' });
    expect(tags).toContain('<meta property="og:title" content="Hello">');
    expect(tags).toContain('<meta property="og:type" content="website">');
    expect(tags).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(tags).toContain('<meta name="twitter:title" content="Hello">');
  });

  it('adds image tags with dimensions and mirrors them for Twitter', () => {
    const tags = ogMetaTags({ title: 't', image: 'https://x.test/og.png', twitterCard: 'summary' });
    expect(tags).toContain('<meta property="og:image" content="https://x.test/og.png">');
    expect(tags).toContain('<meta property="og:image:width" content="1200">');
    expect(tags).toContain('<meta property="og:image:height" content="630">');
    expect(tags).toContain('<meta name="twitter:image" content="https://x.test/og.png">');
    expect(tags).toContain('<meta name="twitter:card" content="summary">');
  });

  it('includes optional description, url and site name only when given', () => {
    const minimal = ogMetaTags({ title: 't' }).join('');
    expect(minimal).not.toContain('og:description');
    expect(minimal).not.toContain('og:url');
    const full = ogMetaTags({ title: 't', description: 'd', url: 'https://x.test/', siteName: 'S' }).join('');
    expect(full).toContain('og:description');
    expect(full).toContain('twitter:description');
    expect(full).toContain('og:url');
    expect(full).toContain('og:site_name');
  });

  it('escapes hostile values so attributes cannot be broken out of', () => {
    const tags = ogMetaTags({ title: '"><script>alert(1)</script>', description: "a'b\"c" }).join('');
    expect(tags).not.toContain('<script>');
    expect(tags).toContain('&lt;script&gt;');
    expect(tags).not.toContain('content=""><');
  });
});

describe('ImageResponse boolean children', () => {
  it('drops booleans instead of rendering "false"', async () => {
    const { ImageResponse } = await import('./index');
    const res = new ImageResponse({ type: 'div', props: { children: [false, 'hi', true] } });
    const body = JSON.parse(await res.text());
    expect(body.element.props.children).toEqual([null, 'hi', null]);
  });
});
