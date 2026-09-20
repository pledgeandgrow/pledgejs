import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileMDX, transformFile } from './transform';

describe('MDX transform', () => {
  it('injects the compiled markup as HTML instead of a text child', () => {
    const code = compileMDX('# Title\n\nHello **world**\n', 'page');
    // A plain string child would be HTML-escaped by React and show literal tags.
    expect(code).toContain('dangerouslySetInnerHTML');
    expect(code).toContain(JSON.stringify('<h1>Title</h1>\n<p>Hello <strong>world</strong></p>'));
    expect(code).not.toMatch(/h\('div', \{[^)]*\}, "/);
  });

  describe('dev cache files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pledge-mdx-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('writes a new module URL each time the file is recompiled in dev', async () => {
      const file = join(dir, 'doc.mdx');
      writeFileSync(file, '# One\n');
      const first = await transformFile(file, true, 4321, undefined, dir);
      writeFileSync(file, '# Two\n');
      const second = await transformFile(file, true, 4321, undefined, dir);
      // Node caches ESM imports by URL; a reused URL would serve stale content.
      expect(second).not.toBe(first);
      expect(readFileSync(fileURLToPath(second), 'utf-8')).toContain('Two');
    });
  });
});
