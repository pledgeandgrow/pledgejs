import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname, basename, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import {
  compilePSXModule,
  mapPanicToOriginal,
} from 'pledgestack-core';
import type { CargoConfig } from 'pledgestack-shared';
import { generateVueModule } from './vue-script-setup';
import {
  PLEDGEPACK_DEFAULT_PORT,
  fetchFromPledgepack,
  transformLocally,
  transformTsxLocally,
  clearTransformCacheDir,
  BoundedLRUMap,
  MAX_TRANSFORM_CACHE_ENTRIES,
  stubAssetImports,
} from 'pledgestack-shared';

const TRANSFORM_CACHE = new BoundedLRUMap<string, string>(MAX_TRANSFORM_CACHE_ENTRIES);

/** Cache for source maps: moduleName → { entries, sourceFilePath } */
const SOURCE_MAP_CACHE = new Map<string, { entries: import('pledgestack-core').SourceMapEntry[]; sourceFilePath: string }>();

/**
 * Transforms a TypeScript/TSX file to JavaScript using PledgePack's Rust compiler (Oxc).
 *
 * In dev mode, fetches the transformed module from PledgePack's dev server (axum + Oxc),
 * which handles JSX→JS, TS type stripping, CSS transforms, and CJS interop.
 * The transformed JS is written to a temp cache file and returned as a file URL for import().
 *
 * This replaces the previous esbuild-based transformation with PledgePack's native Rust pipeline.
 */
export async function transformFile(
  sourcePath: string,
  isDev: boolean,
  pledgepackPort?: number,
  cargoConfig?: CargoConfig,
  rootDir?: string,
  hostname?: string,
): Promise<string> {
  const projectRoot = rootDir ?? process.cwd();
  const ext = extname(sourcePath);

  // Handle .psx and .ps files — parse Rust, generate TSX/types + NAPI bindings
  if (ext === '.psx' || ext === '.ps') {
    return transformPSXFile(sourcePath, isDev, pledgepackPort, ext === '.ps' ? 'ps' : 'psx', cargoConfig, projectRoot, hostname);
  }

  // Handle .vue single-file components
  if (ext === '.vue') {
    return transformVueSFC(sourcePath, isDev, pledgepackPort, projectRoot, hostname);
  }

  // Handle .svelte single-file components
  if (ext === '.svelte') {
    return transformSvelteSFC(sourcePath, isDev, pledgepackPort, projectRoot, hostname);
  }

  // Handle .mdx files — compile MDX to JSX/JS
  if (ext === '.mdx') {
    return transformMDX(sourcePath, isDev, pledgepackPort, projectRoot, hostname);
  }

  if (ext !== '.ts' && ext !== '.tsx' && ext !== '.jsx' && ext !== '.mjs') {
    return pathToFileURL(sourcePath).href;
  }

  const cacheKey = isDev ? `${sourcePath}:${Date.now()}` : sourcePath;
  const cached = TRANSFORM_CACHE.get(cacheKey);
  if (cached) return cached;

  const port = pledgepackPort ?? PLEDGEPACK_DEFAULT_PORT;

  let transformedCode: string;

  if (isDev && port > 0) {
    transformedCode = stripBrowserHmr(
      await fetchFromPledgepack(sourcePath, port, projectRoot, hostname),
    );
  } else {
    transformedCode = await transformLocally(sourcePath, ext);
  }

  // Node cannot import CSS/asset modules — the transformed file also lives
  // in .pledge-cache/, where relative specifiers wouldn't resolve anyway.
  transformedCode = stubAssetImports(transformedCode);

  const hash = createHash('sha256').update(sourcePath).digest('hex').slice(0, 12);
  const cacheDir = join(dirname(sourcePath), '.pledge-cache');
  const outFileName = basename(sourcePath, ext) + `.${hash}.js`;
  const outPath = join(cacheDir, outFileName);

  await mkdir(cacheDir, { recursive: true });

  if (isDev) {
    const devOutPath = join(cacheDir, basename(sourcePath, ext) + `.${Date.now()}.js`);
    await writeFile(devOutPath, transformedCode, 'utf-8');
    const fileUrl = pathToFileURL(devOutPath).href;
    TRANSFORM_CACHE.set(cacheKey, fileUrl);
    return fileUrl;
  }

  await writeFile(outPath, transformedCode, 'utf-8');
  const fileUrl = pathToFileURL(outPath).href;
  TRANSFORM_CACHE.set(cacheKey, fileUrl);
  return fileUrl;
}

