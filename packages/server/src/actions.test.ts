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
});
