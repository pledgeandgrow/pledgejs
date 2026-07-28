import { createServer, type IncomingMessage, type ServerResponse, request as httpRequest } from 'node:http';
import { join, extname, sep } from 'node:path';
import type { PledgeConfig, BundlerAdapter } from 'pledgestack-shared';
import { createRequestHandler } from './handler';
import { tryServePledgeVirtual, tryServeRouterModule } from './virtual-modules';
import { loadInstrumentation } from './instrumentation';
import { compressResponse, readFileFast } from 'pledgestack-core';

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

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', `http://${hostname}:${port}`);

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

      const response = await handler({ url, method: req.method ?? 'GET', headers: req.headers as Record<string, string>, body });

      // Native compression middleware — compress string responses based on Accept-Encoding
      const headers = { ...response.headers };
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
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  });

  if (proxyTarget) {
    server.on('upgrade', (req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
      const upgradeUrl = req.url ?? '';
      // PledgePack HMR
      if (upgradeUrl.includes('/__pledge_hmr')) {
        proxyUpgrade(req, socket, head, proxyTarget);
        return;
      }
      // Vite HMR
      if (upgradeUrl.includes('/__vite') || upgradeUrl.includes('/__vite_hmr')) {
        proxyUpgrade(req, socket, head, proxyTarget);
        return;
      }
    });
  }

  server.listen(port, hostname, () => {
    console.log(`\n  PledgeStack ${isDev ? 'dev' : 'production'} server running at http://${hostname}:${port}\n`);
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

  const publicDir = join(config.rootDir, config.publicDir);
  const filePath = join(publicDir, pathname);

  if (!filePath.startsWith(publicDir + sep) && filePath !== publicDir) return false;

  try {
    const content = await readFileFast(filePath);
    const ext = extname(filePath);
    const contentType = getContentType(ext);
    res.writeHead(200, { 'Content-Type': contentType });
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
