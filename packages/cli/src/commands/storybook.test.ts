import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { findComponents, generateDefaultStory, generatePreviewConfig } from './storybook';

describe('pledge storybook', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pledge-sb-'));
    mkdirSync(join(dir, 'components'), { recursive: true });
    writeFileSync(join(dir, 'components', 'Button.tsx'), 'export const Button = () => null;');
    writeFileSync(join(dir, 'components', 'Button.stories.tsx'), 'export default {};');
    writeFileSync(join(dir, 'components', 'Button.test.tsx'), '');
    writeFileSync(join(dir, 'components', 'types.d.ts'), '');
    writeFileSync(join(dir, 'page.tsx'), '');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('does not treat stories, tests or declaration files as components', async () => {
    const found = (await findComponents(dir)).map((p) => basename(p));
    expect(found).toEqual(['Button.tsx']);
  });

  it('puts the client directive before the import so it is a real directive', () => {
    const story = generateDefaultStory('../.storybook/types', 'Button', true);
    expect(story.startsWith('"use pledge:client";\nimport type { Story } from \'../.storybook/types\';')).toBe(true);
    expect(generateDefaultStory('./x', 'Button', false).startsWith('import type')).toBe(true);
  });

  it('uses the configured appDir for global CSS', () => {
    expect(generatePreviewConfig({ appDir: 'src/app' })).toContain("import '../src/app/globals.css';");
  });
});
