/**
 * Font optimization for PledgeStack.
 *
 * PledgePack handles actual font subsetting and optimization in its asset pipeline.
 * This package provides the component and config interface that generates
 * the correct <link> preload tags and font-face declarations.
 */

export interface FontConfig {
  /** Font family name */
  family: string;
  /** Source path or Google Fonts name */
  src: string;
  /** Font weights to include (default: [400, 700]) */
  weights?: number[];
  /** Font styles to include (default: ['normal']) */
  styles?: ('normal' | 'italic')[];
  /** Font display strategy (default: 'swap') */
  display?: 'auto' | 'block' | 'swap' | 'fallback' | 'optional';
  /** Subset list (default: ['latin']) */
  subsets?: string[];
  /** Whether to preload this font (default: true) */
  preload?: boolean;
  /** Fallback font family for CLS prevention */
  fallback?: string[];
  /** Fallback font metrics for size-adjust (optional) */
  fallbackMetrics?: {
    ascent: number;
    descent: number;
    lineGap: number;
    unitsPerEm: number;
  };
}

export interface ResolvedFont {
  /** CSS font-family declaration string */
  fontFamily: string;
  /** Preload link tags */
  preloadLinks: string[];
  /** @font-face CSS declarations */
  fontFaceCSS: string;
  /** Fallback font stack */
  fallbackStack: string;
}

const GOOGLE_FONTS_BASE = 'https://fonts.googleapis.com/css2';

/**
 * Check if a font source is a Google Font (by name).
 */
function isGoogleFont(src: string): boolean {
  return !src.startsWith('/') && !src.startsWith('.') && !src.startsWith('http');
}

/**
 * Build a Google Fonts URL for the given family and options.
 */
function buildGoogleFontsUrl(config: Required<Pick<FontConfig, 'family' | 'weights' | 'styles' | 'display' | 'subsets'>>): string {
  // Google Fonts CSS2 requires the axis-tuple syntax
  // `family=Name:ital,wght@0,400;0,700;1,400` — NOT repeated `wght=`/`ital=`
  // query params (which the API ignores, silently dropping weights/styles).
  const familyName = config.family.trim().replace(/\s+/g, '+');
  const weights = [...new Set(config.weights)].sort((a, b) => a - b);
  const hasItalic = config.styles.includes('italic');
  const italValues: number[] = [];
  if (config.styles.includes('normal') || !hasItalic) italValues.push(0);
  if (hasItalic) italValues.push(1);

  const tuples: string[] = [];
  for (const ital of italValues) {
    for (const w of weights) {
      tuples.push(hasItalic ? `${ital},${w}` : `${w}`);
    }
  }

  const axis = hasItalic ? 'ital,wght' : 'wght';
  const familyParam = `${familyName}:${axis}@${tuples.join(';')}`;
  // The `:`,`@`,`;`,`,` axis characters must remain literal, so the query is
  // assembled directly rather than via URLSearchParams (which would encode them).
  return `${GOOGLE_FONTS_BASE}?family=${familyParam}&display=${config.display}`;
}

/**
 * Resolve a font configuration into preload links and font-face CSS.
 * PledgePack's asset pipeline will download, subset, and self-host the fonts at build time.
 */
export function resolveFont(config: FontConfig): ResolvedFont {
  const weights = config.weights ?? [400, 700];
  const styles = config.styles ?? ['normal'];
  const display = config.display ?? 'swap';
  const subsets = config.subsets ?? ['latin'];
  const preload = config.preload ?? true;
  const fallback = config.fallback ?? ['system-ui', 'sans-serif'];

  const fontFamily = `'${config.family}', ${fallback.join(', ')}`;
  const fallbackStack = fallback.join(', ');

  if (isGoogleFont(config.src)) {
    const url = buildGoogleFontsUrl({
      family: config.family,
      weights,
      styles,
      display,
      subsets,
    });

    const preloadLinks = preload
      ? [`<link rel="preconnect" href="https://fonts.googleapis.com">`, `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`, `<link href="${url}" rel="stylesheet">`]
      : [`<link href="${url}" rel="stylesheet">`];

    return {
      fontFamily,
      preloadLinks,
      fontFaceCSS: '',
      fallbackStack,
    };
  }

  // Local font file — generate @font-face declarations
  const fontFaceDecls: string[] = [];
  const preloadLinks: string[] = [];

  for (const weight of weights) {
    for (const style of styles) {
      const fontPath = `/_pledge/font?f=${encodeURIComponent(config.family)}&w=${weight}&s=${style}`;
      fontFaceDecls.push(`@font-face {
  font-family: '${config.family}';
  font-style: ${style};
  font-weight: ${weight};
  font-display: ${display};
  src: url('${fontPath}') format('woff2');
}`);
      if (preload && weight === weights[0] && style === 'normal') {
        preloadLinks.push(`<link rel="preload" href="${fontPath}" as="font" type="font/woff2" crossorigin>`);
      }
    }
  }

  return {
    fontFamily,
    preloadLinks,
    fontFaceCSS: fontFaceDecls.join('\n'),
    fallbackStack,
  };
}