/**
 * Removes the browser-only HMR polyfill PledgePack's dev server prepends to
 * every transformed module. The polyfill registers `import.meta.hot`
 * callbacks on `window`, which doesn't exist when the module is imported
 * for SSR — dev mode loads these modules in Node.
 *
 * The block is dead-coded rather than deleted: replacing the guard keeps the
 * transform byte-identical in shape, and the trailing
 * `if (import.meta.hot) { import.meta.hot.accept(); }` is already a no-op in
 * Node (import.meta.hot is undefined).
 */
function stripBrowserHmr(code: string): string {
  if (!code.includes('// Pledge HMR polyfill')) return code;
  return code.replace('if (!import.meta.hot)', 'if (false)');
}

/**
 * Clears the transform cache directory.
 */
export async function clearTransformCache(dir: string): Promise<void> {
  await clearTransformCacheDir(dir);
  TRANSFORM_CACHE.clear();
}

/**
 * Transforms a .psx file:
 * 1. Parses <rust> blocks and inline rust!{} expressions
 * 2. Generates TypeScript types from Rust structs
 * 3. Generates Rust source + Cargo.toml for cargo compilation
 * 4. Generates NAPI wrapper JS
 * 5. Writes source map for error mapping (#207)
 * 6. Compiles Rust with incremental cache (#214) and error mapping (#210)
 * 7. Captures println! output for console.log bridge (#211)
 * 8. Returns the file URL for the transformed module
 */
async function transformPSXFile(
  sourcePath: string,
  isDev: boolean,
  pledgepackPort?: number,
  format: 'psx' | 'ps' = 'psx',
  cargoConfig?: CargoConfig,
  rootDir?: string,
  hostname?: string,
): Promise<string> {
  const projectRoot = rootDir ?? process.cwd();
  const ext = format === 'ps' ? '.ps' : '.psx';
  const moduleName = basename(sourcePath, ext);

  // Shared pipeline (also used by the bundler load hooks): parse, write
  // artifacts, cargo-build the addon (serialized + isolated per source file)
  // and write the NAPI wrapper or the fallback stub.
  const compiled = await compilePSXModule({
    sourcePath,
    format,
    isDev,
    projectRoot,
    cargoConfig,
    // The transformed module is emitted next to the wrapper (<name>.napi.js).
    wrapperImportPath: `./${moduleName}.napi.js`,
    // #208 HMR: notify connected clients that the addon was recompiled.
    onAddonBuilt: ({ moduleName: m, sourcePath: sp }) => notifyRustAddonReload(m, sp),
  });
  const { result, cacheDir } = compiled;

  // Keep the source map for #210 error mapping
  if (result.sourceMap && result.sourceMap.length > 0) {
    SOURCE_MAP_CACHE.set(moduleName, {
      entries: result.sourceMap,
      sourceFilePath: sourcePath,
    });
  }

  // For .ps files (pure Rust), there's no TSX to transform — just use the NAPI wrapper
  if (format === 'ps') {
    const wrapperPath = join(cacheDir, `${moduleName}.napi.js`);
    const fileUrl = pathToFileURL(wrapperPath).href;
    const cacheKey = isDev ? `${sourcePath}:${Date.now()}` : sourcePath;
    TRANSFORM_CACHE.set(cacheKey, fileUrl);
    return fileUrl;
  }

  // Transform the TSX portion (Oxc or esbuild) — only for .psx files
  let transformedCode: string;
  const port = pledgepackPort ?? PLEDGEPACK_DEFAULT_PORT;

  if (isDev && port > 0) {
    // Write TSX to temp file and fetch from PledgePack
    const tsxTempPath = join(cacheDir, `${moduleName}.tsx`);
    await writeFile(tsxTempPath, result.tsx, 'utf-8');
    transformedCode = stripBrowserHmr(
      await fetchFromPledgepack(tsxTempPath, port, projectRoot, hostname),
    );
  } else {
    transformedCode = await transformTsxLocally(result.tsx, isDev);
  }
  transformedCode = stubAssetImports(transformedCode);

  const hash = createHash('sha256').update(sourcePath).digest('hex').slice(0, 12);
  const outFileName = `${moduleName}.${hash}.js`;
  const outPath = join(cacheDir, outFileName);
  await writeFile(outPath, transformedCode, 'utf-8');

  const fileUrl = pathToFileURL(outPath).href;
  const cacheKey = isDev ? `${sourcePath}:${Date.now()}` : sourcePath;
  TRANSFORM_CACHE.set(cacheKey, fileUrl);
  return fileUrl;
}

