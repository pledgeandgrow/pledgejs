/**
 * Component Inspector — DevTools panel for inspecting React components.
 *
 * Goal #230: Click-to-inspect component tree, view props, edit props live,
 * and see component state. Integrates with PledgeStack DevTools overlay.
 */

import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { createElement } from 'react';

export interface ComponentInfo {
  /** Component display name */
  name: string;
  /** Component file path (if available) */
  filePath?: string;
  /** Component props */
  props: Record<string, unknown>;
  /** Component state (for client components) */
  state?: Record<string, unknown>;
  /** Component hooks summary */
  hooks?: string[];
  /** Render time in ms */
  renderTime?: number;
  /** Whether it's a server or client component */
  type: 'server' | 'client';
  /** Children component names */
  children?: string[];
  /** Depth in the tree */
  depth: number;
}

export interface ComponentInspectorProps {
  /** Currently inspected component (if any) */
  selected: ComponentInfo | null;
  /** Callback when a prop is edited */
  onPropEdit?: (key: string, value: unknown) => void;
  /** Callback to navigate to component source */
  onNavigateSource?: (filePath: string) => void;
  /** Theme colors */
  theme: 'dark' | 'light';
}

export function ComponentInspector({ selected, onPropEdit, onNavigateSource, theme }: ComponentInspectorProps) {
  const textColor = theme === 'dark' ? '#e0e0e0' : '#1a1a1a';
  const borderColor = theme === 'dark' ? '#333' : '#ddd';
  const accentColor = '#6c5ce7';

  if (!selected) {
    return createElement('div', {
      style: { padding: '12px', color: textColor, textAlign: 'center' },
    },
      createElement('div', { style: { marginBottom: '8px', color: '#6b7280' } }, 'No component selected'),
      createElement('div', { style: { fontSize: '11px', color: '#6b7280' } },
        'Click on any element in the page to inspect it',
      ),
    );
  }

  return createElement('div', {
    style: { padding: '8px 12px', color: textColor, fontFamily: 'monospace', fontSize: '12px' },
  },
    // Component header
    createElement('div', {
      style: { marginBottom: '12px', paddingBottom: '8px', borderBottom: `1px solid ${borderColor}` },
    },
      createElement('span', { style: { fontWeight: 'bold', color: accentColor, fontSize: '14px' } }, selected.name),
      createElement('span', {
        style: {
          marginLeft: '8px', padding: '2px 6px', borderRadius: '3px', fontSize: '10px',
          background: selected.type === 'server' ? '#1a3a5c' : '#3a1a5c',
          color: '#fff',
        },
      }, selected.type),
      selected.renderTime != null && createElement('span', {
        style: { marginLeft: '8px', color: '#6b7280', fontSize: '11px' },
      }, `${selected.renderTime.toFixed(1)}ms`),
    ),

    // Source file link
    selected.filePath && createElement('div', {
      style: { marginBottom: '12px' },
    },
      createElement('a', {
        onClick: () => onNavigateSource?.(selected.filePath!),
        style: { color: accentColor, cursor: 'pointer', textDecoration: 'underline', fontSize: '11px' },
      }, selected.filePath),
    ),

    // Props section
    createElement('div', { style: { marginBottom: '12px' } },
      createElement('div', {
        style: { fontWeight: 'bold', marginBottom: '6px', color: accentColor },
      }, `Props (${Object.keys(selected.props).length})`),
      createElement(PropEditor, {
        props: selected.props,
        onEdit: onPropEdit,
        borderColor,
        textColor,
        accentColor,
      }),
    ),

    // State section (client components only)
    selected.state && Object.keys(selected.state).length > 0 && createElement('div', {
      style: { marginBottom: '12px' },
    },
      createElement('div', {
        style: { fontWeight: 'bold', marginBottom: '6px', color: accentColor },
      }, `State (${Object.keys(selected.state).length})`),
      createElement(StateTree, {
        state: selected.state,
        borderColor,
        textColor,
      }),
    ),

    // Hooks section
    selected.hooks && selected.hooks.length > 0 && createElement('div', {
      style: { marginBottom: '12px' },
    },
      createElement('div', {
        style: { fontWeight: 'bold', marginBottom: '6px', color: accentColor },
      }, `Hooks (${selected.hooks.length})`),
      createElement('div', null,
        selected.hooks.map((hook, i) =>
          createElement('div', {
            key: i,
            style: { padding: '2px 0', color: '#f59e0b' },
          }, `use${hook}`),
        ),
      ),
    ),

    // Children section
    selected.children && selected.children.length > 0 && createElement('div', null,
      createElement('div', {
        style: { fontWeight: 'bold', marginBottom: '6px', color: accentColor },
      }, `Children (${selected.children.length})`),
      createElement('div', null,
        selected.children.map((child, i) =>
          createElement('div', {
            key: i,
            style: { padding: '2px 0', paddingLeft: '12px', color: '#10b981' },
          }, `<${child} />`),
        ),
      ),
    ),
  );
}

