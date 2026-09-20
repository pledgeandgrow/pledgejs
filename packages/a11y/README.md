# pledgestack-a11y

Accessibility utilities for React apps: a DOM audit with built-in WCAG-style rules, focus management (trap + restore), roving keyboard navigation, RTL/direction context and a translation-key extractor.

> Part of [PledgeStack](https://github.com/pledgeandgrow/pledgejs). Most applications only need the [`pledgestack`](https://www.npmjs.com/package/pledgestack) package, which bundles this functionality; install this package directly when composing pieces yourself.

## Install

```bash
pnpm add pledgestack-a11y react react-dom
```

Requires Node.js >= 20. The package is ESM-only and ships TypeScript declarations.

## Usage

```tsx
import { auditAccessibility, useFocusManagement, RtlProvider } from 'pledgestack-a11y';

// In a test or dev tool (needs a DOM):
const result = auditAccessibility(document);
if (!result.passed) console.table(result.violations);

// Trap focus inside a dialog and restore it on close:
function Dialog() {
  const ref = useFocusManagement<HTMLDivElement>();
  return <div ref={ref}>{/* focusable content */}</div>;
}
```

## API

- `auditAccessibility(root?, rules?)` — runs rules (`img-alt`, `button-text`, `link-text`, `label-associated`, `heading-order`, `tabindex-positive`, `role-valid`) and returns `{ passed, violations, summary }`. Custom `A11yRule`s can be supplied.
- `useFocusManagement()`, `FocusManager` — focus trap and focus restoration.
- `useKeyboardNavigation(items, options)` — arrow/Home/End/Enter navigation with looping and orientation.
- `RtlProvider`, `useRtl()`, `useDirection()` — direction context that sets `dir` on a wrapper element.
- `extractTranslations(source, file, options)` — finds `t("key")` / `<Trans>` usages with file and line.

## Notes

The audit inspects a live DOM (browser, jsdom or happy-dom). It is a fast lint for common problems, not a substitute for a full axe/Lighthouse audit.

## License

MIT
