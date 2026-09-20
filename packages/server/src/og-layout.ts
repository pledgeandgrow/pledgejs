/**
 * Minimal flexbox-to-SVG layout engine for `ImageResponse` element trees.
 *
 * `ImageResponse` (pledgestack-og) serializes a JSX tree of `div` / `span` /
 * `p` / `h1..h6` / `img` / `svg` elements. This module lays that tree out with
 * a small subset of CSS flexbox and emits an SVG document, which the OG
 * renderer then rasterizes to PNG (native addon or `sharp`).
 *
 * Supported style properties (everything is `display: flex`, like Satori):
 *   width, height (px, %), padding*, gap, flexDirection, flexGrow / flex,
 *   justifyContent, alignItems, alignSelf, backgroundColor / background (colors
 *   only), borderRadius, border (uniform width + color), opacity, color,
 *   fontSize, fontWeight, fontFamily, fontStyle, lineHeight, textAlign,
 *   letterSpacing.
 *
 * NOT supported (silently ignored): margins, positioning, gradients, box-shadow,
 * flexWrap, transforms, custom font bytes, background images. Text width is
 * estimated from average glyph metrics, so text wrapping is approximate.
 */

interface RawElement {
  type?: unknown;
  props?: Record<string, unknown>;
}

type Style = Record<string, unknown>;

interface TextProps {
  color: string;
  fontSize: number;
  fontWeight: number;
  fontFamily: string;
  fontStyle: string;
  lineHeight: number;
  textAlign: string;
  letterSpacing: number;
}

interface LNode {
  kind: 'box' | 'text' | 'img' | 'svg';
  style: Style;
  children: LNode[];
  text?: string;
  textProps: TextProps;
  src?: string;
  raw?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  lines?: string[];
}

const MAX_DEPTH = 100;
const MAX_NODES = 5000;

const DEFAULT_TEXT: TextProps = {
  color: '#000000',
  fontSize: 16,
  fontWeight: 400,
  fontFamily: 'sans-serif',
  fontStyle: 'normal',
  lineHeight: 1.2,
  textAlign: 'left',
  letterSpacing: 0,
};

/** Thrown when a tree is too large / deep to lay out safely. */
export class OgLayoutError extends Error {}

export function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------

function px(v: unknown, ref?: number): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = v.trim();
    const m = /^(-?\d+(?:\.\d+)?)(px|%)?$/.exec(t);
    if (!m) return undefined;
    const n = parseFloat(m[1]);
    if (m[2] === '%') return ref === undefined ? undefined : (ref * n) / 100;
    return n;
  }
  return undefined;
}

function sides(style: Style, prefix: 'padding'): [number, number, number, number] {
  let top = 0, right = 0, bottom = 0, left = 0;
  const all = style[prefix];
  if (typeof all === 'number') {
    top = right = bottom = left = all;
  } else if (typeof all === 'string') {
    const parts = all.trim().split(/\s+/).map((p) => px(p) ?? 0);
    if (parts.length === 1) top = right = bottom = left = parts[0];
    else if (parts.length === 2) { top = bottom = parts[0]; right = left = parts[1]; }
    else if (parts.length === 3) { top = parts[0]; right = left = parts[1]; bottom = parts[2]; }
    else if (parts.length >= 4) { [top, right, bottom, left] = parts; }
  }
  const p = (k: string, cur: number) => px(style[`${prefix}${k}`]) ?? cur;
  return [p('Top', top), p('Right', right), p('Bottom', bottom), p('Left', left)];
}

function textPropsFor(style: Style, parent: TextProps): TextProps {
  const fw = style.fontWeight;
  let weight = parent.fontWeight;
  if (typeof fw === 'number') weight = fw;
  else if (typeof fw === 'string') weight = fw === 'bold' ? 700 : fw === 'normal' ? 400 : parseInt(fw, 10) || weight;
  const fontSize = px(style.fontSize) ?? parent.fontSize;
  let lineHeight = parent.lineHeight;
  if (typeof style.lineHeight === 'number') lineHeight = style.lineHeight;
  else if (typeof style.lineHeight === 'string') {
    const lh = px(style.lineHeight);
    if (lh !== undefined) lineHeight = /px$/.test(style.lineHeight.trim()) ? lh / fontSize : lh;
  }
  return {
    color: typeof style.color === 'string' ? style.color : parent.color,
    fontSize,
    fontWeight: weight,
    fontFamily: typeof style.fontFamily === 'string' ? style.fontFamily : parent.fontFamily,
    fontStyle: typeof style.fontStyle === 'string' ? style.fontStyle : parent.fontStyle,
    lineHeight,
    textAlign: typeof style.textAlign === 'string' ? style.textAlign : parent.textAlign,
    letterSpacing: px(style.letterSpacing) ?? parent.letterSpacing,
  };
}

