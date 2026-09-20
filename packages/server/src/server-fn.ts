/**
 * End-to-end type-safe server functions — TanStack Start-style.
 *
 * Separates the server function contract (input/output types + validators)
 * from the implementation. The client gets a fully-typed proxy that
 * enforces the same parameter and return types at compile time, with
 * runtime validation at the RPC boundary.
 *
 * Usage:
 * ```typescript
 * // server/functions.ts
 * import { createServerFn } from 'pledgestack-server';
 * import { z } from './schema'; // or any validator
 *
 * export const getUser = createServerFn()
 *   .validator((input: { id: string }) => input)
 *   .handler(async ({ data }) => {
 *     const user = await db.findUser(data.id);
 *     return { id: user.id, name: user.name };
 *   });
 *
 * // client/component.tsx
 * import { getUser } from './functions';
 * const user = await getUser({ id: '123' }); // fully typed: { id: string; name: string }
 * ```
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServerFnContext<TData> {
  /** Validated input data */
  data: TData;
  /** Request headers (server-only, undefined on client) */
  headers?: Record<string, string>;
  /** Request method */
  method: string;
  /** Request URL */
  url: string;
}

export type ValidatorFn<TInput, TOutput> = (input: TInput) => TOutput;

export type HandlerFn<TData, TOutput> = (ctx: ServerFnContext<TData>) => Promise<TOutput> | TOutput;

/**
 * Middleware function that runs before the handler. Receives the context
 * and a `next` function that calls the next middleware (or the handler).
 * Can short-circuit by returning a value without calling `next()`.
 */
export type MiddlewareFn<TData> = (
  ctx: ServerFnContext<TData>,
  next: () => Promise<unknown>,
) => Promise<unknown> | unknown;

export interface ServerFnContract<TInput, TOutput> {
  /** Input type (for type inference) */
  __input: TInput;
  /** Output type (for type inference) */
  __output: TOutput;
}

// ---------------------------------------------------------------------------
// Server-side: createServerFn builder
// ---------------------------------------------------------------------------

/**
 * Builder for a type-safe server function.
 *
 * Chain `.validator()` then `.handler()` to define the function.
 * The result is callable from both server and client code with full
 * end-to-end type safety.
 */
export interface ServerFnBuilder<TValidatorInput = never> {
  /**
   * Define a validator for the input. The validator receives the raw input
   * and returns validated/transformed data that the handler will receive.
   *
   * @example
   *   .validator((input: { id: string }) => {
   *     if (!input.id) throw new Error('id required');
   *     return input;
   *   })
   */
  validator<TInput, TOutput>(
    fn: ValidatorFn<TInput, TOutput>,
  ): ServerFnBuilderWithValidator<TInput, TOutput>;

  /**
   * Define the handler without a validator. The handler receives raw input.
   */
  handler<TOutput>(
    fn: HandlerFn<TValidatorInput, TOutput>,
  ): ServerFnCallable<TValidatorInput, TOutput>;

  /**
   * Add middleware that runs before the handler. Middleware can inspect/modify
   * the context, short-circuit by returning a value, or call `next()` to
   * proceed to the next middleware or the handler. Multiple `.middleware()`
   * calls chain in order.
   */
  middleware(fn: MiddlewareFn<TValidatorInput>): ServerFnBuilder<TValidatorInput>;

  /**
   * Add an input validator as a dedicated middleware preset. The validator
   * runs before the handler and throws if validation fails. Unlike
   * `.validator()`, this does not transform the input — it only validates.
   * Useful for adding a validation layer on top of an existing validator.
   *
   * @example
   *   .inputValidator((input) => {
   *     if (!input.id) throw new Error('id required');
   *   })
   */
  inputValidator(fn: (input: TValidatorInput) => void | Promise<void>): ServerFnBuilder<TValidatorInput>;

  /**
   * Add an output validator as a dedicated middleware preset. The validator
   * runs after the handler and throws if the output is invalid. Useful for
   * ensuring the handler never returns malformed data.
   *
   * @example
   *   .outputValidator((output) => {
   *     if (!output.id) throw new Error('handler must return an id');
   *   })
   */
  outputValidator<TOutput>(fn: (output: TOutput) => void | Promise<void>): ServerFnBuilder<TValidatorInput>;
}

export interface ServerFnBuilderWithValidator<TInput, TData> {
  /**
   * Define the handler. Receives the validated data in `ctx.data`.
   */
  handler<TOutput>(
    fn: HandlerFn<TData, TOutput>,
  ): ServerFnCallable<TInput, TOutput>;

  /**
   * Add middleware that runs before the handler. Receives the validated data.
   */
  middleware(fn: MiddlewareFn<TData>): ServerFnBuilderWithValidator<TInput, TData>;

  /**
   * Add an input validator as a dedicated middleware preset. Runs before
   * the handler, throws on validation failure. Does not transform input.
   */
  inputValidator(fn: (input: TData) => void | Promise<void>): ServerFnBuilderWithValidator<TInput, TData>;

