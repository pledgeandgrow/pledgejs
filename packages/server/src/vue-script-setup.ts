/**
 * `<script setup>` support for the SSR Vue SFC transform.
 *
 * In a real SFC compiler every top-level binding of a `<script setup>` block
 * (imports, `const`/`let`/`var`, functions, classes — including destructured
 * names) is exposed to the template. This module does that analysis with a
 * small tokenizer-aware scanner (strings, template literals, comments and
 * bracket depth are respected), so the generated `setup()` can return them.
 */

export interface ScriptSetupAnalysis {
  /** `import ...` statements, hoisted to module scope (illegal inside setup()). */
  imports: string[];
  /** Everything else, to run inside `setup()`. */
  body: string;
  /** Names to expose to the template (value bindings only, type-only imports excluded). */
  bindings: string[];
}

const IDENT = /^[A-Za-z_$][\w$]*/;

/** Skips a string / template / comment starting at `i`; returns the index after it, or -1 if none starts here. */
function skipLiteral(code: string, i: number): number {
  const c = code[i];
  if (c === '/' && code[i + 1] === '/') {
    const nl = code.indexOf('\n', i);
    return nl === -1 ? code.length : nl;
  }
  if (c === '/' && code[i + 1] === '*') {
    const end = code.indexOf('*/', i + 2);
    return end === -1 ? code.length : end + 2;
  }
  if (c === '"' || c === "'") {
    let j = i + 1;
    while (j < code.length && code[j] !== c) j += code[j] === '\\' ? 2 : 1;
    return j + 1;
  }
  if (c === '`') {
    let j = i + 1;
    while (j < code.length && code[j] !== '`') {
      if (code[j] === '\\') j += 2;
      else if (code[j] === '$' && code[j + 1] === '{') {
        // nested expression: skip to matching brace
        let depth = 1;
        j += 2;
        while (j < code.length && depth > 0) {
          const skipped = skipLiteral(code, j);
          if (skipped !== -1) { j = skipped; continue; }
          if (code[j] === '{') depth++;
          else if (code[j] === '}') depth--;
          j++;
        }
      } else j++;
    }
    return j + 1;
  }
  return -1;
}

