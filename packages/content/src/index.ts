/**
 * Content Collections — type-safe markdown/MDX with schema validation and query API.
 *
 * Inspired by Astro Content Collections. Define a collection with a Zod-like
 * schema (lightweight, zero-dependency), then query entries with full type
 * inference. Frontmatter is validated at load time — invalid entries are
 * rejected with a clear error pointing to the file.
 *
 * Usage in pledge.config.ts:
 * ```typescript
 * import { contentPlugin } from 'pledgestack-content';
 *
 * export default defineConfig({
 *   plugins: [contentPlugin({
 *     collections: {
 *       blog: {
 *         directory: 'content/blog',
 *         schema: {
 *           title: 'string',
 *           date: 'date',
 *           tags: 'array',
 *           draft: 'boolean?',
 *         },
 *       },
 *     },
 *   })],
 * });
 * ```
 *
 * Usage in a page:
 * ```typescript
 * import { getCollection } from 'pledgestack-content';
 *
 * const posts = await getCollection('blog');
 * const published = posts.filter(p => !p.data.draft);
 * ```
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { PledgePlugin } from 'pledgestack-shared';

// ---------------------------------------------------------------------------
// Schema Types
// ---------------------------------------------------------------------------

export type SchemaType = 'string' | 'number' | 'boolean' | 'date' | 'array' | 'object';

export type SchemaField = SchemaType | `${SchemaType}?`;

export type SchemaDefinition = Record<string, SchemaField>;

export type InferFieldType<F extends SchemaField> =
  F extends `${infer T}?` ?
    T extends SchemaType ?
      T extends 'string' ? string | undefined :
      T extends 'number' ? number | undefined :
      T extends 'boolean' ? boolean | undefined :
      T extends 'date' ? Date | undefined :
      T extends 'array' ? unknown[] | undefined :
      T extends 'object' ? Record<string, unknown> | undefined :
      unknown | undefined :
    unknown | undefined :
  F extends 'string' ? string :
  F extends 'number' ? number :
  F extends 'boolean' ? boolean :
  F extends 'date' ? Date :
  F extends 'array' ? unknown[] :
  F extends 'object' ? Record<string, unknown> :
  unknown;

export type InferSchema<S extends SchemaDefinition> = {
  [K in keyof S]: InferFieldType<S[K]>;
};

export interface CollectionConfig<S extends SchemaDefinition = SchemaDefinition> {
  /** Directory containing content files (relative to project root) */
  directory: string;
  /** Schema definition for frontmatter validation */
  schema: S;
  /** File extensions to include (default: ['.md', '.mdx']) */
  extensions?: string[];
  /** Whether to include subdirectories (default: true) */
  recursive?: boolean;
}

export interface ContentEntry<S extends SchemaDefinition = SchemaDefinition> {
  /** Unique id (file path without extension, relative to collection directory) */
  id: string;
  /** Validated frontmatter data */
  data: InferSchema<S>;
  /** Raw markdown/MDX body (after frontmatter) */
  body: string;
  /** Compiled HTML body (lazy-computed on first access via renderBody) */
  renderedBody?: string;
  /** Absolute file path */
  filePath: string;
  /** URL-safe slug derived from the id */
  slug: string;
}

// ---------------------------------------------------------------------------
// Markdown → HTML Renderer (lightweight, zero-dependency)
// ---------------------------------------------------------------------------

/**
 * Lightweight markdown-to-HTML converter. Supports the common subset:
 * headings, bold, italic, code blocks, inline code, links, images,
 * lists, blockquotes, and horizontal rules. Not a full CommonMark parser
 * — for complex markdown, provide a custom `renderBody` function.
 */
