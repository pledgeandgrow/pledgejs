import { describe, it, expect } from 'vitest';
import { createEdgeSecretProvider } from './edge-security';

describe('edge secret providers (vercel / deno)', () => {
  it('vercel: reads values and keys from an Edge Config client', async () => {
    const p = createEdgeSecretProvider({
      target: 'vercel',
      vercelClient: {
        get: async (k) => (k === 'API' ? 'sekret' : k === 'OBJ' ? { a: 1 } : undefined),
        getAll: async () => ({ API: 'sekret', OBJ: { a: 1 } }),
      },
    });
    expect(await p.get('API')).toBe('sekret');
    expect(await p.get('OBJ')).toBe('{"a":1}');
    expect(await p.get('MISSING')).toBeUndefined();
    expect((await p.keys()).sort()).toEqual(['API', 'OBJ']);
  });

  it('deno: reads values and lists keys under the namespace prefix', async () => {
    const store = new Map<string, unknown>([['app|TOKEN', 'abc'], ['app|DB', 'pg'], ['other|X', 'no']]);
    const p = createEdgeSecretProvider({
      target: 'deno',
      denoKvNamespace: 'app',
      denoKv: {
        get: async (key) => ({ value: store.get(key.join('|')) ?? null }),
        list: async function* ({ prefix }) {
          for (const k of store.keys()) {
            const parts = k.split('|');
            if (parts[0] === prefix[0]) yield { key: parts };
          }
        },
      },
    });
    expect(await p.get('TOKEN')).toBe('abc');
    expect(await p.get('NOPE')).toBeUndefined();
    expect((await p.keys()).sort()).toEqual(['DB', 'TOKEN']);
  });

  it('deno: fails with a clear error outside the Deno runtime', async () => {
    const p = createEdgeSecretProvider({ target: 'deno' });
    await expect(p.get('X')).rejects.toThrow(/Deno runtime/);
  });
});
