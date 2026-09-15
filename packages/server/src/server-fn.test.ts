import { describe, it, expect } from 'vitest';
import {
  createServerFn,
  dispatchServerFn,
  getAllServerFns,
  hasServerFn,
  type InferServerFnInput,
  type InferServerFnOutput,
} from './server-fn';

describe('Server Functions (createServerFn)', () => {
  describe('basic usage', () => {
    it('creates a callable server function with validator + handler', async () => {
      const getUser = createServerFn()
        .validator((input: { id: string }) => {
          if (!input.id) throw new Error('id required');
          return input;
        })
        .handler(async ({ data }) => {
          return { id: data.id, name: 'Alice' };
        });

      // On the server (no window), calls directly
      const result = await getUser({ id: '123' });
      expect(result).toEqual({ id: '123', name: 'Alice' });
    });

    it('creates a server function without a validator', async () => {
      const ping = createServerFn()
        .handler(async () => {
          return { pong: true };
        });

      const result = await ping(undefined as never);
      expect(result).toEqual({ pong: true });
    });

    it('handler receives validated data in ctx', async () => {
      const double = createServerFn()
        .validator((input: { n: number }) => ({ n: input.n * 2 }))
        .handler(async ({ data }) => {
          return data.n;
        });

      const result = await double({ n: 21 });
      expect(result).toBe(42);
    });

    it('validator can transform the input type', async () => {
      const parse = createServerFn()
        .validator((input: string) => ({ parsed: parseInt(input, 10) }))
        .handler(async ({ data }) => {
          return data.parsed;
        });

      const result = await parse('42');
      expect(result).toBe(42);
    });
  });

  describe('validator errors', () => {
    it('throws when validator rejects input', async () => {
      const fn = createServerFn()
        .validator((input: { id: string }) => {
          if (!input.id) throw new Error('id is required');
          return input;
        })
        .handler(async ({ data }) => data.id);

      await expect(fn({ id: '' })).rejects.toThrow('id is required');
    });
  });

  describe('registry + dispatch', () => {
    it('registers server functions in the registry', () => {
      const fn = createServerFn()
        .validator((input: { x: number }) => input)
        .handler(async ({ data }) => data.x + 1);

      const meta = fn.__pledgeServerFn;
      expect(meta.id).toBeDefined();
      expect(meta.name).toBeDefined();
      expect(hasServerFn(meta.id)).toBe(true);
    });

    it('dispatchServerFn calls the registered function', async () => {
      const fn = createServerFn()
        .validator((input: { a: number; b: number }) => input)
        .handler(async ({ data }) => data.a + data.b);

      const meta = fn.__pledgeServerFn;
      const result = await dispatchServerFn(meta.id, [{ a: 20, b: 22 }]);
      expect(result).toBe(42);
    });

    it('dispatchServerFn throws for unknown fn id', async () => {
      await expect(dispatchServerFn('nonexistent', [])).rejects.toThrow('not found');
    });

    it('getAllServerFns lists registered functions', () => {
      const fn = createServerFn()
        .validator((input: { test: boolean }) => input)
        .handler(async ({ data }) => data.test);

      const all = getAllServerFns();
      expect(all.length).toBeGreaterThan(0);
      expect(all.some(f => f.id === fn.__pledgeServerFn.id)).toBe(true);
    });
  });

  describe('type inference', () => {
    it('InferServerFnInput extracts the input type', () => {
      const fn = createServerFn()
        .validator((input: { id: string }) => input)
        .handler(async ({ data }) => ({ name: data.id }));

      type Input = InferServerFnInput<typeof fn>;
      type Output = InferServerFnOutput<typeof fn>;

      // Type-level assertions (compile-time only)
      const _input: Input = { id: 'test' };
      const _output: Output = { name: 'test' };
      expect(_input.id).toBe('test');
      expect(_output.name).toBe('test');
    });
  });

  describe('deterministic IDs', () => {
    it('same handler source produces the same ID', () => {
      const handler = async ({ data }: { data: { x: number } }) => data.x;
      const a = createServerFn()
        .validator((input: { x: number }) => input)
        .handler(handler);
      const b = createServerFn()
        .validator((input: { x: number }) => input)
        .handler(handler);

      expect(a.__pledgeServerFn.id).toBe(b.__pledgeServerFn.id);
    });

    it('different handlers produce different IDs', () => {
      const a = createServerFn()
        .validator((input: { x: number }) => input)
        .handler(async ({ data }) => data.x);
      const b = createServerFn()
        .validator((input: { x: number }) => input)
        .handler(async ({ data }) => data.x + 1);

      expect(a.__pledgeServerFn.id).not.toBe(b.__pledgeServerFn.id);
    });
  });

  describe('middleware chain', () => {
    it('runs middleware before the handler', async () => {
      const order: string[] = [];
      const fn = createServerFn()
        .validator((input: { x: number }) => input)
        .middleware(async (_ctx, next) => {
          order.push('mw-before');
          const result = await next();
          order.push('mw-after');
          return result;
        })
        .handler(async ({ data }) => {
          order.push('handler');
          return data.x * 2;
        });

      const result = await fn({ x: 5 });
      expect(result).toBe(10);
      expect(order).toEqual(['mw-before', 'handler', 'mw-after']);
    });

    it('runs multiple middleware in order', async () => {
      const order: string[] = [];
      const fn = createServerFn()
        .validator((input: { x: number }) => input)
        .middleware(async (_ctx, next) => {
          order.push('mw1-before');
          const r = await next();
          order.push('mw1-after');
          return r;
        })
        .middleware(async (_ctx, next) => {
          order.push('mw2-before');
          const r = await next();
          order.push('mw2-after');
          return r;
        })
        .handler(async ({ data }) => {
          order.push('handler');
          return data.x;
        });

      await fn({ x: 1 });
      expect(order).toEqual([
        'mw1-before', 'mw2-before', 'handler', 'mw2-after', 'mw1-after',
      ]);
    });

    it('middleware can short-circuit by returning without next()', async () => {
      const fn = createServerFn()
        .validator((input: { x: number }) => input)
        .middleware(async (_ctx, _next) => {
          return 'short-circuited';
        })
        .handler(async ({ data }) => data.x);

      const result = await fn({ x: 99 });
      expect(result).toBe('short-circuited');
    });

    it('middleware can modify context before handler runs', async () => {
      const fn = createServerFn()
        .validator((input: { x: number }) => ({ ...input, doubled: input.x * 2 }))
        .middleware(async (ctx, next) => {
          // Modify the data before passing to handler
          (ctx.data as Record<string, unknown>).modified = true;
          return next();
        })
        .handler(async ({ data }) => {
          return { x: data.x, doubled: data.doubled, modified: (data as Record<string, unknown>).modified };
        });

      const result = await fn({ x: 5 });
      expect(result).toEqual({ x: 5, doubled: 10, modified: true });
    });

    it('middleware works with dispatchServerFn', async () => {
      const fn = createServerFn()
        .validator((input: { x: number }) => input)
        .middleware(async (ctx, next) => {
          (ctx.data as Record<string, unknown>).fromMiddleware = true;
          return next();
        })
        .handler(async ({ data }) => ({
          x: data.x,
          fromMiddleware: (data as Record<string, unknown>).fromMiddleware,
        }));

      const result = await dispatchServerFn(fn.__pledgeServerFn.id, [{ x: 7 }]);
      expect(result).toEqual({ x: 7, fromMiddleware: true });
    });

    it('middleware can be added without a validator', async () => {
      const fn = createServerFn()
        .middleware(async (_ctx, next) => {
          const r = await next();
          return `mw:${r}`;
        })
        .handler(async () => 'handler-result');

      const result = await fn(undefined as never);
      expect(result).toBe('mw:handler-result');
    });
  });

  describe('inputValidator / outputValidator presets', () => {
    it('inputValidator runs before handler and throws on invalid input', async () => {
      const fn = createServerFn()
        .validator((input: { id: string }) => input)
        .inputValidator((data) => {
          if (!data.id) throw new Error('id is required');
        })
        .handler(async ({ data }) => ({ result: data.id }));

      const result = await fn({ id: 'abc' });
      expect(result).toEqual({ result: 'abc' });

      await expect(fn({ id: '' })).rejects.toThrow('id is required');
    });

    it('outputValidator runs after handler and throws on invalid output', async () => {
      const fn = createServerFn()
        .validator((input: { x: number }) => input)
        .outputValidator((output: { result: number }) => {
          if (output.result < 0) throw new Error('result must be non-negative');
        })
        .handler(async ({ data }) => ({ result: data.x }));

      const result = await fn({ x: 5 });
      expect(result).toEqual({ result: 5 });

      await expect(fn({ x: -1 })).rejects.toThrow('non-negative');
    });

    it('inputValidator works without a validator', async () => {
      const fn = createServerFn()
        .inputValidator((input: { id: string }) => {
          if (!input.id) throw new Error('id required');
        })
        .handler(async ({ data }) => ({ got: (data as { id: string }).id }));

      const result = await fn({ id: 'test' });
      expect(result).toEqual({ got: 'test' });

      await expect(fn({ id: '' })).rejects.toThrow('id required');
    });

    it('outputValidator works without a validator', async () => {
      const fn = createServerFn()
        .outputValidator((output: { value: number }) => {
          if (output.value > 100) throw new Error('value too large');
        })
        .handler(async () => ({ value: 50 }));

      const result = await fn(undefined as never);
      expect(result).toEqual({ value: 50 });
    });

    it('multiple inputValidators all run', async () => {
      const order: string[] = [];
      const fn = createServerFn()
        .validator((input: { x: number }) => input)
        .inputValidator(() => { order.push('iv1'); })
        .inputValidator(() => { order.push('iv2'); })
        .handler(async ({ data }) => {
          order.push('handler');
          return data.x;
        });

      await fn({ x: 1 });
      expect(order).toEqual(['iv1', 'iv2', 'handler']);
    });

    it('multiple outputValidators all run', async () => {
      const order: string[] = [];
      const fn = createServerFn()
        .outputValidator(() => { order.push('ov1'); })
        .outputValidator(() => { order.push('ov2'); })
        .handler(async () => 42);

      await fn(undefined as never);
      expect(order).toEqual(['ov1', 'ov2']);
    });

    it('inputValidator and outputValidator work together', async () => {
      const fn = createServerFn()
        .validator((input: { x: number }) => input)
        .inputValidator((data) => {
          if (data.x < 0) throw new Error('x must be non-negative');
        })
        .outputValidator((output: { result: number }) => {
          if (output.result > 100) throw new Error('result too large');
        })
        .handler(async ({ data }) => ({ result: data.x * 2 }));

      expect(await fn({ x: 5 })).toEqual({ result: 10 });
      await expect(fn({ x: -1 })).rejects.toThrow('non-negative');
      await expect(fn({ x: 60 })).rejects.toThrow('too large');
    });

    it('inputValidator works with dispatchServerFn', async () => {
      const fn = createServerFn()
        .validator((input: { id: string }) => input)
        .inputValidator((data) => {
          if (data.id === 'blocked') throw new Error('blocked id');
        })
        .handler(async ({ data }) => ({ id: data.id }));

      const result = await dispatchServerFn(fn.__pledgeServerFn.id, [{ id: 'ok' }]);
      expect(result).toEqual({ id: 'ok' });

      await expect(dispatchServerFn(fn.__pledgeServerFn.id, [{ id: 'blocked' }])).rejects.toThrow('blocked id');
    });
  });
});