/** Returns [start, end) ranges of top-level statements (split on depth-0 `;`, newlines and blocks). */
function topLevelStatements(code: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  const flush = (end: number) => {
    if (code.slice(start, end).trim()) out.push([start, end]);
    start = end;
  };
  // A statement continues onto the next line when it ends with an operator or
  // the next line starts with one (method chains, ternaries, etc).
  const continues = (end: number, next: number) => {
    const before = code.slice(start, end).trimEnd();
    if (/[=+\-*/%&|^<>?:,(.[{]$/.test(before) && !/(\+\+|--)$/.test(before)) return true;
    const after = code.slice(next).trimStart();
    return /^(?:[.?:+\-*/%&|=<>,]|instanceof\b|in\b|as\b|satisfies\b)/.test(after) && !/^(?:\+\+|--)/.test(after) && !after.startsWith('//') && !after.startsWith('/*');
  };
  while (i < code.length) {
    const skipped = skipLiteral(code, i);
    if (skipped !== -1) { i = skipped; continue; }
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      // A closing brace at depth 0 ends function/class/block statements
      // (but not `const x = {...}` — that continues to its own terminator).
      if (depth === 0 && c === '}') {
        const head = code.slice(start, i).trimStart();
        if (/^(?:export\s+)?(?:async\s+)?function\b|^(?:export\s+)?class\b|^(?:if|for|while|switch|try|do)\b/.test(head)) {
          // Trailing `else`/`catch`/`finally` blocks continue the statement.
          const rest = code.slice(i + 1).trimStart();
          if (!/^(?:else|catch|finally)\b/.test(rest)) flush(i + 1);
        }
      }
    } else if (depth === 0 && c === ';') {
      flush(i + 1);
    } else if (depth === 0 && c === '\n') {
      if (code.slice(start, i).trim() && !continues(i, i + 1)) flush(i);
    }
    i++;
  }
  flush(code.length);
  return out;
}

/** Splits `s` on depth-0 commas (objects, arrays, calls, generics-free). */
function splitDepth0(s: string, sep = ','): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const skipped = skipLiteral(s, i);
    if (skipped !== -1) { i = skipped - 1; continue; }
    const c = s[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && c === sep) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

/** Identifiers bound by a destructuring/simple pattern (defaults and type annotations ignored). */
function patternIdentifiers(pattern: string, out: string[]): void {
  const p = pattern.trim();
  if (!p) return;
  if (p.startsWith('{') || p.startsWith('[')) {
    const isObj = p.startsWith('{');
    const inner = p.slice(1, p.lastIndexOf(isObj ? '}' : ']'));
    for (const rawEntry of splitDepth0(inner)) {
      let entry = rawEntry.trim();
      if (!entry) continue;
      if (entry.startsWith('...')) entry = entry.slice(3).trim();
      // strip default value: `a = 1` / `{ x } = {}`
      const eq = splitDepth0(entry, '=');
      entry = eq[0].trim();
      if (isObj) {
        // `key: target` -> target; shorthand -> key
        const colon = splitDepth0(entry, ':');
        entry = (colon.length > 1 ? colon[1] : colon[0]).trim();
      }
      patternIdentifiers(entry, out);
    }
    return;
  }
  const m = IDENT.exec(p);
  if (m) out.push(m[0]);
}

/** Names introduced by an `import` statement (type-only imports excluded). */
function importBindings(stmt: string, out: string[]): void {
  let s = stmt.trim().replace(/^import\s+/, '');
  if (/^type\b(?!\s*,|\s+from\b)/.test(s)) return; // `import type ...`
  if (/^['"]/.test(s)) return; // side-effect import
  const fromIdx = s.lastIndexOf(' from ');
  const clause = (fromIdx === -1 ? s : s.slice(0, fromIdx)).trim();
  s = clause;
  const brace = s.indexOf('{');
  const head = (brace === -1 ? s : s.slice(0, brace)).replace(/,\s*$/, '').trim();
  if (head) {
    const ns = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(head);
    if (ns) out.push(ns[1]);
    else if (IDENT.test(head)) out.push(head.split(',')[0].trim());
  }
  if (brace !== -1) {
    const inner = s.slice(brace + 1, s.lastIndexOf('}'));
    for (const spec of inner.split(',')) {
      const t = spec.trim();
      if (!t || /^type\s+\S/.test(t)) continue;
      const as = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(t);
      out.push(as ? as[1] : t);
    }
  }
}

/**
 * Analyzes a `<script setup>` body: hoists imports and collects the top-level
 * bindings the template can reference.
 */
export function analyzeScriptSetup(code: string): ScriptSetupAnalysis {
  const imports: string[] = [];
  const bodyParts: string[] = [];
  const bindings: string[] = [];
  let cursor = 0;

  for (const [start, end] of topLevelStatements(code)) {
    // keep inter-statement text (comments/blank lines) in the body
    if (start > cursor) bodyParts.push(code.slice(cursor, start));
    cursor = end;
    const stmt = code.slice(start, end);
    const trimmed = stmt.trim();

    if (/^import\s*(?:[\w$*{'"]|type\b)/.test(trimmed) && !/^import\s*\(/.test(trimmed) && !/^import\.meta/.test(trimmed)) {
      imports.push(trimmed.endsWith(';') ? trimmed : `${trimmed};`);
      importBindings(trimmed, bindings);
      continue;
    }

    bodyParts.push(stmt);

    const decl = /^(?:export\s+)?(?:const|let|var)\s+/.exec(trimmed);
    if (decl) {
      const rest = trimmed.slice(decl[0].length).replace(/;$/, '');
      for (const declarator of splitDepth0(rest)) {
        // pattern is everything before the first depth-0 `=` (or `:` type annotation for identifiers)
        const pattern = splitDepth0(declarator, '=')[0];
        const isDestructure = /^\s*[{[]/.test(pattern);
        patternIdentifiers(isDestructure ? pattern : pattern.split(':')[0], bindings);
      }
      continue;
    }
    const fn = /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(trimmed);
    if (fn) { bindings.push(fn[1]); continue; }
    const cls = /^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(trimmed);
    if (cls) bindings.push(cls[1]);
  }
  if (cursor < code.length) bodyParts.push(code.slice(cursor));

  return {
    imports,
    body: bodyParts.join('').replace(/^\s*\n/, ''),
    bindings: [...new Set(bindings)].filter((b) => b !== 'default'),
  };
}

/** Wraps a compiled `mode: 'function'` render body so it yields the render function. */
export function renderFunctionFromCompiled(code: string): string {
  return `new Function('Vue', ${JSON.stringify(code)})(__Vue)`;
}

/** Template syntax that needs a real compiler (interpolation, directives, bindings). */
export function templateNeedsCompiler(template: string): boolean {
  return /\{\{|\sv-[\w:-]+|\s[:@#][\w.:-]+\s*=|<component\b|<slot\b|<transition\b|<keep-alive\b/i.test(template);
}

export interface VueModuleInput {
  moduleName: string;
  scriptSetup: string | null;
  /** Plain `<script>` body without `export default` (runs as setup). */
  plainScript: string | null;
  /** Plain `<script>` with `export default` (options-API component). */
  scriptExports: string | null;
  template: string | null;
  /** Result of compiling the template: full compiled code, or null when no compiler is available. */
  compiledRender: string | null;
}

/**
 * Generates the JS module for an SFC. For `<script setup>` the top-level
 * bindings are returned from `setup()` so the compiled template (and the
 * options API `this`) can see them.
 */
export function generateVueModule(input: VueModuleInput): string {
  const { moduleName, template, compiledRender } = input;
  const out: string[] = [
    // Aliased so they never clash with names the user's <script setup> imports.
    "import * as __Vue from 'vue';",
    'const { h: __h, defineComponent: __defineComponent } = __Vue;',
  ];

  // How the template becomes a render function.
  let renderExpr: string;
  if (template === null) {
    renderExpr = `() => __h('div', {}, ${JSON.stringify(`Vue component: ${moduleName}`)})`;
  } else if (compiledRender) {
    renderExpr = renderFunctionFromCompiled(compiledRender);
  } else {
    if (templateNeedsCompiler(template)) {
      throw new Error(
        `[pledgestack] ${moduleName}.vue: the <template> uses interpolation/directives but @vue/compiler-dom ` +
          'is not installed. Install it (pnpm add -D @vue/compiler-dom vue) so templates can see <script setup> bindings.',
      );
    }
    renderExpr = `() => __h('div', { innerHTML: ${JSON.stringify(template)} })`;
  }

  if (input.scriptExports) {
    out.push(input.scriptExports.replace('export default', 'const __component ='));
    out.push(`const __render = ${renderExpr};
if (__component && !__component.render) __component.render = __render;
export default __component;`);
    return out.join('\n');
  }

  let setupBody = '';
  let returned: string[] = [];
  if (input.scriptSetup !== null) {
    const analysis = analyzeScriptSetup(input.scriptSetup);
    out.push(...analysis.imports);
    setupBody = analysis.body;
    returned = analysis.bindings;
  } else if (input.plainScript) {
    setupBody = input.plainScript;
  }

  out.push(`const __render = ${renderExpr};

const __component = __defineComponent({
${setupBody || returned.length ? `  setup(__props, { attrs, slots, emit }) {
${setupBody}
    // <script setup>: every top-level binding is exposed to the template
    return { ${returned.join(', ')} };
  },` : ''}
  render: __render,
});

export default __component;`);
  return out.join('\n');
}
