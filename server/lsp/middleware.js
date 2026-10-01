import { runRequestWork } from '../runtime/request-work.js';
import { readJsonBody, jsonBodyErrorStatus } from '../runtime/json-body.js';
/**
 * /api/lsp/* and /api/config/lsp middleware.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { getMinnowHome } from '../config/home.js';
import { isResolvedPathUnderRoot } from '../workspace/safe-path.js';
import {
  loadMergedLspConfig,
  invalidateLspConfigCache,
  seedLspJson,
} from './config-loader.js';
import {
  getLspCallHierarchy,
  getLspCompletions,
  getLspDefinition,
  getLspDiagnostics,
  getLspDocumentFormatting,
  getLspDocumentSymbols,
  getLspHover,
  getLspRangeFormatting,
  getLspSignatureHelp,
  getLspStructuredDiagnostics,
  getLspWorkspaceSymbols,
  listLspServers,
  notifyLspDocument,
  resolveLspCompletion,
  shutdownAllLsp,
} from './manager.js';
import {
  getBundleJob,
  installBundle,
  listBundleJobs,
  listBundlesWithStatus,
  uninstallBundle,
} from './bundle-installer.js';

function sendJson(res, status, payload) {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function validateProjectRelativePath(body, projectRoot) {
  const rel = body.path;
  if (typeof rel !== 'string' || !rel.trim()) {
    return { ok: false, status: 400, error: 'Invalid path' };
  }
  const abs = path.resolve(projectRoot, rel);
  try {
    if (isResolvedPathUnderRoot(abs, projectRoot)) {
      return { ok: true, rel };
    }
  } catch {
    return { ok: false, status: 400, error: 'Invalid path' };
  }
  return { ok: false, status: 400, error: 'Path outside project' };
}

function validateLspPosition(body) {
  const line = Number(body.line);
  const character = Number(body.character);
  if (!Number.isInteger(line) || !Number.isInteger(character) || line < 0 || character < 0) {
    return { ok: false, status: 400, error: 'Invalid position' };
  }
  return { ok: true, line, character };
}

function validateLspRange(body) {
  const startLine = Number(body.startLine);
  const startCharacter = Number(body.startCharacter);
  const endLine = Number(body.endLine);
  const endCharacter = Number(body.endCharacter);
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(startCharacter) ||
    !Number.isInteger(endLine) ||
    !Number.isInteger(endCharacter) ||
    startLine < 0 ||
    startCharacter < 0 ||
    endLine < 0 ||
    endCharacter < 0
  ) {
    return { ok: false, status: 400, error: 'Invalid range' };
  }
  return {
    ok: true,
    range: {
      start: { line: startLine, character: startCharacter },
      end: { line: endLine, character: endCharacter },
    },
  };
}

export function createLspMiddleware(resolveProjectRoot) {
  const getRoot =
    typeof resolveProjectRoot === 'function'
      ? resolveProjectRoot
      : () => resolveProjectRoot;

  return async (req, res, next) => {
    const url = req.url?.split('?')[0] ?? '';
    if (!url.startsWith('/api/lsp') && url !== '/api/config/lsp') {
      next();
      return;
    }

    const projectRoot = getRoot();

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    return runRequestWork(req, res, async () => {
      try {
        if (url === '/api/lsp/status' && req.method === 'GET') {
          const merged = await loadMergedLspConfig();
          const servers = await listLspServers();
          sendJson(res, 200, { enabled: merged.enabled !== false, servers });
          return;
        }

        if (url === '/api/lsp/diagnostics' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const pathCheck = validateProjectRelativePath(body, projectRoot);
          if (!pathCheck.ok) {
            sendJson(res, pathCheck.status, { error: pathCheck.error });
            return;
          }
          const result = await getLspDiagnostics(pathCheck.rel);
          sendJson(res, 200, { result });
          return;
        }

        if (url === '/api/lsp/notify' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const pathCheck = validateProjectRelativePath(body, projectRoot);
          if (!pathCheck.ok) {
            sendJson(res, pathCheck.status, { error: pathCheck.error });
            return;
          }
          const event = String(body.event ?? '');
          if (!['open', 'change', 'close'].includes(event)) {
            sendJson(res, 400, { error: 'Invalid event' });
            return;
          }
          const result = await notifyLspDocument(
            pathCheck.rel,
            event,
            typeof body.text === 'string' ? body.text : undefined,
          );
          if (!result.ok) {
            sendJson(res, 400, result);
            return;
          }
          sendJson(res, 200, result);
          return;
        }

        if (url === '/api/lsp/completion' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const pathCheck = validateProjectRelativePath(body, projectRoot);
          if (!pathCheck.ok) {
            sendJson(res, pathCheck.status, { error: pathCheck.error });
            return;
          }
          const posCheck = validateLspPosition(body);
          if (!posCheck.ok) {
            sendJson(res, posCheck.status, { error: posCheck.error });
            return;
          }
          const editorText =
            typeof body.text === 'string' ? body.text : undefined;
          const lspContext =
            body.context && typeof body.context === 'object' ? body.context : undefined;
          const { items, error, isIncomplete, triggerCharacters } = await getLspCompletions(
            pathCheck.rel,
            posCheck.line,
            posCheck.character,
            { text: editorText, context: lspContext },
          );
          sendJson(res, 200, {
            items,
            isIncomplete,
            triggerCharacters,
            ...(error ? { error } : {}),
          });
          return;
        }

        if (url === '/api/lsp/hover' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const pathCheck = validateProjectRelativePath(body, projectRoot);
          if (!pathCheck.ok) {
            sendJson(res, pathCheck.status, { error: pathCheck.error });
            return;
          }
          const posCheck = validateLspPosition(body);
          if (!posCheck.ok) {
            sendJson(res, posCheck.status, { error: posCheck.error });
            return;
          }
          const { hover, error } = await getLspHover(
            pathCheck.rel,
            posCheck.line,
            posCheck.character,
          );
          sendJson(res, 200, { hover, ...(error ? { error } : {}) });
          return;
        }

        if (url === '/api/lsp/definition' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const pathCheck = validateProjectRelativePath(body, projectRoot);
          if (!pathCheck.ok) {
            sendJson(res, pathCheck.status, { error: pathCheck.error });
            return;
          }
          const posCheck = validateLspPosition(body);
          if (!posCheck.ok) {
            sendJson(res, posCheck.status, { error: posCheck.error });
            return;
          }
          const { locations, error } = await getLspDefinition(
            pathCheck.rel,
            posCheck.line,
            posCheck.character,
          );
          sendJson(res, 200, { locations, ...(error ? { error } : {}) });
          return;
        }

        if (url === '/api/lsp/signature' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const pathCheck = validateProjectRelativePath(body, projectRoot);
          if (!pathCheck.ok) {
            sendJson(res, pathCheck.status, { error: pathCheck.error });
            return;
          }
          const posCheck = validateLspPosition(body);
          if (!posCheck.ok) {
            sendJson(res, posCheck.status, { error: posCheck.error });
            return;
          }
          const { signatureHelp, error } = await getLspSignatureHelp(
            pathCheck.rel,
            posCheck.line,
            posCheck.character,
          );
          sendJson(res, 200, { signatureHelp, ...(error ? { error } : {}) });
          return;
        }

        if (url === '/api/lsp/format' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const pathCheck = validateProjectRelativePath(body, projectRoot);
          if (!pathCheck.ok) {
            sendJson(res, pathCheck.status, { error: pathCheck.error });
            return;
          }
          const editorText = typeof body.text === 'string' ? body.text : undefined;
          const tabSize = Number(body.tabSize);
          const insertSpaces = body.insertSpaces !== false;
          const { edits, error, serverId } = await getLspDocumentFormatting(pathCheck.rel, {
            editorText,
            ...(Number.isFinite(tabSize) ? { tabSize } : {}),
            insertSpaces,
          });
          sendJson(res, 200, { edits, ...(serverId ? { serverId } : {}), ...(error ? { error } : {}) });
          return;
        }

        if (url === '/api/lsp/format-range' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const pathCheck = validateProjectRelativePath(body, projectRoot);
          if (!pathCheck.ok) {
            sendJson(res, pathCheck.status, { error: pathCheck.error });
            return;
          }
          const rangeCheck = validateLspRange(body);
          if (!rangeCheck.ok) {
            sendJson(res, rangeCheck.status, { error: rangeCheck.error });
            return;
          }
          const editorText = typeof body.text === 'string' ? body.text : undefined;
          const tabSize = Number(body.tabSize);
          const insertSpaces = body.insertSpaces !== false;
          const { edits, error, serverId } = await getLspRangeFormatting(
            pathCheck.rel,
            rangeCheck.range,
            {
              editorText,
              ...(Number.isFinite(tabSize) ? { tabSize } : {}),
              insertSpaces,
            },
          );
          sendJson(res, 200, { edits, ...(serverId ? { serverId } : {}), ...(error ? { error } : {}) });
          return;
        }

        if (url === '/api/lsp/diagnostics-structured' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const pathCheck = validateProjectRelativePath(body, projectRoot);
          if (!pathCheck.ok) {
            sendJson(res, pathCheck.status, { error: pathCheck.error });
            return;
          }
          const editorText =
            typeof body.text === 'string' ? body.text : undefined;
          const { diagnostics, error } = await getLspStructuredDiagnostics(
            pathCheck.rel,
            editorText,
          );
          sendJson(res, 200, { diagnostics, ...(error ? { error } : {}) });
          return;
        }

        if (
          url === '/api/lsp/document-symbols' &&
          (req.method === 'GET' || req.method === 'POST')
        ) {
          const body =
            req.method === 'POST' ? await readJsonBody(req) : {};
          const search = new URL(req.url ?? '', 'http://local').searchParams;
          const pathCheck = validateProjectRelativePath(
            { path: body.path ?? search.get('path') },
            projectRoot,
          );
          if (!pathCheck.ok) {
            sendJson(res, pathCheck.status, { error: pathCheck.error });
            return;
          }
          const { symbols, error } = await getLspDocumentSymbols(pathCheck.rel);
          sendJson(res, 200, { symbols, ...(error ? { error } : {}) });
          return;
        }

        if (
          url === '/api/lsp/workspace-symbols' &&
          (req.method === 'GET' || req.method === 'POST')
        ) {
          const body =
            req.method === 'POST' ? await readJsonBody(req) : {};
          const search = new URL(req.url ?? '', 'http://local').searchParams;
          const query = String(body.query ?? search.get('query') ?? '');
          const { symbols, error } = await getLspWorkspaceSymbols(query);
          sendJson(res, 200, { symbols, ...(error ? { error } : {}) });
          return;
        }

        if (url === '/api/lsp/call-hierarchy' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const pathCheck = validateProjectRelativePath(body, projectRoot);
          if (!pathCheck.ok) {
            sendJson(res, pathCheck.status, { error: pathCheck.error });
            return;
          }
          const posCheck = validateLspPosition(body);
          if (!posCheck.ok) {
            sendJson(res, posCheck.status, { error: posCheck.error });
            return;
          }
          const { item, incomingCalls, outgoingCalls, error } = await getLspCallHierarchy(
            pathCheck.rel,
            posCheck.line,
            posCheck.character,
          );
          sendJson(res, 200, {
            item,
            incomingCalls,
            outgoingCalls,
            ...(error ? { error } : {}),
          });
          return;
        }

        if (url === '/api/lsp/resolve' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const pathCheck = validateProjectRelativePath(body, projectRoot);
          if (!pathCheck.ok) {
            sendJson(res, pathCheck.status, { error: pathCheck.error });
            return;
          }
          const item = body.item;
          if (!item || typeof item !== 'object') {
            sendJson(res, 400, { error: 'Invalid completion item' });
            return;
          }
          const { item: resolved, error } = await resolveLspCompletion(pathCheck.rel, item);
          sendJson(res, 200, { item: resolved, ...(error ? { error } : {}) });
          return;
        }

        if (url === '/api/config/lsp' && req.method === 'GET') {
          const merged = await loadMergedLspConfig();
          const servers = await listLspServers();
          sendJson(res, 200, {
            enabled: merged.enabled !== false,
            formatOnSaveLanguageIds: Array.isArray(merged.formatOnSaveLanguageIds)
              ? merged.formatOnSaveLanguageIds
              : [],
            lsp: merged.lsp,
            servers,
          });
          return;
        }

        if (url === '/api/lsp/bundles' && req.method === 'GET') {
          const payload = await listBundlesWithStatus();
          sendJson(res, 200, payload);
          return;
        }

        if (url === '/api/lsp/bundles/progress' && req.method === 'GET') {
          const bundleId = new URL(req.url ?? '', 'http://local').searchParams.get('bundleId');
          if (bundleId) {
            sendJson(res, 200, { job: getBundleJob(bundleId) });
            return;
          }
          sendJson(res, 200, { jobs: listBundleJobs() });
          return;
        }

        if (url === '/api/lsp/bundles/install' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const bundleId = String(body.bundleId ?? '').trim();
          if (!bundleId) {
            sendJson(res, 400, { error: 'bundleId is required' });
            return;
          }
          const result = await installBundle(bundleId);
          sendJson(res, 200, { ok: true, ...result });
          return;
        }

        if (url === '/api/lsp/bundles/uninstall' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const bundleId = String(body.bundleId ?? '').trim();
          if (!bundleId) {
            sendJson(res, 400, { error: 'bundleId is required' });
            return;
          }
          const result = await uninstallBundle(bundleId);
          sendJson(res, 200, result);
          return;
        }

        if (url === '/api/config/lsp' && req.method === 'PUT') {
          const body = await readJsonBody(req);
          const home = getMinnowHome();
          const filePath = path.join(home, 'lsp.json');
          let current = {};
          try {
            current = JSON.parse(await fs.readFile(filePath, 'utf8'));
          } catch {
            current = await seedLspJson(
              JSON.parse(
                await fs.readFile(
                  path.join(projectRoot, 'src/lsp/defaults.json'),
                  'utf8',
                ),
              ),
            );
          }
          const nextCfg = {
            ...current,
            ...body,
            lsp: { ...(current.lsp ?? {}), ...(body.lsp ?? {}) },
          };
          if (Array.isArray(body.removeLspIds)) {
            for (const id of body.removeLspIds) {
              if (typeof id === 'string' && id) {
                delete nextCfg.lsp[id];
              }
            }
          }
          await fs.writeFile(filePath, `${JSON.stringify(nextCfg, null, 2)}\n`, 'utf8');
          invalidateLspConfigCache();
          shutdownAllLsp();
          sendJson(res, 200, { ok: true });
          return;
        }

        sendJson(res, 404, { error: 'Not found' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(res, jsonBodyErrorStatus(err, 500), { error: message });
      }
    });
  };
}

export async function initLspConfig() {
  const merged = await loadMergedLspConfig();
  return merged;
}