/**
 * ── #208: PSX HMR ──────────────────────────────────────────────────────
 * Notifies connected dev server clients that a Rust addon was recompiled.
 * The client can then reload the module without a full page refresh.
 *
 * This is a simple event emitter — the dev server connects to it via
 * the HMR websocket and triggers a module reload when notified.
 */
type HMRListener = (moduleName: string, sourceFilePath: string) => void;
const HMR_LISTENERS = new Set<HMRListener>();

/** Register a listener for Rust addon reload events */
export function onRustAddonReload(listener: HMRListener): void {
  HMR_LISTENERS.add(listener);
}

/** Unregister a listener */
export function offRustAddonReload(listener: HMRListener): void {
  HMR_LISTENERS.delete(listener);
}

/** Notify all listeners that a Rust addon was recompiled (#208) */
function notifyRustAddonReload(moduleName: string, sourceFilePath: string): void {
  for (const listener of HMR_LISTENERS) {
    try {
      listener(moduleName, sourceFilePath);
    } catch {
      // Listener errors shouldn't affect compilation
    }
  }
}

/**
 * ── #208: PSX HMR ──────────────────────────────────────────────────────
 * Invalidates the transform cache for a .psx/.ps file, forcing recompilation
 * on next access. Called when the file watcher detects a change.
 */
export function invalidatePSXCache(sourcePath: string): void {
  // Remove all cache entries for this source path
  for (const key of TRANSFORM_CACHE.keys()) {
    if (key.startsWith(sourcePath)) {
      TRANSFORM_CACHE.delete(key);
    }
  }
}

/**
 * ── #210: Rust→JS error mapping ────────────────────────────────────────
 * Maps a Rust panic message from a NAPI error to the original .psx/.ps
 * source location. Used by the error overlay to show accurate source lines.
 */
export function mapNapiErrorToSource(
  errorMessage: string,
  moduleName: string,
): { message: string; sourceLine: number; sourceFile: string } | null {
  const sourceMapEntry = SOURCE_MAP_CACHE.get(moduleName);
  if (!sourceMapEntry) return null;

  return mapPanicToOriginal(
    errorMessage,
    sourceMapEntry.entries,
    sourceMapEntry.sourceFilePath,
  );
}

// ── Vue SFC Transform ────────────────────────────────────────────────

/**
 * Parses a Vue Single-File Component (.vue) into its blocks.
 * Extracts <template>, <script setup>, <script>, <style>, and <route> blocks.
 */
interface VueSFCBlocks {
  template: string | null;
  scriptSetup: string | null;
  script: string | null;
  styles: string[];
  route: string | null;
}

