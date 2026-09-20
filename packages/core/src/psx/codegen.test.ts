import { describe, it, expect } from 'vitest';
import { parsePSX, parsePS } from './parser';
import { generateRustSource, generateNapiBindings, generateNapiWrapper, generateTypeDefinitions, usesPoolInjection } from './codegen';
import { transformPSX } from './transform';
import { rustLibName, generateModuleCargoToml } from './workspace';

const PSX = `<rust>
use sqlx::PgPool;

pub async fn get_users(limit: i32) -> Result<Vec<String>, sqlx::Error> { Ok(vec![]) }
pub fn add(a: i32, b: i32) -> i32 { a + b }
</rust>

export default async function P() {
  const n = await rust! { 1 + 1 };
  return <div>{n}</div>;
}`;

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe('generateRustSource', () => {
  const parse = parsePSX(PSX);
  const { rustSource } = generateRustSource(parse, 'users');

  it('does not emit duplicate imports', () => {
    expect(count(rustSource, 'use napi_derive::napi;')).toBe(1);
    expect(count(rustSource, 'use sqlx::PgPool;')).toBe(1);
  });

  it('defines each inline expression function once', () => {
    expect(count(rustSource, 'fn __rust_expr_0(')).toBe(1);
  });

  it('exports stable JS names for napi functions', () => {
    expect(rustSource).toContain('#[napi(js_name = "get_users_napi")]');
    expect(rustSource).toContain('#[napi(js_name = "__rust_expr_0")]');
  });

  it('only awaits async user functions and only maps Result errors', () => {
    expect(rustSource).toMatch(/get_users\(limit\)\.await\.map_err/);
    expect(rustSource).toMatch(/Ok\(add\(a, b\)\)/);
  });
});

describe('transformPSX', () => {
  it('returns NAPI bindings (not Cargo.toml) in napiBindings', () => {
    const r = transformPSX(PSX, { moduleName: 'users' });
    expect(r.napiBindings).toContain('#[napi');
    expect(r.napiBindings).not.toContain('[package]');
  });
});

describe('generateNapiWrapper', () => {
  it('quotes the addon path safely and works as ESM', () => {
    const parse = parsePS('pub fn add(a: i32, b: i32) -> i32 { a + b }');
    const js = generateNapiWrapper(parse, "./a'b\".node");
    expect(js).toContain(JSON.stringify("./a'b\".node"));
    expect(js).toContain('createRequire');
    expect(js).toContain('add: addon.add_napi');
  });
});

describe('generateNapiBindings type mapping', () => {
  it('maps nested generics', () => {
    const parse = parsePS('pub async fn f(x: Vec<Option<String>>) -> Result<Option<Vec<i32>>, Error> { todo!() }');
    const out = generateNapiBindings(parse);
    expect(out).toContain('x: Vec<Option<String>>');
    expect(out).toContain('Result<Option<Vec<i32>>, napi::Error>');
  });
});

