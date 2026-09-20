import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REGISTERED_CODEMODS, listCodemods, runCodemod } from './codemod';

describe('Codemod Transforms (#50)', () => {
  it('has registered codemods', () => {
    expect(REGISTERED_CODEMODS.length).toBeGreaterThan(0);
  });

  it('has next-to-pledge codemod', () => {
    const codemod = REGISTERED_CODEMODS.find((c) => c.name === 'next-to-pledge');
    expect(codemod).toBeDefined();
  });

  it('listCodemods returns name and description', () => {
    const list = listCodemods();
    expect(list.length).toBeGreaterThan(0);
    expect(typeof list[0].name).toBe('string');
    expect(typeof list[0].description).toBe('string');
  });

  it('transforms next/image to pledgestack Image', () => {
    const codemod = REGISTERED_CODEMODS.find((c) => c.name === 'next-image-to-img');
    expect(codemod).toBeDefined();
    const source = "import Image from 'next/image';";
    const result = codemod!.transform(source, 'test.tsx');
    expect(result.changes).toBeGreaterThan(0);
    expect(result.code).not.toContain('next/image');
  });

  it('transforms next/link to pledgestack Link', () => {
    const codemod = REGISTERED_CODEMODS.find((c) => c.name === 'next-to-pledge');
    expect(codemod).toBeDefined();
    const source = "import Link from 'next/link';";
    const result = codemod!.transform(source, 'test.tsx');
    expect(result.changes).toBeGreaterThan(0);
  });

  it('transforms next/router to pledgestack router', () => {
    const codemod = REGISTERED_CODEMODS.find((c) => c.name === 'next-router-to-pledge-router');
    expect(codemod).toBeDefined();
    const source = "import { useRouter } from 'next/router';";
    const result = codemod!.transform(source, 'test.tsx');
    expect(result.changes).toBeGreaterThan(0);
  });

  it('returns 0 changes for non-matching source', () => {
    const codemod = REGISTERED_CODEMODS.find((c) => c.name === 'next-to-pledge');
    expect(codemod).toBeDefined();
    const source = "import React from 'react';";
    const result = codemod!.transform(source, 'test.tsx');
    expect(result.changes).toBe(0);
  });

  it('each codemod has a name, description, and transform function', () => {
    for (const codemod of REGISTERED_CODEMODS) {
      expect(typeof codemod.name).toBe('string');
      expect(typeof codemod.description).toBe('string');
      expect(typeof codemod.transform).toBe('function');
    }
  });
});

describe('runCodemod file handling', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pledge-codemod-'));
    mkdirSync(join(dir, 'sub'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(dir, 'a.tsx'), "import Link from 'next/link';\n");
    writeFileSync(join(dir, 'sub', 'b.ts'), "import { useRouter } from 'next/router';\n");
    writeFileSync(join(dir, 'node_modules', 'x', 'c.ts'), "import Link from 'next/link';\n");
    writeFileSync(join(dir, 'notes.md'), "import Link from 'next/link';\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('walks directories (as documented: `pledge codemod <name> src/`)', async () => {
    const res = await runCodemod({ name: 'next-router-to-pledge-router', path: dir });
    expect(res.filesChanged).toBe(2);
    expect(readFileSync(join(dir, 'sub', 'b.ts'), 'utf-8')).toContain("'pledgestack/router'");
    // vendored and non-source files are left alone
    expect(readFileSync(join(dir, 'node_modules', 'x', 'c.ts'), 'utf-8')).toContain('next/link');
    expect(readFileSync(join(dir, 'notes.md'), 'utf-8')).toContain('next/link');
  });

  it('does not write anything in dry-run mode', async () => {
    const res = await runCodemod({ name: 'next-router-to-pledge-router', path: dir, dryRun: true });
    expect(res.filesChanged).toBe(2);
    expect(readFileSync(join(dir, 'sub', 'b.ts'), 'utf-8')).toContain('next/router');
  });
});