function parseVueSFC(source: string): VueSFCBlocks {
  const blocks: VueSFCBlocks = {
    template: null,
    scriptSetup: null,
    script: null,
    styles: [],
    route: null,
  };

  // Extract <template>
  const templateMatch = source.match(/<template(\s[^>]*)?>([\s\S]*?)<\/template>/i);
  if (templateMatch) blocks.template = templateMatch[2].trim();

  // Extract <script setup> (has higher priority)
  const scriptSetupMatch = source.match(/<script\s+setup[^>]*>([\s\S]*?)<\/script>/i);
  if (scriptSetupMatch) blocks.scriptSetup = scriptSetupMatch[1].trim();

  // Extract regular <script> (without setup)
  const scriptMatch = source.match(/<script(?!\s+setup)[^>]*>([\s\S]*?)<\/script>/i);
  if (scriptMatch) blocks.script = scriptMatch[1].trim();

  // Extract <style> blocks
  const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let styleMatch;
  while ((styleMatch = styleRegex.exec(source)) !== null) {
    blocks.styles.push(styleMatch[1].trim());
  }

  // Extract <route> block (for route metadata)
  const routeMatch = source.match(/<route[^>]*>([\s\S]*?)<\/route>/i);
  if (routeMatch) blocks.route = routeMatch[1].trim();

  return blocks;
}

/**
 * Compiles a Vue template with @vue/compiler-dom (resolved from the project
 * first, then from this package). Returns the compiled render code
 * (`mode: 'function'`, evaluated later against the `Vue` namespace), or null
 * when the compiler is not installed.
 */
function compileVueTemplate(template: string, projectRoot: string): string | null {
  const candidates = [join(projectRoot, 'package.json'), import.meta.url];
  for (const base of candidates) {
    try {
      const req = createRequire(base);
      const { compile } = req('@vue/compiler-dom') as {
        compile: (t: string, o: Record<string, unknown>) => { code: string };
      };
      return compile(template, { mode: 'function', hoistStatic: true }).code;
    } catch (err) {
      // A template syntax error must surface; only "module not found" falls through.
      if ((err as NodeJS.ErrnoException)?.code !== 'MODULE_NOT_FOUND') throw err;
    }
  }
  return null;
}

/**
 * Transforms a .vue SFC into a JS module that can be imported by Node.js.
 *
 * The generated module (see generateVueModule):
 *   1. Imports Vue and hoists the imports of <script setup>
 *   2. Runs the <script setup> body in setup() and returns every top-level
 *      binding so the template can reference it
 *   3. Compiles the <template> into a render function
 *   4. Exports a default component definition
 */
