export type ImageFormat = 'avif' | 'webp' | 'jpeg' | 'png';

export interface ImageProps {
  src: string;
  alt: string;
  width: number;
  height: number;
  sizes?: number[];
  sizesAttr?: string;
  quality?: number;
  formats?: ImageFormat[];
  priority?: boolean;
  loading?: 'lazy' | 'eager';
  placeholder?: 'blur' | 'empty';
  blurDataURL?: string;
  className?: string;
  style?: import('react').CSSProperties;
  fit?: 'cover' | 'contain' | 'fill';
}

const DEFAULT_SIZES = [640, 750, 828, 1080, 1200, 1920];
const DEFAULT_FORMATS: ImageFormat[] = ['avif', 'webp', 'jpeg'];

export function generateSrcSet(
  src: string,
  widths: number[],
  formats: ImageFormat[],
  quality: number,
): string {
  const entries: string[] = [];
  for (const format of formats) {
    for (const width of widths) {
      const params = new URLSearchParams({
        w: String(width),
        q: String(quality),
        f: format,
      });
      entries.push(`/_pledge/image?src=${encodeURIComponent(src)}&${params} ${width}w`);
    }
  }
  return entries.join(', ');
}

export function generateSources(
  src: string,
  widths: number[],
  formats: ImageFormat[],
  quality: number,
  sizesAttr?: string,
): Array<{ srcSet: string; type: string; sizes?: string }> {
  return formats.map((format) => ({
    srcSet: generateSrcSet(src, widths, [format], quality),
    type: `image/${format}`,
    sizes: sizesAttr,
  }));
}

export function optimizeUrl(
  src: string,
  width: number,
  options?: { quality?: number; format?: ImageFormat },
): string {
  const params = new URLSearchParams({
    src,
    w: String(width),
    q: String(options?.quality ?? 75),
    f: options?.format ?? 'webp',
  });
  return `/_pledge/image?${params}`;
}

/**
 * Quotes a value for use inside CSS `url(...)`. Escapes backslashes, quotes and
 * newlines so a hostile blurDataURL cannot terminate the url() and inject
 * further declarations.
 */
export function cssUrl(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\n\r\f]/g, ' ')
    .replace(/[()]/g, (c) => '\\' + c);
  return `url("${escaped}")`;
}

export function aspectRatioPadding(width: number, height: number): string {
  return `${(height / width) * 100}%`;
}

export { DEFAULT_SIZES, DEFAULT_FORMATS };

export interface BlurPlaceholderOptions {
  /** Width of the LQIP image (default: 20) */
  width?: number;
  /** Quality of the LQIP image (default: 10) */
  quality?: number;
  /** Blur radius in CSS pixels for the blur-up effect (default: 20) */
  blurRadius?: number;
}

/**
 * Generate a low-quality image placeholder (LQIP) URL for blur-up effect.
 * Uses PledgePack's image optimization endpoint with tiny dimensions.
 */
export function generateBlurPlaceholder(src: string, options?: BlurPlaceholderOptions): string {
  const width = options?.width ?? 20;
  const quality = options?.quality ?? 10;
  const params = new URLSearchParams({
    src,
    w: String(width),
    q: String(quality),
    f: 'jpeg',
    blur: String(options?.blurRadius ?? 20),
  });
  return `/_pledge/image?${params}`;
}

/**
 * Generate CSS for a blur-up placeholder effect.
 * Returns a style object that can be applied to the image container.
 */
export function blurPlaceholderStyle(blurDataURL: string): import('react').CSSProperties {
  return {
    background: `${cssUrl(blurDataURL)} center/cover no-repeat`,
    filter: 'blur(20px)',
    transform: 'scale(1.1)',
    transition: 'opacity 0.3s ease-out',
  };
}

/**
 * Generate a complete responsive srcset string from a source image.
 * Auto-generates widths based on the device sizes config.
 */
export function generateResponsiveSrcSet(
  src: string,
  options?: {
    widths?: number[];
    formats?: ImageFormat[];
    quality?: number;
    sizesAttr?: string;
  },
): { srcSet: string; sources: Array<{ type: string; srcSet: string; sizes?: string }> } {
  const widths = options?.widths ?? DEFAULT_SIZES;
  const formats = options?.formats ?? DEFAULT_FORMATS;
  const quality = options?.quality ?? 75;
  const sizesAttr = options?.sizesAttr;

  const sources = formats.map((format) => ({
    type: `image/${format}`,
    srcSet: generateSrcSet(src, widths, [format], quality),
    sizes: sizesAttr,
  }));

  // The top-level srcSet is the <img> fallback, which cannot carry a `type`
  // — mixing avif/webp/jpeg candidates into one srcset lets the browser pick a
  // format it may not decode. Use the last (most compatible) format only; the
  // per-format `sources` carry the rest.
  const fallbackFormat = formats[formats.length - 1];
  const srcSet = generateSrcSet(src, widths, fallbackFormat ? [fallbackFormat] : [], quality);

  return { srcSet, sources };
}

/**
 * Generate the sizes attribute for responsive images based on layout.
 *
 * - `responsive`: full width below `breakpoint`, capped at it above.
 * - `fixed`: the image renders at a fixed CSS width — pass it as `breakpoint`
 *   (e.g. `generateSizesAttr('fixed', 320)` -> `320px`). Without a width it
 *   falls back to `100vw` (never `1px`, which made browsers pick the smallest candidate).
 * - `fill`: `100vw`.
 */
export function generateSizesAttr(layout: 'responsive' | 'fixed' | 'fill', breakpoint?: number): string {
  if (layout === 'fixed') return breakpoint && breakpoint > 0 ? `${breakpoint}px` : '100vw';
  if (layout === 'fill') return '100vw';
  return `(max-width: ${breakpoint ?? 768}px) 100vw, ${breakpoint ?? 768}px`;
}
