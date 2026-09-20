import { describe, it, expect } from 'vitest';
import { serverAction, getServerAction, getAllServerActions } from './actions';

describe('Server Actions (#37)', () => {
  it('registers actions on the server', () => {
    const action = serverAction(async (x: number, y: number) => x + y, { name: 'add' });
    expect(action).toBeDefined();
    // The action should have metadata
    const meta = action as unknown as { __pledgeActionId: string; __pledgeActionName: string };
    expect(meta.__pledgeActionId).toBeDefined();
    expect(meta.__pledgeActionName).toBe('add');
  });

  it('can retrieve registered actions by ID', () => {
    const action = serverAction(async (name: string) => `Hello, ${name}!`, { name: 'greet' });
    const meta = action as unknown as { __pledgeActionId: string };
    const retrieved = getServerAction(meta.__pledgeActionId);
    expect(retrieved).toBeDefined();
  });

  it('returns undefined for unknown action IDs', () => {
    expect(getServerAction('nonexistent_id')).toBeUndefined();
  });

  it('can call registered actions', async () => {
    const action = serverAction(async (a: number, b: number) => a * b, { name: 'multiply' });
    const result = await action(6, 7);
    expect(result).toBe(42);
  });

  it('lists all registered actions', () => {
    serverAction(async () => 1, { name: 'list-test-1' });
    serverAction(async () => 2, { name: 'list-test-2' });
    const all = getAllServerActions();
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.some((a) => a.name === 'list-test-1')).toBe(true);
    expect(all.some((a) => a.name === 'list-test-2')).toBe(true);
  });

  it('derives a DETERMINISTIC id — same fn+name yields the same id (so server & client match)', () => {
    // Two identical serverAction() evaluations (as happens in the server and
    // client bundles) must produce the same id, or the client POST 404s.
    const impl = async (x: number) => x + 1;
    const a = serverAction(impl, { name: 'inc' }) as unknown as { __pledgeActionId: string };
    const b = serverAction(impl, { name: 'inc' }) as unknown as { __pledgeActionId: string };
    expect(a.__pledgeActionId).toBe(b.__pledgeActionId);
    expect(a.__pledgeActionId.startsWith('action_inc')).toBe(true);
  });

  it('does NOT depend on function source — same name/id, different source (server vs client bundle) => same id', () => {
    // Bundlers rewrite fn bodies differently for the server and client
    // bundles; the id must not change with them.
    const serverBuild = serverAction(async () => { return 1; }, { name: 'bundleStable' }) as unknown as { __pledgeActionId: string };
    const clientBuild = serverAction(async () => 1, { name: 'bundleStable' }) as unknown as { __pledgeActionId: string };
    expect(serverBuild.__pledgeActionId).toBe(clientBuild.__pledgeActionId);
    const withId1 = serverAction(async () => { return 1; }, { id: 'todos/actions#add' }) as unknown as { __pledgeActionId: string };
    const withId2 = serverAction(async () => 2, { id: 'todos/actions#add' }) as unknown as { __pledgeActionId: string };
    expect(withId1.__pledgeActionId).toBe(withId2.__pledgeActionId);
    expect(withId1.__pledgeActionId).toContain('todos/actions#add');
  });

  it('distinguishes actions by name / explicit id', () => {
    const a = serverAction(async () => 1, { name: 'dupA' }) as unknown as { __pledgeActionId: string };
    const b = serverAction(async () => 1, { name: 'dupB' }) as unknown as { __pledgeActionId: string };
    expect(a.__pledgeActionId).not.toBe(b.__pledgeActionId);
  });

  it('rejects two different functions sharing an id in production', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      serverAction(async () => 1, { id: 'clash#x' });
      expect(() => serverAction(async () => 2, { id: 'clash#x' })).toThrow(/Duplicate RPC id/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