export function renderMarkdown(md: string): string {
  const lines = md.split(/\r?\n/);
  const html: string[] = [];
  let inCodeBlock = false;
  let codeLang = '';
  let codeLines: string[] = [];
  let inList = false;
  let listType: 'ul' | 'ol' = 'ul';

  function flushList() {
    if (inList) {
      html.push(`</${listType}>`);
      inList = false;
    }
  }

  function flushCode() {
    if (inCodeBlock) {
      html.push(`<pre><code class="language-${codeLang}">${escapeHtml(codeLines.join('\n'))}</code></pre>`);
      inCodeBlock = false;
      codeLines = [];
      codeLang = '';
    }
  }

  for (const line of lines) {
    // Code block fence
    if (line.match(/^```/)) {
      if (inCodeBlock) {
        flushCode();
      } else {
        flushList();
        inCodeBlock = true;
        codeLang = line.replace(/^```/, '').trim();
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // Skip empty lines (but flush lists)
    if (!line.trim()) {
      flushList();
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushList();
      const level = headingMatch[1].length;
      html.push(`<h${level}>${inlineMd(headingMatch[2])}</h${level}>`);
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      flushList();
      html.push(`<blockquote>${inlineMd(line.slice(2))}</blockquote>`);
      continue;
    }

    // Horizontal rule
    if (line.match(/^---+\s*$/)) {
      flushList();
      html.push('<hr/>');
      continue;
    }

    // Unordered list
    if (line.match(/^[-*]\s+/)) {
      if (!inList || listType !== 'ul') {
        flushList();
        inList = true;
        listType = 'ul';
        html.push('<ul>');
      }
      html.push(`<li>${inlineMd(line.replace(/^[-*]\s+/, ''))}</li>`);
      continue;
    }

    // Ordered list
    if (line.match(/^\d+\.\s+/)) {
      if (!inList || listType !== 'ol') {
        flushList();
        inList = true;
        listType = 'ol';
        html.push('<ol>');
      }
      html.push(`<li>${inlineMd(line.replace(/^\d+\.\s+/, ''))}</li>`);
      continue;
    }

    // Regular paragraph
    flushList();
    html.push(`<p>${inlineMd(line)}</p>`);
  }

  flushList();
  flushCode();

  return html.join('\n');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"');
}

function inlineMd(s: string): string {
  let result = s;
  // Inline code
  result = result.replace(/`([^`]+)`/g, (_, code) => `<code>${escapeHtml(code)}</code>`);
  // Bold
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic
  result = result.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Images
  result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1"/>');
  // Links
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return result;
}

// ---------------------------------------------------------------------------
// MDX Compiler (first-party, lightweight)
// ---------------------------------------------------------------------------

/**
 * Component registry for MDX compilation. Maps component names to
 * render functions that produce HTML strings.
 *
 * @example
 * registerMdxComponents({
 *   Callout: ({ children, type }) => `<div class="callout ${type}">${children}</div>`,
 *   YouTube: ({ id }) => `<iframe src="https://youtube.com/embed/${id}"></iframe>`,
 * });
 */
export type MdxComponentProps = Record<string, unknown>;
export type MdxComponentFn = (props: MdxComponentProps, children: string) => string;

const mdxComponents = new Map<string, MdxComponentFn>();

/**
 * Register custom components available in MDX files. Components not
 * registered here render as a `<div data-component="Name">` placeholder
 * with their props serialized as data attributes.
 */
export function registerMdxComponents(components: Record<string, MdxComponentFn>): void {
  for (const [name, fn] of Object.entries(components)) {
    mdxComponents.set(name, fn);
  }
}

/**
 * Compiles MDX (Markdown + JSX) to HTML.
 *
 * This is a lightweight first-party MDX compiler. It:
 * - Strips import/export statements (ES module syntax)
 * - Extracts JSX elements (self-closing and with children)
 * - Renders markdown segments with `renderMarkdown`
 * - Renders JSX elements using registered components or fallback placeholders
 *
 * For full MDX compatibility (remark/rehype plugins, expressions, etc.),
 * install `@mdx-js/mdx` and pass it to `setBodyRenderer()`.
 *
 * @example
 * const html = compileMdx('# Hello\n\n<Callout type="info">World</Callout>');
 */
export function compileMdx(source: string): string {
  // Strip import/export statements (ES module syntax)
  let cleaned = source.replace(/^\s*import\s+.*$/gm, '');
  cleaned = cleaned.replace(/^\s*export\s+.*$/gm, '');

  // Extract JSX blocks and replace with placeholders, render markdown,
  // then re-insert rendered JSX.
  const jsxBlocks: string[] = [];
  const PLACEHOLDER_PREFIX = '\u0000MDX_BLOCK_';
  const PLACEHOLDER_SUFFIX = '\u0000';

  // Match JSX elements: <Component ...>...</Component> or <Component .../>
  // Handles nested children by matching balanced tags.
  const jsxRegex = /<([A-Z][A-Za-z0-9]*)(\s+[^>]*)?>([\s\S]*?)<\/\1>|<([A-Z][A-Za-z0-9]*)(\s+[^>]*)?\/>/g;
  cleaned = cleaned.replace(jsxRegex, (match) => {
    const idx = jsxBlocks.length;
    jsxBlocks.push(match);
    return `${PLACEHOLDER_PREFIX}${idx}${PLACEHOLDER_SUFFIX}`;
  });

  // Render the markdown parts (with placeholders)
  let html = renderMarkdown(cleaned);

  // Re-insert rendered JSX components
  for (let i = 0; i < jsxBlocks.length; i++) {
    const rendered = renderJsxBlock(jsxBlocks[i]);
    html = html.replace(`${PLACEHOLDER_PREFIX}${i}${PLACEHOLDER_SUFFIX}`, rendered);
  }

  return html;
}

function renderJsxBlock(jsx: string): string {
  // Self-closing: <Component prop="value" />
  const selfClosing = jsx.match(/^<([A-Z][A-Za-z0-9]*)(\s+[^>]*)?\/>$/);
  if (selfClosing) {
    const name = selfClosing[1];
    const props = parseJsxProps(selfClosing[2] ?? '');
    const fn = mdxComponents.get(name);
    if (fn) return fn(props, '');
    return renderFallbackComponent(name, props, '');
  }

  // With children: <Component prop="value">children</Component>
  const withChildren = jsx.match(/^<([A-Z][A-Za-z0-9]*)(\s+[^>]*)?>([\s\S]*?)<\/\1>$/);
  if (withChildren) {
    const name = withChildren[1];
    const props = parseJsxProps(withChildren[2] ?? '');
    const children = withChildren[3] ?? '';
    // Render children as markdown if they contain markdown syntax
    const renderedChildren = looksLikeMarkdown(children) ? renderMarkdown(children.trim()) : children.trim();
    const fn = mdxComponents.get(name);
    if (fn) return fn(props, renderedChildren);
    return renderFallbackComponent(name, props, renderedChildren);
  }

  // Unknown JSX — escape and return
  return escapeHtml(jsx);
}

function parseJsxProps(attrStr: string): MdxComponentProps {
  const props: MdxComponentProps = {};
  // Match: prop="value" or prop='value' or prop={value}
  const propRegex = /(\w+)=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g;
  let match;
  while ((match = propRegex.exec(attrStr)) !== null) {
    const key = match[1];
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    // Expression values: try to parse as JSON, else string
    if (match[4] !== undefined) {
      try {
        props[key] = JSON.parse(match[4]);
      } catch {
        props[key] = match[4];
      }
    } else {
      props[key] = value;
    }
  }
  // Boolean props (e.g., <Component active />)
  const boolPropRegex = /\s(\w+)(?=\s|$)/g;
  let boolMatch;
  while ((boolMatch = boolPropRegex.exec(attrStr)) !== null) {
    if (!(boolMatch[1] in props)) {
      props[boolMatch[1]] = true;
    }
  }
  return props;
}

function looksLikeMarkdown(s: string): boolean {
  return /^#{1,6}\s|^\*\*|^\*|^-\s|^\d+\.\s|^>/m.test(s.trim());
}

function renderFallbackComponent(name: string, props: MdxComponentProps, children: string): string {
  const dataAttrs = Object.entries(props)
    .map(([k, v]) => ` data-${k}="${escapeHtml(String(v))}"`)
    .join('');
  return `<div data-component="${escapeHtml(name)}"${dataAttrs}>${children}</div>`;
}

// ---------------------------------------------------------------------------
// Body Renderer (pluggable)
// ---------------------------------------------------------------------------

export type BodyRenderer = (body: string, filePath: string) => string;

let customBodyRenderer: BodyRenderer | null = null;

/**
 * Set a custom body renderer (e.g., to use a real MDX compiler or a more
 * complete markdown parser). Called once at setup time.
 *
 * @example
 * import { renderMarkdown } from 'pledgestack-content';
 * setBodyRenderer((body, filePath) => {
 *   if (filePath.endsWith('.mdx')) return compileMdx(body);
 *   return renderMarkdown(body);
 * });
 */
export function setBodyRenderer(renderer: BodyRenderer): void {
  customBodyRenderer = renderer;
}

/**
 * Renders a content entry's body to HTML. Uses the custom renderer if set,
 * otherwise falls back to the built-in renderer (compileMdx for .mdx files,
 * renderMarkdown for .md files). Results are cached on the entry to avoid
 * re-rendering on every access.
 */
export function renderBody<S extends SchemaDefinition>(entry: ContentEntry<S>): string {
  if (entry.renderedBody !== undefined) return entry.renderedBody;

  const renderer = customBodyRenderer ?? ((body, filePath) => {
    if (filePath.endsWith('.mdx')) return compileMdx(body);
    return renderMarkdown(body);
  });
  const html = renderer(entry.body, entry.filePath);
  entry.renderedBody = html;
  return html;
}

// ---------------------------------------------------------------------------
// Content Layer Caching
// ---------------------------------------------------------------------------

interface CacheEntry {
  mtimeMs: number;
  entries: Map<string, ContentEntry>;
  loadedAt: number;
}

const collectionCache = new Map<string, CacheEntry>();

/**
 * Checks whether a collection's cache is stale (any file modified since load).
 * Returns true if reload is needed.
 */
export function isCacheStale(name: string, rootDir: string): boolean {
  const cached = collectionCache.get(name);
  if (!cached) return true;

  const registryEntry = collectionRegistry.get(name);
  if (!registryEntry) return true;

  // Verify the collection directory still exists
  try {
    statSync(join(rootDir, registryEntry.config.directory));
  } catch {
    return true; // Directory removed
  }

  for (const [, entry] of cached.entries) {
    try {
      const stat = statSync(entry.filePath);
      if (stat.mtimeMs > cached.mtimeMs) return true;
    } catch {
      return true; // File deleted
    }
  }
  return false;
}

/**
 * Returns cached entries if fresh, or reloads if stale. This is the
 * recommended way to access collections in dev mode — it avoids re-reading
 * files on every request while still picking up changes.
 */
export function getCollectionCached<S extends SchemaDefinition = SchemaDefinition>(
  name: string,
  rootDir?: string,
): ContentEntry<S>[] {
  if (rootDir && isCacheStale(name, rootDir)) {
    const registryEntry = collectionRegistry.get(name);
    if (registryEntry) {
      loadCollection(name, registryEntry.config as CollectionConfig<S>, rootDir);
    }
  }
  return getCollection<S>(name);
}

// ---------------------------------------------------------------------------
// Frontmatter Parser
// ---------------------------------------------------------------------------

/**
 * Minimal YAML-like frontmatter parser. Supports:
 * - key: value (string, number, boolean, date)
 * - key: [item1, item2] (arrays)
 * - Quoted strings ("..." or '...')
 * - Comments (# ...)
 *
 * This is NOT a full YAML parser — it covers the common frontmatter subset.
 * For complex YAML, users can swap in a real parser via the `parser` option.
 */
export function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { data: {}, body: raw };
  }

  const yamlBlock = match[1];
  const body = match[2].replace(/^\r?\n/, '');
  const data: Record<string, unknown> = {};
  const lines = yamlBlock.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const valuePart = trimmed.slice(colonIdx + 1).trim();

    data[key] = parseValue(valuePart);
  }

  return { data, body };
}

function parseValue(raw: string): unknown {
  // Array: [item1, item2, item3]
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map(s => parseScalar(s.trim()));
  }

  return parseScalar(raw);
}

function parseScalar(raw: string): unknown {
  // Quoted string
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }

  // Boolean
  if (raw === 'true') return true;
  if (raw === 'false') return false;

  // Null
  if (raw === 'null' || raw === '~') return null;

  // Number
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    return Number(raw);
  }

  // ISO date (YYYY-MM-DD)
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return new Date(raw);
  }

  // Plain string
  return raw;
}

// ---------------------------------------------------------------------------
// Schema Validator
// ---------------------------------------------------------------------------

export interface ValidationError {
  field: string;
  message: string;
  expected: string;
  actual: string;
}

export function validateEntry(
  data: Record<string, unknown>,
  schema: SchemaDefinition,
): { valid: boolean; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  for (const [key, typeSpec] of Object.entries(schema)) {
    const optional = typeSpec.endsWith('?');
    const baseType = optional ? typeSpec.slice(0, -1) : typeSpec;
    const value = data[key];

    if (value === undefined || value === null) {
      if (!optional) {
        errors.push({
          field: key,
          message: `Missing required field "${key}"`,
          expected: baseType,
          actual: String(value),
        });
      }
      continue;
    }

    const actualType = getTypeName(value);
    if (!typesMatch(actualType, baseType)) {
      errors.push({
        field: key,
        message: `Field "${key}" has type "${actualType}", expected "${baseType}"`,
        expected: baseType,
        actual: actualType,
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

function getTypeName(value: unknown): string {
  if (value instanceof Date) return 'date';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function typesMatch(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  // 'object' matches plain objects
  if (expected === 'object' && actual === 'object') return true;
  return false;
}

// ---------------------------------------------------------------------------
// Collection Loader
// ---------------------------------------------------------------------------

interface CollectionRegistryEntry {
  config: CollectionConfig;
  entries: Map<string, ContentEntry>;
}

const collectionRegistry = new Map<string, CollectionRegistryEntry>();

/**
 * Loads all entries from a collection directory, validating frontmatter
 * against the schema. Invalid entries are skipped with a warning.
 */
export function loadCollection<S extends SchemaDefinition>(
  name: string,
  config: CollectionConfig<S>,
  rootDir: string,
): ContentEntry<S>[] {
  const entries = new Map<string, ContentEntry>();
  const collectionDir = join(rootDir, config.directory);
  const extensions = config.extensions ?? ['.md', '.mdx'];
  const recursive = config.recursive ?? true;

  function scanDir(dir: string) {
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      return;
    }

    for (const file of files) {
      const fullPath = join(dir, file);
      const stat = statSync(fullPath);

      if (stat.isDirectory() && recursive) {
        scanDir(fullPath);
      } else if (stat.isFile()) {
        const ext = file.match(/\.[^.]+$/)?.[0] ?? '';
        if (!extensions.includes(ext)) continue;

        const raw = readFileSync(fullPath, 'utf-8');
        const { data, body } = parseFrontmatter(raw);

        const validation = validateEntry(data, config.schema as SchemaDefinition);
        if (!validation.valid) {
          console.warn(`[pledgestack-content] Skipping "${relative(rootDir, fullPath)}":`);
          for (const err of validation.errors) {
            console.warn(`  ${err.message}`);
          }
          continue;
        }

        const relPath = relative(collectionDir, fullPath)
          .replace(/\\/g, '/')
          .replace(/\.[^.]+$/, '');
        const slug = relPath.split('/').pop() ?? relPath;

        const entry: ContentEntry<S> = {
          id: relPath,
          data: data as InferSchema<S>,
          body,
          filePath: fullPath,
          slug,
        };

        entries.set(relPath, entry);
      }
    }
  }

  scanDir(collectionDir);

  collectionRegistry.set(name, {
    config: config as CollectionConfig,
    entries: entries as Map<string, ContentEntry>,
  });

  // Populate the cache with current mtimes
  const maxMtime = Array.from(entries.values()).reduce((max, e) => {
    try {
      return Math.max(max, statSync(e.filePath).mtimeMs);
    } catch {
      return max;
    }
  }, 0);
  collectionCache.set(name, {
    mtimeMs: maxMtime,
    entries: entries as Map<string, ContentEntry>,
    loadedAt: Date.now(),
  });

  return Array.from(entries.values()) as ContentEntry<S>[];
}

/**
 * Retrieves all entries from a previously-loaded collection.
 * Must be called after the collection is loaded (e.g., via the plugin's
 * buildStart hook or loadCollection directly).
 */
export function getCollection<S extends SchemaDefinition = SchemaDefinition>(
  name: string,
): ContentEntry<S>[] {
  const entry = collectionRegistry.get(name);
  if (!entry) {
    throw new Error(
      `Content collection "${name}" not found. Define it in pledge.config.ts plugins and ensure it's loaded before calling getCollection().`,
    );
  }
  return Array.from(entry.entries.values()) as ContentEntry<S>[];
}