const SAFE_COLOR = /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%/]+\)|hsla?\([\d\s.,%/deg]+\)|[a-zA-Z]+)$/;
function safeColor(v: unknown): string | undefined {
  return typeof v === 'string' && SAFE_COLOR.test(v.trim()) ? v.trim() : undefined;
}

// ---------------------------------------------------------------------------
// Tree building
// ---------------------------------------------------------------------------

function newNode(kind: LNode['kind'], style: Style, textProps: TextProps): LNode {
  return { kind, style, children: [], textProps, x: 0, y: 0, w: 0, h: 0 };
}

function flatten(children: unknown, out: unknown[] = [], depth = 0): unknown[] {
  if (depth > MAX_DEPTH) throw new OgLayoutError('OG element tree is nested too deeply');
  if (children === null || children === undefined || typeof children === 'boolean') return out;
  if (Array.isArray(children)) {
    for (const c of children) flatten(c, out, depth + 1);
    return out;
  }
  out.push(children);
  return out;
}

function build(element: unknown, parentText: TextProps, counter: { n: number }, depth: number): LNode | null {
  if (depth > MAX_DEPTH) throw new OgLayoutError('OG element tree is nested too deeply');
  if (++counter.n > MAX_NODES) throw new OgLayoutError('OG element tree has too many nodes');

  if (typeof element === 'string' || typeof element === 'number') {
    const text = String(element);
    if (text.trim() === '' && typeof element === 'string' && text.includes('\n')) return null;
    const n = newNode('text', {}, parentText);
    n.text = text;
    return n;
  }
  if (!element || typeof element !== 'object' || Array.isArray(element)) return null;

  const el = element as RawElement;
  const type = typeof el.type === 'string' ? el.type : 'div';
  const props = el.props ?? {};
  const style = (props.style && typeof props.style === 'object' ? props.style : {}) as Style;

  if (type === 'svg') {
    const n = newNode('svg', style, parentText);
    n.raw = serializeInlineSvg(el);
    n.w = px(props.width) ?? px(style.width) ?? 0;
    n.h = px(props.height) ?? px(style.height) ?? 0;
    return n;
  }
  if (type === 'img') {
    const n = newNode('img', style, parentText);
    const src = typeof props.src === 'string' ? props.src : '';
    // Only inline data: images are allowed — remote/file URLs would let a
    // user-controlled element tree trigger SSRF / local file reads.
    n.src = /^data:image\/(png|jpe?g|gif|webp);/i.test(src) ? src : undefined;
    return n;
  }

  const tp = textPropsFor(style, parentText);
  const n = newNode('box', style, tp);
  // Headings render bold by default.
  if (/^h[1-6]$/.test(type) && style.fontWeight === undefined) n.textProps = { ...tp, fontWeight: 700 };
  for (const child of flatten(props.children)) {
    const c = build(child, n.textProps, counter, depth + 1);
    if (c) n.children.push(c);
  }
  return n;
}

function serializeInlineSvg(el: RawElement): string {
  const walk = (node: unknown, depth: number): string => {
    if (depth > MAX_DEPTH) throw new OgLayoutError('SVG is nested too deeply');
    if (node === null || node === undefined || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return esc(String(node));
    if (Array.isArray(node)) return node.map((c) => walk(c, depth + 1)).join('');
    const e = node as RawElement;
    const tag = typeof e.type === 'string' ? e.type : '';
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(tag) || /^(script|foreignObject|style|use|image)$/i.test(tag)) return '';
    const attrs: string[] = [];
    for (const [k, v] of Object.entries(e.props ?? {})) {
      if (k === 'children' || k === 'style') continue;
      if (typeof v !== 'string' && typeof v !== 'number') continue;
      const name = k === 'className' ? 'class' : k;
      if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(name) || /^on/i.test(name) || /href/i.test(name)) continue;
      attrs.push(`${name}="${esc(String(v))}"`);
    }
    return `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>${walk(e.props?.children, depth + 1)}</${tag}>`;
  };
  return walk(el, 0);
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

function glyphWidth(ch: string, fontSize: number, weight: number): number {
  const base = /[A-Z0-9MW@%]/.test(ch) ? 0.66 : /[ilj.,:;'|!()\[\] ]/.test(ch) ? 0.3 : /[mw]/.test(ch) ? 0.8 : 0.55;
  const wide = /[⺀-￿]/.test(ch) ? 1 : base;
  return wide * fontSize * (weight >= 600 ? 1.06 : 1);
}

function textWidth(text: string, tp: TextProps): number {
  let w = 0;
  for (const ch of text) w += glyphWidth(ch, tp.fontSize, tp.fontWeight) + tp.letterSpacing;
  return w;
}

function wrapText(text: string, maxW: number, tp: TextProps): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) { lines.push(''); continue; }
    let cur = '';
    for (const word of words) {
      const candidate = cur ? `${cur} ${word}` : word;
      if (cur && textWidth(candidate, tp) > maxW) {
        lines.push(cur);
        cur = word;
      } else {
        cur = candidate;
      }
    }
    lines.push(cur);
  }
  return lines;
}