/**
 * Prop editor — displays and allows editing of component props.
 */
function PropEditor({ props, onEdit, borderColor, textColor, accentColor }: {
  props: Record<string, unknown>;
  onEdit?: (key: string, value: unknown) => void;
  borderColor: string;
  textColor: string;
  accentColor: string;
}): ReactNode {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  const startEdit = useCallback((key: string, value: unknown) => {
    setEditingKey(key);
    setEditValue(typeof value === 'string' ? value : JSON.stringify(value));
  }, []);

  const commitEdit = useCallback((key: string) => {
    let parsed: unknown = editValue;
    try {
      parsed = JSON.parse(editValue);
    } catch {
      // Keep as string
    }
    onEdit?.(key, parsed);
    setEditingKey(null);
  }, [editValue, onEdit]);

  const entries = Object.entries(props);
  if (entries.length === 0) {
    return createElement('div', { style: { color: '#6b7280', fontStyle: 'italic' } }, 'No props');
  }

  return createElement('div', null,
    entries.map(([key, value]) =>
      createElement('div', {
        key,
        style: { display: 'flex', alignItems: 'flex-start', padding: '4px 0', borderBottom: `1px solid ${borderColor}` },
      },
        // Prop name
        createElement('div', {
          style: { minWidth: '80px', color: accentColor, fontWeight: 'bold' },
        }, key),
        // Prop value (editable)
        editingKey === key
          ? createElement('input', {
              value: editValue,
              onChange: (e) => setEditValue(e.target.value),
              onBlur: () => commitEdit(key),
              onKeyDown: (e) => { if (e.key === 'Enter') commitEdit(key); },
              style: {
                flex: 1, background: 'transparent', border: `1px solid ${accentColor}`,
                color: textColor, padding: '2px 4px', borderRadius: '3px',
                fontFamily: 'monospace', fontSize: '12px',
              },
            })
          : createElement('div', {
              onClick: () => startEdit(key, value),
              style: {
                flex: 1, cursor: onEdit ? 'pointer' : 'default', color: textColor,
                fontFamily: 'monospace', fontSize: '11px',
              },
            }, formatValue(value)),
      ),
    ),
  );
}

/**
 * State tree viewer — displays component state as a collapsible tree.
 */
function StateTree({ state, borderColor, textColor }: {
  state: Record<string, unknown>;
  borderColor: string;
  textColor: string;
}): ReactNode {
  return createElement('div', null,
    Object.entries(state).map(([key, value]) =>
      createElement(StateNode, {
        key,
        name: key,
        value,
        depth: 0,
        borderColor,
        textColor,
      }),
    ),
  );
}