describe('generateTypeDefinitions', () => {
  it('does not let a doc comment terminate the JSDoc block', () => {
    const parse = parsePS('/// evil */ export const x = 1; /*\npub fn f() {}');
    const dts = generateTypeDefinitions(parse);
    expect(dts).not.toMatch(/\/\*\* evil \*\//);
  });
});

describe('module naming', () => {
  it('derives the cargo lib name with hyphens normalised to underscores', () => {
    expect(rustLibName('user-list')).toBe('pledge_user_list');
    expect(rustLibName('page.client')).toBe('pledge_page_client');
    expect(generateModuleCargoToml('page.client')).toContain('name = "pledge-page_client"');
  });

  it('imports the wrapper through wrapperImportPath when given', () => {
    const r = transformPSX(PSX, { moduleName: 'users', wrapperImportPath: './users.napi.js' });
    expect(r.tsx.startsWith('import { rust } from "./users.napi.js";')).toBe(true);
    const d = transformPSX(PSX, { moduleName: 'users' });
    expect(d.tsx.startsWith('import { rust } from "./users.js";')).toBe(true);
  });
});

describe('napi mirror conversions (user structs)', () => {
  const SRC = `
#[derive(Serialize, Deserialize)]
pub struct Address { pub city: String }
pub struct User { pub id: i32, pub name: String, pub email: Option<String>, pub home: Address, pub tags: Vec<Address> }
pub enum Role { Admin, Guest }
pub fn get_user(id: i32) -> User { todo!() }
pub async fn find(id: i32) -> Result<Option<User>, String> { todo!() }
pub fn save(u: &User, role: Role, all: Vec<User>) -> Vec<User> { todo!() }
pub fn greet(name: &str) -> String { todo!() }
`;
  const out = generateNapiBindings(parsePS(SRC));

  it('emits From impls in both directions for every struct', () => {
    expect(out).toContain('impl From<User> for UserNapi {');
    expect(out).toContain('impl From<UserNapi> for User {');
    expect(out).toContain('impl From<Address> for AddressNapi {');
  });

  it('converts nested fields (Option, Vec, nested struct)', () => {
    expect(out).toContain('email: v.email,');
    expect(out).toContain('home: AddressNapi::from(v.home),');
    expect(out).toContain('tags: v.tags.into_iter().map(|__v| AddressNapi::from(__v)).collect::<Vec<_>>(),');
    expect(out).toContain('home: Address::from(v.home),');
  });

  it('converts return values and parameters at the function boundary', () => {
    expect(out).toContain('pub async fn get_user_napi(id: i32) -> Result<UserNapi, napi::Error> {');
    expect(out).toContain('let __out = get_user(id);');
    expect(out).toContain('Ok(__out.map(|__v| UserNapi::from(__v)))');
    expect(out).toContain('let __arg_u = User::from(u);');
    expect(out).toContain('save(&__arg_u, __arg_role, __arg_all)');
    expect(out).toContain('let __arg_role = Role::from(role);');
  });

  it('mirrors unit enums as string enums and leaves plain params alone', () => {
    expect(out).toContain('#[napi(string_enum)]');
    expect(out).toContain('impl From<RoleNapi> for Role {');
    expect(out).toContain('greet(&name)');
  });

  it('does not invent mirrors for types the module does not define', () => {
    const o = generateNapiBindings(parsePS('pub fn f(x: chrono::NaiveDate) -> uuid::Uuid { todo!() }'));
    expect(o).not.toContain('UuidNapi');
    expect(o).not.toContain('NaiveDateNapi');
  });

  it('refuses enums with struct-like variants at codegen time', () => {
    const p = parsePS('pub enum Shape { Circle { r: f64 } }\npub fn f(s: Shape) {}');
    expect(() => generateNapiBindings(p)).toThrow(/struct-like variants/);
  });
});

describe('pool parameter injection', () => {
  const SRC = `
use sqlx::PgPool;
pub async fn count(pool: &PgPool, min: i32) -> Result<i64, sqlx::Error> { todo!() }
`;
  const parse = parsePS(SRC);
  const out = generateNapiBindings(parse);

  it('removes the pool from the JS-facing signature and injects it in the call', () => {
    expect(out).toContain('pub async fn count_napi(min: i32) -> Result<i64, napi::Error> {');
    expect(out).toContain('count(__pledge_pool().await?, min).await.map_err');
    expect(generateTypeDefinitions(parse)).toContain('count(min: number)');
    expect(generateTypeDefinitions(parse)).not.toContain('pool');
  });

  it('emits a lazily created process-wide pool built from DATABASE_URL', () => {
    expect(out).toContain('tokio::sync::OnceCell<sqlx::PgPool>');
    expect(out).toContain('std::env::var("DATABASE_URL")');
    expect(out).toContain('PgPoolOptions');
    expect(usesPoolInjection(parse)).toBe(true);
  });

  it('does not emit the helper when no function takes a pool', () => {
    expect(generateNapiBindings(parsePS('pub fn f() -> i32 { 1 }'))).not.toContain('__pledge_pool');
  });

  it('fails loudly for unsupported pool types', () => {
    const p = parsePS('pub async fn f(pool: &MySqlPool) -> i32 { 1 }');
    expect(() => generateNapiBindings(p)).toThrow(/unsupported `pool` parameter type/);
  });

  it('a non-pool parameter that happens to be called pool is a normal param', () => {
    const o = generateNapiBindings(parsePS('pub fn f(pool: usize) -> usize { pool }'));
    expect(o).toContain('f_napi(pool: usize)');
  });
});