/**
 * Retrieves a single entry by id from a previously-loaded collection.
 */
export function getEntry<S extends SchemaDefinition = SchemaDefinition>(
  name: string,
  id: string,
): ContentEntry<S> | null {
  const entry = collectionRegistry.get(name);
  if (!entry) {
    throw new Error(`Content collection "${name}" not found.`);
  }
  return (entry.entries.get(id) as ContentEntry<S>) ?? null;
}

/**
 * Returns the names of all loaded collections.
 */
export function getAllCollectionNames(): string[] {
  return Array.from(collectionRegistry.keys());
}

/**
 * Query builder for filtering, sorting, and limiting collection entries.
 *
 * @example
 * const posts = await getCollection('blog');
 * const recent = query(posts)
 *   .filter(p => !p.data.draft)
 *   .sort((a, b) => b.data.date.getTime() - a.data.date.getTime())
 *   .limit(10)
 *   .toArray();
 */
export function query<S extends SchemaDefinition>(entries: ContentEntry<S>[]) {
  return new ContentQuery(entries);
}

class ContentQuery<S extends SchemaDefinition> {
  private items: ContentEntry<S>[];

  constructor(items: ContentEntry<S>[]) {
    this.items = [...items];
  }

  filter(predicate: (entry: ContentEntry<S>) => boolean): this {
    this.items = this.items.filter(predicate);
    return this;
  }