/**
 * Generate a CSS variable name for a font family.
 */
export function fontVarName(family: string): string {
  return `--pledge-font-${family.toLowerCase().replace(/\s+/g, '-')}`;
}

export interface FallbackFontMetrics {
  ascent: number;
  descent: number;
  lineGap: number;
  unitsPerEm: number;
  /** Average character width ratio (0-1) */
  avgCharWidth?: number;
}

export interface SizeAdjustResult {
  /** CSS size-adjust percentage */
  sizeAdjust: number;
  /** Adjusted fallback font stack CSS */
  fallbackCSS: string;
  /** @font-face declaration with size-adjust */
  fontFaceCSS: string;
}

const COMMON_METRICS: Record<string, FallbackFontMetrics> = {
  'system-ui': { ascent: 905, descent: 215, lineGap: 0, unitsPerEm: 1000, avgCharWidth: 0.5 },
  'Arial': { ascent: 905, descent: 212, lineGap: 0, unitsPerEm: 1000, avgCharWidth: 0.5 },
  'Helvetica': { ascent: 928, descent: 236, lineGap: 0, unitsPerEm: 1000, avgCharWidth: 0.5 },
  'Times New Roman': { ascent: 916, descent: 215, lineGap: 0, unitsPerEm: 1000, avgCharWidth: 0.45 },
  'Georgia': { ascent: 916, descent: 215, lineGap: 0, unitsPerEm: 1000, avgCharWidth: 0.48 },
  'Courier New': { ascent: 833, descent: 300, lineGap: 0, unitsPerEm: 1000, avgCharWidth: 0.6 },
  'sans-serif': { ascent: 905, descent: 215, lineGap: 0, unitsPerEm: 1000, avgCharWidth: 0.5 },
  'serif': { ascent: 916, descent: 215, lineGap: 0, unitsPerEm: 1000, avgCharWidth: 0.47 },
  'monospace': { ascent: 833, descent: 300, lineGap: 0, unitsPerEm: 1000, avgCharWidth: 0.6 },
};

/**
 * Calculate size-adjust percentage for a fallback font to match
 * the web font's metrics, reducing CLS (Cumulative Layout Shift).
 *
 * size-adjust = (fallbackUnitsPerEm / webFontUnitsPerEm) * 100
 */
export function calculateSizeAdjust(
  webFontMetrics: FallbackFontMetrics,
  fallbackFontName: string,
): SizeAdjustResult {
  const fallbackMetrics = COMMON_METRICS[fallbackFontName] ?? COMMON_METRICS['sans-serif'];

  const sizeAdjust = (fallbackMetrics.unitsPerEm / webFontMetrics.unitsPerEm) * 100;
  const ascentAdjust = (webFontMetrics.ascent / fallbackMetrics.ascent) * 100;

  const fallbackCSS = `'${fallbackFontName}'`;
  const fontFaceCSS = `@font-face {
  font-family: '${fallbackFontName}-fallback';
  src: local('${fallbackFontName}');
  size-adjust: ${sizeAdjust.toFixed(2)}%;
  ascent-override: ${ascentAdjust.toFixed(2)}%;
  descent-override: ${((webFontMetrics.descent / fallbackMetrics.descent) * 100).toFixed(2)}%;
  line-gap-override: ${((webFontMetrics.lineGap / Math.max(fallbackMetrics.lineGap, 1)) * 100).toFixed(2)}%;
}`;

  return { sizeAdjust, fallbackCSS, fontFaceCSS };
}

/**
 * Generate optimized font-display CSS with fallback metrics.
 * Produces @font-face declarations with size-adjust to minimize CLS.
 */
export function generateOptimizedFontCSS(
  config: FontConfig,
  webFontMetrics?: FallbackFontMetrics,
): { fontFaceCSS: string; fallbackCSS: string; preloadLinks: string[] } {
  const resolved = resolveFont(config);
  const fallbackFonts = config.fallback ?? ['system-ui', 'sans-serif'];

  if (!webFontMetrics || !config.fallbackMetrics) {
    return {
      fontFaceCSS: resolved.fontFaceCSS,
      fallbackCSS: resolved.fallbackStack,
      preloadLinks: resolved.preloadLinks,
    };
  }

  const adjustedDecls: string[] = [resolved.fontFaceCSS];
  for (const fallback of fallbackFonts) {
    const adjust = calculateSizeAdjust(config.fallbackMetrics ?? webFontMetrics, fallback);
    adjustedDecls.push(adjust.fontFaceCSS);
  }

  const fallbackStack = fallbackFonts.map((f) => `'${f}-fallback'`).join(', ');

  return {
    fontFaceCSS: adjustedDecls.join('\n'),
    fallbackCSS: fallbackStack,
    preloadLinks: resolved.preloadLinks,
  };
}

/**
 * Get common font metrics for a fallback font name.
 */
export function getFontMetrics(family: string): FallbackFontMetrics | undefined {
  return COMMON_METRICS[family];
}
