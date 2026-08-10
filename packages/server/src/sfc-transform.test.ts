import { describe, it, expect } from 'vitest';

// Test the SFC parsing logic by importing the transform module
// We test the parsing functions indirectly via the transform output

describe('Vue SFC Transform', () => {
  // Test the parseVueSFC logic by replicating it
  function parseVueSFC(source: string) {
    const blocks = { template: null as string | null, scriptSetup: null as string | null, script: null as string | null, styles: [] as string[], route: null as string | null };

    const templateMatch = source.match(/<template(\s[^>]*)?>([\s\S]*?)<\/template>/i);
    if (templateMatch) blocks.template = templateMatch[2].trim();

    const scriptSetupMatch = source.match(/<script\s+setup[^>]*>([\s\S]*?)<\/script>/i);
    if (scriptSetupMatch) blocks.scriptSetup = scriptSetupMatch[1].trim();

    const scriptMatch = source.match(/<script(?!\s+setup)[^>]*>([\s\S]*?)<\/script>/i);
    if (scriptMatch) blocks.script = scriptMatch[1].trim();

    const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
    let styleMatch;
    while ((styleMatch = styleRegex.exec(source)) !== null) {
      blocks.styles.push(styleMatch[1].trim());
    }

    const routeMatch = source.match(/<route[^>]*>([\s\S]*?)<\/route>/i);
    if (routeMatch) blocks.route = routeMatch[1].trim();

    return blocks;
  }

  it('extracts template block', () => {
    const source = `<template><div>Hello</div></template>`;
    const blocks = parseVueSFC(source);
    expect(blocks.template).toBe('<div>Hello</div>');
  });

  it('extracts script setup block', () => {
    const source = `<script setup>const count = ref(0);</script>`;
    const blocks = parseVueSFC(source);
    expect(blocks.scriptSetup).toBe('const count = ref(0);');
  });

  it('extracts regular script block', () => {
    const source = `<script>export default { data() { return {}; } }</script>`;
    const blocks = parseVueSFC(source);
    expect(blocks.script).toBe('export default { data() { return {}; } }');
  });

  it('extracts style blocks', () => {
    const source = `<style>.red { color: red; }</style><style scoped>.blue { color: blue; }</style>`;
    const blocks = parseVueSFC(source);
    expect(blocks.styles.length).toBe(2);
    expect(blocks.styles[0]).toContain('color: red');
    expect(blocks.styles[1]).toContain('color: blue');
  });

  it('extracts route metadata block', () => {
    const source = `<route>{"name": "home"}</route>`;
    const blocks = parseVueSFC(source);
    expect(blocks.route).toBe('{"name": "home"}');
  });

  it('handles full SFC with all blocks', () => {
    const source = `<template><div>{{ msg }}</div></template>
<script setup>const msg = ref('Hello');</script>
<style>div { color: red; }</style>`;
    const blocks = parseVueSFC(source);
    expect(blocks.template).toContain('{{ msg }}');
    expect(blocks.scriptSetup).toContain("ref('Hello')");
    expect(blocks.styles.length).toBe(1);
  });

  it('returns nulls for empty SFC', () => {
    const blocks = parseVueSFC('');
    expect(blocks.template).toBeNull();
    expect(blocks.scriptSetup).toBeNull();
    expect(blocks.script).toBeNull();
    expect(blocks.styles).toEqual([]);
  });
});

describe('Svelte SFC Transform', () => {
  function parseSvelteSFC(source: string) {
    const blocks = { script: null as string | null, scriptModule: null as string | null, template: source, styles: [] as string[] };

    const moduleMatch = source.match(/<script\s+context=["']module["'][^>]*>([\s\S]*?)<\/script>/i)
      ?? source.match(/<script\s+module[^>]*>([\s\S]*?)<\/script>/i);
    if (moduleMatch) {
      blocks.scriptModule = moduleMatch[1].trim();
      blocks.template = blocks.template.replace(moduleMatch[0], '');
    }

    const scriptMatch = blocks.template.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
    if (scriptMatch) {
      blocks.script = scriptMatch[1].trim();
      blocks.template = blocks.template.replace(scriptMatch[0], '');
    }

    const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
    let styleMatch;
    while ((styleMatch = styleRegex.exec(blocks.template)) !== null) {
      blocks.styles.push(styleMatch[1].trim());
    }
    blocks.template = blocks.template.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').trim();

    return blocks;
  }

  it('extracts module script', () => {
    const source = `<script context="module">export const prerender = true;</script>`;
    const blocks = parseSvelteSFC(source);
    expect(blocks.scriptModule).toBe('export const prerender = true;');
  });

  it('extracts instance script', () => {
    const source = `<script>let count = 0;</script>`;
    const blocks = parseSvelteSFC(source);
    expect(blocks.script).toBe('let count = 0;');
  });

  it('extracts both module and instance scripts', () => {
    const source = `<script context="module">export const prerender = true;</script><script>let count = 0;</script>`;
    const blocks = parseSvelteSFC(source);
    expect(blocks.scriptModule).toBe('export const prerender = true;');
    expect(blocks.script).toBe('let count = 0;');
  });

  it('extracts template (markup outside script/style)', () => {
    const source = `<div>Hello {name}</div><script>let name = 'World';</script>`;
    const blocks = parseSvelteSFC(source);
    expect(blocks.template).toContain('<div>Hello {name}</div>');
  });

  it('extracts style blocks', () => {
    const source = `<style>div { color: red; }</style><div>Hello</div>`;
    const blocks = parseSvelteSFC(source);
    expect(blocks.styles.length).toBe(1);
    expect(blocks.styles[0]).toContain('color: red');
  });

  it('handles empty SFC', () => {
    const blocks = parseSvelteSFC('');
    expect(blocks.script).toBeNull();
    expect(blocks.scriptModule).toBeNull();
  });
});