function isRow(n: LNode): boolean {
  const d = n.style.flexDirection;
  return d !== 'column' && d !== 'column-reverse';
}

function grow(n: LNode): number {
  const g = n.style.flexGrow ?? n.style.flex;
  const v = typeof g === 'number' ? g : typeof g === 'string' ? parseFloat(g) : 0;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function measure(n: LNode, availW: number, availH: number, forceW?: number, forceH?: number): void {
  if (n.kind === 'text') {
    const tp = n.textProps;
    const maxW = forceW ?? availW;
    n.lines = wrapText(n.text ?? '', Math.max(maxW, tp.fontSize), tp);
    const natural = Math.max(0, ...n.lines.map((l) => textWidth(l, tp)));
    n.w = forceW ?? Math.min(natural, maxW);
    n.h = forceH ?? n.lines.length * tp.fontSize * tp.lineHeight;
    return;
  }
  if (n.kind === 'svg') {
    n.w = forceW ?? n.w;
    n.h = forceH ?? n.h;
    return;
  }
  if (n.kind === 'img') {
    n.w = forceW ?? px(n.style.width, availW) ?? 0;
    n.h = forceH ?? px(n.style.height, availH) ?? n.w;
    return;
  }

  const [pt, pr, pb, pl] = sides(n.style, 'padding');
  const padH = pl + pr;
  const padV = pt + pb;
  const explicitW = forceW ?? px(n.style.width, availW);
  const explicitH = forceH ?? px(n.style.height, availH);
  const innerW = (explicitW ?? availW) - padH;
  const innerH = (explicitH ?? availH) - padV;
  const row = isRow(n);
  const gap = px(n.style.gap) ?? 0;
  const kids = n.children;

  for (const c of kids) measure(c, Math.max(innerW, 0), Math.max(innerH, 0));

  const mainOf = (c: LNode) => (row ? c.w : c.h);
  const crossOf = (c: LNode) => (row ? c.h : c.w);
  const totalGap = gap * Math.max(kids.length - 1, 0);
  const fixedMain = row ? explicitW : explicitH;
  const innerMain = fixedMain !== undefined ? fixedMain - (row ? padH : padV) : undefined;

  // Flex-grow: distribute leftover main-axis space.
  if (innerMain !== undefined) {
    const used = kids.reduce((s, c) => s + mainOf(c), 0) + totalGap;
    const free = innerMain - used;
    const totalGrow = kids.reduce((s, c) => s + grow(c), 0);
    if (free > 0 && totalGrow > 0) {
      for (const c of kids) {
        const g = grow(c);
        if (g > 0) {
          const target = mainOf(c) + (free * g) / totalGrow;
          if (row) measure(c, innerW, innerH, target, undefined);
          else measure(c, innerW, innerH, undefined, target);
        }
      }
    }
  }

  const naturalMain = kids.reduce((s, c) => s + mainOf(c), 0) + totalGap;
  const naturalCross = Math.max(0, ...kids.map(crossOf));
  const finalW = explicitW ?? ((row ? naturalMain : naturalCross) + padH);
  const finalH = explicitH ?? ((row ? naturalCross : naturalMain) + padV);
  n.w = finalW;
  n.h = finalH;

  const innerCross = (row ? finalH - padV : finalW - padH);
  const innerMainFinal = (row ? finalW - padH : finalH - padV);
  const align = typeof n.style.alignItems === 'string' ? n.style.alignItems : 'stretch';

  // Cross-axis stretch: re-measure children that have no explicit cross size.
  for (const c of kids) {
    const self = typeof c.style.alignSelf === 'string' ? c.style.alignSelf : align;
    const explicitCross = row ? c.style.height : c.style.width;
    if (self === 'stretch' && explicitCross === undefined && c.kind === 'box') {
      if (row) measure(c, innerW, innerH, c.w, innerCross);
      else measure(c, innerW, innerH, innerCross, c.h);
    }
  }

  // Positioning along the main axis.
  const used = kids.reduce((s, c) => s + mainOf(c), 0) + totalGap;
  const free = Math.max(innerMainFinal - used, 0);
  const justify = typeof n.style.justifyContent === 'string' ? n.style.justifyContent : 'flex-start';
  let cursor = 0;
  let between = gap;
  if (justify === 'center') cursor = free / 2;
  else if (justify === 'flex-end' || justify === 'end') cursor = free;
  else if (justify === 'space-between' && kids.length > 1) between = gap + free / (kids.length - 1);
  else if (justify === 'space-around' && kids.length > 0) { const s = free / kids.length; cursor = s / 2; between = gap + s; }
  else if (justify === 'space-evenly' && kids.length > 0) { const s = free / (kids.length + 1); cursor = s; between = gap + s; }

  for (const c of kids) {
    const self = typeof c.style.alignSelf === 'string' ? c.style.alignSelf : align;
    const cs = crossOf(c);
    let crossOff = 0;
    if (self === 'center') crossOff = (innerCross - cs) / 2;
    else if (self === 'flex-end' || self === 'end') crossOff = innerCross - cs;
    const mainOff = cursor;
    c.x = pl + (row ? mainOff : crossOff);
    c.y = pt + (row ? crossOff : mainOff);
    cursor += mainOf(c) + between;
  }
}

// ---------------------------------------------------------------------------
// SVG emission
// ---------------------------------------------------------------------------

function emit(n: LNode, ox: number, oy: number, out: string[], depth = 0): void {
  const x = ox + n.x;
  const y = oy + n.y;

  if (n.kind === 'text') {
    const tp = n.textProps;
    const lh = tp.fontSize * tp.lineHeight;
    const anchor = tp.textAlign === 'center' ? 'middle' : tp.textAlign === 'right' || tp.textAlign === 'end' ? 'end' : 'start';
    const tx = anchor === 'middle' ? x + n.w / 2 : anchor === 'end' ? x + n.w : x;
    const color = safeColor(tp.color) ?? '#000000';
    const family = esc(tp.fontFamily.replace(/[^\w\s,'"-]/g, ''));
    (n.lines ?? []).forEach((line, i) => {
      if (!line) return;
      const baseline = y + i * lh + (lh - tp.fontSize) / 2 + tp.fontSize * 0.8;
      out.push(
        `<text x="${tx.toFixed(2)}" y="${baseline.toFixed(2)}" font-family="${family}" font-size="${tp.fontSize}" ` +
        `font-weight="${tp.fontWeight}" font-style="${esc(tp.fontStyle)}" fill="${esc(color)}" text-anchor="${anchor}"` +
        `${tp.letterSpacing ? ` letter-spacing="${tp.letterSpacing}"` : ''} xml:space="preserve">${esc(line)}</text>`,
      );
    });
    return;
  }
  if (n.kind === 'img') {
    if (n.src) out.push(`<image x="${x}" y="${y}" width="${n.w}" height="${n.h}" href="${esc(n.src)}"/>`);
    return;
  }
  if (n.kind === 'svg') {
    out.push(`<g transform="translate(${x} ${y})">${n.raw ?? ''}</g>`);
    return;
  }

  const bg = safeColor(n.style.backgroundColor) ?? safeColor(n.style.background);
  const radius = px(n.style.borderRadius) ?? 0;
  const opacity = typeof n.style.opacity === 'number' ? n.style.opacity : 1;
  const bw = px(n.style.borderWidth) ?? 0;
  const bc = safeColor(n.style.borderColor);
  const open = opacity < 1 ? `<g opacity="${opacity}">` : '';
  if (open) out.push(open);
  if (bg) out.push(`<rect x="${x}" y="${y}" width="${n.w}" height="${n.h}" rx="${radius}" fill="${esc(bg)}"/>`);
  if (bw > 0 && bc) {
    out.push(
      `<rect x="${x + bw / 2}" y="${y + bw / 2}" width="${Math.max(n.w - bw, 0)}" height="${Math.max(n.h - bw, 0)}" ` +
      `rx="${radius}" fill="none" stroke="${esc(bc)}" stroke-width="${bw}"/>`,
    );
  }
  for (const c of n.children) emit(c, x, y, out, depth + 1);
  if (open) out.push('</g>');
}

/**
 * Lays out a serialized ImageResponse element tree and returns an SVG string
 * of exactly `width` x `height` pixels.
 */
export function layoutTreeToSvg(element: unknown, width: number, height: number): string {
  const counter = { n: 0 };
  // A fragment/array at the root (or a component returning one) becomes a plain container.
  const rootElement = Array.isArray(element) ? { type: 'div', props: { children: element } } : element;
  const root = build(rootElement, DEFAULT_TEXT, counter, 0);
  if (!root) throw new OgLayoutError('OG element tree is empty');
  measure(root, width, height, width, height);
  root.x = 0;
  root.y = 0;
  const parts: string[] = [];
  emit(root, 0, 0, parts);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    parts.join('') +
    '</svg>'
  );
}
