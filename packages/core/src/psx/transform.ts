/**
 * PSX transform — the main entry point for .psx file processing.
 *
 * Takes raw .psx source, parses it, generates all artifacts, and returns
 * everything PledgePack needs to compile and serve the file.
 *
 * Pipeline:
 *   .psx source
 *     → parsePSX()           — split Rust blocks from TSX
 *     → generateTypeDefinitions() — .d.ts from Rust structs
 *     → generateRustSource()      — lib.rs for cargo
 *     → generateNapiBindings()    — NAPI binding Rust code
 *     → generateNapiWrapper()     — JS wrapper importing native addon
 *     → inject rust import into TSX
 *     → return all artifacts
 */

import { parsePSX, parsePS } from './parser';
import {
  generateTypeDefinitions,
  generateRustSource,
  generateNapiWrapper,
  generateNapiBindings,
} from './codegen';
import type { PSXTransformResult, SourceMapEntry } from './types';

export interface PSXTransformOptions {
  /** Module name (derived from filename, e.g., "users" from "users.psx") */
  moduleName: string;
  /** Output directory for generated artifacts */
  outputDir?: string;
  /** Path to the compiled native addon (relative to output) */
  addonPath?: string;
  /**
   * Module specifier the transformed TSX uses to import the generated NAPI
   * wrapper. Defaults to `addonPath` with `.node` -> `.js`. Bundlers that write
   * the wrapper as `<name>.napi.js` next to the emitted module pass
   * `./<name>.napi.js` here so the import resolves.
   */
  wrapperImportPath?: string;
  /** Whether to generate Rust artifacts (false = TSX-only mode) */
  compileRust?: boolean;
  /** File format: .psx (Rust+TSX) or .ps (pure Rust) */
  format?: 'psx' | 'ps';
}

/**
 * Transforms a .psx file into all its compiled artifacts.
 *
 * Usage:
 *   const result = transformPSX(source, { moduleName: 'users' });
 *   // result.tsx          — TypeScript/JSX for Oxc to compile
 *   // result.types        — .d.ts type definitions
 *   // result.rustSource   — lib.rs for cargo
 *   // result.napiBindings — NAPI binding code
 *   // result.napiWrapper  — JS wrapper for the native addon
 */
export function transformPSX(
  source: string,
  options: PSXTransformOptions,
): PSXTransformResult {
  const { moduleName, addonPath, wrapperImportPath, compileRust = true, format = 'psx' } = options;

  // .ps files are pure Rust — treat entire file as one Rust block
  // .psx files mix Rust and TypeScript/JSX
  const parse = format === 'ps' ? parsePS(source) : parsePSX(source);

  // If no Rust content, return the TSX as-is
  if (!parse.hasRust) {
    return {
      tsx: source,
      types: '',
      rustSource: '',
      napiBindings: '',
      napiWrapper: '',
      needsRustCompile: false,
      parse,
    };
  }

  // Generate TypeScript type definitions
  const types = generateTypeDefinitions(parse);

  // Generate Rust source for cargo compilation (includes source map)
  let rustSource = '';
  let sourceMap: SourceMapEntry[] | undefined;
  if (compileRust) {
    const result = generateRustSource(parse, moduleName);
    rustSource = result.rustSource;
    sourceMap = result.sourceMap;
  }

  // Generate NAPI bindings (included in rustSource, but also returned separately for tooling)
  const napiBindings = compileRust ? generateNapiBindings(parse) : '';

  // Generate JS wrapper that imports the native addon
  const resolvedAddonPath = addonPath ?? `./${moduleName}.node`;
  const napiWrapper = generateNapiWrapper(parse, resolvedAddonPath);

  // Inject the rust import at the top of the TSX content
  const rustImport = `import { rust } from ${JSON.stringify(wrapperImportPath ?? resolvedAddonPath.replace(/\.node$/, '.js'))};\n`;
  const tsx = rustImport + parse.tsxContent;

  return {
    tsx,
    types,
    rustSource,
    napiBindings,
    napiWrapper,
    needsRustCompile: compileRust,
    parse,
    sourceMap,
  };
}

/**
 * Writes all PSX artifacts to disk.
 * Called by PledgePack during the build process.
 */
export interface PSXArtifacts {
  tsxPath: string;
  typesPath: string;
  rustSourcePath: string;
  cargoTomlPath: string;
  napiWrapperPath: string;
}

export function getArtifactPaths(
  moduleName: string,
  outputDir: string,
): PSXArtifacts {
  const base = `${outputDir}/${moduleName}`;
  return {
    tsxPath: `${base}.tsx`,
    typesPath: `${base}.d.ts`,
    rustSourcePath: `${base}.rs`,
    cargoTomlPath: `${outputDir}/Cargo.toml`,
    napiWrapperPath: `${base}.js`,
  };
}

/**
 * Checks if a file path is a .psx file.
 */
export function isPSXFile(filePath: string): boolean {
  return filePath.endsWith('.psx');
}

/**
 * Checks if a file path is a .ps file (pure Rust).
 */
export function isPSFile(filePath: string): boolean {
  return filePath.endsWith('.ps');
}

/**
 * Checks if a file path is a PledgeStack native file (.psx or .ps).
 */
export function isPledgeFile(filePath: string): boolean {
  return filePath.endsWith('.psx') || filePath.endsWith('.ps');
}
