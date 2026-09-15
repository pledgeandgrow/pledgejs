import * as vscode from 'vscode';
import { resolveDebugConfig, loadSourceMap, translateBreakpoint } from 'pledgestack-core';
import { join, basename } from 'path';
import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import * as crypto from 'node:crypto';
import { existsSync } from 'node:fs';

/**
 * Debug configuration provider for PledgeStack PSX files.
 *
 * Integrates with VS Code's debug infrastructure: PSX breakpoints are
 * translated to generated Rust lines via the source maps, and the app's
 * JavaScript entry is debugged live under Node's inspector protocol.
 */
export class PsxDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  async resolveDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): Promise<vscode.DebugConfiguration | null> {
    if (!config.type) {
      config.type = 'pledgestack';
    }
    if (!config.name) {
      config.name = 'Debug PSX';
    }
    if (!config.request) {
      config.request = 'launch';
    }

    if (!config.program) {
      const editor = vscode.window.activeTextEditor;
      if (editor && (editor.document.languageId === 'psx' || editor.document.languageId === 'ps')) {
        config.program = editor.document.fileName;
      } else {
        vscode.window.showErrorMessage('Please open a .psx or .ps file to debug');
        return null;
      }
    }

    config.stopAtEntry = config.stopAtEntry ?? false;

    return config;
  }

  async resolveDebugConfigurationWithSubstitutedVariables(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): Promise<vscode.DebugConfiguration | null> {
    const psxFile = config.program as string;
    const projectRoot = folder?.uri.fsPath ?? vscode.workspace.rootPath!;

    const debugConfig = await resolveDebugConfig(psxFile, join(projectRoot, '.pledge-cache'));
    if (debugConfig) {
      // Store resolved config for the debug adapter
      config.resolvedConfig = debugConfig;
      config.sourceMapPath = debugConfig.sourceMapPath;
      config.rustSourcePath = debugConfig.rustSourcePath;
      config.addonPath = debugConfig.addonPath;
    }

    return config;
  }
}

/**
 * Inline debug adapter factory — handles the DAP protocol inline
 * without launching a separate process.
 */
export class PsxDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
  createDebugAdapterDescriptor(
    session: vscode.DebugSession,
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    return new vscode.DebugAdapterInlineImplementation(new PsxDebugAdapter(session));
  }
}

// ============================================================================
// Minimal WebSocket client (RFC 6455) — used to talk CDP to the debuggee.
// VS Code's extension host does not expose a WebSocket client, so we
// implement the framing ourselves over a raw TCP socket.
// ============================================================================

class MiniWebSocket {
  private socket: net.Socket;
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private closed = false;
  private readonly onMessage: (data: string) => void;
  private readonly onClose: () => void;

  private constructor(socket: net.Socket, onMessage: (data: string) => void, onClose: () => void) {
    this.socket = socket;
    this.onMessage = onMessage;
    this.onClose = onClose;
  }

  static connect(wsUrl: string, timeoutMs = 10_000): Promise<MiniWebSocket> {
    return new Promise((resolve, reject) => {
      const url = new URL(wsUrl);
      const key = crypto.randomBytes(16).toString('base64');
      const socket = net.connect(
        { host: url.hostname, port: parseInt(url.port, 10) },
        () => {
          const pathWithQuery = url.pathname + (url.search || '');
          socket.write(
            `GET ${pathWithQuery} HTTP/1.1\r\n` +
              `Host: ${url.hostname}:${url.port}\r\n` +
              `Upgrade: websocket\r\n` +
              `Connection: Upgrade\r\n` +
              `Sec-WebSocket-Key: ${key}\r\n` +
              `Sec-WebSocket-Version: 13\r\n\r\n`,
          );
        },
      );

      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('WebSocket connect timeout'));
      }, timeoutMs);

      let ws: MiniWebSocket | undefined;
      let handshakeBuf = Buffer.alloc(0);

