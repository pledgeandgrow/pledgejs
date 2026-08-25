import { describe, it, expect } from 'vitest';
import { resolveFont } from './index';

// resolveFont builds the Google Fonts URL internally; assert the axis-tuple form.
describe('Google Fonts URL axis-tuple syntax (#font)', () => {
  it('uses ital,wght@ tuples for multi-weight + italic, not repeated wght=', () => {
    const resolved = resolveFont({ family: 'Inter', src: 'Inter', weights: [400, 700], styles: ['normal', 'italic'] });
    const url = JSON.stringify(resolved);
    expect(url).toContain('family=Inter:ital,wght@0,400;0,700;1,400;1,700');
    expect(url).not.toMatch(/wght=\d+&wght=/); // no repeated wght params
  });

  it('uses wght@ (no ital axis) for normal-only weights', () => {
    const resolved = resolveFont({ family: 'Roboto', src: 'Roboto', weights: [300, 400, 700], styles: ['normal'] });
    const url = JSON.stringify(resolved);
    expect(url).toContain('family=Roboto:wght@300;400;700');
  });

  it('encodes multi-word family names with +', () => {
    const resolved = resolveFont({ family: 'Open Sans', src: 'Open Sans', weights: [400], styles: ['normal'] });
    expect(JSON.stringify(resolved)).toContain('family=Open+Sans:wght@400');
  });
});
