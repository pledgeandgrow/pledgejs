// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { createElement, act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
  auditAccessibility,
  extractTranslations,
  FocusManager,
  useKeyboardNavigation,
  useFocusManagement,
  RtlProvider,
  useRtl,
  useDirection,
} from './index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

async function render(element: ReactElement) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(element); });
  return { host, root, unmount: () => act(async () => { root.unmount(); }) };
}

describe('auditAccessibility', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('passes a clean document', () => {
    mount('<main><h1>Title</h1><img src="a.png" alt="A cat"><button>Save</button><a href="/x">Read more</a>' +
      '<label for="n">Name</label><input id="n"></main>');
    const result = auditAccessibility(document);
    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.summary).toEqual({ errors: 0, warnings: 0, info: 0 });
  });

  it('flags images without alt text', () => {
    mount('<img src="a.png">');
    const r = auditAccessibility(document);
    expect(r.passed).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain('img-alt');
    expect(r.violations[0].fix).toMatch(/alt/);
  });

  it('flags icon-only buttons and links, but accepts aria-label', () => {
    mount('<button></button><a href="#"></a><button aria-label="Close"></button><a href="#" aria-label="Home"></a>');
    const r = auditAccessibility(document);
    expect(r.violations.filter((v) => v.rule === 'button-text')).toHaveLength(1);
    expect(r.violations.filter((v) => v.rule === 'link-text')).toHaveLength(1);
  });

  it('flags form controls without labels and accepts label[for] / aria-label', () => {
    mount('<input id="bad"><input id="good"><label for="good">Good</label><select aria-label="Pick"></select><textarea></textarea>');
    const r = auditAccessibility(document);
    const bad = r.violations.filter((v) => v.rule === 'label-associated').map((v) => v.element);
    expect(bad).toHaveLength(2); // #bad and the bare textarea
    expect(bad.some((e) => e.includes('id="bad"'))).toBe(true);
  });

  it('warns on skipped heading levels but not on first heading or going back up', () => {
    mount('<h2>a</h2><h3>b</h3><h5>c</h5><h2>d</h2>');
    const r = auditAccessibility(document);
    const order = r.violations.filter((v) => v.rule === 'heading-order');
    expect(order).toHaveLength(1);
    expect(order[0].severity).toBe('warning');
    expect(order[0].element).toContain('<h5');
    // warnings do not fail the audit
    expect(r.passed).toBe(true);
  });

  it('warns on positive tabindex and invalid roles', () => {
    mount('<div tabindex="3"></div><div tabindex="0"></div><div role="bogus"></div><div role="dialog"></div>');
    const r = auditAccessibility(document);
    expect(r.violations.filter((v) => v.rule === 'tabindex-positive')).toHaveLength(1);
    expect(r.violations.filter((v) => v.rule === 'role-valid')).toHaveLength(1);
    expect(r.summary.warnings).toBe(2);
  });

  it('audits a sub-tree and supports custom rules', () => {
    mount('<section id="s"><p class="x">hi</p></section><p>outside</p>');
    const section = document.getElementById('s')!;
    const r = auditAccessibility(section, [
      { id: 'no-p', description: 'no paragraphs', severity: 'info', check: (el) => el.tagName === 'P' },
    ]);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].element).toBe('<p class="x">');
    expect(r.summary.info).toBe(1);
  });

  it('a throwing rule does not abort the audit', () => {
    mount('<img src="x">');
    const r = auditAccessibility(document, [
      { id: 'boom', description: 'boom', severity: 'error', check: () => { throw new Error('x'); } },
      { id: 'img', description: 'img', severity: 'error', check: (el) => el.tagName === 'IMG' },
    ]);
    expect(r.violations.map((v) => v.rule)).toEqual(['img']);
  });
});

describe('extractTranslations', () => {
  it('finds t() and translate() calls with line numbers', () => {
    const src = "const a = t('home.title');\nconst b = translate(\"nav.about\");\nfoo();";
    const out = extractTranslations(src, 'a.tsx');
    expect(out).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'home.title', file: 'a.tsx', line: 1 }),
      expect.objectContaining({ key: 'nav.about', line: 2 }),
    ]));
  });

  it('finds <Trans> components and honours custom function names', () => {
    const src = '<Trans>Hello world</Trans>\nconst x = i18n("k.one");';
    const out = extractTranslations(src, 'b.tsx', { functionNames: ['i18n'] });
    expect(out.map((e) => e.key)).toEqual(expect.arrayContaining(['Hello world', 'k.one']));
  });

  it('does not treat unrelated identifiers as translation calls', () => {
    expect(extractTranslations("split('a'); const t2 = 5; format('x');", 'c.ts')).toEqual([]);
  });
});

describe('FocusManager', () => {
  it('pushes focus to an element and restores it on pop', () => {
    mount('<button id="a">a</button><button id="b">b</button>');
    const a = document.getElementById('a')!;
    const b = document.getElementById('b')!;
    a.focus();
    const fm = new FocusManager();
    fm.push(b);
    expect(document.activeElement).toBe(b);
    expect(fm.depth).toBe(1);
    fm.pop();
    expect(document.activeElement).toBe(a);
    expect(fm.depth).toBe(0);
  });
});