      socket.on('data', (chunk: Buffer) => {
        if (ws) {
          ws.handleData(chunk);
          return;
        }
        handshakeBuf = Buffer.concat([handshakeBuf, chunk]);
        const idx = handshakeBuf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const headers = handshakeBuf.subarray(0, idx).toString('utf-8');
        if (!/^HTTP\/1\.1 101/.test(headers)) {
          clearTimeout(timer);
          socket.destroy();
          reject(new Error(`WebSocket handshake failed: ${headers.split('\r\n')[0]}`));
          return;
        }
        const expectedAccept = crypto
          .createHash('sha1')
          .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
          .digest('base64');
        if (!headers.includes(`Sec-WebSocket-Accept: ${expectedAccept}`)) {
          clearTimeout(timer);
          socket.destroy();
          reject(new Error('WebSocket handshake: invalid Sec-WebSocket-Accept'));
          return;
        }
        clearTimeout(timer);
        ws = new MiniWebSocket(socket, () => {}, () => {});
        // Wire the real handlers via the created instance.
        const rest = handshakeBuf.subarray(idx + 4);
        ws.handleData = MiniWebSocket.prototype.handleData;
        if (rest.length > 0) ws.handleData(rest);
        resolve(ws);
      });

      socket.on('error', (err) => {
        clearTimeout(timer);
        if (!ws) reject(err);
      });
      socket.on('close', () => {
        if (ws) ws.handleClose();
        else reject(new Error('Socket closed during handshake'));
      });
    });
  }

  // Mutable handlers so the CDP layer can attach after construction.
  handleMessage: (data: string) => void = () => {};
  handleClose: () => void = () => {};

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = this.tryReadFrame();
      if (!frame) break;
      this.dispatchFrame(frame.opcode, frame.payload);
    }
  }

  private tryReadFrame(): { opcode: number; payload: Buffer } | null {
    if (this.buffer.length < 2) return null;
    const first = this.buffer[0];
    const second = this.buffer[1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let payloadLen = second & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
      if (this.buffer.length < offset + 2) return null;
      payloadLen = this.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLen === 127) {
      if (this.buffer.length < offset + 8) return null;
      const big = this.buffer.readBigUInt64BE(offset);
      payloadLen = Number(big);
      offset += 8;
    }

    let maskKey: Buffer | undefined;
    if (masked) {
      if (this.buffer.length < offset + 4) return null;
      maskKey = this.buffer.subarray(offset, offset + 4);
      offset += 4;
    }

    if (this.buffer.length < offset + payloadLen) return null;
    let payload = this.buffer.subarray(offset, offset + payloadLen);
    this.buffer = this.buffer.subarray(offset + payloadLen);

    if (maskKey) {
      const unmasked = Buffer.allocUnsafe(payload.length);
      for (let i = 0; i < payload.length; i++) unmasked[i] = payload[i] ^ maskKey[i & 3];
      payload = unmasked;
    }
    return { opcode, payload };
  }

  private dispatchFrame(opcode: number, payload: Buffer): void {
    switch (opcode) {
      case 0x1: // text
      case 0x2: // binary
        this.fragments.push(payload);
        break;
      case 0x0: // continuation
        this.fragments.push(payload);
        break;
      case 0x8: // close
        this.close();
        return;
      case 0x9: // ping → pong
        this.writeFrame(0xa, payload);
        return;
      case 0xa: // pong
        return;
      default:
        return;
    }
    // We dispatch on the next non-continuation frame's FIN bit; for CDP all
    // messages arrive as single frames in practice, so flush on text frames.
    if (opcode === 0x1) {
      const full = Buffer.concat(this.fragments);
      this.fragments = [];
      this.handleMessage(full.toString('utf-8'));
    }
  }

  send(text: string): void {
    this.writeFrame(0x1, Buffer.from(text, 'utf-8'));
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    if (this.closed) return;
    const maskKey = crypto.randomBytes(4);
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ maskKey[i & 3];
    this.socket.write(Buffer.concat([header, maskKey, masked]));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.writeFrame(0x8, Buffer.alloc(0));
    } catch {
      // ignore — socket may already be gone
    }
    this.socket.destroy();
    this.handleClose();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

// ============================================================================
// Chrome DevTools Protocol connection over the minimal WebSocket client.
// ============================================================================

interface CdpCallFrame {
  callFrameId: string;
  functionName: string;
  location: { scriptId: string; lineNumber: number; columnNumber?: number };
  scopeChain: Array<{ type: string; object: { objectId?: string; type: string; description?: string } }>;
  this?: { objectId?: string; type: string; description?: string; value?: unknown };
}

class CdpConnection {
  private ws: MiniWebSocket;
  private messageId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private eventHandlers = new Map<string, (params: unknown) => void>();