function StateNode({ name, value, depth, borderColor, textColor }: {
  name: string;
  value: unknown;
  depth: number;
  borderColor: string;
  textColor: string;
}): ReactNode {
  const [expanded, setExpanded] = useState(depth < 2);
  const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
  const isArray = Array.isArray(value);
  const hasChildren = isObject && Object.keys(value as object).length > 0;

  return createElement('div', {
    style: { paddingLeft: `${depth * 16}px` },
  },
    createElement('div', {
      style: { display: 'flex', alignItems: 'center', padding: '2px 0' },
    },
      hasChildren && createElement('span', {
        onClick: () => setExpanded(!expanded),
        style: { cursor: 'pointer', marginRight: '4px', color: '#6b7280', userSelect: 'none' },
      }, expanded ? '▼' : '▶'),
      createElement('span', {
        style: { color: '#8b5cf6', fontWeight: 'bold', marginRight: '4px' },
      }, name),
      createElement('span', {
        style: { color: textColor, fontSize: '11px' },
      }, hasChildren ? (isArray ? `Array(${(value as unknown[]).length})` : `{${Object.keys(value as object).length}}`) : formatValue(value)),
    ),
    expanded && hasChildren && createElement('div', null,
      Object.entries(value as Record<string, unknown>).map(([k, v]) =>
        createElement(StateNode, {
          key: k,
          name: k,
          value: v,
          depth: depth + 1,
          borderColor,
          textColor,
        }),
      ),
    ),
  );
}

/**
 * Formats a value for display in the inspector.
 */
function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `"${value}"`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'function') return 'fn()';
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length <= 3) {
      return `{ ${keys.map((k) => `${k}: ${formatValue((value as Record<string, unknown>)[k])}`).join(', ')} }`;
    }
    return `{${keys.length} keys}`;
  }
  return String(value);
}

/**
 * Element picker — overlay that highlights elements on hover and selects on click.
 * Activated by a "Pick element" button in the DevTools.
 */
export function ElementPicker({ onPick, active }: {
  onPick: (el: HTMLElement) => void;
  active: boolean;
}) {
  const [hoveredEl, setHoveredEl] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) {
      setHoveredEl(null);
      return;
    }

    const handleMove = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const target = e.target as HTMLElement;
      if (target !== hoveredEl) {
        setHoveredEl(target);
      }
    };

    const handleClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const target = e.target as HTMLElement;
      onPick(target);
    };

    document.addEventListener('mousemove', handleMove, true);
    document.addEventListener('click', handleClick, true);

    return () => {
      document.removeEventListener('mousemove', handleMove, true);
      document.removeEventListener('click', handleClick, true);
    };
  }, [active, hoveredEl, onPick]);

  useEffect(() => {
    if (!hoveredEl) return;

    const rect = hoveredEl.getBoundingClientRect();
    const overlay = document.createElement('div');
    overlay.id = '__pledge_picker_overlay__';
    overlay.style.cssText = `
      position: fixed;
      top: ${rect.top}px;
      left: ${rect.left}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
      border: 2px solid #6c5ce7;
      background: rgba(108, 92, 231, 0.1);
      pointer-events: none;
      z-index: 999999;
    `;

    const label = document.createElement('div');
    label.style.cssText = `
      position: fixed;
      top: ${rect.top - 20}px;
      left: ${rect.left}px;
      background: #6c5ce7;
      color: #fff;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 11px;
      font-family: monospace;
      pointer-events: none;
      z-index: 999999;
    `;
    label.textContent = hoveredEl.tagName.toLowerCase() +
      (hoveredEl.className ? `.${hoveredEl.className.split(' ')[0]}` : '');

    const existing = document.getElementById('__pledge_picker_overlay__');
    if (existing) existing.remove();
    document.body.appendChild(overlay);
    document.body.appendChild(label);

    return () => {
      overlay.remove();
      label.remove();
    };
  }, [hoveredEl]);

  if (!active) return null;

  return createElement('div', {
    style: {
      position: 'fixed', top: '0', left: '0', right: '0', bottom: '0',
      cursor: 'crosshair', zIndex: 999998, pointerEvents: 'none',
    },
  });
}
