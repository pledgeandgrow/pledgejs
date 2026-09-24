import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { detectCircularDeps, resolveImportPath } from './why';

function node(path: string, imports: string[]) {
  return { path, importers: new Set<string>(), imports: new Set(imports), isEntry: false };
}

describe('pledge why', () => {
  it('reports circular dependency chains in their real order (dedupe must not sort them)', () => {
    const graph = new Map([
      ['z.js', node('z.js', ['a.js'])],
      ['a.js', node('a.js', ['m.js'])],
      ['m.js', node('m.js', ['z.js'])],
    ]);
    const cycles = detectCircularDeps(graph, 'z.js');
    expect(cycles).toEqual([['z.js', 'a.js', 'm.js', 'z.js']]);
  });

  it('resolves multiple ../ segments', () => {
    const root = join(process.cwd(), 'proj');
    const from = join(root, 'out', 'a', 'b', 'c', 'entry.js');
    expect(resolveImportPath('../../shared/util.js', from, root)).toBe('out/a/shared/util.js');
    expect(resolveImportPath('./x.js', from, root)).toBe('out/a/b/c/x.js');
  });

  it('anchors specifiers that escape the project root instead of emitting raw ../../ chains', () => {
    const root = join(process.cwd(), 'proj');
    const from = join(root, '.pledge', 'chunk.js');
    const resolved = resolveImportPath('../../../../../../app/page.js', from, root)!;
    expect(resolved).not.toContain('..');
    expect(resolved.replace(/\\/g, '/')).toContain('app/page.js');
  });
});
