import { describe, it, expect } from 'vitest';
import { REGISTERED_CODEMODS, listCodemods } from './codemod';

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
