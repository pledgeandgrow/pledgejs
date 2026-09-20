import { describe, it, expect } from 'vitest';
import { SeaOrmDatabase, MlModel, type SeaOrmDriver, type MlExecutor } from './integrations';

describe('Sea-ORM integration — fails at config time without a backend', () => {
  it('throws an actionable error at construction when no driver is given', () => {
    expect(() => new SeaOrmDatabase({ url: 'postgres://localhost/db' })).toThrow(/SeaOrmConfig\.driver is required/);
    expect(() => new SeaOrmDatabase({ url: 'postgres://localhost/db' })).toThrow(/SeaOrmDriver/);
  });

  it('validates the url', () => {
    expect(() => new SeaOrmDatabase({ url: '' })).toThrow(/url is required/);
  });

  it('works end to end through a user-supplied driver', async () => {
    const rows: Record<string, unknown>[] = [];
    const driver: SeaOrmDriver = {
      connect: () => ({ conn: true }),
      insert: async <T,>(_c: unknown, _e: string, data: Partial<T>) => { rows.push(data as Record<string, unknown>); return data as T; },
      find: async <T,>() => rows as T[],
      delete: async () => { rows.length = 0; return true; },
    };
    const db = new SeaOrmDatabase({ url: 'postgres://localhost/db', driver });
    await db.connect();
    await db.insert('user', { name: 'a' });
    expect(await db.find('user', {})).toEqual([{ name: 'a' }]);
    expect(await db.delete('user', 1)).toBe(true);
    expect(await db.find('user', {})).toEqual([]);
  });
});

describe('ML inference integration — fails at config time without a backend', () => {
  it('throws an actionable error at construction when no executor is given', () => {
    expect(() => new MlModel({ modelPath: 'm.onnx' })).toThrow(/MlModelConfig\.executor is required/);
    expect(() => new MlModel({ modelPath: 'm.onnx' })).toThrow(/MlExecutor/);
  });

  it('validates modelPath', () => {
    expect(() => new MlModel({ modelPath: '' })).toThrow(/modelPath is required/);
  });

  it('runs load/infer/unload through a user-supplied executor', async () => {
    const calls: string[] = [];
    const executor: MlExecutor = {
      load: () => { calls.push('load'); return { id: 1 }; },
      infer: (_m, input) => { calls.push('infer'); return { output: (input as number[]).map((x) => x * 2), inferenceTimeMs: 1 }; },
      unload: () => { calls.push('unload'); },
    };
    const model = new MlModel({ modelPath: 'm.onnx', executor });
    const res = await model.infer([1, 2, 3]);
    expect(res.output).toEqual([2, 4, 6]);
    const batch = await model.inferBatch([[1], [2]]);
    expect(batch.map((b) => b.output)).toEqual([[2], [4]]);
    await model.unload();
    expect(calls).toEqual(['load', 'infer', 'infer', 'infer', 'unload']);
  });
});
