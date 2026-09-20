/**
 * PSX codegen — generates TypeScript types, NAPI bindings, and Rust source
 * from parsed .psx files.
 *
 * Given a PSXParseResult, produces:
 * 1. TypeScript type definitions (.d.ts) from Rust structs/enums
 * 2. NAPI binding Rust code (napi-rs macros) wrapping user functions
 * 3. JavaScript wrapper module that imports the native addon
 * 4. Complete Rust source file (Cargo.toml + lib.rs) for compilation
 */

import type { PSXParseResult, RustFunction, SourceMapEntry } from './types';
import { parseGenericType } from './parser';
import { rustCrateName } from './workspace';

/** Makes a doc comment safe to embed in a JSDoc block (escapes the terminator). */
function safeJsDoc(text: string): string {
  return text.replace(/\*\//g, '*\\/');
}

/**
 * Generates TypeScript type definitions from Rust structs and enums.
 */
export function generateTypeDefinitions(parse: PSXParseResult): string {
  const lines: string[] = [
    '/**',
    ' * Auto-generated type definitions from .psx Rust blocks.',
    ' * Do not edit manually — PledgePack regenerates on build.',
    ' */',
    '',
  ];

  // Generate enums
  for (const enumDef of parse.allEnums) {
    if (enumDef.docComment) lines.push(`/** ${safeJsDoc(enumDef.docComment)} */`);
    lines.push(`export type ${enumDef.name} = ${enumDef.variants.map((v) => `'${v.name}'`).join(' | ') || 'never'};`);
    lines.push('');
  }

  // Generate structs as interfaces
  for (const struct of parse.allStructs) {
    if (struct.docComment) lines.push(`/** ${safeJsDoc(struct.docComment)} */`);
    lines.push(`export interface ${struct.name} {`);
    for (const field of struct.fields) {
      if (field.docComment) lines.push(`  /** ${safeJsDoc(field.docComment)} */`);
      const optional = field.isOption ? '?' : '';
      lines.push(`  ${field.name}${optional}: ${field.typeName};`);
    }
    lines.push('}');
    lines.push('');
  }

  // Generate rust namespace declaration
  const publicFunctions = parse.allFunctions.filter((fn) => fn.isPub);
  if (publicFunctions.length > 0 || parse.inlineExpressions.length > 0) {
    lines.push('export declare const rust: {');
    for (const fn of publicFunctions) {
      const params = fn.params
        .filter((p) => p.name !== 'self' && p.name !== '&self' && !isPoolParam(p))
        .map((p) => `${p.name}: ${p.typeName}`)
        .join(', ');
      if (fn.docComment) lines.push(`  /** ${safeJsDoc(fn.docComment)} */`);
      lines.push(`  ${fn.name}(${params}): Promise<${fn.returnTypeName}>;`);
    }
    for (const expr of parse.inlineExpressions) {
      lines.push(`  ${expr.varName}(): Promise<unknown>;`);
    }
    lines.push('};');
  }

  return lines.join('\n');
}

/** True when the function's declared return type is `Result<..>` (any path). */
function returnsResult(fn: RustFunction): boolean {
  const generic = parseGenericType(fn.returnType);
  return !!generic && (generic.base.split('::').pop() === 'Result');
}

/**
 * Generates the NAPI binding Rust code that wraps user functions
 * for Node.js FFI access via napi-rs.
 *
 * `standalone` (default) prepends the `use` lines the bindings need. Pass
 * `false` when the bindings are appended to a file that already imports them
 * (see generateRustSource) — duplicate `use` items are a Rust compile error.
 */
export function generateNapiBindings(parse: PSXParseResult, opts: { standalone?: boolean } = {}): string {
  const standalone = opts.standalone ?? true;
  const lines: string[] = [
    '// Auto-generated NAPI bindings from .psx Rust blocks.',
    '// Do not edit manually — PledgePack regenerates on build.',
    '',
  ];
  if (standalone) {
    lines.push('use napi_derive::napi;', 'use serde::Serialize;', '');
  }

  const ctx = buildNapiContext(parse);

  // Napi mirrors of user structs/enums (`#[napi(object)]` cannot be applied
  // to the user's own types) plus `From` conversions in both directions, so
  // function signatures can accept/return the mirrors while the user's
  // functions keep working with their own types.
  for (const struct of parse.allStructs) {
    if (struct.docComment) lines.push(`/// ${struct.docComment.replace(/\n/g, '\n/// ')}`);
    lines.push('#[napi(object)]');
    lines.push(`pub struct ${struct.name}Napi {`);
    for (const field of struct.fields) {
      const napiType = rustTypeToNapi(field.type, ctx);
      lines.push(`  pub ${field.name}: ${field.isOption ? `Option<${napiType}>` : napiType},`);
    }
    lines.push('}');
    lines.push('');
    for (const [from, to, dir] of [
      [struct.name, `${struct.name}Napi`, 'toNapi'],
      [`${struct.name}Napi`, struct.name, 'fromNapi'],
    ] as const) {
      lines.push(`impl From<${from}> for ${to} {`);
      lines.push(`    fn from(v: ${from}) -> Self {`);
      lines.push(`        ${to} {`);
      for (const field of struct.fields) {
        const fieldType = field.isOption ? `Option<${field.type}>` : field.type;
        lines.push(`            ${field.name}: ${convertExpr(`v.${field.name}`, fieldType, ctx, dir)},`);
      }
      lines.push('        }');
      lines.push('    }');
      lines.push('}');
      lines.push('');
    }
  }

  for (const en of parse.allEnums) {
    if (!ctx.unitEnums.has(en.name)) continue;
    lines.push('#[napi(string_enum)]');
    lines.push(`pub enum ${en.name}Napi {`);
    for (const v of en.variants) lines.push(`    ${v.name},`);
    lines.push('}');
    lines.push('');
    for (const [from, to] of [[en.name, `${en.name}Napi`], [`${en.name}Napi`, en.name]] as const) {
      lines.push(`impl From<${from}> for ${to} {`);
      lines.push(`    fn from(v: ${from}) -> Self {`);
      lines.push('        match v {');
      for (const v of en.variants) lines.push(`            ${from}::${v.name} => ${to}::${v.name},`);
      lines.push('        }');
      lines.push('    }');
      lines.push('}');
      lines.push('');
    }
  }

  // `pool` parameters are injected from a process-wide lazily created pool.
  const publicFns = parse.allFunctions.filter((fn) => fn.isPub);
  if (publicFns.some((fn) => fn.params.some(isPoolParam))) {
    for (const fn of publicFns) for (const p of fn.params) if (isPoolParam(p)) poolKind(p, fn.name);
    lines.push(POOL_HELPER, '');
  }

  // Add napi-wrapped functions
  for (const fn of publicFns) {
    if (fn.docComment) lines.push(`/// ${fn.docComment.replace(/\n/g, '\n/// ')}`);
    // napi-rs camelCases exported names by default; pin the JS name so the
    // generated wrapper (`addon.<name>_napi`) always finds it.
    lines.push(`#[napi(js_name = "${fn.name}_napi")]`);

    const userParams = fn.params.filter((p) => p.name !== 'self' && p.name !== '&self');
    const wireParams = userParams.filter((p) => !isPoolParam(p));
    const params = wireParams
      .map((p) => {
        // `&mut T` params are received by value and re-borrowed mutably.
        const mutable = /^&\s*mut\b/.test(p.type.trim()) ? 'mut ' : '';
        return `${mutable}${p.name}: ${rustTypeToNapi(p.type, ctx)}`;
      })
      .join(', ');

    const returnType = rustTypeToNapi(fn.returnType, ctx);
    lines.push(`pub async fn ${fn.name}_napi(${params}) -> Result<${returnType}, napi::Error> {`);

    // Build the call to the user's function: inject the pool, convert napi
    // mirrors back into the user's types and re-borrow reference params.
    const callArgs: string[] = [];
    for (const p of userParams) {
      if (isPoolParam(p)) {
        poolKind(p, fn.name);
        const byValue = !p.type.trim().startsWith('&');
        callArgs.push(byValue ? '__pledge_pool().await?.clone()' : '__pledge_pool().await?');
        continue;
      }
      const t = p.type.trim();
      const prefix = /^&\s*mut\b/.test(t) ? '&mut ' : t.startsWith('&') ? '&' : '';
      if (needsConv(t, ctx)) {
        const local = `__arg_${p.name}`;
        lines.push(`    ${prefix === '&mut ' ? 'let mut' : 'let'} ${local} = ${convertExpr(p.name, t, ctx, 'fromNapi')};`);
        callArgs.push(`${prefix}${local}`);
      } else {
        callArgs.push(`${prefix}${p.name}`);
      }
    }

    // Only `.await` async functions and only `map_err` functions that return
    // a Result — anything else does not compile.
    const call = `${fn.name}(${callArgs.join(', ')})${fn.isAsync ? '.await' : ''}`;
    const generic = parseGenericType(fn.returnType);
    const okType = returnsResult(fn) ? generic?.args[0] : fn.returnType;
    const convOut = okType !== undefined && needsConv(okType, ctx);
    if (returnsResult(fn)) {
      if (convOut) {
        lines.push(`    let __out = ${call}.map_err(|e| napi::Error::from_reason(e.to_string()))?;`);
        lines.push(`    Ok(${convertExpr('__out', okType, ctx, 'toNapi')})`);
      } else {
        lines.push(`    ${call}.map_err(|e| napi::Error::from_reason(e.to_string()))`);
      }
    } else if (convOut) {
      lines.push(`    let __out = ${call};`);
      lines.push(`    Ok(${convertExpr('__out', okType, ctx, 'toNapi')})`);
    } else {
      lines.push(`    Ok(${call})`);
    }
    lines.push('}');
    lines.push('');
  }

  // Add inline expression functions
  for (const expr of parse.inlineExpressions) {
    lines.push(`#[napi(js_name = "${expr.varName}")]`);
    lines.push(`pub async fn ${expr.varName}() -> Result<serde_json::Value, napi::Error> {`);
    lines.push(`    let result = { ${expr.source} };`);
    lines.push(`    serde_json::to_value(result).map_err(|e| napi::Error::from_reason(e.to_string()))`);
    lines.push('}');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generates the complete Rust source file for cargo compilation.
 * Combines user code + NAPI bindings + necessary imports.
 * Also produces source map entries mapping generated lines to original .psx/.ps lines.
 */
export function generateRustSource(
  parse: PSXParseResult,
  moduleName: string,
): { rustSource: string; sourceMap: SourceMapEntry[] } {
  const lines: string[] = [
    `// Auto-generated Rust source for ${moduleName}.psx`,
    '// Do not edit manually — PledgePack regenerates on build.',
    '',
  ];
  const sourceMap: SourceMapEntry[] = [];

  // Standard imports. The user's blocks are emitted verbatim below and carry
  // their own `use` statements, so we must NOT re-emit them (a duplicate
  // `use` is error E0252) and must skip any standard import the user already
  // brought into scope.
  const userImports = parse.allImports.join('\n');
  const importsIdent = (ident: string) => new RegExp(`\\b${ident}\\b`).test(userImports);
  if (!importsIdent('napi_derive')) lines.push('use napi_derive::napi;');
  if (!importsIdent('Serialize')) lines.push('use serde::Serialize;');
  if (!importsIdent('Deserialize')) lines.push('use serde::Deserialize;');
  lines.push('');

  // User Rust code (from blocks) — track line offsets for source mapping
  for (const block of parse.rustBlocks) {
    const blockStartLine = lines.length;
    lines.push('// === User Rust code ===');
    // Split block source into lines and track mapping
    const blockLines = block.source.split('\n');
    for (let i = 0; i < blockLines.length; i++) {
      const generatedLine = blockStartLine + 1 + i; // +1 for the comment line
      const originalLine = block.startLine + i;
      sourceMap.push({
        generatedLine,
        originalLine,
        moduleName,
      });
      lines.push(blockLines[i]);
    }
    lines.push('');
  }

  // NAPI bindings (functions, structs and inline expressions). The imports
  // are already in the header above.
  lines.push('// === NAPI bindings (auto-generated) ===');
  lines.push(generateNapiBindings(parse, { standalone: false }));

  return { rustSource: lines.join('\n'), sourceMap };
}

/**
 * Generates a Cargo.toml for the .psx module.
 */
export function generateCargoToml(moduleName: string, parse: PSXParseResult): string {
  const hasSqlx = parse.allImports.some((i) => i.includes('sqlx'));

  const dependencies: string[] = [
    'napi = { version = "2", features = ["napi8", "async"] }',
    'napi-derive = "2"',
    'serde = { version = "1", features = ["derive"] }',
    'serde_json = "1"',
    'tokio = { version = "1", features = ["full"] }',
  ];

  if (hasSqlx) {
    dependencies.push('sqlx = { version = "0.7", features = ["runtime-tokio", "postgres", "macros", "chrono"] }');
  }

  return `[package]
name = "${rustCrateName(moduleName)}"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
${dependencies.map((d) => `${d}`).join('\n')}

[profile.release]
lto = true
opt-level = 3
`;
}

/**
 * Generates the JavaScript wrapper that imports the native addon
 * and provides the `rust` namespace.
 */
export function generateNapiWrapper(
  parse: PSXParseResult,
  addonPath: string,
): string {
  const lines: string[] = [
    '/**',
    ' * Auto-generated NAPI wrapper for .psx Rust functions.',
    ' * Do not edit manually — PledgePack regenerates on build.',
    ' */',
    '',
    // The wrapper uses ESM `export`, where `require` is not defined.
    "import { createRequire } from 'node:module';",
    'const require = createRequire(import.meta.url);',
    `const addon = require(${JSON.stringify(addonPath)});`,
    '',
    'export const rust = {',
  ];

  for (const fn of parse.allFunctions) {
    if (!fn.isPub) continue;
    lines.push(`  ${fn.name}: addon.${fn.name}_napi,`);
  }

  for (const expr of parse.inlineExpressions) {
    lines.push(`  ${expr.varName}: addon.${expr.varName},`);
  }

  lines.push('};');
  lines.push('');

  return lines.join('\n');
}

// ── Napi mirror types & conversions ──────────────────────────────────

interface NapiContext {
  /** User structs (each gets a `<Name>Napi` mirror). */
  structs: Set<string>;
  /** Enums whose variants are all unit variants (mirrored as string enums). */
  unitEnums: Set<string>;
  /** Enums with struct-like variants — not representable across NAPI. */
  dataEnums: Set<string>;
}

function buildNapiContext(parse: PSXParseResult): NapiContext {
  const ctx: NapiContext = { structs: new Set(), unitEnums: new Set(), dataEnums: new Set() };
  for (const s of parse.allStructs) ctx.structs.add(s.name);
  for (const e of parse.allEnums) {
    if (e.variants.some((v) => v.fields !== undefined)) ctx.dataEnums.add(e.name);
    else ctx.unitEnums.add(e.name);
  }
  return ctx;
}

/** Strips references, lifetimes and `mut` so only the value type remains. */
function cleanRustType(rustType: string): string {
  return rustType
    .replace(/&/g, '')
    .replace(/'\w+/g, '')
    .replace(/\bmut\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const lastSegment = (name: string) => name.split('::').pop() ?? name;

/** True when the (cleaned) type mentions a user struct/enum that has a mirror. */
function needsConv(rustType: string, ctx: NapiContext): boolean {
  const t = cleanRustType(rustType);
  const generic = parseGenericType(t);
  if (generic) {
    const name = lastSegment(generic.base);
    if (name === 'Option' || name === 'Vec' || name === 'HashMap' || name === 'Result') {
      return generic.args.some((a) => needsConv(a, ctx));
    }
    return false;
  }
  const name = lastSegment(t);
  return ctx.structs.has(name) || ctx.unitEnums.has(name);
}

/**
 * Rust expression converting `expr` (of `rustType`) between the user's types
 * and their napi mirrors. `toNapi`: user -> mirror; `fromNapi`: mirror -> user.
 */
function convertExpr(expr: string, rustType: string, ctx: NapiContext, dir: 'toNapi' | 'fromNapi'): string {
  const t = cleanRustType(rustType);
  if (!needsConv(t, ctx)) return expr;
  const generic = parseGenericType(t);
  if (generic) {
    const name = lastSegment(generic.base);
    const [a, b] = generic.args;
    switch (name) {
      case 'Option':
        return `${expr}.map(|__v| ${convertExpr('__v', a, ctx, dir)})`;
      case 'Vec':
        return `${expr}.into_iter().map(|__v| ${convertExpr('__v', a, ctx, dir)}).collect::<Vec<_>>()`;
      case 'HashMap':
        return `${expr}.into_iter().map(|(__k, __v)| (__k, ${convertExpr('__v', b, ctx, dir)})).collect::<std::collections::HashMap<_, _>>()`;
      default:
        return expr;
    }
  }
  const name = lastSegment(t);
  const target = dir === 'toNapi' ? `${name}Napi` : name;
  return `${target}::from(${expr})`;
}

// ── Connection pool injection ────────────────────────────────────────

/**
 * A parameter named `pool` whose type is an sqlx pool is not part of the JS
 * signature: the generated wrapper injects a process-wide pool instead.
 */
export function isPoolParam(p: { name: string; type: string }): boolean {
  return p.name === 'pool' && /Pool\b/.test(p.type);
}

/** True when any public function of the module takes an injected `pool`. */
export function usesPoolInjection(parse: PSXParseResult): boolean {
  return parse.allFunctions.some((fn) => fn.isPub && fn.params.some(isPoolParam));
}

/**
 * Validates the pool parameter type. Only Postgres pools are supported (the
 * generated helper builds a `sqlx::PgPool` from `DATABASE_URL`); anything else
 * fails at codegen time rather than producing Rust that does not compile.
 */
function poolKind(p: { name: string; type: string }, fnName: string): 'pg' {
  const t = p.type.replace(/\s+/g, '').replace(/^&/, '');
  if (t.startsWith('mut')) {
    throw new Error(`[pledgestack] ${fnName}(): \`pool\` must be a shared reference (&PgPool) or PgPool, not \`&mut\`.`);
  }
  if (/^(?:sqlx::)?(?:postgres::)?PgPool$/.test(t) || /^(?:sqlx::)?Pool<(?:sqlx::)?(?:postgres::)?Postgres>$/.test(t)) {
    return 'pg';
  }
  throw new Error(
    `[pledgestack] ${fnName}(): unsupported \`pool\` parameter type \`${p.type}\`. ` +
      'Automatic pool injection supports only Postgres (`&PgPool` / `&sqlx::PgPool`, connected via DATABASE_URL). ' +
      'Rename the parameter (e.g. `db`) and build the pool yourself for other databases.',
  );
}

const POOL_HELPER = [
  '// === Injected connection pool (auto-generated) ===',
  '// `pool: &PgPool` parameters are not part of the JS signature: the pool is',
  '// created lazily, once per addon, from DATABASE_URL.',
  'static __PLEDGE_POOL: tokio::sync::OnceCell<sqlx::PgPool> = tokio::sync::OnceCell::const_new();',
  '',
  "async fn __pledge_pool() -> Result<&'static sqlx::PgPool, napi::Error> {",
  '    __PLEDGE_POOL',
  '        .get_or_try_init(|| async {',
  '            let url = std::env::var("DATABASE_URL").map_err(|_| {',
  '                napi::Error::from_reason("DATABASE_URL is not set (required by `pool` parameters)")',
  '            })?;',
  '            let max = std::env::var("PLEDGE_DB_MAX_CONNECTIONS")',
  '                .ok()',
  '                .and_then(|v| v.parse::<u32>().ok())',
  '                .unwrap_or(10);',
  '            sqlx::postgres::PgPoolOptions::new()',
  '                .max_connections(max)',
  '                .connect(&url)',
  '                .await',
  '                .map_err(|e| napi::Error::from_reason(format!("failed to connect to DATABASE_URL: {e}")))',
  '        })',
  '        .await',
  '}',
].join('\n');

/**
 * Maps Rust types to NAPI-compatible Rust types.
 */
function rustTypeToNapi(rustType: string, ctx: NapiContext): string {
  const trimmed = cleanRustType(rustType);

  const generic = parseGenericType(trimmed);
  if (generic) {
    const name = lastSegment(generic.base);
    const [a, b] = generic.args;
    switch (name) {
      case 'Option':
      case 'Vec':
        if (a !== undefined) return `${name}<${rustTypeToNapi(a, ctx)}>`;
        break;
      case 'HashMap':
        if (a !== undefined && b !== undefined) return `HashMap<${rustTypeToNapi(a, ctx)}, ${rustTypeToNapi(b, ctx)}>`;
        break;
      case 'Result': // Result<T, E> → T (errors surface as napi::Error)
        if (a !== undefined) return rustTypeToNapi(a, ctx);
        break;
    }
    return trimmed;
  }

  // Primitives
  const primitiveMap: Record<string, string> = {
    'i8': 'i8',
    'i16': 'i16',
    'i32': 'i32',
    'i64': 'i64',
    'u8': 'u8',
    'u16': 'u16',
    'u32': 'u32',
    'u64': 'u64',
    'f32': 'f32',
    'f64': 'f64',
    'bool': 'bool',
    'String': 'String',
    'str': 'String',
    '()': '()',
  };

  if (primitiveMap[trimmed]) return primitiveMap[trimmed];

  const name = lastSegment(trimmed);
  if (ctx.dataEnums.has(name)) {
    throw new Error(
      `[pledgestack] enum \`${name}\` has struct-like variants, which cannot cross the NAPI boundary. ` +
        'Use a unit-only enum (mirrored as a string enum) or a struct, or keep it internal to Rust.',
    );
  }
  // User struct / unit enum → its Napi mirror; anything else passes through.
  if (ctx.structs.has(name) || ctx.unitEnums.has(name)) return `${name}Napi`;
  return trimmed;
}
