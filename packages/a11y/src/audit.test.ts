import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { auditAccessibility } from './audit';

// Minimal DOM doubles: the vitest environment is node, and the rules only use
// tagName / attributes / textContent / ownerDocument / closest.
type Attrs = Record<string, string>;
function el(tagName: string, attrs: Attrs = {}, extra: Record<string, unknown> = {}) {
  return {
    tagName,
    id: attrs.id ?? '',
    className: '',
    textContent: '',
    getAttribute: (n: string) => (n in attrs ? attrs[n] : null),
    hasAttribute: (n: string) => n in attrs,
    closest: () => null,
    ...extra,
  };
}

function rootWith(elements: ReturnType<typeof el>[], labels: ReturnType<typeof el>[] = []) {
  const doc = {
    querySelectorAll: (sel: string) => (sel === 'label' ? labels : sel.startsWith('h1') ? [] : []),
    querySelector: () => null,
  };
  for (const e of elements) (e as Record<string, unknown>).ownerDocument = doc;
  return { querySelectorAll: () => elements } as unknown as Element;
}

describe('auditAccessibility', () => {
  beforeAll(() => { vi.stubGlobal('Document', class {}); });
  afterAll(() => { vi.unstubAllGlobals(); });

  it('does not flag decorative images with an explicit empty alt', () => {
    const result = auditAccessibility(rootWith([el('IMG', { alt: '' })]));
    expect(result.violations.filter((v) => v.rule === 'img-alt')).toEqual([]);
  });

  it('still flags images with no alt attribute at all', () => {
    const result = auditAccessibility(rootWith([el('IMG')]));
    expect(result.violations.some((v) => v.rule === 'img-alt')).toBe(true);
  });

  it('accepts an input wrapped in a <label> and one with a matching label[for] (even with quotes in the id)', () => {
    const wrapped = el('INPUT', {}, { closest: (s: string) => (s === 'label' ? {} : null) });
    const weird = el('INPUT', { id: 'a"b' });
    const label = el('LABEL', { for: 'a"b' });
    const result = auditAccessibility(rootWith([wrapped, weird], [label]));
    expect(result.violations.filter((v) => v.rule === 'label-associated')).toEqual([]);
  });
});
