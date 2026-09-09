/**
 * HTTP middleware for /api/diagnostics — local error capture and health probes.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearDiagnosticLogs } from './ring-log.js';
import { loadDiagnosticLogTail, loadGroupedErrors } from './store.js';
import { formatDiagnosticReportMarkdown } from './redact.js';
import { logRendererDiagnostic } from './process-handlers.js';
import { listLspServers, getLspBridgeHealthSnapshot } from '../lsp/manager.js';
import { listPtySessionMeta } from '../terminal/pty-host.js';

const PACKAGE_JSON_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');

function readAppVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
    return typeof pkg.version === 'string' && pkg.version.trim() ? pkg.version.trim() : 'unknown';
  } catch {
    return 'unknown';
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

/**
 * Aggregate subsystem health for the diagnostics viewer and health strip.
 */
export async function buildDiagnosticsHealth() {
  let lspRunning = 0;
  let lspOk = true;
  let lspBridgeError = null;
  try {
    const servers = await listLspServers();
    lspRunning = servers.filter((s) => s.running).length;
    const bridge = getLspBridgeHealthSnapshot();
    lspBridgeError = bridge.lastBridgeError ?? null;
    if (lspBridgeError?.message) {
      lspOk = false;
    }
  } catch {
    lspOk = false;
  }

  let ptySessions = 0;
  let ptyOk = true;
  try {
    const sessions = listPtySessionMeta();
    ptySessions = sessions.filter((s) => !s.exited).length;
  } catch {
    ptyOk = false;
  }

  const recentErrors = await loadGroupedErrors({ maxLines: 100, redact: true });
  const lastError = recentErrors[0] ?? null;

  return {
    ok: true,
    version: readAppVersion(),
    platform: `${os.platform()} ${os.release()}`,
    nodeVersion: process.version,
    electronVersion: process.versions.electron ?? null,
    components: {
      server: { ok: true },
      tools: { ok: true },
      memory: { ok: true },
      brain: { ok: true },
      lsp: {
        ok: lspOk,
        running: lspRunning,
        ...(lspBridgeError?.message ? { lastBridgeError: lspBridgeError.message } : {}),
      },
      pty: { ok: ptyOk, sessions: ptySessions },
      electron: {
        ok: process.versions.electron ? true : null,
        available: Boolean(process.versions.electron),
      },
    },
    lastError: lastError
      ? {
          signature: lastError.signature,
          message: lastError.message,
          source: lastError.source,
          lastAt: lastError.lastAt,
        }
      : null,
  };
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathname
 * @returns {Promise<boolean>}
 */
export async function handleDiagnosticsRequest(req, res, pathname) {
  if (!pathname.startsWith('/api/diagnostics')) {
    return false;
  }

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }

  try {
    if (pathname === '/api/diagnostics/ping' && req.method === 'GET') {
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (pathname === '/api/diagnostics/health' && req.method === 'GET') {
      const health = await buildDiagnosticsHealth();
      sendJson(res, 200, health);
      return true;
    }

    if (pathname === '/api/diagnostics/errors' && req.method === 'GET') {
      const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
      const source = parsed.searchParams.get('source') ?? 'all';
      const maxLines = Number(parsed.searchParams.get('maxLines')) || 500;
      const errors = await loadGroupedErrors({
        source:
          source === 'renderer' || source === 'server' || source === 'electron'
            ? source
            : 'all',
        maxLines,
        redact: true,
      });
      sendJson(res, 200, { errors });
      return true;
    }

    if (pathname === '/api/diagnostics/logs' && req.method === 'GET') {
      const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
      const source = parsed.searchParams.get('source') ?? 'all';
      const maxLines = Number(parsed.searchParams.get('maxLines')) || 100;
      const lines = await loadDiagnosticLogTail({
        source,
        maxLines,
        redact: true,
      });
      sendJson(res, 200, { lines });
      return true;
    }

    if (pathname === '/api/diagnostics/report' && req.method === 'GET') {
      const health = await buildDiagnosticsHealth();
      const errors = await loadGroupedErrors({ maxLines: 200, redact: true });
      const logLines = await loadDiagnosticLogTail({ maxLines: 50, redact: true });
      const markdown = formatDiagnosticReportMarkdown({
        version: health.version,
        platform: health.platform,
        nodeVersion: health.nodeVersion,
        electronVersion: health.electronVersion,
        health,
        errors,
        logLines,
      });
      sendJson(res, 200, { markdown });
      return true;
    }

    if (pathname === '/api/diagnostics/clear' && req.method === 'POST') {
      await clearDiagnosticLogs();
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (pathname === '/api/diagnostics/report' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const kind = typeof body.kind === 'string' ? body.kind : 'renderer-error';
      const message = typeof body.message === 'string' ? body.message : '';
      const stack = typeof body.stack === 'string' ? body.stack : undefined;
      const surface = typeof body.surface === 'string' ? body.surface : undefined;
      if (!message.trim()) {
        sendJson(res, 400, { error: 'message is required' });
        return true;
      }
      await logRendererDiagnostic({
        kind,
        message,
        stack,
        surface,
        version: readAppVersion(),
      });
      sendJson(res, 200, { ok: true });
      return true;
    }

    sendJson(res, 404, { error: 'Not found' });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: message });
    return true;
  }
}

/** Vite connect middleware factory. */
export function createDiagnosticsMiddleware() {
  return async (req, res, next) => {
    const rawUrl = req.url ?? '/';
    const parsed = new URL(rawUrl, 'http://127.0.0.1');
    if (!parsed.pathname.startsWith('/api/diagnostics')) {
      next();
      return;
    }
    const handled = await handleDiagnosticsRequest(req, res, parsed.pathname);
    if (!handled) {
      next();
    }
  };
}
