import { createServer, type IncomingMessage, type ServerResponse, request as httpRequest } from 'node:http';
import { join, extname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { PledgeConfig, BundlerAdapter } from 'pledgestack-shared';
import { createRequestHandler } from './handler';
import { tryServePledgeVirtual, tryServeRouterModule } from './virtual-modules';
import { loadInstrumentation } from './instrumentation';
import { compressResponse, readFileFast } from 'pledgestack-core';
import { applySecurityHeaders } from './security-headers';
import { staticAssetHeaders } from './mime-types';
import { createHealthCheck } from './health';
import { createMetricsCollector, createMetricsMiddleware } from './metrics';
import { validateHost } from './dns-rebinding';
import { setupGracefulShutdown } from './graceful-shutdown';

export interface NodeServerOptions {
  config: PledgeConfig;
  port?: number;
  hostname?: string;
  isDev?: boolean;
  /** Bundler dev server port for proxying module/asset/HMR requests */
  pledgepackPort?: number;
  /** Optional bundler adapter — if provided, used for module transforms instead of legacy transformFile */
  adapter?: BundlerAdapter;
}

/**
 * Creates and starts a Node.js HTTP server for PledgeStack.
 *
 * In dev mode with pledgepackPort set:
 *   - Module/asset/HMR requests are proxied to PledgePack's Rust dev server
 *   - SSR, API routes, and middleware are handled by Node.js
 *   - HMR is handled by PledgePack's Rust server (WebSocket proxy)
 *
 * In production mode:
 *   - All requests handled by Node.js from pre-bundled output
 */
export function startNodeServer(options: NodeServerOptions) {
  const { config, port = 3000, hostname = 'localhost', isDev = false, pledgepackPort, adapter } = options;
  const { handler } = createRequestHandler({ config, isDev, pledgepackPort, adapter });

  const proxyTarget = pledgepackPort ? `http://${hostname}:${pledgepackPort}` : null;

  // Set up health check endpoint
  const healthCheck = createHealthCheck({ path: '/health' });

  // Set up metrics collection
  const metricsCollector = createMetricsCollector();
  const metricsMiddleware = createMetricsMiddleware(metricsCollector);

  // Set up graceful shutdown with request tracking
  const shutdownServers: Server[] = [];
  const shutdown = setupGracefulShutdown({
    servers: shutdownServers,
    onShutdown: [],
  });

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Track in-flight request for graceful shutdown
    shutdown.trackRequest(req, res);

    try {
      const url = new URL(req.url ?? '/', `http://${hostname}:${port}`);

      // DNS rebinding protection in dev mode
      if (isDev) {
        const host = req.headers['host'];
        if (!validateHost(host)) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('DNS rebinding detected');
          return;
        }
      }

      // Health check endpoint
      if (url.pathname === '/health') {
        const result = await healthCheck.handler();
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.body));
        return;
      }

      // Metrics endpoint
      if (url.pathname === '/metrics') {
        const metrics = JSON.stringify(metricsCollector.export(), null, 2);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(metrics);
        return;
      }

      if (await tryServePledgeVirtual(req, res, config, isDev, pledgepackPort)) return;

      if (tryServeRouterModule(req, res, config)) return;

      if (proxyTarget && shouldProxyToBundler(url.pathname)) {
        proxyRequest(req, res, proxyTarget);
        return;
      }

      if (await tryServeStatic(req, res, config)) return;

      let body: string | null = null;
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        body = Buffer.concat(chunks).toString('utf-8');
      }

      const metricsStartTime = metricsMiddleware.requestStart(req.method ?? 'GET', url.pathname);
      const response = await handler({ url, method: req.method ?? 'GET', headers: req.headers as Record<string, string>, body });
      metricsMiddleware.requestEnd(req.method ?? 'GET', url.pathname, response.status, metricsStartTime);

      // Auto-apply security headers to all responses
      const isHttps = req.headers['x-forwarded-proto'] === 'https' || (req.socket as { encrypted?: boolean }).encrypted === true;
      const headers = applySecurityHeaders({ ...response.headers }, config, isHttps);
      let responseBody: string | Buffer | null = null;

      if (typeof response.body === 'string' && !response.isBase64) {
        const acceptEncoding = req.headers['accept-encoding'] as string | undefined;
        if (acceptEncoding) {
          const { body: compressed, encoding } = compressResponse(response.body, acceptEncoding);
          if (encoding) {
            responseBody = compressed;
            headers['Content-Encoding'] = encoding;
            headers['Vary'] = headers['Vary'] ? `${headers['Vary']}, Accept-Encoding` : 'Accept-Encoding';
          } else {
            responseBody = response.body;
          }
        } else {
          responseBody = response.body;
        }
      }

      res.writeHead(response.status, headers);
      if (responseBody) {
        if (response.isBase64 && typeof responseBody === 'string') {
          res.end(Buffer.from(responseBody, 'base64'));
        } else if (typeof responseBody === 'string') {
          res.end(responseBody);
        } else if (Buffer.isBuffer(responseBody)) {
          res.end(responseBody);
        } else {
          res.end();
        }
      } else if (response.body && typeof response.body !== 'string') {
          const reader = response.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
          res.end();
      } else {
        res.end();
      }
    } catch (err) {
      console.error('[pledgestack] Request error:', err);
      const isDev = process.env.NODE_ENV !== 'production';
      const errorHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Internal Server Error</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0a0a; color: #e0e0e0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .container { text-align: center; max-width: 600px; padding: 2rem; }
    .status { font-size: 6rem; font-weight: 700; color: #ff4444; line-height: 1; }
    .title { font-size: 1.5rem; margin: 1rem 0; color: #fff; }
    .message { color: #999; font-size: 1rem; margin-bottom: 2rem; }
    a { color: #3b82f6; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <div class="status">500</div>
    <h1 class="title">Internal Server Error</h1>
    <p class="message">Something went wrong on the server.</p>
    ${isDev ? `<pre style="text-align:left;background:#1a1a1a;padding:1rem;border-radius:8px;overflow:auto;font-size:0.85rem;color:#ff6b6b;">${String(err).replace(/</g, '&lt;')}</pre>` : ''}
    <p><a href="/">Go home</a></p>
  </div>
</body>
</html>`;
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(errorHtml);
    }
  });

  // WebSocket upgrade handler — supports HMR proxy and app WebSocket routes
  server.on('upgrade', (req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    const upgradeUrl = req.url ?? '';
    // PledgePack HMR
    if (upgradeUrl.includes('/__pledge_hmr')) {
      if (proxyTarget) proxyUpgrade(req, socket, head, proxyTarget);
      return;
    }
    // Vite HMR
    if (upgradeUrl.includes('/__vite') || upgradeUrl.includes('/__vite_hmr')) {
      if (proxyTarget) proxyUpgrade(req, socket, head, proxyTarget);
      return;
    }
    // App WebSocket routes (ws://host/ws/*)
    if (upgradeUrl.startsWith('/ws/')) {
      // WebSocket route handling is done via the pledgestack-ws plugin
      // The actual WebSocket server is created by the plugin's configureServer hook
      // If no WS plugin is configured, close the connection
      socket.destroy();
      return;
    }
  });

  server.listen(port, hostname, async () => {
    console.log(`\n  PledgeStack ${isDev ? 'dev' : 'production'} server running at http://${hostname}:${port}\n`);

    // Restore fetch cache from KV store on startup (production only)
    if (!isDev) {
      try {
        const { initKvCache, restoreFromKV } = await import('./fetch-cache');
        await initKvCache();
        await restoreFromKV();
      } catch {
        // KV store not available — continue with empty cache
      }
    }
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  [pledgestack] Port ${port} is already in use. Try a different port with --port.\n`);
    } else {
      console.error(`\n  [pledgestack] Server error:`, err);
    }
    process.exit(1);
  });

  loadInstrumentation(config, server, isDev).catch((err) => {
    console.error('[pledgestack] Instrumentation failed:', err);
  });

  // Register server with graceful shutdown (push to array captured by closure)
  shutdownServers.push(server);

  return server;
}

const MODULE_EXTENSIONS = /\.(js|ts|tsx|jsx|mjs|cjs|css|json|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|wasm)$/;

function shouldProxyToBundler(pathname: string): boolean {
  if (pathname.startsWith('/src/')) return true;
  if (pathname.startsWith('/app/')) return true;
  if (pathname.startsWith('/node_modules/')) return true;
  if (pathname.startsWith('/@fs/')) return true;
  if (pathname.startsWith('/@id/')) return true;
  if (pathname.startsWith('/__pledge_hmr')) return true;
  if (pathname.startsWith('/__pledge_public/')) return true;
  if (pathname.startsWith('/__pledge_error')) return true;
  if (MODULE_EXTENSIONS.test(pathname)) return true;
  return false;
}

function proxyRequest(req: IncomingMessage, res: ServerResponse, target: string) {
  const proxyReq = httpRequest(target + req.url, {
    method: req.method,
    headers: req.headers,
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (err) => {
    console.error('[pledgestack] Proxy error:', err);
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Bad Gateway — bundler dev server unavailable');
  });
  req.pipe(proxyReq);
}

function proxyUpgrade(req: IncomingMessage, socket: import('node:stream').Duplex, _head: Buffer, target: string) {
  const targetUrl = new URL(target);
  const proxyReq = httpRequest({
    hostname: targetUrl.hostname,
    port: targetUrl.port,
    path: req.url,
    method: 'GET',
    headers: {
      ...req.headers,
      host: targetUrl.host,
    },
  });
  proxyReq.on('upgrade', (proxyRes, proxySocket: import('node:net').Socket, proxyHead: Buffer) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Accept: ${proxyRes.headers['sec-websocket-accept'] ?? ''}\r\n` +
      (proxyRes.headers['sec-websocket-protocol']
        ? `Sec-WebSocket-Protocol: ${proxyRes.headers['sec-websocket-protocol']}\r\n`
        : '') +
      `\r\n`
    );
    if (proxyHead.length > 0) socket.write(proxyHead);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
    proxySocket.on('error', () => socket.destroy());
    socket.on('error', () => proxySocket.destroy());
  });
  proxyReq.on('error', (err) => {
    console.error('[pledgestack] WebSocket proxy error:', err);
    socket.destroy();
  });
  proxyReq.end();
}

/**
 * Attempts to serve a static file from the public directory.
 */
async function tryServeStatic(
  _req: IncomingMessage,
  res: ServerResponse,
  config: PledgeConfig,
): Promise<boolean> {
  const rawUrl = _req.url ?? '/';
  if (rawUrl === '/' || rawUrl.includes('/__pledge__/')) return false;

  const pathname = decodeURIComponent(new URL(rawUrl, 'http://localhost').pathname);

  // Path traversal protection — reject paths containing .. or null bytes
  if (pathname.includes('..') || pathname.includes('\0')) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return true;
  }

  const publicDir = join(config.rootDir, config.publicDir);
  const filePath = join(publicDir, pathname);

  if (!filePath.startsWith(publicDir + sep) && filePath !== publicDir) return false;

  try {
    const content = await readFileFast(filePath);
    const ext = extname(filePath);
    const contentType = getContentType(ext);

    // Generate ETag for cache validation
    const etag = 'W/"' + createHash('sha256').update(content).digest('hex').slice(0, 16) + '"';

    // Check If-None-Match for 304 Not Modified
    const ifNoneMatch = _req.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch === etag) {
      res.writeHead(304, { ETag: etag });
      res.end();
      return true;
    }

    // Build response headers
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      ETag: etag,
    };

    // Add security headers for script/style assets
    if (ext === '.js' || ext === '.mjs' || ext === '.css') {
      Object.assign(headers, staticAssetHeaders(extname(filePath)));
    }

    // Cache-Control: immutable for hashed assets, short cache for HTML
    if (ext === '.html' || ext === '') {
      headers['Cache-Control'] = 'no-cache, must-revalidate';
    } else if (ext.match(/\.(js|mjs|css|woff2?|ttf|otf|png|jpg|jpeg|gif|svg|ico|webp|avif)$/)) {
      // Hashed assets (common with bundlers) — cache for 1 year
      headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    } else {
      headers['Cache-Control'] = 'public, max-age=3600';
    }

    res.writeHead(200, headers);
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

function getContentType(ext: string): string {
  const types: Record<string, string> = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };
  return types[ext] ?? 'application/octet-stream';
}
