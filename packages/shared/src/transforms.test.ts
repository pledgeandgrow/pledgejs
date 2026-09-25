import { describe, it, expect } from 'vitest';
import { stubAssetImports, isAssetSpecifier, devImportMapScript } from './transforms';
import { splitDocumentMarkup } from './renderer';

describe('isAssetSpecifier', () => {
  it('matches stylesheets and common asset extensions', () => {
    for (const spec of [
      './globals.css',
      '../theme.scss',
      './logo.png',
      './font.woff2',
      './doc.pdf',
      './styles.css?inline',
    ]) {
      expect(isAssetSpecifier(spec), spec).toBe(true);
    }
  });

  it('does not match JavaScript/TypeScript modules', () => {
    for (const spec of ['./utils', './lib.ts', './comp.tsx', 'react', './mod.js']) {
      expect(isAssetSpecifier(spec), spec).toBe(false);
    }
  });
});

describe('stubAssetImports', () => {
  it('stubs side-effect CSS imports so Node can load the module', () => {
    const code = `import { jsxDEV } from "react/jsx-dev-runtime";\nimport "./globals.css";\nexport default function L() {}`;
    const out = stubAssetImports(code);
    expect(out).not.toContain('import "./globals.css"');
    expect(out).toContain('react/jsx-dev-runtime');
    expect(out).toContain('export default function L() {}');
  });

  it('stubs default imports with a CSS-module proxy for .module.css', () => {
    const out = stubAssetImports(`import styles from './card.module.css';`);
    expect(out).toContain('const styles = new Proxy(');
  });

  it('stubs default asset imports with the specifier string', () => {
    const out = stubAssetImports(`import logo from './logo.png';`);
    expect(out).toContain(`const logo = "./logo.png";`);
  });

  it('stubs namespace, named, re-export and dynamic asset imports', () => {
    expect(stubAssetImports(`import * as ns from './x.svg';`)).toContain('const ns = { default:');
    const named = stubAssetImports(`import { a, b as c } from './x.css';`);
    expect(named).toContain('const a = undefined;');
    expect(named).toContain('const c = undefined;');
    expect(stubAssetImports(`export { x } from './x.css';`)).not.toContain("from './x.css'");
    expect(stubAssetImports(`const m = await import('./x.css');`)).toContain('Promise.resolve({ default:');
  });

  it('leaves ordinary JS imports untouched', () => {
    const code = `import { x } from './utils';\nimport React from 'react';\nexport const y = x;`;
    expect(stubAssetImports(code)).toBe(code);
  });
});

describe('splitDocumentMarkup', () => {
  it('splits a React-rendered document (with doctype) into head and body', () => {
    const html = '<!DOCTYPE html><html lang="en"><head><style>.x{color:red}</style><title>T</title></head><body><nav>N</nav><main>M</main></body></html>';
    const doc = splitDocumentMarkup(html);
    expect(doc).not.toBeNull();
    expect(doc!.head).toContain('<style>.x{color:red}</style>');
    expect(doc!.head).toContain('<title>T</title>');
    expect(doc!.body).toContain('<nav>N</nav>');
    expect(doc!.body).toContain('<main>M</main>');
    expect(doc!.body).not.toContain('<head');
  });

  it('handles documents without a doctype', () => {
    const doc = splitDocumentMarkup('<html><head></head><body><p>hi</p></body></html>');
    expect(doc?.body).toContain('<p>hi</p>');
  });

  it('returns null for non-document content', () => {
    expect(splitDocumentMarkup('<div><p>fragment</p></div>')).toBeNull();
    expect(splitDocumentMarkup('')).toBeNull();
  });
});

describe('devImportMapScript', () => {
  it('maps bare specifiers to esm.sh and the bundled client runtime', () => {
    const tag = devImportMapScript({ react: '19.3.0', reactDom: '19.3.0' });
    expect(tag).toContain('<script type="importmap">');
    expect(tag).toContain('"react":"https://esm.sh/react@19.3.0"');
    expect(tag).toContain('"react-dom/client":"https://esm.sh/react-dom@19.3.0/client"');
    expect(tag).toContain('"pledgestack-client":"/node_modules/pledgestack/dist/client.js"');
  });

  it('falls back to unversioned specifiers without versions', () => {
    const tag = devImportMapScript();
    expect(tag).toContain('"react":"https://esm.sh/react"');
  });
});
