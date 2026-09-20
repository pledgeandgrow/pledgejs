import { describe, it, expect } from 'vitest';
import { parsePSX, parsePS, rustTypeToTs } from './parser';

describe('rustTypeToTs', () => {
  it('maps nested generics without garbling', () => {
    expect(rustTypeToTs('Vec<Option<String>>')).toBe('(string | null)[]');
    expect(rustTypeToTs('Result<Vec<User>, sqlx::Error>')).toBe('User[]');
    expect(rustTypeToTs('Result<Option<String>, Error>')).toBe('string | null');
    expect(rustTypeToTs('Option<Vec<i32>>')).toBe('number[] | null');
    expect(rustTypeToTs('HashMap<String, Vec<i32>>')).toBe('Record<string, number[]>');
    expect(rustTypeToTs('Result<HashMap<String, i32>, Error>')).toBe('Record<string, number>');
  });
});

describe('parsePS function qualifiers', () => {
  it('marks `pub async fn` as pub + async', () => {
    const r = parsePS('pub async fn get_users(limit: i32) -> Result<Vec<User>, sqlx::Error> { todo!() }');
    expect(r.allFunctions).toHaveLength(1);
    const fn = r.allFunctions[0];
    expect(fn.name).toBe('get_users');
    expect(fn.isPub).toBe(true);
    expect(fn.isAsync).toBe(true);
    expect(fn.returnTypeName).toBe('User[]');
  });

  it('detects non-pub async fns and pub(crate) fns', () => {
    const r = parsePS('async fn a() {}\npub(crate) async fn b() {}\npub const fn c() -> i32 { 1 }\npub fn d() {}');
    const byName = Object.fromEntries(r.allFunctions.map((f) => [f.name, f]));
    expect(byName.a).toMatchObject({ isPub: false, isAsync: true });
    expect(byName.b).toMatchObject({ isPub: true, isAsync: true });
    expect(byName.c).toMatchObject({ isPub: true, isAsync: false });
    expect(byName.d).toMatchObject({ isPub: true, isAsync: false });
  });

  it('keeps spaces in return types (impl/dyn/mut)', () => {
    const r = parsePS("pub fn f() -> &'static str { \"x\" }\npub fn g() -> impl Iterator<Item = i32> { 0..1 }");
    expect(r.allFunctions[0].returnTypeName).toBe('string');
    expect(r.allFunctions[1].returnType).toContain('impl Iterator');
  });
});

describe('tokenizer lifetimes', () => {
  it('does not treat lifetimes as char literals', () => {
    const src = `pub fn pick<'a>(x: &'a str, y: &'a str) -> &'a str { x }
pub fn after(n: i32) -> i32 { n }`;
    const r = parsePS(src);
    expect(r.allFunctions.map((f) => f.name)).toEqual(['pick', 'after']);
    expect(r.allFunctions[0].params.map((p) => p.name)).toEqual(['x', 'y']);
    expect(r.allFunctions[0].params[0].typeName).toBe('string');
  });

  it('still handles char literals containing a quote', () => {
    const r = parsePS(`pub fn q() -> char { '\\'' }\npub fn z() -> char { 'a' }`);
    expect(r.allFunctions.map((f) => f.name)).toEqual(['q', 'z']);
  });
});

describe('struct fields', () => {
  it('parses one-line structs and nested generics', () => {
    const r = parsePS('pub struct P { pub x: i32, pub tags: Option<Vec<String>>, m: HashMap<String, i32> }');
    const fields = r.allStructs[0].fields;
    expect(fields.map((f) => f.name)).toEqual(['x', 'tags', 'm']);
    expect(fields[1].isOption).toBe(true);
    expect(fields[1].typeName).toBe('string[]');
    expect(fields[2].typeName).toBe('Record<string, number>');
  });

  it('keeps doc comments and skips attributes', () => {
    const r = parsePS(`pub struct U {
  /// the id, primary
  pub id: i32,
  #[serde(rename = "n")]
  pub name: String,
}`);
    const fields = r.allStructs[0].fields;
    expect(fields.map((f) => f.name)).toEqual(['id', 'name']);
    expect(fields[0].docComment).toBe('the id, primary');
  });
});

describe('enum variants', () => {
  it('keeps variants that have doc comments', () => {
    const r = parsePS(`pub enum Role {
  /// An admin
  Admin,
  /// A regular user
  User,
  Guest, // no docs
}`);
    expect(r.allEnums[0].variants.map((v) => v.name)).toEqual(['Admin', 'User', 'Guest']);
    expect(r.allEnums[0].variants[0].docComment).toBe('An admin');
  });
});

describe('inline rust! expressions', () => {
  it('captures expressions containing braces', () => {
    const r = parsePSX(`export default async function P() {
  const v = await rust! { format!("{}-{}", 1, if true { 2 } else { 3 }) };
  return <div>{v}</div>;
}`);
    expect(r.inlineExpressions).toHaveLength(1);
    expect(r.inlineExpressions[0].source).toBe('format!("{}-{}", 1, if true { 2 } else { 3 })');
    expect(r.tsxContent).toContain('const v = await __rust_expr_0();');
    expect(r.tsxContent).not.toContain('await await');
    expect(r.tsxContent).toContain('return <div>{v}</div>;');
  });

  it('does not match identifiers that merely end in "rust"', () => {
    const r = parsePSX('const a = trust! { 1 };');
    expect(r.inlineExpressions).toHaveLength(0);
  });
});

describe('block line numbers', () => {
  it('startLine points at the first line of the trimmed block source', () => {
    const src = 'import x from "y";\n\n<rust>\n\npub fn f() {}\n</rust>\n';
    const r = parsePSX(src);
    const block = r.rustBlocks[0];
    expect(src.split('\n')[block.startLine]).toBe(block.source.split('\n')[0]);
  });
});
