import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatRustSource, formatDirectory, checkFormatting } from './fmt';

const hasRustfmt = spawnSync('rustfmt', ['--version']).status === 0;

describe.runIf(hasRustfmt)('psx fmt (real rustfmt)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pledge-fmt-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const UGLY = 'pub fn add(a:i32,b:i32)->i32{a+b}';
  const PRETTY = 'pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}';

  it('actually formats (rustfmt must not be invoked with a stray "fmt" file argument)', async () => {
    const { formatted, changed } = await formatRustSource(UGLY);
    expect(changed).toBe(true);
    expect(formatted).toBe(PRETTY);
  });

  it('keeps the surrounding whitespace so already-formatted code is reported unchanged', async () => {
    const src = `\n${PRETTY}\n`;
    const { formatted, changed } = await formatRustSource(src);
    expect(changed).toBe(false);
    expect(formatted).toBe(src);
  });

  it('a properly formatted .ps file is not rewritten (and keeps its trailing newline)', async () => {
    const file = join(dir, 'a.ps');
    writeFileSync(file, PRETTY + '\n');
    const results = await formatDirectory(dir);
    expect(results.find((r) => r.file === 'a.ps')?.changed).toBe(false);
    expect(readFileSync(file, 'utf-8')).toBe(PRETTY + '\n');
  });

  it('formats <rust> blocks in place without collapsing them onto the tag line', async () => {
    const file = join(dir, 'p.psx');
    writeFileSync(file, `<rust>\n${UGLY}\n</rust>\nexport default function P() { return null; }\n`);
    await formatDirectory(dir);
    expect(readFileSync(file, 'utf-8')).toBe(`<rust>\n${PRETTY}\n</rust>\nexport default function P() { return null; }\n`);
    // ...and a second run is a no-op.
    const again = await formatDirectory(dir);
    expect(again.find((r) => r.file === 'p.psx')?.changed).toBe(false);
  });

  it('checkFormatting reports unformatted files WITHOUT modifying them', async () => {
    const file = join(dir, 'b.ps');
    writeFileSync(file, UGLY + '\n');
    const needs = await checkFormatting(dir);
    expect(needs.map((r) => r.file)).toEqual(['b.ps']);
    expect(readFileSync(file, 'utf-8')).toBe(UGLY + '\n');
  });
});
