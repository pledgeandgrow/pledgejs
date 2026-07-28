import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import type { PledgeConfig } from 'pledgestack-shared';
import { FILE_CONVENTIONS } from 'pledgestack-shared';

/**
 * Serves PledgeStack virtual modules at /__pledge__/* paths.
 *
 * - /__pledge__/client.css → served from .pledge/__pledge__/client.css
 * - /__pledge__/client.js → generated ESM hydration module
 * - /__pledge__/rsc-client.js → generated RSC client module
 *
 * In dev mode, import paths point to PledgePack's dev server for on-the-fly
 * transformation of react/react-dom from node_modules.
 */
export async function tryServePledgeVirtual(
  req: IncomingMessage,
  res: ServerResponse,
  config: PledgeConfig,
  isDev: boolean,
  pledgepackPort?: number,
): Promise<boolean> {
  const url = req.url ?? '/';
  if (!url.startsWith('/__pledge__/')) return false;

  const pathname = url.split('?')[0];

  if (pathname === '/__pledge__/client.css') {
    return serveClientCss(res, config);
  }

  if (pathname === '/__pledge__/client.js') {
    return serveClientJs(res, config, isDev, pledgepackPort);
  }

  if (pathname === '/__pledge__/rsc-client.js') {
    return serveRscClientJs(res, config, isDev, pledgepackPort);
  }

  if (pathname === '/__pledge__/action') {
    return false;
  }

  return false;
}

/**
 * Serves the /__pledge_router virtual module.
 *
 * This intercepts the router module generation from PledgePack's Rust dev server
 * to fix a bug where route.ts API files were imported with `import default`,
 * but API routes use named exports (GET, POST, etc.) — no default export.
 *
 * The generated module:
 *   - Imports `default` from page/layout/error/loading/not-found files
 *   - Imports named exports (GET, POST, PUT, DELETE, PATCH) from route.ts files
 *   - Exports a route map for client-side navigation
 */
export function tryServeRouterModule(
  req: IncomingMessage,
  res: ServerResponse,
  config: PledgeConfig,
): boolean {
  const url = req.url ?? '/';
  const pathname = url.split('?')[0];

  if (pathname !== '/__pledge_router') return false;

  const appDir = join(config.rootDir, config.appDir);
  const files = scanRouteFiles(appDir);
  const imports: string[] = [];
  const routeEntries: string[] = [];

  for (const file of files) {
    const importPath = `/${file.relativePath}`;

    if (file.convention === FILE_CONVENTIONS.route) {
      const varName = `route_${routeEntries.length}`;
      imports.push(`import * as ${varName} from '${importPath}';`);
      routeEntries.push(`  ${JSON.stringify(file.routePattern)}: { type: 'api', handlers: ${varName} }`);
    } else {
      const varName = `mod_${routeEntries.length}`;
      imports.push(`import ${varName} from '${importPath}';`);
      const conventionType = file.convention ?? 'page';
      routeEntries.push(`  ${JSON.stringify(file.routePattern)}: { type: ${JSON.stringify(conventionType)}, component: ${varName} }`);
    }
  }

  const code = `// PledgeStack router (auto-generated)
${imports.join('\n')}

export const routes = {
${routeEntries.join(',\n')}
};
`;

  res.writeHead(200, {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(code);
  return true;
}

interface RouteFileInfo {
  relativePath: string;
  convention: string | null;
  routePattern: string;
}

function scanRouteFiles(appDir: string): RouteFileInfo[] {
  const results: RouteFileInfo[] = [];

  function walk(dir: string, prefix: string) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        if (entry.startsWith('.') || entry === 'node_modules') continue;
        let segment = entry;
        if (/^\([^)]+\)$/.test(segment)) segment = '';
        if (segment.startsWith('@')) segment = '';
        walk(fullPath, prefix + '/' + segment);
      } else if (stat.isFile() && /\.(tsx|ts|jsx|js)$/.test(entry)) {
        const base = entry.replace(/\.(tsx|ts|jsx|js)$/, '');
        const convention = base in FILE_CONVENTIONS ? base : null;
        if (!convention) continue;

        const relPath = relative(appDir, fullPath).split(sep).join('/');
        let pattern = prefix || '/';
        pattern = pattern.replace(/\/+/g, '/') || '/';
        if (pattern.endsWith('/') && pattern !== '/') {
          pattern = pattern.slice(0, -1);
        }

        results.push({ relativePath: relPath, convention, routePattern: pattern });
      }
    }
  }

  walk(appDir, '');
  return results;
}

async function serveClientCss(
  res: ServerResponse,
  config: PledgeConfig,
): Promise<boolean> {
  const cssPath = join(config.rootDir, config.outDir, '__pledge__', 'client.css');
  try {
    const content = await readFile(cssPath, 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
    res.end(content);
    return true;
  } catch {
    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
    res.end('/* PledgeStack — no client CSS */');
    return true;
  }
}

function serveClientJs(
  res: ServerResponse,
  config: PledgeConfig,
  _isDev: boolean,
  _pledgepackPort?: number,
): boolean {
  const rscEnabled = config.rsc;
  const reactImport = '/node_modules/react/index.js';
  const reactDomClientImport = '/node_modules/react-dom/client.js';

  const code = `// PledgeStack client hydration (auto-generated)
import { hydrateRoot } from '${reactDomClientImport}';
import { createElement } from '${reactImport}';

const root = document.getElementById('__pledge_root__');
if (root) {
  // SSR content is already in the DOM — set up client-side navigation
  ${rscEnabled ? `// RSC mode: hydration handled by rsc-client.js` : ``}
  // Intercept same-origin link clicks for client-side navigation
  document.addEventListener('click', (e) => {
    const link = e.target instanceof Element ? e.target.closest('a[href]') : null;
    if (!link) return;
    if (link.target === '_blank' || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const href = link.getAttribute('href');
    if (!href || href.startsWith('http') || href.startsWith('//')) return;
    e.preventDefault();
    window.location.href = link.href;
  });
}
`;

  res.writeHead(200, {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(code);
  return true;
}

function serveRscClientJs(
  res: ServerResponse,
  _config: PledgeConfig,
  _isDev: boolean,
  _pledgepackPort?: number,
): boolean {
  const reactImport = '/node_modules/react/index.js';
  const reactDomClientImport = '/node_modules/react-dom/client.js';

  const code = `// PledgeStack RSC client (auto-generated)
import { hydrateRoot } from '${reactDomClientImport}';
import { createElement } from '${reactImport}';

// RSC hydration: read the serialized RSC payload and hydrate
const rscData = document.getElementById('__pledge_rsc_data__');
const manifest = document.getElementById('__pledge_manifest__');
const root = document.getElementById('__pledge_root__');

if (root && rscData) {
  try {
    const payload = JSON.parse(rscData.textContent || '[]');
    // The SSR content is already in the DOM
    // In a full implementation, this would reconstruct the React tree
    // from the RSC payload and hydrate it
  } catch (e) {
    console.error('[pledgestack] RSC hydration error:', e);
  }
}
`;

  res.writeHead(200, {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(code);
  return true;
}
