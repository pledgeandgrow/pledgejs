import { describe, it, expect } from 'vitest';
import type { PPRContext } from './ppr';

describe('PPR (Partial Prerendering)', () => {
  describe('PPRContext interface', () => {
    it('supports build-time prerender (isPrerender=true)', () => {
      const ctx: PPRContext = {
        config: {} as any,
        match: {} as any,
        tree: {} as any,
        modules: new Map(),
        isPrerender: true,
      };
      expect(ctx.isPrerender).toBe(true);
      expect(ctx.staticShell).toBeUndefined();
    });

    it('supports request-time fill with staticShell (isPrerender=false)', () => {
      const ctx: PPRContext = {
        config: {} as any,
        match: {} as any,
        tree: {} as any,
        modules: new Map(),
        staticShell: '<html>shell</html>',
        isPrerender: false,
      };
      expect(ctx.isPrerender).toBe(false);
      expect(ctx.staticShell).toBe('<html>shell</html>');
    });
  });
});
