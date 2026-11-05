import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { getRequestIngress } from '../network/ingress.js';
import { getSessionToken, timingSafeEqualToken } from '../runtime/session-token.js';
import { BrowserPage, launchBrowser } from '../browser-driver/session.js';
import { normalizeLaunchOptions } from '../browser-driver/launch-options.js';
import { loadBrowserConfig } from '../cdp/browser-config.js';

const path = '/api/browser-agent/desktop-v1';
let desktop;

class DesktopConnection extends EventEmitter {
  pending = new Map();
  constructor(socket) {
    super();
    this.setMaxListeners(0);
    this.socket = socket;
    let responsive = true;
    socket.on('pong', () => { responsive = true; });
    const heartbeat = setInterval(() => {
      if (!responsive) { socket.terminate(); return; }
      responsive = false;
      socket.ping();
    }, 15000);
    heartbeat.unref();
    socket.on('message', (raw) => {
      try {
        const message = JSON.parse(raw);
        if (message.event) this.emit(message.tabId, message.event, message.params);
        else this.pending.get(message.id)?.(message);
      } catch { socket.terminate(); }
    });
    socket.on('error', () => socket.terminate());
    socket.once('close', () => {
      clearInterval(heartbeat);
      if (desktop === this) desktop = null;
      for (const settle of this.pending.values()) settle({ error: 'Desktop browser disconnected' });
      this.emit('disconnect');
    });
  }
  call(tabId, op, args = {}, timeoutMs = 15000) {
    if (this.socket.readyState !== 1 || this.pending.size >= 256) {
      return Promise.reject(new Error('Desktop browser unavailable or busy'));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const settle = ({ result, error }) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (error) reject(new Error(error));
        else resolve(result);
      };
      const timer = setTimeout(() => settle({ error: 'Desktop browser command timed out' }), timeoutMs);
      this.pending.set(id, settle);
      this.socket.send(JSON.stringify({ id, tabId, op, args }), (err) => {
        if (err) settle({ error: err.message });
      });
    });
  }
}

export function attachNativeBrowserHost(server) {
  const ws = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== path) return;
    if (req.headers.origin || getRequestIngress(req) !== 'loopback' ||
        !timingSafeEqualToken(req.headers['x-minnow-token'], getSessionToken()) || desktop) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    ws.handleUpgrade(req, socket, head, (client) => { desktop = new DesktopConnection(client); });
  });
}

class NativePage extends BrowserPage {
  native = true;
  alive = true;
  lastSnapshot = null;
  client = new EventEmitter();

  constructor(host, tabId, options, allowedOriginPatterns) {
    super();
    Object.assign(this, { host, tabId, options, allowedOriginPatterns });
    this.client.send = (method, params, opts) =>
      host.call(tabId, 'command', { method, params }, opts?.timeoutMs || options.commandTimeoutMs);
    this.onEvent = (event, params) => {
      if (event === 'closed') this.end();
      else this.client.emit(event, params);
    };
    this.onDisconnect = () => this.end();
    host.on(tabId, this.onEvent);
    host.once('disconnect', this.onDisconnect);
    this.timer = setTimeout(() => void this.close().catch(() => {}), options.hardTimeoutMs);
    this.timer.unref();
  }
  end() {
    if (!this.alive) return;
    this.alive = false;
    clearTimeout(this.timer);
    this.host.off(this.tabId, this.onEvent);
    this.host.off('disconnect', this.onDisconnect);
    this.client.emit('closed');
  }
  async setMode(mode) {
    return this.host.call(this.tabId, 'mode', { mode, patterns: this.allowedOriginPatterns });
  }
  confirmTransfer(owner) {
    return this.host.call(this.tabId, 'confirm-transfer', { owner }, 60000);
  }
  async isResponsive() { return this.alive; }
  async close() {
    if (!this.alive) return;
    try { await this.host.call(this.tabId, 'close'); }
    finally { this.end(); }
  }
  async kill() { await this.close(); }
}

export async function launchAgentPage(opts) {
  const config = await loadBrowserConfig();
  if (!config.nativeAgentTabs && process.env.MINNOW_NATIVE_AGENT_BROWSER !== '1') return launchBrowser(opts);
  if (!desktop && (process.versions.electron || process.env.MINNOW_ELECTRON === '1') && process.env.MINNOW_NATIVE_AGENT_BROWSER !== '0') {
    for (let attempt = 0; attempt < 20 && !desktop; attempt++) await delay(100);
    if (!desktop) throw new Error('Native Agent Browser is disconnected. Reopen Minnow or disable native agent tabs in Browser settings.');
  }
  const host = desktop;
  if (!host) return launchBrowser(opts);
  if (!config.enabled) throw new Error('Browser automation is disabled in Settings');
  const page = new NativePage(host, opts.tabId, normalizeLaunchOptions(opts), opts.allowedOriginPatterns ?? config.allowedOriginPatterns);
  try {
    await host.call(opts.tabId, 'create', { viewport: opts.viewport });
    await page.client.send('Page.enable');
    return { ok: true, session: page };
  } catch (error) {
    await page.close().catch(() => {});
    throw error;
  }
}
