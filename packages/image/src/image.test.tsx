import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  Image,
  generateSrcSet,
  generateSources,
  optimizeUrl,
  aspectRatioPadding,
  generateBlurPlaceholder,
  blurPlaceholderStyle,
  generateResponsiveSrcSet,
  generateSizesAttr,
  cssUrl,
  DEFAULT_SIZES,
  DEFAULT_FORMATS,
} from './index';

describe('generateSrcSet', () => {
  it('emits one candidate per width with the descriptor and encoded src', () => {
    const set = generateSrcSet('/img/a b.png', [320, 640], ['webp'], 80);
    const parts = set.split(', ');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe('/_pledge/image?src=%2Fimg%2Fa%20b.png&w=320&q=80&f=webp 320w');
    expect(parts[1]).toContain('w=640');
    expect(parts[1].endsWith(' 640w')).toBe(true);
  });

  it('is the cross product of formats and widths', () => {
    expect(generateSrcSet('/a.png', [1, 2, 3], ['avif', 'webp'], 75).split(', ')).toHaveLength(6);
  });

  it('never lets a hostile src break out of the query string', () => {
    const set = generateSrcSet('/a.png&w=1 evil', [100], ['jpeg'], 75);
    expect(set).toContain('src=%2Fa.png%26w%3D1%20evil');
  });
});

describe('generateSources / optimizeUrl / aspectRatioPadding', () => {
  it('generateSources builds one <source> per format with the right MIME type', () => {
    const sources = generateSources('/a.png', [100, 200], ['avif', 'webp'], 75, '100vw');
    expect(sources.map((s) => s.type)).toEqual(['image/avif', 'image/webp']);
    expect(sources[0].srcSet).toContain('f=avif');
    expect(sources[0].srcSet).not.toContain('f=webp');
    expect(sources[0].sizes).toBe('100vw');
  });

  it('optimizeUrl defaults to q=75 and webp', () => {
    expect(optimizeUrl('/a.png', 300)).toBe('/_pledge/image?src=%2Fa.png&w=300&q=75&f=webp');
    expect(optimizeUrl('/a.png', 300, { quality: 50, format: 'png' })).toContain('q=50&f=png');
  });

  it('aspectRatioPadding computes height/width as a percentage', () => {
    expect(aspectRatioPadding(200, 100)).toBe('50%');
    expect(aspectRatioPadding(1200, 630)).toBe('52.5%');
  });

  it('exposes sane defaults', () => {
    expect(DEFAULT_SIZES).toEqual([...DEFAULT_SIZES].sort((a, b) => a - b));
    expect(DEFAULT_FORMATS).toEqual(['avif', 'webp', 'jpeg']);
  });
});

describe('blur placeholder', () => {
  it('generateBlurPlaceholder requests a tiny, low-quality jpeg with a blur radius', () => {
    const url = generateBlurPlaceholder('/a.png');
    const q = new URL(url, 'http://x').searchParams;
    expect(q.get('w')).toBe('20');
    expect(q.get('q')).toBe('10');
    expect(q.get('f')).toBe('jpeg');
    expect(q.get('blur')).toBe('20');
    expect(new URL(generateBlurPlaceholder('/a.png', { width: 8, quality: 5, blurRadius: 2 }), 'http://x').searchParams.get('w')).toBe('8');
  });

  it('blurPlaceholderStyle quotes the URL so it cannot inject CSS', () => {
    const style = blurPlaceholderStyle('data:image/png;base64,AAA');
    expect(style.background).toBe('url("data:image/png;base64,AAA") center/cover no-repeat');
    const hostile = blurPlaceholderStyle('x"); background: red; foo: url("y');
    expect(String(hostile.background)).not.toContain('"); background');
    expect(cssUrl('a"b')).toBe('url("a\\"b")');
    expect(cssUrl('a\nb')).toBe('url("a b")');
  });
});

describe('generateResponsiveSrcSet', () => {
  it('produces per-format sources and a single-format (fallback) top-level srcset', () => {
    const { srcSet, sources } = generateResponsiveSrcSet('/a.png', { widths: [100, 200], formats: ['avif', 'jpeg'] });
    expect(sources.map((s) => s.type)).toEqual(['image/avif', 'image/jpeg']);
    // The top-level srcset must not mix formats.
    expect(srcSet).toContain('f=jpeg');
    expect(srcSet).not.toContain('f=avif');
    expect(srcSet.split(', ')).toHaveLength(2);
  });

  it('uses the default widths/formats when none are given', () => {
    const { sources, srcSet } = generateResponsiveSrcSet('/a.png');
    expect(sources).toHaveLength(DEFAULT_FORMATS.length);
    expect(srcSet.split(', ')).toHaveLength(DEFAULT_SIZES.length);
  });
});

describe('generateSizesAttr', () => {
  it('responsive: full width below the breakpoint, capped above', () => {
    expect(generateSizesAttr('responsive')).toBe('(max-width: 768px) 100vw, 768px');
    expect(generateSizesAttr('responsive', 1024)).toBe('(max-width: 1024px) 100vw, 1024px');
  });

  it('fill is 100vw', () => {
    expect(generateSizesAttr('fill')).toBe('100vw');
  });

  it('fixed uses the given width and never degenerates to 1px', () => {
    expect(generateSizesAttr('fixed', 320)).toBe('320px');
    expect(generateSizesAttr('fixed')).toBe('100vw');
    expect(generateSizesAttr('fixed')).not.toBe('1px');
  });
});

describe('<Image>', () => {
  it('renders a <picture> with a <source> per format and a lazy jpeg fallback <img>', () => {
    const html = renderToStaticMarkup(<Image src="/hero.png" alt="Hero" width={800} height={400} />);
    expect(html.startsWith('<picture')).toBe(true);
    expect((html.match(/<source /g) ?? []).length).toBe(3);
    expect(html).toContain('type="image/avif"');
    expect(html).toContain('alt="Hero"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('width="800"');
    expect(html).toContain('f=jpeg');
  });

  it('priority images load eagerly and are marked high fetch priority', () => {
    const html = renderToStaticMarkup(<Image src="/hero.png" alt="Hero" width={800} height={400} priority />);
    expect(html).toContain('loading="eager"');
    expect(html).toContain('fetchpriority="high"');
  });

  it('respects custom formats, sizes and quality', () => {
    const html = renderToStaticMarkup(
      <Image src="/a.png" alt="" width={100} height={100} formats={['webp']} sizes={[100, 200]} quality={40} sizesAttr="50vw" />,
    );
    expect((html.match(/<source /g) ?? []).length).toBe(1);
    expect(html).toContain('q=40');
    expect(html).toContain('sizes="50vw"');
    expect(html).toContain('200w');
  });

  it('applies a blur placeholder background safely', () => {
    const html = renderToStaticMarkup(
      <Image src="/a.png" alt="" width={10} height={10} placeholder="blur" blurDataURL={'data:image/png;base64,AAA'} />,
    );
    expect(html).toContain('data:image/png;base64,AAA');
    expect(html).toContain('center/cover');
  });

  it('escapes hostile alt text', () => {
    const html = renderToStaticMarkup(<Image src="/a.png" alt={'"><script>x</script>'} width={10} height={10} />);
    expect(html).not.toContain('<script>');
  });
});
