import fs from 'node:fs';
import {
  ensureMinnowLayout,
  ensureMinnowLayoutInitialized,
  getMinnowHome,
} from './home.js';
import {
  readResource,
  writeResource,
  patchResource,
  readConfigJson,
  writeConfigJson,
  configFileExists,
} from './store.js';
import {
  validateSessionState,
  normalizeToolConfig,
  validateSystemPromptSettings,
  mergeConfigMeta,
} from './validators.js';
import { resolveConfigPath, ALLOWED_CONFIG_FILES } from './paths.js';
import { handleRunsConfigRequest } from '../runs/middleware.js';
import {
  exportSessionStateToJson,
  readChatHistory,
  readSessionRevision,
  readSessionSummariesState,
  searchSessionChats,
  useJsonSessionsStore,
} from './sessions-repo.js';
import { getSessionsDb, readSessionMeta } from './sessions-db.js';
import { sessionsDbPath } from './sessions-paths.js';

const MAX_MIGRATE_BYTES = 10 * 1024 * 1024;

const STORAGE_KEYS = {
  sessions: 'minnow-sessions-v1',
  tools: 'minnow.tools',
  systemPrompt: 'minnow.systemPrompt',
};

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
 * @param {object} body
 */
async function handleMigrate(body) {
  const warnings = [];
  const written = [];

  await ensureMinnowLayout();

  const meta = (await readConfigJson('config.json')) ?? {};
  if (meta.migratedFromLocalStorage === true) {
    return { ok: true, skipped: true, migrated: true, written: [], warnings: [] };
  }

  const ls = body?.localStorage && typeof body.localStorage === 'object' ? body.localStorage : {};
  const force = body?.force === true && process.env.MINNOW_DEBUG === '1';

  const migrations = [
    {
      key: 'sessions',
      raw: ls.sessions,
      file: useJsonSessionsStore() ? 'sessions/state.json' : 'sessions/sessions.db',
      parse: (str) => validateSessionState(JSON.parse(str)),
      write: async (parsed) => {
        await writeResource('sessions', parsed);
      },
      exists: async () => {
        if (useJsonSessionsStore()) {
          return configFileExists('sessions/state.json');
        }
        return fs.existsSync(sessionsDbPath());
      },
    },
    {
      key: 'tools',
      raw: ls.tools,
      file: 'tools.json',
      parse: (str) => normalizeToolConfig(JSON.parse(str)),
      write: async (parsed) => {
        await writeConfigJson('tools.json', parsed);
      },
      exists: async () => configFileExists('tools.json'),
    },
    {
      key: 'systemPrompt',
      raw: ls.systemPrompt,
      file: 'system-prompt.json',
      parse: (str) => validateSystemPromptSettings(JSON.parse(str)),
      write: async (parsed) => {
        await writeConfigJson('system-prompt.json', parsed);
      },
      exists: async () => configFileExists('system-prompt.json'),
    },
  ];

  const keysMigrated = [];

  for (const item of migrations) {
    if (typeof item.raw !== 'string' || !item.raw.trim()) continue;

    try {
      const parsed = item.parse(item.raw);
      if (force === false && (await item.exists()) && meta.migratedFromLocalStorage) {
        warnings.push(`${item.file} already exists; skipped`);
        continue;
      }
      await item.write(parsed);
      written.push(item.file);
      if (item.key === 'sessions') keysMigrated.push(STORAGE_KEYS.sessions);
      if (item.key === 'tools') keysMigrated.push(STORAGE_KEYS.tools);
      if (item.key === 'systemPrompt') keysMigrated.push(STORAGE_KEYS.systemPrompt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`${item.key}: ${message}`);
    }
  }

  const hasAnyLocal =
    (typeof ls.sessions === 'string' && ls.sessions.trim()) ||
    (typeof ls.tools === 'string' && ls.tools.trim()) ||
    (typeof ls.systemPrompt === 'string' && ls.systemPrompt.trim());

  if (hasAnyLocal || written.length > 0) {
    const merged = mergeConfigMeta(meta, {
      migratedFromLocalStorage: true,
      migratedAt: new Date().toISOString(),
      localStorageKeysMigrated: [
        ...new Set([...(meta.localStorageKeysMigrated ?? []), ...keysMigrated]),
      ],
    });
    await writeConfigJson('config.json', merged);
  }

  return {
    ok: true,
    migrated: true,
    skipped: false,
    written,
    warnings,
  };
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathname
 * @returns {Promise<boolean>}
 */
export async function handleConfigRequest(req, res, pathname) {

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }

  try {
    if (pathname === '/api/config/default-model') {
      if (req.method === 'GET') {
        sendJson(res, 200, (await readConfigJson('default-model.json')) ?? { value: null });
        return true;
      }
      if (req.method === 'PUT') {
        const body = await readJsonBody(req);
        if (typeof body?.value !== 'string' || body.value.length > 4096) {
          sendJson(res, 400, { error: 'Expected a model selection string' });
          return true;
        }
        const saved = { value: body.value.trim() };
        await writeConfigJson('default-model.json', saved);
        sendJson(res, 200, saved);
        return true;
      }
    }
    if (pathname === '/api/config/ping' && req.method === 'GET') {
      await ensureMinnowLayoutInitialized();
      const debug = process.env.MINNOW_DEBUG === '1';
      sendJson(res, 200, {
        ok: true,
        home: '.minnow',
        homeResolved: true,
        ...(debug ? { homePath: getMinnowHome() } : {}),
      });
      return true;
    }

    if (pathname === '/api/config/status' && req.method === 'GET') {
      await ensureMinnowLayout();
      const meta = (await readConfigJson('config.json')) ?? {};
      /** @type {Record<string, unknown>} */
      const status = {
        ok: true,
        storage: 'home',
        migrated: meta.migratedFromLocalStorage === true,
        schemaVersion: meta.schemaVersion ?? 1,
        sessionsStore: useJsonSessionsStore() ? 'json' : 'sqlite',
      };
      if (!useJsonSessionsStore()) {
        try {
          const db = getSessionsDb();
          const failedAt = readSessionMeta(db, 'jsonImportFailedAt');
          if (failedAt) status.jsonImportFailedAt = failedAt;
        } catch {
        }
      }
      sendJson(res, 200, status);
      return true;
    }

    if (pathname === '/api/config/sessions/export-json' && req.method === 'POST') {
      await ensureMinnowLayout();
      const data = useJsonSessionsStore()
        ? ((await readConfigJson('sessions/state.json')) ?? (await readResource('sessions')))
        : exportSessionStateToJson();
      sendJson(res, 200, { ok: true, data });
      return true;
    }

    if (pathname === '/api/config/sessions/summaries' && req.method === 'GET') {
      await ensureMinnowLayout();
      if (useJsonSessionsStore()) {
        const full = (await readConfigJson('sessions/state.json')) ?? (await readResource('sessions'));
        const url = new URL(req.url ?? '', 'http://localhost');
        const workspace = url.searchParams.get('workspace') ?? '';
        const chats = Array.isArray(full?.chats) ? full.chats : [];
        const summaries = chats
          .filter((chat) => {
            if (!workspace) return true;
            const wp = typeof chat.workspacePath === 'string' ? chat.workspacePath : '';
            return wp === workspace;
          })
          .map((chat) => {
            const history = Array.isArray(chat.history) ? chat.history : [];
            const last = history.length ? history[history.length - 1] : null;
            let lastMessagePreview = '';
            if (last && typeof last === 'object' && typeof last.content === 'string') {
              lastMessagePreview = last.content.slice(0, 240);
            }
            const { history: _drop, ...rest } = chat;
            return {
              ...rest,
              messageCount: history.length,
              lastMessagePreview,
            };
          });
        sendJson(res, 200, { ...full, chats: summaries });
        return true;
      }
      const url = new URL(req.url ?? '', 'http://localhost');
      const workspace = url.searchParams.get('workspace') ?? undefined;
      sendJson(res, 200, readSessionSummariesState({ workspace }));
      return true;
    }

    const historyMatch = pathname.match(/^\/api\/config\/sessions\/history\/([^/]+)$/);
    if (historyMatch && req.method === 'GET') {
      await ensureMinnowLayout();
      const chatId = decodeURIComponent(historyMatch[1] ?? '').trim();
      const url = new URL(req.url ?? '', 'http://localhost');
      const offsetRaw = url.searchParams.get('offset');
      const limitRaw = url.searchParams.get('limit');
      const opts = {};
      if (offsetRaw != null && offsetRaw !== '') opts.offset = Number(offsetRaw);
      if (limitRaw != null && limitRaw !== '') opts.limit = Number(limitRaw);

      if (useJsonSessionsStore()) {
        const full = (await readConfigJson('sessions/state.json')) ?? (await readResource('sessions'));
        const chat = Array.isArray(full?.chats)
          ? full.chats.find((c) => c && c.id === chatId)
          : null;
        let history = Array.isArray(chat?.history) ? chat.history : [];
        const offset = typeof opts.offset === 'number' && opts.offset > 0 ? Math.floor(opts.offset) : 0;
        const limit = typeof opts.limit === 'number' && opts.limit > 0 ? Math.floor(opts.limit) : null;
        if (offset || limit != null) {
          history = limit != null ? history.slice(offset, offset + limit) : history.slice(offset);
        }
        sendJson(res, 200, { chatId, history });
        return true;
      }

      sendJson(res, 200, { chatId, history: readChatHistory(chatId, opts) });
      return true;
    }

    if (pathname === '/api/config/sessions/search' && req.method === 'GET') {
      await ensureMinnowLayout();
      const url = new URL(req.url ?? '', 'http://localhost');
      const q = url.searchParams.get('q') ?? '';
      const workspace = url.searchParams.get('workspace') ?? undefined;
      const limitRaw = url.searchParams.get('limit');
      const limit = limitRaw != null && limitRaw !== '' ? Number(limitRaw) : 30;

      if (useJsonSessionsStore()) {
        const full = (await readConfigJson('sessions/state.json')) ?? (await readResource('sessions'));
        const chats = Array.isArray(full?.chats) ? full.chats : [];
        const tokens = String(q)
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean);
        const wsKey = workspace ? String(workspace) : '';
        /** @type {Array<Record<string, unknown>>} */
        const results = [];
        for (const chat of chats) {
          if (!chat || typeof chat !== 'object') continue;
          if (wsKey && String(chat.workspacePath ?? '') !== wsKey) continue;
          const name = String(chat.name ?? '');
          const nameLower = name.toLowerCase();
          let best = null;
          if (tokens.length && tokens.every((t) => nameLower.includes(t))) {
            best = {
              chatId: chat.id,
              name,
              workspacePath: chat.workspacePath ?? '',
              lastMessageAt: chat.lastMessageAt ?? 0,
              score: 280,
              matchedIn: 'title',
              snippet: '',
            };
          }
          const history = Array.isArray(chat.history) ? chat.history : [];
          for (const msg of history) {
            if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
            const body = typeof msg.content === 'string' ? msg.content : '';
            if (!body || !tokens.length) continue;
            const lower = body.toLowerCase();
            if (!tokens.every((t) => lower.includes(t))) continue;
            const score = 140;
            if (best && best.score >= score) continue;
            const idx = lower.indexOf(tokens[0]);
            const start = Math.max(0, idx - 32);
            best = {
              chatId: chat.id,
              name,
              workspacePath: chat.workspacePath ?? '',
              lastMessageAt: chat.lastMessageAt ?? 0,
              score,
              matchedIn: 'message',
              role: msg.role,
              snippet: `${start > 0 ? '…' : ''}${body.slice(start, start + 110).trim()}${start + 110 < body.length ? '…' : ''}`,
            };
          }
          if (best) results.push(best);
        }
        results.sort((a, b) => {
          if (a.score !== b.score) return b.score - a.score;
          return (b.lastMessageAt || 0) - (a.lastMessageAt || 0);
        });
        sendJson(res, 200, { results: results.slice(0, Math.min(100, Math.max(1, limit || 30))) });
        return true;
      }

      sendJson(res, 200, searchSessionChats({ q, workspace, limit }));
      return true;
    }

    if (pathname === '/api/config/migrate' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const payload = JSON.stringify(body ?? {});
      if (Buffer.byteLength(payload, 'utf8') > MAX_MIGRATE_BYTES) {
        sendJson(res, 400, { error: 'Migration payload too large' });
        return true;
      }
      const result = await handleMigrate(body);
      sendJson(res, 200, result);
      return true;
    }

    const resourceMatch = pathname.match(
      /^\/api\/config\/(sessions|tools|search|servers|research|skills|system-prompt|rules|sub-agents|bugs|issues|issues-taxonomy|reviews|appearance|meta)$/,
    );
    if (resourceMatch) {
      const resource = resourceMatch[1];

      if (req.method === 'GET') {
        const data = await readResource(resource);
        if (resource === 'issues' && data === null) {
          sendJson(res, 404, { error: 'Not found' });
          return true;
        }
        sendJson(res, 200, data);
        return true;
      }

      if (req.method === 'PUT') {
        const body = await readJsonBody(req);
        const saved = await writeResource(resource, body);
        const payload = { ok: true, data: saved };
        if (resource === 'sessions' && !useJsonSessionsStore()) {
          payload.revision = readSessionRevision();
        }
        sendJson(res, 200, payload);
        return true;
      }

      if (req.method === 'PATCH' || req.method === 'POST') {
        if (resource !== 'sessions') {
          sendJson(res, 405, { error: 'Method not allowed' });
          return true;
        }
        const body = await readJsonBody(req);
        const result = await patchResource(resource, body);
        sendJson(res, 200, result);
        return true;
      }
    }

    if (pathname.startsWith('/api/config/runs')) {
      return handleRunsConfigRequest(req, res, pathname);
    }

    const fileMatch = pathname === '/api/config/file';
    if (fileMatch) {
      const url = new URL(req.url ?? '', 'http://localhost');
      const key = url.searchParams.get('key') ?? '';

      if (req.method === 'GET') {
        try {
          resolveConfigPath(key);
        } catch {
          sendJson(res, 400, { error: 'Invalid config path' });
          return true;
        }
        const data = await readConfigJson(key);
        if (data === null) {
          sendJson(res, 404, { error: 'Not found' });
          return true;
        }
        sendJson(res, 200, data);
        return true;
      }

      if (req.method === 'PUT') {
        try {
          resolveConfigPath(key);
        } catch {
          sendJson(res, 400, { error: 'Invalid config path' });
          return true;
        }
        const body = await readJsonBody(req);
        await writeConfigJson(key, body);
        sendJson(res, 200, { ok: true });
        return true;
      }
    }

    if (pathname.startsWith('/api/config/') && pathname.includes('..')) {
      sendJson(res, 400, { error: 'Invalid config path' });
      return true;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const statusCode =
      err && typeof err === 'object' && 'statusCode' in err
        ? Number(/** @type {{ statusCode: number }} */ (err).statusCode)
        : undefined;
    if (statusCode === 413) {
      sendJson(res, 413, { error: message });
      return true;
    }
    if (statusCode === 409) {
      const revision =
        err && typeof err === 'object' && 'revision' in err
          ? Number(/** @type {{ revision: number }} */ (err).revision)
          : undefined;
      sendJson(res, 409, { error: message, ...(revision != null ? { revision } : {}) });
      return true;
    }
    if (message === 'Invalid config path' || message.includes('Invalid config')) {
      sendJson(res, 400, { error: 'Invalid config path' });
      return true;
    }
    if (statusCode === 400) {
      sendJson(res, 400, { error: message });
      return true;
    }
    console.error('[config]', message);
    sendJson(res, 500, { error: message });
    return true;
  }

  if (pathname === '/api/config/lsp') {
    return false;
  }

  if (pathname.startsWith('/api/config')) {
    sendJson(res, 404, { error: 'Not found' });
    return true;
  }

  return false;
}

export function createConfigMiddleware() {
  return async (req, res, next) => {
    const url = req.url?.split('?')[0] ?? '';
    if (!url.startsWith('/api/config')) {
      next();
      return;
    }

    const handled = await handleConfigRequest(req, res, url);
    if (!handled) {
      next();
    }
  };
}

export { ALLOWED_CONFIG_FILES, resolveConfigPath };
