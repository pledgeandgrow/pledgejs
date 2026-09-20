import { describe, it, expect } from 'vitest';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import plugin from './index';

/** Lints `code` as `filename` with a single pledge rule enabled; returns the messages. */
function lint(rule: string, code: string, filename: string, options: unknown[] = []) {
  const linter = new Linter();
  return linter.verify(
    code,
    [
      {
        files: ['**/*.ts', '**/*.tsx'],
        languageOptions: {
          parser: tseslint.parser as never,
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        plugins: { pledge: plugin as never },
        rules: { [`pledge/${rule}`]: ['error', ...options] },
      },
    ],
    { filename },
  );
}

const B = String.fromCharCode(92);

/**
 * Runs a rule against a hand-built context, so filenames can be arbitrary
 * (ESLint's flat-config file matching rejects Windows-style paths on POSIX).
 * Fires Program then Program:exit and returns the reported messageIds.
 */
function runRuleOnFile(rule: string, filename: string, source = ''): Array<string | undefined> {
  const reported: Array<string | undefined> = [];
  const context = {
    filename,
    getFilename: () => filename,
    sourceCode: { getText: () => source },
    getSourceCode: () => ({ getText: () => source }),
    report: (d: { messageId?: string }) => reported.push(d.messageId),
  };
  const handlers = (plugin.rules as Record<string, { create: (c: unknown) => Record<string, (n?: unknown) => void> }>)[rule].create(context);
  handlers.Program?.({ type: 'Program' });
  handlers['Program:exit']?.();
  return reported;
}

const ids = (msgs: ReturnType<typeof lint>) => msgs.map((m) => m.messageId);

describe('eslint-plugin-pledge', () => {
  it('exports every documented rule', () => {
    expect(Object.keys(plugin.rules).sort()).toEqual([
      'no-async-in-client-component',
      'no-dangerously-set-inner-html',
      'no-default-export-in-layout',
      'no-default-export-in-page',
      'no-eval',
      'no-implied-eval',
      'no-new-func',
      'no-secrets-in-client',
      'no-unsafe-fetch',
      'no-use-client-in-server',
    ]);
  });

  describe('page / layout default export', () => {
    it('reports a page without a default export', () => {
      const msgs = lint('no-default-export-in-page', 'export const x = 1;', 'app/page.tsx');
      expect(ids(msgs)).toEqual(['missingDefault']);
    });

    it('accepts a page with a default export', () => {
      expect(lint('no-default-export-in-page', 'export default function Page() { return null; }', 'app/page.tsx')).toEqual([]);
    });

    it('ignores non-page files', () => {
      expect(lint('no-default-export-in-page', 'export const x = 1;', 'app/util.ts')).toEqual([]);
    });

    it('reports a layout without a default export and accepts one with', () => {
      expect(ids(lint('no-default-export-in-layout', 'export const y = 1;', 'app/layout.tsx'))).toEqual(['missingDefault']);
      expect(lint('no-default-export-in-layout', 'export default function L() { return null; }', 'app/layout.tsx')).toEqual([]);
    });

    it('only matches files named exactly page/layout, not names that merely end that way', () => {
      expect(lint('no-default-export-in-layout', 'export const helper = 1;', 'app/og-layout.ts')).toEqual([]);
      expect(lint('no-default-export-in-page', 'export const helper = 1;', 'app/homepage.tsx')).toEqual([]);
      expect(lint('no-async-in-client-component', 'export default async function P() { return null; }', 'app/homepage.tsx')).toEqual([]);
    });

    it('recognises Windows-style absolute paths (backslashes, drive letter)', () => {
      const reports = runRuleOnFile('no-default-export-in-page', 'C:' + B + 'proj' + B + 'app' + B + 'page.tsx');
      expect(reports).toEqual(['missingDefault']);
      expect(runRuleOnFile('no-default-export-in-layout', 'C:' + B + 'proj' + B + 'app' + B + 'layout.tsx')).toEqual(['missingDefault']);
      expect(runRuleOnFile('no-default-export-in-page', 'C:' + B + 'proj' + B + 'app' + B + 'util.ts')).toEqual([]);
    });
  });

  describe('no-async-in-client-component', () => {
    it('flags async default-export functions and arrows in pages', () => {
      expect(ids(lint('no-async-in-client-component', 'export default async function P() { return null; }', 'app/page.tsx'))).toEqual(['noAsync']);
      expect(ids(lint('no-async-in-client-component', 'export default async () => null;', 'app/layout.tsx'))).toEqual(['noAsync']);
    });

    it('allows sync components and non-page files', () => {
      expect(lint('no-async-in-client-component', 'export default function P() { return null; }', 'app/page.tsx')).toEqual([]);
      expect(lint('no-async-in-client-component', 'export default async function P() { return null; }', 'lib/x.tsx')).toEqual([]);
    });
  });

  describe('no-use-client-in-server', () => {
    it('flags "use client" in server-only files (including on Windows paths)', () => {
      expect(ids(lint('no-use-client-in-server', '"use client";\nexport default function E() { return null; }', 'app/error.tsx'))).toEqual(['noUseClient']);
      const winPath = 'C:' + B + 'proj' + B + 'app' + B + 'loading.tsx';
      expect(runRuleOnFile('no-use-client-in-server', winPath, '"use client";')).toEqual(['noUseClient']);
    });

    it('does not flag other files or files without the directive', () => {
      expect(lint('no-use-client-in-server', '"use client";\nexport default function B() { return null; }', 'app/button.tsx')).toEqual([]);
      expect(lint('no-use-client-in-server', 'export default function E() { return null; }', 'app/error.tsx')).toEqual([]);
    });
  });

  describe('security rules', () => {
    it('no-eval', () => {
      expect(ids(lint('no-eval', 'eval("1+1");', 'a.ts'))).toEqual(['noEval']);
      expect(lint('no-eval', 'const evaluate = (x: string) => x; evaluate("1");', 'a.ts')).toEqual([]);
    });

    it('no-implied-eval flags string timers only', () => {
      expect(ids(lint('no-implied-eval', 'setTimeout("doIt()", 10);', 'a.ts'))).toEqual(['noImpliedEval']);
      expect(ids(lint('no-implied-eval', 'setInterval("doIt()", 10);', 'a.ts'))).toEqual(['noImpliedEval']);
      expect(lint('no-implied-eval', 'setTimeout(() => {}, 10);', 'a.ts')).toEqual([]);
    });

    it('no-new-func', () => {
      expect(ids(lint('no-new-func', 'const f = new Function("return 1");', 'a.ts'))).toEqual(['noNewFunc']);
      expect(lint('no-new-func', 'const f = new Map();', 'a.ts')).toEqual([]);
    });

    it('no-dangerously-set-inner-html', () => {
      expect(ids(lint('no-dangerously-set-inner-html', 'const a = <div dangerouslySetInnerHTML={{ __html: x }} />;', 'a.tsx'))).toEqual(['noDanger']);
      expect(lint('no-dangerously-set-inner-html', 'const a = <div className="x" />;', 'a.tsx')).toEqual([]);
    });

    it('no-unsafe-fetch flags dynamic URLs but not string literals', () => {
      expect(ids(lint('no-unsafe-fetch', 'fetch(url);', 'a.ts'))).toEqual(['unsafeFetch']);
      expect(ids(lint('no-unsafe-fetch', 'fetch(`https://x/${id}`);', 'a.ts'))).toEqual(['unsafeFetch']);
      expect(ids(lint('no-unsafe-fetch', 'fetch(req.url);', 'a.ts'))).toEqual(['unsafeFetch']);
      expect(lint('no-unsafe-fetch', 'fetch("https://api.example.com/x");', 'a.ts')).toEqual([]);
    });

    it('no-secrets-in-client flags long hard-coded secrets in client files only', () => {
      expect(ids(lint('no-secrets-in-client', 'const apiKey = "sk_live_1234567890";', 'src/foo.client.ts'))).toEqual(['noSecrets']);
      expect(lint('no-secrets-in-client', 'const apiKey = "short";', 'src/foo.client.ts')).toEqual([]);
      expect(lint('no-secrets-in-client', 'const apiKey = process.env.KEY;', 'src/foo.client.ts')).toEqual([]);
      expect(lint('no-secrets-in-client', 'const apiKey = "sk_live_1234567890";', 'src/server.ts')).toEqual([]);
    });
  });
});

describe('client directive handling', () => {
  it('no-use-client-in-server recognises the PledgeStack directive and leading comments', () => {
    expect(ids(lint('no-use-client-in-server', '"use pledge:client";\nexport default function E() { return null; }', 'app/error.tsx'))).toEqual(['noUseClient']);
    expect(ids(lint('no-use-client-in-server', '// header\n/* license */\n"use client";\nexport default function E() { return null; }', 'app/loading.tsx'))).toEqual(['noUseClient']);
    expect(lint('no-use-client-in-server', 'const s = "use client";\nexport default function E() { return null; }', 'app/error.tsx')).toEqual([]);
  });

  it('no-secrets-in-client keys off the file, not any "client" substring in the path', () => {
    const code = 'const apiKey = "sk_live_1234567890";';
    expect(lint('no-secrets-in-client', code, 'src/oauth-client-secret.ts')).toEqual([]);
    expect(lint('no-secrets-in-client', code, 'client-work/src/server.ts')).toEqual([]);
    expect(ids(lint('no-secrets-in-client', code, 'src/client/api.ts'))).toEqual(['noSecrets']);
    expect(ids(lint('no-secrets-in-client', '"use client";\n' + code, 'src/widget.tsx'))).toEqual(['noSecrets']);
    expect(ids(lint('no-secrets-in-client', '"use pledge:client";\n' + code, 'src/widget.tsx'))).toEqual(['noSecrets']);
  });

  it('no-dangerously-set-inner-html honours its allowSanitized option', () => {
    const safe = 'const a = <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(x) }} />;';
    const unsafe = 'const a = <div dangerouslySetInnerHTML={{ __html: x }} />;';
    expect(ids(lint('no-dangerously-set-inner-html', safe, 'a.tsx'))).toEqual(['noDanger']);
    expect(lint('no-dangerously-set-inner-html', safe, 'a.tsx', [{ allowSanitized: true }])).toEqual([]);
    expect(ids(lint('no-dangerously-set-inner-html', unsafe, 'a.tsx', [{ allowSanitized: true }]))).toEqual(['noDanger']);
  });
});