  sort(compareFn: (a: ContentEntry<S>, b: ContentEntry<S>) => number): this {
    this.items.sort(compareFn);
    return this;
  }

  limit(count: number): this {
    this.items = this.items.slice(0, count);
    return this;
  }

  skip(count: number): this {
    this.items = this.items.slice(count);
    return this;
  }

  toArray(): ContentEntry<S>[] {
    return [...this.items];
  }

  get length(): number {
    return this.items.length;
  }

  [Symbol.iterator](): Iterator<ContentEntry<S>> {
    let index = 0;
    const items = this.items;
    return {
      next() {
        if (index < items.length) {
          return { value: items[index++], done: false };
        }
        return { value: undefined as unknown as ContentEntry<S>, done: true };
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export interface ContentPluginOptions {
  collections: Record<string, CollectionConfig>;
}

/**
 * PledgeStack plugin that loads content collections at build time.
 *
 * Collections are loaded during `buildStart` and made available via
 * `getCollection()` / `getEntry()` during rendering.
 */
export function contentPlugin(options: ContentPluginOptions): PledgePlugin {
  return {
    name: 'pledgestack-content',

    async buildStart(config) {
      for (const [name, collectionConfig] of Object.entries(options.collections)) {
        loadCollection(name, collectionConfig, config.rootDir);
        const count = getCollection(name).length;
        console.log(`  ✓ Loaded ${count} entries from collection "${name}"`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// All types are exported inline above; no re-exports needed.
