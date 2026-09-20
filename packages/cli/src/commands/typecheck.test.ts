import { describe, it, expect } from 'vitest';
import { TSC_ARGS } from './typecheck';

describe('pledge typecheck', () => {
  it('passes the tsconfig relative to cwd so paths with spaces survive shell:true on Windows', () => {
    const p = TSC_ARGS[TSC_ARGS.indexOf('-p') + 1];
    expect(p).toBe('tsconfig.json');
    expect(TSC_ARGS.every((a) => !/[\/]/.test(a))).toBe(true);
  });
});
