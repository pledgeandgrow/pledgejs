import { describe, it, expect } from 'vitest';
import { resolveFont, fontVarName } from 'pledgestack-font';

describe('Font Optimization (#19)', () => {
  it('resolves a Google font configuration', () => {
    const resolved = resolveFont({ family: 'Inter', src: 'Inter' });
    expect(resolved.fontFamily).toContain('Inter');
    expect(resolved.preloadLinks).toBeDefined();
    expect(resolved.preloadLinks.length).toBeGreaterThan(0);
  });

  it('generates a CSS variable name from family', () => {
    const varName = fontVarName('Inter');
    expect(varName).toContain('inter');
    expect(varName).toMatch(/^--pledge-font-/);
  });

  it('handles multi-word font families', () => {
    const varName = fontVarName('Source Sans Pro');
    expect(varName).not.toContain(' ');
  });

  it('includes fallback font stack', () => {
    const resolved = resolveFont({ family: 'Roboto', src: 'Roboto' });
    expect(resolved.fallbackStack).toBeDefined();
    expect(resolved.fallbackStack).toContain('sans-serif');
  });

  it('generates preconnect links for Google Fonts', () => {
    const resolved = resolveFont({ family: 'Inter', src: 'Inter', preload: true });
    const preconnect = resolved.preloadLinks.find((l) => l.includes('preconnect'));
    expect(preconnect).toBeDefined();
  });

  it('handles local font files', () => {
    const resolved = resolveFont({ family: 'MyFont', src: '/fonts/myfont.woff2' });
    expect(resolved.fontFaceCSS).toBeDefined();
  });
});
