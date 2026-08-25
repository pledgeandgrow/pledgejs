export interface A11yRule {
  id: string;
  description: string;
  severity: 'error' | 'warning' | 'info';
  check: (element: Element) => boolean;
  fix?: string;
}

export interface A11yAuditResult {
  passed: boolean;
  violations: Array<{
    rule: string;
    severity: 'error' | 'warning' | 'info';
    message: string;
    element: string;
    fix?: string;
  }>;
  summary: { errors: number; warnings: number; info: number };
}

const DEFAULT_RULES: A11yRule[] = [
  {
    id: 'img-alt',
    description: 'Images must have alt text',
    severity: 'error',
    check: (el) => el.tagName === 'IMG' && !el.getAttribute('alt'),
    fix: 'Add an alt attribute to the image',
  },
  {
    id: 'button-text',
    description: 'Buttons must have accessible text',
    severity: 'error',
    check: (el) => el.tagName === 'BUTTON' && !el.textContent?.trim() && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby'),
    fix: 'Add text content or aria-label to the button',
  },
  {
    id: 'link-text',
    description: 'Links must have descriptive text',
    severity: 'error',
    check: (el) => el.tagName === 'A' && !el.textContent?.trim() && !el.getAttribute('aria-label'),
    fix: 'Add descriptive text to the link',
  },
  {
    id: 'label-associated',
    description: 'Form inputs must have associated labels',
    severity: 'error',
    check: (el) => {
      if (el.tagName !== 'INPUT' && el.tagName !== 'SELECT' && el.tagName !== 'TEXTAREA') return false;
      const id = el.getAttribute('id');
      if (!id) return !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby');
      return !document.querySelector(`label[for="${id}"]`) && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby');
    },
    fix: 'Add a <label for="..."> or aria-label attribute',
  },
  {
    id: 'heading-order',
    description: 'Headings should be in logical order',
    severity: 'warning',
    check: (el) => {
      if (!/^H[1-6]$/.test(el.tagName)) return false;
      const level = Number(el.tagName[1]);

      // Walk backward through the whole document (not just siblings) to find
      // the nearest preceding heading, since the previous heading is often a
      // sibling's descendant rather than a sibling itself.
      const doc = el.ownerDocument;
      const headings = Array.from(doc.querySelectorAll('h1, h2, h3, h4, h5, h6'));
      const index = headings.indexOf(el);
      if (index <= 0) return false; // first heading on the page — nothing to violate

      const prevLevel = Number(headings[index - 1].tagName[1]);
      // A heading level may only increase by one at a time (e.g. h2 -> h3 is
      // fine, h2 -> h4 skips a level and is a violation). Decreasing levels
      // (going back up, e.g. h3 -> h2) is always fine.
      return level > prevLevel + 1;
    },
  },
  {
    id: 'tabindex-positive',
    description: 'Avoid positive tabindex values',
    severity: 'warning',
    check: (el) => {
      const tabindex = el.getAttribute('tabindex');
      return tabindex !== null && parseInt(tabindex) > 0;
    },
    fix: 'Use tabindex="0" or remove tabindex',
  },
  {
    id: 'role-valid',
    description: 'ARIA roles must be valid',
    severity: 'warning',
    check: (el) => {
      const role = el.getAttribute('role');
      if (!role) return false;
      const validRoles = ['alert', 'alertdialog', 'application', 'article', 'banner', 'button', 'checkbox', 'columnheader', 'combobox', 'complementary', 'contentinfo', 'definition', 'dialog', 'directory', 'document', 'form', 'grid', 'gridcell', 'group', 'heading', 'img', 'link', 'list', 'listbox', 'listitem', 'log', 'main', 'marquee', 'math', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'navigation', 'none', 'note', 'option', 'presentation', 'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup', 'rowheader', 'scrollbar', 'search', 'separator', 'slider', 'spinbutton', 'status', 'switch', 'tab', 'tablist', 'tabpanel', 'textbox', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem'];
      return !validRoles.includes(role);
    },
    fix: 'Use a valid ARIA role or remove the role attribute',
  },
];

export function auditAccessibility(
  root: Element | Document = document,
  rules: A11yRule[] = DEFAULT_RULES,
): A11yAuditResult {
  const violations: A11yAuditResult['violations'] = [];
  const elements = (root instanceof Document ? root.body : root).querySelectorAll('*');

  for (const el of elements) {
    for (const rule of rules) {
      try {
        if (rule.check(el)) {
          violations.push({
            rule: rule.id,
            severity: rule.severity,
            message: rule.description,
            element: `<${el.tagName.toLowerCase()}${el.id ? ` id="${el.id}"` : ''}${el.className ? ` class="${el.className}"` : ''}>`,
            fix: rule.fix,
          });
        }
      } catch {
        /* skip */
      }
    }
  }

  const summary = {
    errors: violations.filter((v) => v.severity === 'error').length,
    warnings: violations.filter((v) => v.severity === 'warning').length,
    info: violations.filter((v) => v.severity === 'info').length,
  };

  return {
    passed: summary.errors === 0,
    violations,
    summary,
  };
}