async function transformVueSFC(
  sourcePath: string,
  isDev: boolean,
  // Reserved for dev-mode module URL rewriting / relative import resolution,
  // matching transformReactSFC's signature — not yet needed by this transform.
  _pledgepackPort: number | undefined,
  projectRoot: string,
  _hostname?: string,
): Promise<string> {
  const source = await readFile(sourcePath, 'utf-8');
  const blocks = parseVueSFC(source);
  const moduleName = basename(sourcePath, '.vue');

  // Regular <script> — with `export default` it is an options-API component,
  // otherwise it runs as setup code.
  let plainScript: string | null = null;
  let scriptExports: string | null = null;
  if (!blocks.scriptSetup && blocks.script) {
    if (blocks.script.includes('export default')) scriptExports = blocks.script;
    else plainScript = blocks.script;
  }

  const compiledRender = blocks.template ? compileVueTemplate(blocks.template, projectRoot) : null;

  const parts: string[] = [
    generateVueModule({
      moduleName,
      scriptSetup: blocks.scriptSetup,
      plainScript,
      scriptExports,
      template: blocks.template,
      compiledRender,
    }),
  ];

  // Route metadata from <route> block
  if (blocks.route) {
    let routeMeta = blocks.route;
    try {
      routeMeta = JSON.stringify(JSON.parse(blocks.route));
    } catch {
      // Not valid JSON — leave as-is
    }
    parts.push(`export const route = ${routeMeta};`);
  }

  // Export styles as a string (injected at runtime)
  if (blocks.styles.length > 0) {
    const allStyles = blocks.styles.join('\n').replace(/\\/g, '\\\\').replace(/`/g, '\\`');
    parts.push(`export const __styles = \`${allStyles}\`;`);
  }

  let transformedCode = parts.join('\n');

  // <script setup lang="ts"> — strip the types so Node can import the module.
  if (/<script[^>]*\blang\s*=\s*["']tsx?["']/i.test(source)) {
    transformedCode = await transformTsxLocally(transformedCode, isDev);
  }
  transformedCode = stubAssetImports(transformedCode);

  // Write to cache and return file URL
  const hash = createHash('sha256').update(sourcePath).digest('hex').slice(0, 12);
  const cacheDir = join(dirname(sourcePath), '.pledge-cache');
  await mkdir(cacheDir, { recursive: true });

  if (isDev) {
    const devOutPath = join(cacheDir, `${moduleName}.vue.${Date.now()}.js`);
    await writeFile(devOutPath, transformedCode, 'utf-8');
    return pathToFileURL(devOutPath).href;
  }

  const outPath = join(cacheDir, `${moduleName}.vue.${hash}.js`);
  await writeFile(outPath, transformedCode, 'utf-8');
  return pathToFileURL(outPath).href;
}

// ── Svelte SFC Transform ─────────────────────────────────────────────

/**
 * Parses a Svelte single-file component (.svelte) into its blocks.
 */
interface SvelteSFCBlocks {
  script: string | null;
  scriptModule: string | null; // <script context="module">
  template: string; // Svelte markup (everything outside <script> and <style>)
  styles: string[];
}

function parseSvelteSFC(source: string): SvelteSFCBlocks {
  const blocks: SvelteSFCBlocks = {
    script: null,
    scriptModule: null,
    template: source,
    styles: [],
  };

  // Extract <script context="module"> or <script module>
  const moduleMatch = source.match(/<script\s+context=["']module["'][^>]*>([\s\S]*?)<\/script>/i)
    ?? source.match(/<script\s+module[^>]*>([\s\S]*?)<\/script>/i);
  if (moduleMatch) {
    blocks.scriptModule = moduleMatch[1].trim();
    blocks.template = blocks.template.replace(moduleMatch[0], '');
  }

  // Extract regular <script>
  const scriptMatch = blocks.template.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
  if (scriptMatch) {
    blocks.script = scriptMatch[1].trim();
    blocks.template = blocks.template.replace(scriptMatch[0], '');
  }

  // Extract <style> blocks
  const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let styleMatch;
  while ((styleMatch = styleRegex.exec(blocks.template)) !== null) {
    blocks.styles.push(styleMatch[1].trim());
  }
  blocks.template = blocks.template.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').trim();

  return blocks;
}

/**
 * Transforms a .svelte SFC into a JS module.
 *
 * Uses svelte/compiler if available, otherwise generates a lightweight
 * component that renders the markup as static HTML.
 */
async function transformSvelteSFC(
  sourcePath: string,
  isDev: boolean,
  // Reserved for dev-mode module URL rewriting / relative import resolution,
  // matching transformReactSFC's signature — not yet needed by this transform.
  _pledgepackPort: number | undefined,
  _projectRoot: string,
  _hostname?: string,
): Promise<string> {
  const source = await readFile(sourcePath, 'utf-8');
  const blocks = parseSvelteSFC(source);
  const moduleName = basename(sourcePath, '.svelte');

  // Try to use svelte/compiler if available
  try {
    const { compile } = require('svelte/compiler');
    const result = compile(source, {
      generate: 'ssr',
      dev: isDev,
    });
    result.js.code = stubAssetImports(result.js.code);
    // The compiled SSR code is a JS module
    const cacheDir = join(dirname(sourcePath), '.pledge-cache');
    await mkdir(cacheDir, { recursive: true });
    if (isDev) {
      const devOutPath = join(cacheDir, `${moduleName}.svelte.${Date.now()}.js`);
      await writeFile(devOutPath, result.js.code, 'utf-8');
      return pathToFileURL(devOutPath).href;
    }
    const hash = createHash('sha256').update(sourcePath).digest('hex').slice(0, 12);
    const outPath = join(cacheDir, `${moduleName}.svelte.${hash}.js`);
    await writeFile(outPath, result.js.code, 'utf-8');
    return pathToFileURL(outPath).href;
  } catch {
    // svelte/compiler not available — generate a lightweight component
  }

  // Fallback: generate a component that exports a render function
  const parts: string[] = [];

  // Module-level script (exports)
  if (blocks.scriptModule) {
    parts.push(blocks.scriptModule);
  }

  // Instance script — wrap in a function that returns bindings
  const instanceCode = blocks.script || '';

  // Escape the template HTML for embedding
  const escapedTemplate = blocks.template
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');

  // Generate a simple SSR component
  parts.push(`
// Svelte component (fallback transform — install svelte for full compilation)
${instanceCode ? `const __instance = (() => {
  ${instanceCode}
  return {};
})();` : ''}

export function render(props = {}) {
  return \`${escapedTemplate}\`;
}

export default { render };
`);

  // Export styles
  if (blocks.styles.length > 0) {
    const allStyles = blocks.styles.join('\n').replace(/\\/g, '\\\\').replace(/`/g, '\\`');
    parts.push(`export const __styles = \`${allStyles}\`;`);
  }

  const transformedCode = stubAssetImports(parts.join('\n'));

  // Write to cache and return file URL
  const hash = createHash('sha256').update(sourcePath).digest('hex').slice(0, 12);
  const cacheDir = join(dirname(sourcePath), '.pledge-cache');
  await mkdir(cacheDir, { recursive: true });

  if (isDev) {
    const devOutPath = join(cacheDir, `${moduleName}.svelte.${Date.now()}.js`);
    await writeFile(devOutPath, transformedCode, 'utf-8');
    return pathToFileURL(devOutPath).href;
  }

  const outPath = join(cacheDir, `${moduleName}.svelte.${hash}.js`);
  await writeFile(outPath, transformedCode, 'utf-8');
  return pathToFileURL(outPath).href;
}

/**
 * Transforms an .mdx file into a JS module.
 * Uses a lightweight MDX-to-JSX compiler that extracts markdown content
 * and wraps it in a React component.
 */
async function transformMDX(
  sourcePath: string,
  isDev: boolean,
  pledgepackPort?: number,
  _projectRoot?: string,
  _hostname?: string,
): Promise<string> {
  const source = await readFile(sourcePath, 'utf-8');
  const moduleName = basename(sourcePath, '.mdx');
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 8);
  const cacheDir = join(dirname(sourcePath), '.pledge-cache', 'mdx');
  await mkdir(cacheDir, { recursive: true });

  // Check cache
  if (!isDev) {
    const cachedPath = join(cacheDir, `${moduleName}.${hash}.js`);
    if (existsSync(cachedPath)) return pathToFileURL(cachedPath).href;
  }

  // Simple MDX compilation: extract JSX blocks and convert markdown to JSX
  // This is a lightweight compiler — for full MDX support, use the mdxPlugin
  const compiledCode = compileMDX(source, moduleName);

  if (isDev && pledgepackPort) {
    // Unique file name per compile: Node caches ESM imports by URL, so reusing
    // one path would keep serving the first version after the .mdx is edited.
    const devOutPath = join(cacheDir, `${moduleName}.dev.${Date.now()}.js`);
    await writeFile(devOutPath, compiledCode, 'utf-8');
    return pathToFileURL(devOutPath).href;
  }

  const outPath = join(cacheDir, `${moduleName}.mdx.${hash}.js`);
  await writeFile(outPath, compiledCode, 'utf-8');
  return pathToFileURL(outPath).href;
}

/**
 * Lightweight MDX-to-JSX compiler.
 * Converts markdown to HTML elements and preserves embedded JSX.
 * Frontmatter (--- delimited) is stripped from the rendered content and
 * exported as `frontmatter`, honoring config.mdx.frontmatter (default: on).
 */
export function compileMDX(source: string, moduleName: string): string {
  // Extract frontmatter before compiling so --- blocks never render as
  // page content; the parsed data is exported for metadata resolution.
  const fmMatch = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  let frontmatter: Record<string, unknown> = {};
  let body = source;
  if (fmMatch) {
    body = source.slice(fmMatch[0].length);
    for (const line of fmMatch[1].split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      let value: unknown = line.slice(colonIdx + 1).trim();
      if (value === 'true') value = true;
      else if (value === 'false') value = false;
      else if (/^\d+$/.test(value as string)) value = Number(value);
      else if ((value as string).startsWith('[') && (value as string).endsWith(']')) {
        value = (value as string).slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      } else {
        value = (value as string).replace(/^["']|["']$/g, '');
      }
      frontmatter[key] = value;
    }
  }

  // Split into lines and process
  const lines = body.split('\n');
  const jsxParts: string[] = [];
  let inJsxBlock = false;
  let jsxBuffer: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    // Handle fenced code blocks
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        inCodeBlock = false;
        jsxParts.push(`</pre></code>`);
      } else {
        inCodeBlock = true;
        const lang = line.trim().slice(3);
        jsxParts.push(`<code><pre data-language="${lang}">`);
      }
      continue;
    }
    if (inCodeBlock) {
      jsxParts.push(line.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
      continue;
    }

    // Handle JSX blocks (lines starting with <)
    if (line.trim().startsWith('<') && !line.trim().startsWith('<img') && !line.trim().startsWith('<a ')) {
      if (!inJsxBlock) {
        inJsxBlock = true;
        jsxBuffer = [];
      }
      jsxBuffer.push(line);
      continue;
    }
    if (inJsxBlock) {
      if (line.trim() === '' || !line.trim().startsWith('<')) {
        jsxParts.push(jsxBuffer.join('\n'));
        jsxBuffer = [];
        inJsxBlock = false;
      } else {
        jsxBuffer.push(line);
        continue;
      }
    }

    // Markdown to JSX conversion
    const trimmed = line.trim();
    if (trimmed.startsWith('# ')) {
      jsxParts.push(`<h1>${trimmed.slice(2)}</h1>`);
    } else if (trimmed.startsWith('## ')) {
      jsxParts.push(`<h2>${trimmed.slice(3)}</h2>`);
    } else if (trimmed.startsWith('### ')) {
      jsxParts.push(`<h3>${trimmed.slice(4)}</h3>`);
    } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      jsxParts.push(`<li>${trimmed.slice(2)}</li>`);
    } else if (trimmed.startsWith('> ')) {
      jsxParts.push(`<blockquote>${trimmed.slice(2)}</blockquote>`);
    } else if (trimmed === '') {
      // Skip empty lines
    } else {
      // Paragraph — handle inline formatting
      let html = trimmed
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`(.+?)`/g, '<code>$1</code>')
        .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');
      jsxParts.push(`<p>${html}</p>`);
    }
  }
  if (inJsxBlock && jsxBuffer.length > 0) {
    jsxParts.push(jsxBuffer.join('\n'));
  }

  const jsxContent = jsxParts.join('\n');

  // The body is HTML produced above (embedded JSX blocks pass through as
  // markup). Passing it as a child string would make React render the tags
  // as literal, escaped text, so inject it as HTML instead.
  return `// Compiled from ${moduleName.replace(/[\r\n]/g, ' ')}.mdx
import { createElement as h } from 'react';

export const frontmatter = ${JSON.stringify(frontmatter)};

function MDXContent(props) {
  return h('div', { className: 'mdx-content', ...props, dangerouslySetInnerHTML: { __html: ${JSON.stringify(jsxContent)} } });
}

MDXContent.__mdx = true;
export default MDXContent;
`;
}