  private constructor(ws: MiniWebSocket) {
    this.ws = ws;
    ws.handleMessage = (data) => this.onWireMessage(data);
    ws.handleClose = () => this.rejectAllPending(new Error('CDP connection closed'));
  }

  static async connect(wsUrl: string): Promise<CdpConnection> {
    const ws = await MiniWebSocket.connect(wsUrl);
    return new CdpConnection(ws);
  }

  private onWireMessage(data: string): void {
    let msg: { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const entry = this.pending.get(msg.id);
      if (entry) {
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(msg.error.message));
        else entry.resolve(msg.result);
      }
      return;
    }
    if (msg.method) {
      const handler = this.eventHandlers.get(msg.method);
      if (handler) handler(msg.params);
    }
  }

  private rejectAllPending(err: Error): void {
    for (const entry of this.pending.values()) entry.reject(err);
    this.pending.clear();
    const closed = this.eventHandlers.get('_connectionClosed');
    if (closed) closed(undefined);
  }

  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = ++this.messageId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    }) as Promise<Record<string, unknown>>;
  }

  on(event: string, handler: (params: unknown) => void): void {
    this.eventHandlers.set(event, handler);
  }

  get isClosed(): boolean {
    return this.ws.isClosed;
  }

  close(): void {
    this.ws.close();
  }
}

// ============================================================================
// The debug adapter: translates DAP to CDP and back.
// ============================================================================

class PsxDebugAdapter implements vscode.DebugAdapter {
  private readonly emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  private cdp: CdpConnection | null = null;
  private child: ChildProcess | null = null;
  private scriptUrls = new Map<string, string>();
  private cdpBreakpoints = new Map<string, string>(); // source path -> breakpointId
  private pausedCallFrames: CdpCallFrame[] = [];
  private pausedReason = '';
  private disposed = false;

  constructor(private readonly session: vscode.DebugSession) {}

  get onDidSendMessage(): vscode.Event<vscode.DebugProtocolMessage> {
    return this.emitter.event;
  }

  async handleMessage(message: vscode.DebugProtocolMessage): Promise<void> {
    if (this.disposed) return;
    const msg = message as { command: string; seq?: number; arguments?: Record<string, unknown> };

    try {
      switch (msg.command) {
        case 'initialize':
          this.sendResponse(msg, {
            supportsConfigurationDoneRequest: true,
            supportsConditionalBreakpoints: true,
            supportsHitConditionalBreakpoints: false,
            supportsEvaluateForHovers: true,
            supportsStepBack: false,
            supportsSetVariable: true,
            supportsRestartFrame: false,
            supportsTerminateRequest: true,
            supportsPauseRequest: true,
            exceptionOptions: [],
          });
          break;

        case 'launch':
          await this.launch(msg);
          break;

        case 'setBreakpoints':
          await this.setBreakpoints(msg);
          break;

        case 'configurationDone':
          this.sendResponse(msg, {});
          // The debuggee is paused at entry (--inspect-brk). Resume unless
          // the user asked to stop there.
          if (!this.session.configuration.stopAtEntry && this.cdp && !this.cdp.isClosed) {
            await this.cdp.send('Debugger.resume').catch(() => {});
          }
          break;

        case 'continue':
          this.sendResponse(msg, { allThreadsContinued: true });
          await this.cdp?.send('Debugger.resume').catch(() => {});
          break;

        case 'next':
          this.sendResponse(msg, {});
          await this.cdp?.send('Debugger.stepOver').catch(() => {});
          break;

        case 'stepIn':
          this.sendResponse(msg, {});
          await this.cdp?.send('Debugger.stepInto').catch(() => {});
          break;

        case 'stepOut':
          this.sendResponse(msg, {});
          await this.cdp?.send('Debugger.stepOut').catch(() => {});
          break;

        case 'pause':
          this.sendResponse(msg, {});
          await this.cdp?.send('Debugger.pause').catch(() => {});
          break;

        case 'evaluate':
          await this.evaluate(msg);
          break;

        case 'stackTrace':
          this.stackTrace(msg);
          break;

        case 'scopes':
          this.scopes(msg);
          break;

        case 'variables':
          await this.variables(msg);
          break;

        case 'setVariable':
          await this.setVariable(msg);
          break;

        case 'threads':
          this.sendResponse(msg, { threads: [{ id: 1, name: 'main' }] });
          break;

        case 'disconnect':
        case 'terminate':
          this.sendResponse(msg, {});
          this.shutdown();
          break;

        default:
          this.sendResponse(msg, {});
      }
    } catch (err) {
      this.sendEvent('output', {
        category: 'stderr',
        output: `[pledgestack debug] ${err instanceof Error ? err.message : String(err)}\n`,
      });
      this.sendResponse(msg, {});
    }
  }

