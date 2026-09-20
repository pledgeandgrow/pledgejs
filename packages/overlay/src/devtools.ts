import { useState, useCallback, type ReactNode } from 'react';
import { createElement } from 'react';
import { ComponentInspector, ElementPicker, type ComponentInfo } from './component-inspector';

export interface RouteInfo {
  path: string;
  mode: string;
  runtime: string;
  filePath: string;
  loadTime?: number;
  renderTime?: number;
}

export interface CacheEntry {
  key: string;
  tags: string[];
  expiresAt: number;
  size: number;
}

export interface DevToolsProps {
  routes: RouteInfo[];
  cacheEntries?: CacheEntry[];
  theme?: 'dark' | 'light';
  defaultTab?: 'routes' | 'cache' | 'build' | 'inspector';
  selectedComponent?: ComponentInfo | null;
  onPropEdit?: (key: string, value: unknown) => void;
  onNavigateSource?: (filePath: string) => void;
}

type Tab = 'routes' | 'cache' | 'build' | 'inspector';

export function DevTools({ routes, cacheEntries = [], theme = 'dark', defaultTab = 'routes', selectedComponent = null, onPropEdit, onNavigateSource }: DevToolsProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>(defaultTab);
  const [picking, setPicking] = useState(false);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  const bgColor = theme === 'dark' ? '#1a1a2e' : '#ffffff';
  const textColor = theme === 'dark' ? '#e0e0e0' : '#1a1a1a';
  const borderColor = theme === 'dark' ? '#333' : '#ddd';
  const accentColor = '#6c5ce7';

  if (!open) {
    return createElement('button', {
      onClick: toggle,
      style: {
        position: 'fixed', bottom: '16px', left: '16px', zIndex: 99998,
        background: accentColor, color: '#fff', border: 'none',
        padding: '8px 14px', borderRadius: '8px', cursor: 'pointer',
        fontFamily: 'monospace', fontSize: '12px', fontWeight: 'bold',
        boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
      },
    }, 'PledgeStack DevTools');
  }

  return createElement('div', {
    style: {
      position: 'fixed', bottom: '0', left: '0', right: '0', zIndex: 99998,
      maxHeight: '40vh', background: bgColor, color: textColor,
      borderTop: `2px solid ${accentColor}`, fontFamily: 'monospace', fontSize: '12px',
      display: 'flex', flexDirection: 'column',
    },
  },
    createElement('div', {
      style: { display: 'flex', alignItems: 'center', padding: '6px 12px', borderBottom: `1px solid ${borderColor}` },
    },
      createElement('span', { style: { fontWeight: 'bold', marginRight: '16px', color: accentColor } }, 'PledgeStack DevTools'),
      createElement('button', { onClick: () => setTab('routes'), style: tabBtnStyle(tab === 'routes', accentColor, textColor) }, 'Routes'),
      createElement('button', { onClick: () => setTab('cache'), style: tabBtnStyle(tab === 'cache', accentColor, textColor) }, 'Cache'),
      createElement('button', { onClick: () => setTab('build'), style: tabBtnStyle(tab === 'build', accentColor, textColor) }, 'Build'),
      createElement('button', { onClick: () => setTab('inspector'), style: tabBtnStyle(tab === 'inspector', accentColor, textColor) }, 'Inspector'),
      createElement('button', { onClick: () => setPicking(true), style: { marginLeft: '4px', background: 'none', border: `1px solid ${accentColor}`, color: accentColor, padding: '2px 8px', cursor: 'pointer', borderRadius: '4px', fontSize: '11px' } }, 'Pick'),
      createElement('button', { onClick: toggle, style: { marginLeft: 'auto', background: 'none', border: 'none', color: textColor, cursor: 'pointer' } }, 'x'),
    ),
    createElement('div', { style: { flex: 1, overflowY: 'auto', padding: '8px 12px' } },
      tab === 'routes' && renderRoutes(routes, borderColor),
      tab === 'cache' && renderCache(cacheEntries, borderColor),
      tab === 'build' && renderBuild(routes, borderColor),
      tab === 'inspector' && createElement(ComponentInspector, { selected: selectedComponent, onPropEdit, onNavigateSource, theme }),
    ),
    picking && createElement(ElementPicker, {
      active: picking,
      onPick: () => { setPicking(false); setTab('inspector'); },
    }),
  );
}

