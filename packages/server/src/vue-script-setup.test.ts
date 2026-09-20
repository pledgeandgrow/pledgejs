import { describe, it, expect } from 'vitest';
import { analyzeScriptSetup, generateVueModule, templateNeedsCompiler } from './vue-script-setup';

describe('analyzeScriptSetup', () => {
  it('collects const/let/var, functions, classes and hoists imports', () => {
    const a = analyzeScriptSetup(`
import { ref, computed as comp } from 'vue';
import Foo from './Foo.vue';
import type { Bar } from './types';
import * as utils from './utils';
const count = ref(0);
let label = 'x', other = 2;
var legacy = 1;
function inc() { count.value++; }
async function load() { await 1; }
class Thing {}
`);
    expect(a.imports).toHaveLength(4);
    expect(a.imports.join('\n')).toContain("from 'vue'");
    expect(a.body).not.toContain('import ');
    expect(a.bindings.sort()).toEqual(
      ['Foo', 'Thing', 'comp', 'count', 'inc', 'label', 'legacy', 'load', 'other', 'ref', 'utils'].sort(),
    );
  });

  it('handles destructuring, defaults, renames and rest', () => {
    const a = analyzeScriptSetup(`
const { a, b: renamed, c = 1, ...rest } = obj;
const [first, , third = 3, ...tail] = arr;
const { nested: { deep } } = obj;
`);
    expect(a.bindings.sort()).toEqual(['a', 'c', 'deep', 'first', 'rest', 'renamed', 'tail', 'third'].sort());
  });

  it('does not treat nested declarations or strings as top-level bindings', () => {
    const a = analyzeScriptSetup(`
const outer = () => {
  const inner = 1;
  return inner;
};
function f() {
  const insideFn = 1;
}
const s = "const fake = 1; import x from 'y'";
const t = \`\${1 + 1} const alsoFake = 2\`;
// const commented = 1
/* let blockCommented = 2 */
if (outer()) {
  const inIf = 1;
}
`);
    expect(a.bindings.sort()).toEqual(['f', 'outer', 's', 't']);
  });

  it('handles TS annotations and multi-line initializers / chains', () => {
    const a = analyzeScriptSetup(`
const n: number = 1
const list = [1, 2, 3]
  .map((x) => x * 2)
  .filter(Boolean)
const obj = {
  a: 1,
  b: 2,
}
const after = 3
`);
    expect(a.bindings.sort()).toEqual(['after', 'list', 'n', 'obj']);
  });

  it('keeps side-effect imports hoisted but exposes nothing for them', () => {
    const a = analyzeScriptSetup(`import './style.css';\nconst v = 1;`);
    expect(a.imports).toEqual(["import './style.css';"]);
    expect(a.bindings).toEqual(['v']);
  });

  it('does not hoist dynamic import() or import.meta', () => {
    const a = analyzeScriptSetup(`const mod = await import('./x');\nconst u = import.meta.url;`);
    expect(a.imports).toEqual([]);
    expect(a.bindings).toEqual(['mod', 'u']);
  });
});

describe('generateVueModule', () => {
  const base = {
    moduleName: 'Counter',
    plainScript: null,
    scriptExports: null,
  };

  it('returns <script setup> bindings from setup() so the template can see them', () => {
    const code = generateVueModule({
      ...base,
      scriptSetup: "import { ref } from 'vue';\nconst count = ref(0);\nfunction inc() { count.value++; }",
      template: '<button @click="inc">{{ count }}</button>',
      compiledRender: 'return function render(_ctx) { return _ctx.count }',
    });
    expect(code).toContain('return { ref, count, inc };');
    // imports are hoisted out of setup()
    expect(code.indexOf("import { ref } from 'vue';")).toBeLessThan(code.indexOf('setup('));
    expect(code).toContain('render: __render');
    expect(code).toContain('new Function');
    // does not clash with the user's own `ref` import
    expect(code).not.toMatch(/import \{[^}]*\bdefineComponent\b[^}]*\} from 'vue'/);
  });

  it('fails loudly when the template needs a compiler that is not installed', () => {
    expect(() =>
      generateVueModule({ ...base, scriptSetup: 'const x = 1', template: '<p>{{ x }}</p>', compiledRender: null }),
    ).toThrow(/@vue\/compiler-dom is not installed/);
  });

  it('allows static templates without a compiler', () => {
    const code = generateVueModule({ ...base, scriptSetup: 'const x = 1', template: '<p>hi</p>', compiledRender: null });
    expect(code).toContain('innerHTML');
    expect(templateNeedsCompiler('<p>hi</p>')).toBe(false);
    expect(templateNeedsCompiler('<p :a="b"></p>')).toBe(true);
  });

  it('options-API scripts are merged with the render function', () => {
    const code = generateVueModule({
      ...base,
      scriptSetup: null,
      scriptExports: 'export default { data() { return { a: 1 } } }',
      template: '<p>hi</p>',
      compiledRender: null,
    });
    expect(code).toContain('const __component = { data()');
    expect(code).toContain('__component.render = __render');
  });
});
