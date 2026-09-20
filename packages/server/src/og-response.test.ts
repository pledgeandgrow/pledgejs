import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { ImageResponse } from 'pledgestack-og';
import { maybeRenderOgResponse, rasterizeSvgToPng } from './og-response';
import { layoutTreeToSvg } from './og-layout';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Plain-object element trees (what JSX compiles to) so the test needs no JSX transform.
const el = (type: string, props: Record<string, unknown> = {}, children?: unknown) => ({
  type,
  props: children === undefined ? props : { ...props, children },
});

const card = () =>
  el(
    'div',
    { style: { display: 'flex', width: '100%', height: '100%', backgroundColor: '#ff0000', alignItems: 'center', justifyContent: 'center' } },
    el('div', { style: { fontSize: 60, color: '#ffffff', fontWeight: 700 } }, 'Hello OG'),
  );

const realSharp = async () => sharp;

describe('ImageResponse -> PNG rendering', () => {
  it('renders a div/flex tree to a real PNG with the requested dimensions', async () => {
    const res = new ImageResponse(card(), { width: 600, height: 315 });
    const out = await maybeRenderOgResponse(res, { native: false, loadSharp: realSharp });
    expect(out.status).toBe(200);
    expect(out.headers.get('content-type')).toBe('image/png');
    expect(out.headers.get('x-pledge-og-rendered')).toBe('true');

    const bytes = Buffer.from(await out.arrayBuffer());
    expect([...bytes.subarray(0, 8)]).toEqual(PNG_MAGIC);
    const meta = await sharp(bytes).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(600);
    expect(meta.height).toBe(315);

    // Top-left corner pixel is the red background (proves layout + raster, not a blank canvas).
    const { data } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
    expect([data[0], data[1], data[2]]).toEqual([255, 0, 0]);
  });

  it('renders SVG-rooted trees too', async () => {
    const tree = el('svg', { width: 100, height: 50 }, el('rect', { width: 100, height: 50, fill: '#00ff00' }));
    const res = new ImageResponse(tree, { width: 100, height: 50 });
    const out = await maybeRenderOgResponse(res, { native: false, loadSharp: realSharp });
    const { data } = await sharp(Buffer.from(await out.arrayBuffer())).raw().toBuffer({ resolveWithObject: true });
    expect([data[0], data[1], data[2]]).toEqual([0, 255, 0]);
  });

  it('returns a clear 501 (never serialized JSX labelled image/png) when no rasterizer exists', async () => {
    const res = new ImageResponse(card(), { width: 600, height: 315 });
    const out = await maybeRenderOgResponse(res, { native: false, loadSharp: async () => null });
    expect(out.status).toBe(501);
    expect(out.headers.get('content-type')).toContain('application/json');
    expect(out.headers.get('x-pledge-og-error')).toBe('true');
    const body = (await out.json()) as { message: string };
    expect(body.message).toMatch(/sharp/);
    expect(body.message).toMatch(/rust-og-renderer/);
  });

  it('leaves non-OG and already-rendered responses untouched', async () => {
    const plain = new Response('hi');
    expect(await maybeRenderOgResponse(plain)).toBe(plain);
    const rendered = new Response('x', { headers: { 'x-pledge-og': 'true', 'x-pledge-og-rendered': 'true' } });
    expect(await maybeRenderOgResponse(rendered)).toBe(rendered);
  });

  it('rejects absurdly deep trees with 422 instead of overflowing the stack', async () => {
    let tree: unknown = 'leaf';
    for (let i = 0; i < 400; i++) tree = el('div', {}, tree);
    const res = new Response(JSON.stringify({ element: tree, width: 100, height: 100 }), {
      headers: { 'x-pledge-og': 'true', 'x-pledge-og-rendered': 'false' },
    });
    const out = await maybeRenderOgResponse(res, { native: false, loadSharp: realSharp });
    expect(out.status).toBe(422);
  });
});

describe('rasterizeSvgToPng', () => {
  it('returns null when neither native nor sharp is available', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    expect(await rasterizeSvgToPng(svg, 10, 10, { native: false, loadSharp: async () => null })).toBeNull();
  });
});

describe('layoutTreeToSvg', () => {
  it('positions flex children: space-between row puts items at both edges', () => {
    const tree = el(
      'div',
      { style: { display: 'flex', justifyContent: 'space-between', width: 400, height: 100 } },
      [
        el('div', { style: { width: 50, height: 50, backgroundColor: '#111111' } }),
        el('div', { style: { width: 50, height: 50, backgroundColor: '#222222' } }),
      ],
    );
    const svg = layoutTreeToSvg(tree, 400, 100);
    expect(svg).toContain('<rect x="0" y="0" width="50" height="50" rx="0" fill="#111111"/>');
    expect(svg).toContain('<rect x="350" y="0" width="50" height="50" rx="0" fill="#222222"/>');
  });

  it('column direction with centered alignment', () => {
    const tree = el(
      'div',
      { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', width: 200, height: 200 } },
      el('div', { style: { width: 40, height: 20, backgroundColor: '#123456' } }),
    );
    const svg = layoutTreeToSvg(tree, 200, 200);
    expect(svg).toContain('<rect x="80" y="90" width="40" height="20"');
  });

  it('flexGrow fills the remaining space', () => {
    const tree = el(
      'div',
      { style: { display: 'flex', width: 300, height: 100 } },
      [
        el('div', { style: { width: 100, height: 100, backgroundColor: '#aaaaaa' } }),
        el('div', { style: { flexGrow: 1, height: 100, backgroundColor: '#bbbbbb' } }),
      ],
    );
    const svg = layoutTreeToSvg(tree, 300, 100);
    expect(svg).toContain('<rect x="100" y="0" width="200" height="100" rx="0" fill="#bbbbbb"/>');
  });

  it('escapes text and rejects non-data image sources', () => {
    const tree = el('div', {}, [
      el('div', {}, '<script>alert(1)</script> & "q"'),
      el('img', { src: 'file:///etc/passwd', width: 10, height: 10 }),
      el('img', { src: 'https://evil.example/x.png', width: 10, height: 10 }),
    ]);
    const svg = layoutTreeToSvg(tree, 300, 100);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).not.toContain('<image');
    expect(svg).not.toContain('etc/passwd');
  });

  it('does not emit unsafe colors', () => {
    const tree = el('div', { style: { backgroundColor: 'red" onload="x' } });
    expect(layoutTreeToSvg(tree, 10, 10)).not.toContain('onload');
  });
});
