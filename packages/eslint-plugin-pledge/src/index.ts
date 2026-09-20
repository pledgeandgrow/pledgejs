import type { Rule } from 'eslint';
import type { FunctionDeclaration, ArrowFunctionExpression, VariableDeclarator } from 'estree';

/** Filename of the linted file — `context.filename` (ESLint 9) with a fallback for older cores. Path separators are normalized so rules work on Windows. */
function filenameOf(context: Rule.RuleContext): string {
  const raw = (context as { filename?: string }).filename ?? context.getFilename();
  return raw.replace(/\\/g, '/');
}

/** Base name of a normalized path (`app/og-layout.ts` -> `og-layout.ts`), so `layout.ts` does not match `og-layout.ts`. */
function baseNameOf(filename: string): string {
  return filename.split('/').pop() ?? '';
}

/**
 * True when the source begins with a client directive ('use client' or
 * PledgeStack's 'use pledge:client'). A BOM, whitespace and leading comments
 * are allowed before it — they do not stop it from being a directive.
 */
export function hasClientDirective(source: string): boolean {
  let rest = source.replace(/^\uFEFF/, '');
  for (;;) {
    const trimmed = rest.replace(/^\s+/, '');
    if (trimmed.startsWith('//')) {
      const nl = trimmed.indexOf('\n');
      rest = nl === -1 ? '' : trimmed.slice(nl + 1);
    } else if (trimmed.startsWith('/*')) {
      const end = trimmed.indexOf('*/');
      rest = end === -1 ? '' : trimmed.slice(end + 2);
    } else {
      rest = trimmed;
      break;
    }
  }
  return /^(['"])use (?:client|pledge:client)\1/.test(rest);
}

const noDefaultExportInPage: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Enforce default export in page.tsx files',
    },
    messages: {
      missingDefault: 'page.tsx must have a default export (the page component)',
    },
    schema: [],
  },
  create(context) {
    const filename = filenameOf(context);
    if (!['page.tsx', 'page.ts'].includes(baseNameOf(filename))) return {};

    let hasDefaultExport = false;

    return {
      ExportDefaultDeclaration() {
        hasDefaultExport = true;
      },
      'Program:exit'() {
        if (!hasDefaultExport) {
          context.report({
            loc: { line: 1, column: 0 },
            messageId: 'missingDefault',
          });
        }
      },
    };
  },
};

const noDefaultExportInLayout: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Enforce default export in layout.tsx files',
    },
    messages: {
      missingDefault: 'layout.tsx must have a default export (the layout component)',
    },
    schema: [],
  },
  create(context) {
    const filename = filenameOf(context);
    if (!['layout.tsx', 'layout.ts'].includes(baseNameOf(filename))) return {};

    let hasDefaultExport = false;

    return {
      ExportDefaultDeclaration() {
        hasDefaultExport = true;
      },
      'Program:exit'() {
        if (!hasDefaultExport) {
          context.report({
            loc: { line: 1, column: 0 },
            messageId: 'missingDefault',
          });
        }
      },
    };
  },
};

const noAsyncInClientComponent: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow async client components',
    },
    messages: {
      noAsync: 'Client components cannot be async. Use React hooks for data fetching instead.',
    },
    schema: [],
  },
  create(context) {
    const filename = filenameOf(context);
    if (!['page.tsx', 'layout.tsx'].includes(baseNameOf(filename))) return {};

    return {
      'ExportDefaultDeclaration > FunctionDeclaration[async=true]'(node: FunctionDeclaration) {
        context.report({ node, messageId: 'noAsync' });
      },
      'ExportDefaultDeclaration > ArrowFunctionExpression[async=true]'(node: ArrowFunctionExpression) {
        context.report({ node, messageId: 'noAsync' });
      },
    };
  },
};

const noUseClientInServer: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Discourage "use client" in server-only files (layout.tsx, loading.tsx, error.tsx)',
    },
    messages: {
      noUseClient: '"use client" is not needed in {{file}} — this file is always a server component.',
    },
    schema: [],
  },
  create(context) {
    const filename = filenameOf(context);
    const serverOnlyFiles = ['loading.tsx', 'error.tsx', 'not-found.tsx', 'head.tsx', 'template.tsx'];
    const basename = filename.split(/[\\/]/).pop() ?? '';
    if (!serverOnlyFiles.includes(basename)) return {};

    return {
      Program(node) {
        const source = (context.sourceCode ?? context.getSourceCode()).getText(node);
        if (hasClientDirective(source)) {
          context.report({ loc: { line: 1, column: 0 }, messageId: 'noUseClient', data: { file: basename } });
        }
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Security lint rules (item 173)
// ---------------------------------------------------------------------------

const noEval: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow eval() — security risk' },
    messages: { noEval: 'eval() is not allowed — it can execute arbitrary code.' },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'eval') {
          context.report({ node, messageId: 'noEval' });
        }
      },
    };
  },
};