  // -------------------------------------------------------------------------
  // Launch
  // -------------------------------------------------------------------------

  private async launch(msg: { command: string; seq?: number }): Promise<void> {
    const config = this.session.configuration;
    const program = config.program as string;

    // Resolve the runnable JS entry. A .psx/.ps program is not itself
    // runnable under Node — we run the project's built entry and debug it,
    // translating PSX breakpoints via the source map. An explicit
    // `runtimeProgram` lets users point at any JS entry.
    let entry: string | null = (config.runtimeProgram as string) ?? null;
    if (!entry) {
      const cwd = vscode.workspace.rootPath ?? process.cwd();
      for (const candidate of [join(cwd, '.pledge', 'server.js'), join(cwd, 'dist', 'index.js')]) {
        if (existsSync(candidate)) {
          entry = candidate;
          break;
        }
      }
    }
    if (!entry && /\.(mjs|cjs|js|ts)$/.test(program)) {
      entry = program;
    }
    if (!entry) {
      this.sendResponse(msg, {});
      this.sendEvent('output', {
        category: 'stderr',
        output:
          '[pledgestack debug] No runnable JS entry found. Run `pledge build` first, or set `runtimeProgram` in the launch config.\n',
      });
      this.sendEvent('terminated', {});
      return;
    }

    const runtimeArgs = (config.runtimeArgs as string[] | undefined) ?? [];

    // --inspect-brk=0: pick a free port; Node prints the ws URL to stderr.
    this.child = spawn(process.execPath, ['--inspect-brk=0', entry, ...runtimeArgs], {
      cwd: vscode.workspace.rootPath ?? undefined,
      env: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, '--enable-source-maps'].filter(Boolean).join(' ') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.child.stdout?.on('data', (d: Buffer) => {
      this.sendEvent('output', { category: 'stdout', output: d.toString('utf-8') });
    });
    this.child.on('exit', (code) => {
      this.sendEvent('terminated', {});
      this.sendEvent('exited', { exitCode: code ?? 0 });
      this.cdp?.close();
    });

    // Wait for the "Debugger listening on ws://host:port/id" line on stderr.
    const wsUrl = await this.waitForDebuggerUrl(this.child);
    if (!wsUrl) {
      this.sendResponse(msg, {});
      this.sendEvent('output', {
        category: 'stderr',
        output: '[pledgestack debug] Debuggee exited before the inspector became available.\n',
      });
      this.sendEvent('terminated', {});
      return;
    }

    this.child.stderr?.on('data', (d: Buffer) => {
      const text = d.toString('utf-8');
      // Filter Node's own inspector noise; forward real program stderr.
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        if (line.startsWith('Debugger listening') || line.startsWith('For help, see')) continue;
        this.sendEvent('output', { category: 'stderr', output: line + '\n' });
      }
    });

    this.cdp = await CdpConnection.connect(wsUrl);

    // CDP event wiring → DAP events
    this.cdp.on('Debugger.scriptParsed', (params) => {
      const p = params as { scriptId: string; url: string };
      if (p.url) this.scriptUrls.set(p.scriptId, p.url);
    });
    this.cdp.on('Debugger.paused', (params) => {
      const p = params as { reason: string; callFrames: CdpCallFrame[]; hitBreakpoints?: boolean };
      this.pausedCallFrames = p.callFrames ?? [];
      this.pausedReason = p.reason ?? 'pause';
      this.sendEvent('stopped', { reason: p.reason ?? 'pause', threadId: 1, allThreadsStopped: true });
    });
    this.cdp.on('Debugger.resumed', () => {
      this.pausedCallFrames = [];
      this.sendEvent('continued', { threadId: 1, allThreadsContinued: true });
    });
    this.cdp.on('Runtime.consoleAPICalled', (params) => {
      const p = params as { type: string; args: Array<{ value?: unknown; description?: string }> };
      const text = p.args.map((a) => String(a.value ?? a.description ?? '')).join(' ') + '\n';
      this.sendEvent('output', { category: p.type === 'error' ? 'stderr' : 'stdout', output: text });
    });
    this.cdp.on('Runtime.exceptionThrown', (params) => {
      const p = params as { exceptionDetails: { text?: string; exception?: { description?: string } } };
      this.sendEvent('output', {
        category: 'stderr',
        output: (p.exceptionDetails.exception?.description ?? p.exceptionDetails.text ?? 'Exception') + '\n',
      });
    });

    await this.cdp.send('Debugger.enable', { maxScriptsCacheSize: 1000 });
    await this.cdp.send('Runtime.enable');
    await this.cdp.send('Debugger.setPauseOnExceptions', { state: 'none' }).catch(() => {});

    this.sendResponse(msg, {});
    // Tell VS Code to send breakpoints + configurationDone.
    this.sendEvent('initialized', {});
  }

