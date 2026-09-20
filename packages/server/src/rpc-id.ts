/**
 * Stable RPC ids for server actions / server functions.
 *
 * The id is sent by the browser (client bundle) and looked up in the registry
 * populated by the server bundle, so it must be identical in both. Hashing
 * `fn.toString()` is NOT stable across bundles (minification, transpile
 * targets, dead-code elimination and instrumentation all change the source),
 * so ids come from something the author controls:
 *
 *   1. an explicit `id` (recommended: "<file path>#<export name>", e.g.
 *      "todos/actions#addTodo"), else
 *   2. the explicit / inferred `name`, else
 *   3. (anonymous functions only) a best-effort hash of the source — this is
 *      the only case that can drift between bundles; a warning is logged in
 *      production so the author adds an `id`.
 */
export interface RpcIdInput {
  prefix: string;
  id?: string;
  name?: string;
  source: string;
}

function fnv1a(src: string): string {
  let h = 2166136261;
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

const warned = new Set<string>();

export function stableRpcId({ prefix, id, name, source }: RpcIdInput): string {
  if (id) {
    // Keep ids header-safe and short-URL friendly.
    return `${prefix}_${id.replace(/[^A-Za-z0-9_./#:-]/g, '_')}`;
  }
  if (name && name !== 'anonymous') {
    return `${prefix}_${name.replace(/[^A-Za-z0-9_./#:-]/g, '_')}`;
  }
  const hashed = `${prefix}_anonymous_${fnv1a(source)}`;
  if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production' && !warned.has(hashed)) {
    warned.add(hashed);
    console.warn(
      `[pledgestack] Anonymous ${prefix === 'sfn' ? 'server function' : 'server action'} has no id/name — ` +
      'its id is derived from function source and can differ between server and client bundles. ' +
      'Pass { id: "<file>#<export>" } to make it stable.',
    );
  }
  return hashed;
}

/**
 * Registers `fn` under `id`, refusing to silently replace a *different*
 * function registered under the same id in production (two actions sharing an
 * id would let a request dispatch to the wrong handler). Re-registration in
 * dev/test (HMR re-evaluation) replaces with a warning.
 */
export function registerUnique<T>(registry: Map<string, T>, id: string, fn: T, identity: string, identities: Map<string, string>): void {
  const existing = identities.get(id);
  if (existing !== undefined && existing !== identity) {
    const msg = `[pledgestack] Duplicate RPC id "${id}" registered by two different functions — pass a unique { id } to each.`;
    if (process.env.NODE_ENV === 'production') throw new Error(msg);
    console.warn(msg);
  }
  identities.set(id, identity);
  registry.set(id, fn);
}
