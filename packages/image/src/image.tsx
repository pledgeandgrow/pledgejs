import type { CSSProperties } from 'react';
import {
  cssUrl,
  type ImageProps,
  generateSources,
  optimizeUrl,
  DEFAULT_SIZES,
  DEFAULT_FORMATS,
} from './types';

/**
 * Image component — renders a <picture> with responsive sources.
 *
 * This is a server component by default. Use `pledge()` to make it interactive.
 * PledgePack handles the actual image optimization at the `/_pledge/image` endpoint.
 */
export function Image({
  src,
  alt,
  width,
  height,
  sizes = DEFAULT_SIZES,
  sizesAttr,
  quality = 75,
  formats = DEFAULT_FORMATS,
  priority = false,
  loading = priority ? 'eager' : 'lazy',
  placeholder = 'empty',
  blurDataURL,
  className,
  style,
  fit = 'cover',
}: ImageProps) {
  const sources = generateSources(src, sizes, formats, quality, sizesAttr);
  const fallbackSrc = optimizeUrl(src, width, { quality, format: 'jpeg' });
  const containerStyle: CSSProperties = {
    position: 'relative',
    display: 'block',
    overflow: 'hidden',
    ...style,
  };
  const imgStyle: CSSProperties = {
    width: '100%',
    height: '100%',
    objectFit: fit,
    ...(placeholder === 'blur' && blurDataURL
      ? { background: `${cssUrl(blurDataURL)} center/cover no-repeat` }
      : {}),
  };

  return (
    <picture style={containerStyle} className={className}>
      {sources.map((s) => (
        <source key={s.type} srcSet={s.srcSet} type={s.type} sizes={s.sizes} />
      ))}
      <img
        src={fallbackSrc}
        alt={alt}
        width={width}
        height={height}
        loading={loading}
        decoding="async"
        // @ts-expect-error fetchPriority is valid HTML but not in React types yet
        fetchpriority={priority ? 'high' : 'auto'}
        style={imgStyle}
      />
    </picture>
  );
}