function tabBtnStyle(active: boolean, accent: string, text: string): Record<string, string> {
  return {
    background: active ? accent : 'none',
    border: 'none', color: active ? '#fff' : text,
    padding: '4px 10px', cursor: 'pointer', borderRadius: '4px', marginRight: '4px',
  };
}

function renderRoutes(routes: RouteInfo[], border: string): ReactNode {
  if (routes.length === 0) return createElement('div', null, 'No routes loaded');
  return createElement('table', { style: { width: '100%', borderCollapse: 'collapse' } },
    createElement('thead', null,
      createElement('tr', null,
        ['Path', 'Mode', 'Runtime', 'File', 'Load', 'Render'].map((h) =>
          createElement('th', { key: h, style: { textAlign: 'left', padding: '4px 8px', borderBottom: `1px solid ${border}` } }, h),
        ),
      ),
    ),
    createElement('tbody', null,
      routes.map((r) => createElement('tr', { key: r.path },
        createElement('td', { style: tdStyle(border) }, r.path),
        createElement('td', { style: tdStyle(border) }, r.mode),
        createElement('td', { style: tdStyle(border) }, r.runtime),
        createElement('td', { style: tdStyle(border) }, r.filePath.split(/[\\/]/).pop() ?? r.filePath),
        createElement('td', { style: tdStyle(border) }, r.loadTime != null ? `${r.loadTime.toFixed(1)}ms` : '-'),
        createElement('td', { style: tdStyle(border) }, r.renderTime != null ? `${r.renderTime.toFixed(1)}ms` : '-'),
      )),
    ),
  );
}

function renderCache(entries: CacheEntry[], border: string): ReactNode {
  if (entries.length === 0) return createElement('div', null, 'No cache entries');
  return createElement('table', { style: { width: '100%', borderCollapse: 'collapse' } },
    createElement('thead', null,
      createElement('tr', null,
        ['Key', 'Tags', 'Expires', 'Size'].map((h) =>
          createElement('th', { key: h, style: { textAlign: 'left', padding: '4px 8px', borderBottom: `1px solid ${border}` } }, h),
        ),
      ),
    ),
    createElement('tbody', null,
      entries.map((e) => createElement('tr', { key: e.key },
        createElement('td', { style: tdStyle(border) }, e.key),
        createElement('td', { style: tdStyle(border) }, e.tags.join(', ')),
        createElement('td', { style: tdStyle(border) }, new Date(e.expiresAt).toISOString()),
        createElement('td', { style: tdStyle(border) }, `${e.size}B`),
      )),
    ),
  );
}

function renderBuild(routes: RouteInfo[], border: string): ReactNode {
  const stats = {
    total: routes.length,
    ssg: routes.filter((r) => r.mode === 'ssg').length,
    ssr: routes.filter((r) => r.mode === 'ssr').length,
    rsc: routes.filter((r) => r.mode === 'rsc').length,
    api: routes.filter((r) => r.mode === 'api').length,
  };
  return createElement('div', null,
    createElement('div', { style: { marginBottom: '8px' } }, 'Build Summary'),
    Object.entries(stats).map(([key, val]) =>
      createElement('div', { key, style: { display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: `1px solid ${border}` } },
        createElement('span', null, key),
        createElement('span', { style: { fontWeight: 'bold', color: '#6c5ce7' } }, String(val)),
      ),
    ),
  );
}

function tdStyle(border: string): Record<string, string> {
  return { padding: '4px 8px', borderBottom: `1px solid ${border}` };
}