describe('useFocusManagement', () => {
  it('focuses the first focusable element, traps Tab, and restores focus on unmount', async () => {
    mount('<button id="outside">outside</button>');
    const outside = document.getElementById('outside')!;
    outside.focus();

    function Dialog() {
      const ref = useFocusManagement<HTMLDivElement>();
      return createElement('div', { ref },
        createElement('button', { id: 'first' }, 'first'),
        createElement('button', { id: 'last' }, 'last'));
    }
    const { unmount } = await render(createElement(Dialog));
    const first = document.getElementById('first')!;
    const last = document.getElementById('last')!;
    expect(document.activeElement).toBe(first);

    // Shift+Tab on the first element wraps to the last.
    const shiftTab = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(shiftTab);
    expect(shiftTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);

    // Tab on the last element wraps to the first.
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    await unmount();
    expect(document.activeElement).toBe(outside);
  });
});

describe('useKeyboardNavigation', () => {
  function List({ items, loop, orientation, onPick }: { items: string[]; loop?: boolean; orientation?: 'vertical' | 'horizontal' | 'both'; onPick?: (i: string) => void }) {
    const { containerRef, activeIndex } = useKeyboardNavigation<HTMLUListElement>(items, { loop, orientation });
    return createElement('ul', { ref: containerRef, 'data-active': activeIndex },
      items.map((it, i) => createElement('li', { key: it, 'data-index': i, tabIndex: 0, onClick: () => onPick?.(it) }, it)));
  }
  const press = async (el: Element, key: string) => {
    await act(async () => { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
  };

  it('moves the active index with arrows, wrapping when loop is on', async () => {
    const { host } = await render(createElement(List, { items: ['a', 'b', 'c'] }));
    const ul = host.querySelector('ul')!;
    expect(ul.getAttribute('data-active')).toBe('0');
    await press(ul, 'ArrowDown');
    expect(ul.getAttribute('data-active')).toBe('1');
    expect(document.activeElement).toBe(host.querySelector('[data-index="1"]'));
    await press(ul, 'End');
    expect(ul.getAttribute('data-active')).toBe('2');
    await press(ul, 'ArrowDown');
    expect(ul.getAttribute('data-active')).toBe('0'); // wrapped
    await press(ul, 'ArrowUp');
    expect(ul.getAttribute('data-active')).toBe('2'); // wrapped back
    await press(ul, 'Home');
    expect(ul.getAttribute('data-active')).toBe('0');
  });

  it('clamps at the ends when loop is off and respects orientation', async () => {
    const { host } = await render(createElement(List, { items: ['a', 'b'], loop: false, orientation: 'vertical' }));
    const ul = host.querySelector('ul')!;
    await press(ul, 'ArrowUp');
    expect(ul.getAttribute('data-active')).toBe('0');
    await press(ul, 'ArrowRight'); // ignored for vertical lists
    expect(ul.getAttribute('data-active')).toBe('0');
    await press(ul, 'ArrowDown');
    await press(ul, 'ArrowDown');
    expect(ul.getAttribute('data-active')).toBe('1');
  });

  it('Enter activates the current item', async () => {
    const picked: string[] = [];
    const { host } = await render(createElement(List, { items: ['a', 'b'], onPick: (i: string) => picked.push(i) }));
    const ul = host.querySelector('ul')!;
    await press(ul, 'ArrowDown');
    await press(ul, 'Enter');
    expect(picked).toEqual(['b']);
  });
});

describe('RTL helpers', () => {
  function Probe() {
    const { direction, isRtl, toggle } = useRtl();
    return createElement('button', { id: 'p', onClick: toggle }, `${direction}:${isRtl}:${useDirection()}`);
  }

  it('provides direction, sets dir on the wrapper, and toggles', async () => {
    const { host } = await render(createElement(RtlProvider, { initialDirection: 'rtl' }, createElement(Probe)));
    const btn = host.querySelector('button') as HTMLButtonElement;
    expect(btn.textContent).toBe('rtl:true:rtl');
    expect(host.querySelector('[dir]')!.getAttribute('dir')).toBe('rtl');
    await act(async () => { btn.click(); });
    expect(btn.textContent).toBe('ltr:false:ltr');
    expect(host.querySelector('[dir]')!.getAttribute('dir')).toBe('ltr');
  });

  it('defaults to ltr outside a provider', async () => {
    const { host } = await render(createElement(Probe));
    expect(host.querySelector('button')!.textContent).toBe('ltr:false:ltr');
  });
});

describe('extractTranslations — no duplicate entries', () => {
  it('reports each double- or single-quoted call exactly once', () => {
    expect(extractTranslations('t("a") + t(\'b\')', 'x.ts').map((e) => e.key)).toEqual(['a', 'b']);
  });
});