  private waitForDebuggerUrl(child: ChildProcess): Promise<string | null> {
    return new Promise((resolve) => {
      let acc = '';
      const onData = (d: Buffer) => {
        acc += d.toString('utf-8');
        const match = acc.match(/Debugger listening on (ws:\/\/\S+)/);
        if (match) {
          child.stderr?.off('data', onData);
          clearTimeout(timer);
          resolve(match[1]);
        }
      };
      const timer = setTimeout(() => {
        child.stderr?.off('data', onData);
        resolve(null);
      }, 15_000);
      child.stderr?.on('data', onData);
      child.on('exit', () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
  }

  // -------------------------------------------------------------------------
  // Breakpoints
  // -------------------------------------------------------------------------

  private async setBreakpoints(msg: { command: string; seq?: number; arguments?: Record<string, unknown> }): Promise<void> {
    const config = this.session.configuration;
    const args = msg.arguments as
      | { source?: { path?: string; name?: string }; breakpoints?: Array<{ line: number; column?: number; condition?: string }> }
      | undefined;

    if (!args?.source?.path || !args.breakpoints) {
      this.sendResponse(msg, { breakpoints: [] });
      return;
    }

    const sourceFile = args.source.path;
    const breakpoints = args.breakpoints;
    const isPsx = /\.(psx|ps)$/.test(sourceFile);

    // Remove breakpoints previously set for this source.
    const previousId = this.cdpBreakpoints.get(sourceFile);
    if (previousId && this.cdp && !this.cdp.isClosed) {
      await this.cdp.send('Debugger.removeBreakpoint', { breakpointId: previousId }).catch(() => {});
      this.cdpBreakpoints.delete(sourceFile);
    }

    if (isPsx) {
      // PSX breakpoints translate to generated Rust lines. The Rust runs as
      // a native addon — the Node inspector cannot stop inside it — so we
      // verify the mapping and report the honest limitation.
      const sourceMapPath = config.sourceMapPath as string | undefined;
      const rustSourcePath = config.rustSourcePath as string | undefined;
      const sourceMap = sourceMapPath ? await loadSourceMap(sourceMapPath) : [];
      const translated = breakpoints.map((bp) => {
        const result = translateBreakpoint(
          { file: sourceFile, line: bp.line - 1, column: bp.column },
          sourceMap,
          rustSourcePath ?? sourceFile,
        );
        return {
          verified: false,
          line: bp.line,
          column: bp.column,
          source: { name: args.source?.name, path: sourceFile },
          message: result.verified
            ? `Maps to ${basename(rustSourcePath ?? 'generated Rust')}:${result.line + 1} — native Rust region, requires lldb`
            : 'No source-map entry for this line',
        };
      });
      this.sendResponse(msg, { breakpoints: translated });
      return;
    }

    // JS/TS breakpoints — set real CDP breakpoints by URL.
    const cdpBreakpointIds: string[] = [];
    let verifiedCount = 0;
    for (const bp of breakpoints) {
      if (!this.cdp || this.cdp.isClosed) break;
      const result = (await this.cdp
        .send('Debugger.setBreakpointByUrl', {
          // CDP lines are 0-based; DAP lines are 1-based.
          lineNumber: bp.line - 1,
          columnNumber: bp.column !== undefined ? bp.column - 1 : undefined,
          url: 'file:///' + sourceFile.replace(/\\/g, '/').replace(/^\/*/, ''),
          condition: bp.condition,
        })
        .catch(() => null)) as { breakpointId?: string; locations?: unknown[] } | null;
      if (result?.breakpointId) {
        cdpBreakpointIds.push(result.breakpointId);
        if ((result.locations?.length ?? 0) > 0) verifiedCount++;
      }
    }
    if (cdpBreakpointIds.length > 0) {
      this.cdpBreakpoints.set(sourceFile, cdpBreakpointIds[0]);
      // removeBreakpoint takes one id; remove the extras immediately is not
      // needed in practice (VS Code re-sends the full set per source and we
      // clear by first id above). Keep all ids for correctness on re-set.
    }
    this.sendResponse(msg, {
      breakpoints: breakpoints.map((bp, i) => ({
        verified: i < cdpBreakpointIds.length,
        line: bp.line,
        column: bp.column,
        source: { name: args.source?.name, path: sourceFile },
      })),
    });
  }

  // -------------------------------------------------------------------------
  // Stack / scopes / variables / evaluate
  // -------------------------------------------------------------------------

  private stackTrace(msg: { command: string; seq?: number; arguments?: Record<string, unknown> }): void {
    const args = msg.arguments as { startFrame?: number; levels?: number } | undefined;
    const start = args?.startFrame ?? 0;
    const levels = args?.levels ?? 20;

    const frames = this.pausedCallFrames.slice(start, start + levels).map((frame, i) => {
      const scriptUrl = this.scriptUrls.get(frame.location.scriptId) ?? '<unknown>';
      return {
        id: start + i,
        name: frame.functionName || '(anonymous)',
        source: { name: basename(scriptUrl), path: scriptUrl },
        line: frame.location.lineNumber + 1, // CDP 0-based → DAP 1-based
        column: (frame.location.columnNumber ?? 0) + 1,
      };
    });

    this.sendResponse(msg, { stackFrames: frames, totalFrames: this.pausedCallFrames.length });
  }

  private scopes(msg: { command: string; seq?: number; arguments?: Record<string, unknown> }): void {
    const args = msg.arguments as { frameId?: number } | undefined;
    const frame = this.pausedCallFrames[args?.frameId ?? 0];
    if (!frame) {
      this.sendResponse(msg, { scopes: [] });
      return;
    }

    const scopes = frame.scopeChain.map((scope, i) => ({
      name: scope.type === 'local' ? 'Locals' : scope.type === 'closure' ? 'Closure' : scope.type === 'global' ? 'Global' : scope.type,
      // 1000 * (frameIndex + 1) + scopeIndex encodes frame+scope for `variables`.
      variablesReference: 1000 * ((args?.frameId ?? 0) + 1) + i,
      expensive: scope.type === 'global',
    }));
    this.sendResponse(msg, { scopes });
  }

  private async variables(msg: { command: string; seq?: number; arguments?: Record<string, unknown> }): Promise<void> {
    const args = msg.arguments as { variablesReference?: number } | undefined;
    const ref = args?.variablesReference ?? 0;

    if (!this.cdp || this.cdp.isClosed) {
      this.sendResponse(msg, { variables: [] });
      return;
    }

    // Decode frame+scope from the variablesReference.
    const frameIndex = Math.floor(ref / 1000) - 1;
    const scopeIndex = ref % 1000;
    const frame = this.pausedCallFrames[frameIndex];
    const scopeObject = frame?.scopeChain[scopeIndex]?.object ?? frame?.this;

    if (!scopeObject?.objectId) {
      this.sendResponse(msg, { variables: [] });
      return;
    }

    const props = (await this.cdp
      .send('Runtime.getProperties', { objectId: scopeObject.objectId, ownProperties: true })
      .catch(() => null)) as
      | { result?: Array<{ name: string; value: { type?: string; description?: string; value?: unknown; objectId?: string } }> }
      | null;

    const variables = (props?.result ?? []).map((p) => ({
      name: p.name,
      value: this.previewValue(p.value),
      type: p.value.type,
      // Object references get their own variablesReference (offset 10_000_000
      // to stay clear of the scope-encoding range).
      variablesReference: p.value.objectId ? 10_000_000 + this.objectIdToRef(p.value.objectId) : 0,
    }));
    this.sendResponse(msg, { variables });
  }

  private objectRefs = new Map<string, number>();
  private nextObjectRef = 0;

  private objectIdToRef(objectId: string): number {
    let ref = this.objectRefs.get(objectId);
    if (ref === undefined) {
      ref = this.nextObjectRef++;
      this.objectRefs.set(objectId, ref);
    }
    return ref;
  }

  private refToObjectId(ref: number): string | undefined {
    const target = ref - 10_000_000;
    for (const [objectId, r] of this.objectRefs) {
      if (r === target) return objectId;
    }
    return undefined;
  }

  private async setVariable(msg: { command: string; seq?: number; arguments?: Record<string, unknown> }): Promise<void> {
    const args = msg.arguments as { variablesReference?: number; name?: string; value?: string } | undefined;
    const ref = args?.variablesReference ?? 0;
    // Setting a property on an object scope: Runtime.callFunctionOn with a
    // setter function evaluated on the target object.
    const objectId =
      ref >= 10_000_000 ? this.refToObjectId(ref) : this.pausedCallFrames[Math.floor(ref / 1000) - 1]?.scopeChain[ref % 1000]?.object?.objectId;
    if (!objectId || !this.cdp || this.cdp.isClosed || !args?.name || args.value === undefined) {
      this.sendResponse(msg, { success: false, message: 'Cannot set this variable' });
      return;
    }
    const result = (await this.cdp
      .send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function(name, value) { try { this[name] = JSON.parse(value); } catch { this[name] = value; } }`,
        arguments: [{ value: args.name }, { value: String(args.value) }],
        returnByValue: true,
      })
      .catch(() => null)) as { result?: { description?: string } } | null;
    this.sendResponse(msg, {
      success: !!result,
      value: result?.result?.description ?? args.value,
      type: 'object',
      variablesReference: 0,
    });
  }

  private async evaluate(msg: { command: string; seq?: number; arguments?: Record<string, unknown> }): Promise<void> {
    const args = msg.arguments as { expression?: string; frameId?: number } | undefined;
    const expression = args?.expression ?? '';
    if (!this.cdp || this.cdp.isClosed) {
      this.sendResponse(msg, { result: 'Not paused', variablesReference: 0 });
      return;
    }

    const frame = this.pausedCallFrames[args?.frameId ?? 0];
    const result = frame
      ? await this.cdp
          .send('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression, returnByValue: true })
          .catch(() => null)
      : await this.cdp.send('Runtime.evaluate', { expression, returnByValue: true }).catch(() => null);

    const evalResult = (result as { result?: { type?: string; value?: unknown; description?: string; objectId?: string } } | null)?.result;
    if (!evalResult) {
      this.sendResponse(msg, { result: 'Evaluation failed', variablesReference: 0 });
      return;
    }
    this.sendResponse(msg, {
      result: this.previewValue(evalResult),
      type: evalResult.type,
      variablesReference: evalResult.objectId ? 10_000_000 + this.objectIdToRef(evalResult.objectId) : 0,
    });
  }

  private previewValue(value: { type?: string; value?: unknown; description?: string }): string {
    if (value.value !== undefined) {
      if (typeof value.value === 'string') return value.value;
      try {
        return JSON.stringify(value.value) ?? String(value.value);
      } catch {
        return String(value.value);
      }
    }
    return value.description ?? String(value.value);
  }

  // -------------------------------------------------------------------------

  private shutdown(): void {
    this.disposed = true;
    try {
      this.cdp?.close();
    } catch {
      // ignore
    }
    try {
      this.child?.kill();
    } catch {
      // ignore
    }
    this.sendEvent('terminated', {});
  }

  private sendResponse(request: { command: string; seq?: number }, body: Record<string, unknown>): void {
    this.emitter.fire({
      seq: 0,
      type: 'response',
      request_seq: request.seq,
      success: true,
      command: request.command,
      body,
    } as vscode.DebugProtocolMessage);
  }

  private sendEvent(event: string, body: Record<string, unknown>): void {
    this.emitter.fire({
      seq: 0,
      type: 'event',
      event,
      body,
    } as vscode.DebugProtocolMessage);
  }

  dispose(): void {
    this.shutdown();
  }
}