const noImpliedEval: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow implied eval via setTimeout/setInterval with string' },
    messages: { noImpliedEval: '{{fn}} with string argument is equivalent to eval() — use a function instead.' },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && ['setTimeout', 'setInterval', 'setImmediate'].includes(node.callee.name)) {
          if (node.arguments.length > 0 && node.arguments[0].type === 'Literal' && typeof (node.arguments[0] as { value: unknown }).value === 'string') {
            context.report({ node, messageId: 'noImpliedEval', data: { fn: node.callee.name } });
          }
        }
      },
    };
  },
};

const noNewFunc: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow new Function() — equivalent to eval()' },
    messages: { noNewFunc: 'new Function() is not allowed — it can execute arbitrary code.' },
    schema: [],
  },
  create(context) {
    return {
      NewExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'Function') {
          context.report({ node, messageId: 'noNewFunc' });
        }
      },
    };
  },
};

/** True for `{{ __html: fn(...) }}` where the callee's name contains "sanitize". */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isSanitizedHtml(value: any): boolean {
  const obj = value?.type === 'JSXExpressionContainer' ? value.expression : undefined;
  if (obj?.type !== 'ObjectExpression') return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const html = obj.properties.find((p: any) => p.type === 'Property' && (p.key?.name === '__html' || p.key?.value === '__html'));
  const call = html?.value;
  if (call?.type !== 'CallExpression') return false;
  const callee = call.callee;
  const calleeName = callee.type === 'Identifier' ? callee.name : callee.type === 'MemberExpression' ? callee.property?.name : '';
  return /sanitize/i.test(calleeName ?? '');
}

const noDangerouslySetInnerHTML: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow dangerouslySetInnerHTML — XSS risk' },
    messages: { noDanger: 'dangerouslySetInnerHTML is not allowed — use safe DOM APIs or a sanitizer.' },
    schema: [{ type: 'object', properties: { allowSanitized: { type: 'boolean' } } }],
  },
  create(context) {
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      JSXAttribute(node: any) {
        const name = node.name as { type: string; name?: string };
        if (name.type === 'JSXIdentifier' && name.name === 'dangerouslySetInnerHTML') {
          // `allowSanitized` (declared in the schema) permits `{ __html: sanitize(x) }`
          // / `DOMPurify.sanitize(x)` — the value must be passed through a call
          // whose name contains "sanitize".
          const allowSanitized = (context.options[0] as { allowSanitized?: boolean } | undefined)?.allowSanitized;
          if (allowSanitized && isSanitizedHtml(node.value)) return;
          context.report({ node, messageId: 'noDanger' });
        }
      },
    };
  },
};

const noUnsafeFetch: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Warn on fetch() with user-controlled URLs — SSRF risk' },
    messages: { unsafeFetch: 'fetch() with dynamic URL may be vulnerable to SSRF — validate the URL against an allowlist.' },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'fetch') {
          const arg = node.arguments[0];
          if (arg && (arg.type === 'Identifier' || arg.type === 'MemberExpression' || arg.type === 'TemplateLiteral')) {
            context.report({ node, messageId: 'unsafeFetch' });
          }
        }
      },
    };
  },
};

const noSecretsInClient: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow hardcoded secrets in client components' },
    messages: { noSecrets: 'Possible hardcoded secret in client component — use environment variables instead.' },
    schema: [],
  },
  create(context) {
    const filename = filenameOf(context);
    // A client file is one named *.client.ts(x), living under a `client`
    // directory, or opting in with a client directive. (Matching the substring
    // "client" anywhere in the path flagged e.g. "oauth-client-secret.ts" and
    // every project checked out under a folder called "client-work".)
    const dirs = filename.split('/').slice(0, -1);
    let isClient = /\.client\.[cm]?[jt]sx?$/.test(baseNameOf(filename)) || dirs.includes('client');

    const secretPatterns = [/secret/i, /api[_-]?key/i, /password/i, /token/i, /private[_-]?key/i];
    return {
      Program(node) {
        if (!isClient) {
          isClient = hasClientDirective((context.sourceCode ?? context.getSourceCode()).getText(node));
        }
      },
      VariableDeclarator(node: VariableDeclarator) {
        if (!isClient) return;
        if (node.id.type === 'Identifier' && secretPatterns.some((p) => p.test((node.id as { name: string }).name))) {
          if (node.init && node.init.type === 'Literal' && typeof node.init.value === 'string' && (node.init.value as string).length > 8) {
            context.report({ node, messageId: 'noSecrets' });
          }
        }
      },
    };
  },
};

const plugin = {
  rules: {
    'no-default-export-in-page': noDefaultExportInPage,
    'no-default-export-in-layout': noDefaultExportInLayout,
    'no-async-in-client-component': noAsyncInClientComponent,
    'no-use-client-in-server': noUseClientInServer,
    'no-eval': noEval,
    'no-implied-eval': noImpliedEval,
    'no-new-func': noNewFunc,
    'no-dangerously-set-inner-html': noDangerouslySetInnerHTML,
    'no-unsafe-fetch': noUnsafeFetch,
    'no-secrets-in-client': noSecretsInClient,
  },
} as const;

export default plugin;
export { plugin as pledgePlugin };
