import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseFrontmatter,
  validateEntry,
  loadCollection,
  getCollection,
  getEntry,
  query,
  contentPlugin,
  renderMarkdown,
  renderBody,
  setBodyRenderer,
  getCollectionCached,
  isCacheStale,
  compileMdx,
  registerMdxComponents,
  type SchemaDefinition,
} from './index';

const tmpDir = join(process.cwd(), '.test-content-tmp');

describe('Content Collections', () => {
  describe('parseFrontmatter', () => {
    it('parses simple frontmatter', () => {
      const raw = `---\ntitle: Hello World\ndate: 2024-01-15\ndraft: false\n---\n\nBody content here`;
      const { data, body } = parseFrontmatter(raw);
      expect(data.title).toBe('Hello World');
      expect(data.date).toBeInstanceOf(Date);
      expect(data.draft).toBe(false);
      expect(body).toBe('Body content here');
    });

    it('parses arrays', () => {
      const raw = `---\ntags: [react, rust, edge]\n---\n\nBody`;
      const { data } = parseFrontmatter(raw);
      expect(data.tags).toEqual(['react', 'rust', 'edge']);
    });

    it('parses quoted strings', () => {
      const raw = `---\ntitle: "Hello: World"\n---\n\nBody`;
      const { data } = parseFrontmatter(raw);
      expect(data.title).toBe('Hello: World');
    });

    it('parses numbers', () => {
      const raw = `---\norder: 42\nprice: 9.99\n---\n\nBody`;
      const { data } = parseFrontmatter(raw);
      expect(data.order).toBe(42);
      expect(data.price).toBe(9.99);
    });

    it('handles no frontmatter', () => {
      const raw = `Just body content`;
      const { data, body } = parseFrontmatter(raw);
      expect(data).toEqual({});
      expect(body).toBe('Just body content');
    });

    it('skips comments', () => {
      const raw = `---\n# This is a comment\ntitle: Real\n---\n\nBody`;
      const { data } = parseFrontmatter(raw);
      expect(data.title).toBe('Real');
      expect(data['# This is a comment']).toBeUndefined();
    });
  });

  describe('validateEntry', () => {
    const schema: SchemaDefinition = {
      title: 'string',
      date: 'date',
      tags: 'array',
      draft: 'boolean?',
      count: 'number?',
    };

    it('validates a correct entry', () => {
      const data = { title: 'Hello', date: new Date('2024-01-01'), tags: ['a', 'b'] };
      const result = validateEntry(data, schema);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('reports missing required fields', () => {
      const data = { title: 'Hello' };
      const result = validateEntry(data, schema);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'date')).toBe(true);
      expect(result.errors.some(e => e.field === 'tags')).toBe(true);
    });

    it('allows missing optional fields', () => {
      const data = { title: 'Hello', date: new Date('2024-01-01'), tags: [] };
      const result = validateEntry(data, schema);
      expect(result.valid).toBe(true);
    });

    it('reports type mismatches', () => {
      const data = { title: 123, date: new Date('2024-01-01'), tags: [] };
      const result = validateEntry(data, schema);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === 'title')).toBe(true);
    });
  });

  describe('loadCollection + getCollection', () => {
    beforeEach(() => {
      mkdirSync(join(tmpDir, 'content', 'blog'), { recursive: true });
      mkdirSync(join(tmpDir, 'content', 'blog', 'nested'), { recursive: true });
      writeFileSync(join(tmpDir, 'content', 'blog', 'post1.md'),
        `---\ntitle: First Post\ndate: 2024-01-01\ntags: [intro, news]\n---\n\n# Hello\n\nWorld`);
      writeFileSync(join(tmpDir, 'content', 'blog', 'post2.md'),
        `---\ntitle: Second Post\ndate: 2024-02-01\ntags: [advanced]\ndraft: true\n---\n\n# Advanced`);
      writeFileSync(join(tmpDir, 'content', 'blog', 'nested', 'deep.md'),
        `---\ntitle: Deep Post\ndate: 2024-03-01\ntags: [nested]\n---\n\nNested content`);
      writeFileSync(join(tmpDir, 'content', 'blog', 'invalid.md'),
        `---\ntitle: Invalid Post\n---\n\nMissing required fields`);
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('loads and validates entries', () => {
      const schema: SchemaDefinition = {
        title: 'string',
        date: 'date',
        tags: 'array',
        draft: 'boolean?',
      };

      loadCollection('blog', { directory: 'content/blog', schema }, tmpDir);
      const entries = getCollection('blog');

      // 3 valid + 1 skipped (invalid.md missing date/tags)
      expect(entries.length).toBe(3);
      expect(entries.some(e => e.id === 'post1')).toBe(true);
      expect(entries.some(e => e.id === 'post2')).toBe(true);
      expect(entries.some(e => e.id === 'nested/deep')).toBe(true);
    });

    it('parses frontmatter data correctly', () => {
      const schema: SchemaDefinition = {
        title: 'string',
        date: 'date',
        tags: 'array',
        draft: 'boolean?',
      };

      loadCollection('blog-test2', { directory: 'content/blog', schema }, tmpDir);
      const entries = getCollection('blog-test2');
      const post1 = entries.find(e => e.id === 'post1');

      expect(post1).toBeDefined();
      expect(post1!.data.title).toBe('First Post');
      expect(post1!.data.date).toBeInstanceOf(Date);
      expect(post1!.data.tags).toEqual(['intro', 'news']);
      expect(post1!.data.draft).toBeUndefined();
      expect(post1!.body).toContain('# Hello');
      expect(post1!.slug).toBe('post1');
    });

    it('getEntry retrieves by id', () => {
      const schema: SchemaDefinition = {
        title: 'string',
        date: 'date',
        tags: 'array',
      };

      loadCollection('blog-test3', { directory: 'content/blog', schema }, tmpDir);
      const entry = getEntry('blog-test3', 'post1');
      expect(entry).not.toBeNull();
      expect(entry!.data.title).toBe('First Post');

      const missing = getEntry('blog-test3', 'nonexistent');
      expect(missing).toBeNull();
    });

    it('throws for unknown collection', () => {
      expect(() => getCollection('nonexistent-collection')).toThrow('not found');
    });
  });

  describe('query builder', () => {
    const schema: SchemaDefinition = {
      title: 'string',
      date: 'date',
      tags: 'array',
      draft: 'boolean?',
    };
    let entries: ReturnType<typeof getCollection>;

    beforeEach(() => {
      mkdirSync(join(tmpDir, 'content', 'qblog'), { recursive: true });
      writeFileSync(join(tmpDir, 'content', 'qblog', 'a.md'),
        `---\ntitle: A\ndate: 2024-03-01\ntags: [x]\n---\n\nA`);
      writeFileSync(join(tmpDir, 'content', 'qblog', 'b.md'),
        `---\ntitle: B\ndate: 2024-01-01\ntags: [x]\ndraft: true\n---\n\nB`);
      writeFileSync(join(tmpDir, 'content', 'qblog', 'c.md'),
        `---\ntitle: C\ndate: 2024-02-01\ntags: [x]\n---\n\nC`);

      loadCollection('qblog', { directory: 'content/qblog', schema }, tmpDir);
      entries = getCollection('qblog');
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('filters entries', () => {
      const result = query(entries)
        .filter(e => !e.data.draft)
        .toArray();
      expect(result).toHaveLength(2);
      expect(result.every(e => e.id !== 'b')).toBe(true);
    });

    it('sorts entries', () => {
      const result = query(entries)
        .sort((a, b) => (b.data.date as Date).getTime() - (a.data.date as Date).getTime())
        .toArray();
      expect(result[0].id).toBe('a');
      expect(result[2].id).toBe('b');
    });

    it('limits results', () => {
      const result = query(entries).limit(2).toArray();
      expect(result).toHaveLength(2);
    });

    it('skips entries', () => {
      const result = query(entries).skip(1).toArray();
      expect(result).toHaveLength(2);
    });

    it('chains filter + sort + limit', () => {
      const result = query(entries)
        .filter(e => !e.data.draft)
        .sort((a, b) => (a.data.date as Date).getTime() - (b.data.date as Date).getTime())
        .limit(1)
        .toArray();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('c');
    });

    it('exposes length', () => {
      expect(query(entries).length).toBe(3);
    });

    it('is iterable', () => {
      const result = query(entries);
      const ids = [];
      for (const entry of result) {
        ids.push(entry.id);
      }
      expect(ids).toHaveLength(3);
    });
  });

  describe('contentPlugin', () => {
    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('creates a plugin with the correct name', () => {
      const plugin = contentPlugin({ collections: {} });
      expect(plugin.name).toBe('pledgestack-content');
    });

    it('loads collections in buildStart', async () => {
      mkdirSync(join(tmpDir, 'content', 'pblog'), { recursive: true });
      writeFileSync(join(tmpDir, 'content', 'pblog', 'post.md'),
        `---\ntitle: Plugin Post\ndate: 2024-01-01\ntags: [test]\n---\n\nBody`);

      const schema: SchemaDefinition = {
        title: 'string',
        date: 'date',
        tags: 'array',
      };

      const plugin = contentPlugin({
        collections: {
          pblog: { directory: 'content/pblog', schema },
        },
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await plugin.buildStart!({ rootDir: tmpDir } as never);
      consoleSpy.mockRestore();

      const entries = getCollection('pblog');
      expect(entries).toHaveLength(1);
      expect(entries[0].data.title).toBe('Plugin Post');
    });
  });

  describe('renderMarkdown', () => {
    it('renders headings', () => {
      const html = renderMarkdown('# Title\n## Subtitle');
      expect(html).toContain('<h1>Title</h1>');
      expect(html).toContain('<h2>Subtitle</h2>');
    });

    it('renders bold and italic', () => {
      const html = renderMarkdown('**bold** and *italic*');
      expect(html).toContain('<strong>bold</strong>');
      expect(html).toContain('<em>italic</em>');
    });

    it('renders code blocks', () => {
      const html = renderMarkdown('```js\nconst x = 1;\n```');
      expect(html).toContain('<pre><code class="language-js">');
      expect(html).toContain('const x = 1');
    });

    it('renders inline code', () => {
      const html = renderMarkdown('Use `npm` to install');
      expect(html).toContain('<code>npm</code>');
    });

    it('renders links', () => {
      const html = renderMarkdown('[Click here](https://example.com)');
      expect(html).toContain('<a href="https://example.com">Click here</a>');
    });

    it('renders images', () => {
      const html = renderMarkdown('![Alt text](image.png)');
      expect(html).toContain('<img src="image.png" alt="Alt text"/>');
    });

    it('renders unordered lists', () => {
      const html = renderMarkdown('- item 1\n- item 2');
      expect(html).toContain('<ul>');
      expect(html).toContain('<li>item 1</li>');
    });

    it('renders ordered lists', () => {
      const html = renderMarkdown('1. first\n2. second');
      expect(html).toContain('<ol>');
      expect(html).toContain('<li>first</li>');
    });

    it('renders blockquotes', () => {
      const html = renderMarkdown('> A quote');
      expect(html).toContain('<blockquote>A quote</blockquote>');
    });

    it('renders horizontal rules', () => {
      const html = renderMarkdown('---');
      expect(html).toContain('<hr/>');
    });

    it('renders paragraphs', () => {
      const html = renderMarkdown('Just a paragraph');
      expect(html).toContain('<p>Just a paragraph</p>');
    });

    it('escapes HTML in code blocks', () => {
      const html = renderMarkdown('```\n<div>test</div>\n```');
      expect(html).toContain('<div>');
    });
  });

  describe('renderBody', () => {
    const schema: SchemaDefinition = {
      title: 'string',
      date: 'date',
      tags: 'array',
    };

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
      setBodyRenderer(null as unknown as (body: string, filePath: string) => string);
    });

    it('renders body to HTML using built-in renderer', () => {
      mkdirSync(join(tmpDir, 'content', 'rblog'), { recursive: true });
      writeFileSync(join(tmpDir, 'content', 'rblog', 'post.md'),
        `---\ntitle: Test\ndate: 2024-01-01\ntags: [x]\n---\n\n# Hello\n\n**Bold** text`);

      loadCollection('rblog', { directory: 'content/rblog', schema }, tmpDir);
      const entries = getCollection('rblog');
      const html = renderBody(entries[0]);
      expect(html).toContain('<h1>Hello</h1>');
      expect(html).toContain('<strong>Bold</strong>');
    });

    it('caches rendered body on the entry', () => {
      mkdirSync(join(tmpDir, 'content', 'cblog'), { recursive: true });
      writeFileSync(join(tmpDir, 'content', 'cblog', 'post.md'),
        `---\ntitle: Cache\ndate: 2024-01-01\ntags: [x]\n---\n\nBody`);

      loadCollection('cblog', { directory: 'content/cblog', schema }, tmpDir);
      const entries = getCollection('cblog');
      expect(entries[0].renderedBody).toBeUndefined();

      renderBody(entries[0]);
      expect(entries[0].renderedBody).toBeDefined();
    });

    it('uses custom body renderer when set', () => {
      mkdirSync(join(tmpDir, 'content', 'custom'), { recursive: true });
      writeFileSync(join(tmpDir, 'content', 'custom', 'post.md'),
        `---\ntitle: Custom\ndate: 2024-01-01\ntags: [x]\n---\n\nBody`);

      setBodyRenderer((body) => `<div class="custom">${body}</div>`);

      loadCollection('custom-render', { directory: 'content/custom', schema }, tmpDir);
      const entries = getCollection('custom-render');
      const html = renderBody(entries[0]);
      expect(html).toBe('<div class="custom">Body</div>');
    });
  });

  describe('content layer caching', () => {
    const schema: SchemaDefinition = {
      title: 'string',
      date: 'date',
      tags: 'array',
    };

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('isCacheStale returns true for unknown collection', () => {
      expect(isCacheStale('nonexistent', tmpDir)).toBe(true);
    });

    it('isCacheStale returns false right after loading', () => {
      mkdirSync(join(tmpDir, 'content', 'cache1'), { recursive: true });
      writeFileSync(join(tmpDir, 'content', 'cache1', 'post.md'),
        `---\ntitle: Fresh\ndate: 2024-01-01\ntags: [x]\n---\n\nBody`);

      loadCollection('cache1', { directory: 'content/cache1', schema }, tmpDir);
      expect(isCacheStale('cache1', tmpDir)).toBe(false);
    });

    it('getCollectionCached returns entries without reload when fresh', () => {
      mkdirSync(join(tmpDir, 'content', 'cache2'), { recursive: true });
      writeFileSync(join(tmpDir, 'content', 'cache2', 'post.md'),
        `---\ntitle: Cached\ndate: 2024-01-01\ntags: [x]\n---\n\nBody`);

      loadCollection('cache2', { directory: 'content/cache2', schema }, tmpDir);
      const entries = getCollectionCached('cache2', tmpDir);
      expect(entries).toHaveLength(1);
      expect(entries[0].data.title).toBe('Cached');
    });

    it('getCollectionCached reloads when file changes', () => {
      mkdirSync(join(tmpDir, 'content', 'cache3'), { recursive: true });
      const filePath = join(tmpDir, 'content', 'cache3', 'post.md');
      writeFileSync(filePath,
        `---\ntitle: Original\ndate: 2024-01-01\ntags: [x]\n---\n\nBody`);

      loadCollection('cache3', { directory: 'content/cache3', schema }, tmpDir);
      expect(getCollectionCached('cache3', tmpDir)[0].data.title).toBe('Original');

      // Wait a bit so mtime changes
      writeFileSync(filePath,
        `---\ntitle: Updated\ndate: 2024-01-01\ntags: [x]\n---\n\nNew body`);

      const updated = getCollectionCached('cache3', tmpDir);
      expect(updated[0].data.title).toBe('Updated');
    });
  });

  describe('compileMdx', () => {
    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('renders markdown parts in MDX', () => {
      const html = compileMdx('# Hello\n\nSome **bold** text');
      expect(html).toContain('<h1>Hello</h1>');
      expect(html).toContain('<strong>bold</strong>');
    });

    it('strips import/export statements', () => {
      const html = compileMdx('import { Foo } from "bar"\n\n# Title\n\nexport const x = 1');
      expect(html).toContain('<h1>Title</h1>');
      expect(html).not.toContain('import');
      expect(html).not.toContain('export');
    });

    it('renders self-closing JSX components as fallback', () => {
      const html = compileMdx('<YouTube id="abc123" />');
      expect(html).toContain('data-component="YouTube"');
      expect(html).toContain('data-id="abc123"');
    });

    it('renders JSX components with children as fallback', () => {
      const html = compileMdx('<Callout type="info">Hello world</Callout>');
      expect(html).toContain('data-component="Callout"');
      expect(html).toContain('data-type="info"');
      expect(html).toContain('Hello world');
    });

    it('uses registered components for rendering', () => {
      registerMdxComponents({
        Callout: (props, children) => `<div class="callout ${props.type}">${children}</div>`,
      });
      const html = compileMdx('<Callout type="warning">Danger</Callout>');
      expect(html).toContain('<div class="callout warning">');
      expect(html).toContain('Danger');
    });

    it('renders markdown inside JSX children', () => {
      registerMdxComponents({
        Card: (_props, children) => `<div class="card">${children}</div>`,
      });
      const html = compileMdx('<Card>\n# Inner Title\n\n**Bold** text\n</Card>');
      expect(html).toContain('<div class="card">');
      expect(html).toContain('<h1>Inner Title</h1>');
      expect(html).toContain('<strong>Bold</strong>');
    });

    it('handles boolean props', () => {
      const html = compileMdx('<Button active disabled />');
      expect(html).toContain('data-active="true"');
      expect(html).toContain('data-disabled="true"');
    });

    it('handles expression props', () => {
      const html = compileMdx('<Counter count={42} />');
      expect(html).toContain('data-count="42"');
    });

    it('mixes markdown and JSX', () => {
      registerMdxComponents({
        Alert: (props, children) => `<div class="alert ${props.severity}">${children}</div>`,
      });
      const html = compileMdx('# Title\n\n<Alert severity="error">Something broke</Alert>\n\nAfter alert');
      expect(html).toContain('<h1>Title</h1>');
      expect(html).toContain('<div class="alert error">');
      expect(html).toContain('Something broke');
      expect(html).toContain('<p>After alert</p>');
    });

    it('renderBody uses compileMdx for .mdx files', () => {
      // Callout was registered in a previous test — verify it renders correctly
      mkdirSync(join(tmpDir, 'content', 'mdxblog'), { recursive: true });
      writeFileSync(join(tmpDir, 'content', 'mdxblog', 'post.mdx'),
        `---\ntitle: MDX Post\ndate: 2024-01-01\ntags: [x]\n---\n\n# Hello\n\n<Callout type="info">World</Callout>`);

      const schema: SchemaDefinition = {
        title: 'string',
        date: 'date',
        tags: 'array',
      };

      loadCollection('mdxblog', { directory: 'content/mdxblog', schema }, tmpDir);
      const entries = getCollection('mdxblog');
      const html = renderBody(entries[0]);
      expect(html).toContain('<h1>Hello</h1>');
      // Callout component is registered, so it renders as a div
      expect(html).toContain('callout');
      expect(html).toContain('World');
    });
  });
});