  /**
   * Add an output validator as a dedicated middleware preset. Runs after
   * the handler, throws if the output is invalid.
   */
  outputValidator<TOutput>(fn: (output: TOutput) => void | Promise<void>): ServerFnBuilderWithValidator<TInput, TData>;
}

// ---------------------------------------------------------------------------
// Server function callable
// ---------------------------------------------------------------------------

/**
 * A fully-built server function. Callable from both server and client.
 * On the server: calls the handler directly.
 * On the client: POSTs to the RPC endpoint with full type safety.
 */
export interface ServerFnCallable<TInput, TOutput> {
  (input: TInput): Promise<TOutput>;
  /** Metadata for the RPC layer */
  __pledgeServerFn: {
    id: string;
    name: string;
    validator?: ValidatorFn<unknown, unknown>;
    handler: HandlerFn<unknown, unknown>;
    middleware: MiddlewareFn<unknown>[];
  };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

import { stableRpcId, registerUnique } from './rpc-id';

const serverFnRegistry = new Map<string, ServerFnCallable<unknown, unknown>>();

const serverFnIdentities = new Map<string, string>();

const ACTION_ENDPOINT = '/__pledge__/action';

/**
 * Create a new server function builder.
 *
 * @example
 * const getUser = createServerFn()
 *   .validator((input: { id: string }) => input)
 *   .handler(async ({ data }) => {
 *     return { id: data.id, name: 'Alice' };
 *   });
 */
export function createServerFn(options?: {
  /** Stable id shared by server and client bundles, e.g. "users/api#getUser". */
  id?: string;
  name?: string;
}): ServerFnBuilder {
  const middlewares: MiddlewareFn<unknown>[] = [];
  const inputValidators: Array<(input: unknown) => void | Promise<void>> = [];
  const outputValidators: Array<(output: unknown) => void | Promise<void>> = [];

  const builder: ServerFnBuilder = {
    middleware(fn) {
      middlewares.push(fn as MiddlewareFn<unknown>);
      return builder;
    },

    inputValidator(fn) {
      inputValidators.push(fn as (input: unknown) => void | Promise<void>);
      return builder;
    },

    outputValidator(fn) {
      outputValidators.push(fn as (output: unknown) => void | Promise<void>);
      return builder;
    },

    validator<TInput, TOutput>(validatorFn: ValidatorFn<TInput, TOutput>) {
      return {
        middleware(mwFn: MiddlewareFn<TOutput>) {
          middlewares.push(mwFn as MiddlewareFn<unknown>);
          return this;
        },
        inputValidator(fn: (input: TOutput) => void | Promise<void>) {
          inputValidators.push(fn as (input: unknown) => void | Promise<void>);
          return this;
        },
        outputValidator(fn: (output: unknown) => void | Promise<void>) {
          outputValidators.push(fn);
          return this;
        },
        handler<TOutput2>(handlerFn: HandlerFn<TOutput, TOutput2>): ServerFnCallable<TInput, TOutput2> {
          // Wrap handler with output validators
          const wrappedHandler: HandlerFn<unknown, unknown> = outputValidators.length > 0
            ? async (ctx: ServerFnContext<unknown>) => {
                const result = await handlerFn(ctx as ServerFnContext<TOutput>);
                for (const ov of outputValidators) {
                  await ov(result);
                }
                return result;
              }
            : handlerFn as HandlerFn<unknown, unknown>;

          // Add input validators as a middleware that runs before the handler
          if (inputValidators.length > 0) {
            const inputValidatorMw: MiddlewareFn<unknown> = async (ctx, next) => {
              for (const iv of inputValidators) {
                await iv(ctx.data);
              }
              return next();
            };
            return createCallable<TInput, TOutput, TOutput2>(
              validatorFn as ValidatorFn<unknown, unknown>,
              wrappedHandler,
              [...middlewares, inputValidatorMw],
              options,
            );
          }

          return createCallable<TInput, TOutput, TOutput2>(
            validatorFn as ValidatorFn<unknown, unknown>,
            wrappedHandler,
            [...middlewares],
            options,
          );
        },
      } as ServerFnBuilderWithValidator<TInput, TOutput>;
    },

    handler<TOutput>(handlerFn: HandlerFn<never, TOutput>): ServerFnCallable<never, TOutput> {
      // No validator — pass input through directly
      const identityValidator = (input: unknown) => input;

      // Wrap handler with output validators
      const wrappedHandler: HandlerFn<unknown, unknown> = outputValidators.length > 0
        ? async (ctx: ServerFnContext<unknown>) => {
            const result = await handlerFn(ctx as ServerFnContext<never>);
            for (const ov of outputValidators) {
              await ov(result);
            }
            return result;
          }
        : handlerFn as HandlerFn<unknown, unknown>;

      // Add input validators as a middleware
      if (inputValidators.length > 0) {
        const inputValidatorMw: MiddlewareFn<unknown> = async (ctx, next) => {
          for (const iv of inputValidators) {
            await iv(ctx.data);
          }
          return next();
        };
        return createCallable<never, unknown, TOutput>(
          identityValidator,
          wrappedHandler,
          [...middlewares, inputValidatorMw],
          options,
        );
      }

      return createCallable<never, unknown, TOutput>(
        identityValidator,
        wrappedHandler,
        [...middlewares],
        options,
      );
    },
  };

  return builder;
}

function createCallable<TInput, TData, TOutput>(
  validator: ValidatorFn<unknown, unknown>,
  handler: HandlerFn<unknown, unknown>,
  middlewares: MiddlewareFn<unknown>[],
  options?: { id?: string; name?: string },
): ServerFnCallable<TInput, TOutput> {
  void {} as TData; // TData used for type inference at call sites
  const fnName = options?.name ?? options?.id?.split('#').pop() ?? ((handler as { name?: string }).name || 'anonymous');
  const fnId = stableRpcId({ prefix: 'sfn', id: options?.id, name: options?.name, source: handler.toString() });

  /** Compose middleware chain: each mw can call next() to proceed */
  async function runMiddlewareChain(
    ctx: ServerFnContext<unknown>,
    finalHandler: () => Promise<unknown>,
  ): Promise<unknown> {
    if (middlewares.length === 0) return finalHandler();

    let index = -1;
    async function dispatch(i: number): Promise<unknown> {
      if (i <= index) throw new Error('next() called multiple times in middleware');
      index = i;
      if (i >= middlewares.length) return finalHandler();
      const mw = middlewares[i]!;
      return mw(ctx, () => dispatch(i + 1));
    }
    return dispatch(0);
  }

  const callable = async (input: TInput): Promise<TOutput> => {
    if (typeof window === 'undefined') {
      // Server-side: validate, run middleware chain, then handler
      const data = validator(input);
      const ctx: ServerFnContext<typeof data> = {
        data,
        method: 'POST',
        url: ACTION_ENDPOINT,
      };
      const result = await runMiddlewareChain(ctx as ServerFnContext<unknown>, () =>
        handler(ctx) as Promise<unknown>,
      );
      return result as TOutput;
    }

    // Client-side: POST to RPC endpoint
    const response = await fetch(ACTION_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Pledge-Action-Id': fnId,
        'X-Pledge-Action-Name': fnName,
      },
      body: JSON.stringify({ args: [input] }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Server function failed' }));
      throw new Error(error.message ?? `Server function "${fnName}" failed`);
    }

    const result = await response.json();
    return result.result as TOutput;
  };

  (callable as ServerFnCallable<TInput, TOutput>).__pledgeServerFn = {
    id: fnId,
    name: fnName,
    validator,
    handler,
    middleware: middlewares,
  };

  registerUnique(serverFnRegistry, fnId, callable as ServerFnCallable<unknown, unknown>, handler.toString(), serverFnIdentities);

  return callable as ServerFnCallable<TInput, TOutput>;
}

// ---------------------------------------------------------------------------
// Server-side: dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatches a server function call by ID. Called by the action endpoint
 * handler when a request comes in with `X-Pledge-Action-Id`.
 */
export async function dispatchServerFn(
  fnId: string,
  args: unknown[],
  ctx?: Partial<ServerFnContext<unknown>>,
): Promise<unknown> {
  const callable = serverFnRegistry.get(fnId);
  if (!callable) {
    throw new Error(`Server function "${fnId}" not found`);
  }

  const meta = callable.__pledgeServerFn;
  const input = args[0];
  const data = meta.validator ? meta.validator(input) : input;

  const fullCtx: ServerFnContext<unknown> = {
    data,
    method: ctx?.method ?? 'POST',
    url: ctx?.url ?? ACTION_ENDPOINT,
    headers: ctx?.headers,
  };

  // Run middleware chain, then handler
  if (meta.middleware.length === 0) {
    return meta.handler(fullCtx);
  }

  let index = -1;
  async function dispatch(i: number): Promise<unknown> {
    if (i <= index) throw new Error('next() called multiple times in middleware');
    index = i;
    if (i >= meta.middleware.length) return meta.handler(fullCtx);
    const mw = meta.middleware[i]!;
    return mw(fullCtx, () => dispatch(i + 1));
  }
  return dispatch(0);
}

/**
 * Gets all registered server functions (for debugging/introspection).
 */
export function getAllServerFns(): Array<{ id: string; name: string }> {
  return Array.from(serverFnRegistry.entries()).map(([id, fn]) => ({
    id,
    name: fn.__pledgeServerFn.name,
  }));
}

/**
 * Checks if a server function is registered by ID.
 */
export function hasServerFn(fnId: string): boolean {
  return serverFnRegistry.has(fnId);
}

// ---------------------------------------------------------------------------
// Type helpers (for consumers to extract types)
// ---------------------------------------------------------------------------

export type InferServerFnInput<T> = T extends ServerFnCallable<infer I, unknown> ? I : never;
export type InferServerFnOutput<T> = T extends ServerFnCallable<unknown, infer O> ? O : never;
