/**
 * /api/workspace — get, set, and pick the AI workspace folder.
 */

import {
  buildRecentWorkspaceList,
  buildSandboxWorkspaceItem,
  getWorkspaceInfo,
  removeRecentWorkspacePath,
  setDefaultWorkspaceRoot,
  validateWorkspacePath,
  workspaceLabel,
} from './root.js';
import {
  closeWorkspace,
  listOpenWorkspaces,
  openWorkspace,
} from './open-workspaces.js';
import {
  browseWorkspaceFolders,
  createWorkspaceSubfolder,
  ensureDefaultProjectsParent,
  saveDefaultProjectsParent,
} from './browse.js';
import { pickWorkspaceFolder } from './pick-folder.js';
import { cloneWorkspaceRepository } from './clone.js';
import { countWorkspaceLoc } from './loc.js';
import {
  getDevServerStatus,
  listDevServerStatuses,
  readStartupGuide,
  restartDevServerById,
  startDevServer,
  startDevServerById,
  stopDevServer,
  stopDevServerById,
} from '../dev-server/manager.js';
import {
  createDevServer,
  deleteDevServer,
  updateDevServer,
} from '../dev-server/registry.js';
import { findFreePort, killPortOwner, listListeningPorts } from '../dev-server/ports.js';
import { readDevServerSettings, writeDevServerSettings } from '../dev-server/settings.js';
import { getWorkspaceGitStatus } from './git-status.js';
import { ensureBaselineGitignore } from './baseline-gitignore.js';
import { initializeWorkspaceGit } from './initialize-git.js';
import { revealInSystemExplorer } from './reveal-in-explorer.js';
import { validateAllowedWorkspaceRoot } from '../chats-workspace/paths.js';
import { resolveSafePath, runWithPathAccess, runWithToolContext } from '../runtime/path-access.js';
import { getEffectiveWorkspaceRoot } from '../runtime/path-access.js';

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

/**
 * Match `/api/workspace/dev-servers/:id` or `/api/workspace/dev-servers/:id/<action>`.
 * @param {string} pathname
 * @returns {{ id: string, action: string | null } | null}
 */
function matchDevServerIdRoute(pathname) {
  const prefix = '/api/workspace/dev-servers/';
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  if (!rest) return null;
  const slash = rest.indexOf('/');
  if (slash < 0) return { id: decodeURIComponent(rest), action: null };
  const id = decodeURIComponent(rest.slice(0, slash));
  const action = rest.slice(slash + 1);
  if (!id || !action || action.includes('/')) return null;
  return { id, action };
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

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathname
 * @param {URLSearchParams} [searchParams]
 * @returns {Promise<boolean>}
 */
export async function handleWorkspaceRequest(req, res, pathname, searchParams = new URLSearchParams()) {

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }

  try {
    if (pathname === '/api/workspace/browse' && req.method === 'GET') {
      const browsePath = searchParams.get('path') ?? '';
      const listing = await browseWorkspaceFolders(browsePath);
      sendJson(res, 200, { ok: true, ...listing });
      return true;
    }

    if (pathname === '/api/workspace/mkdir' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const parentPath = body?.parentPath;
      const name = body?.name;
      if (typeof parentPath !== 'string' || !parentPath.trim()) {
        sendJson(res, 400, { error: 'parentPath is required' });
        return true;
      }
      if (typeof name !== 'string' || !name.trim()) {
        sendJson(res, 400, { error: 'name is required' });
        return true;
      }
      const created = await createWorkspaceSubfolder(parentPath, name);
      sendJson(res, 201, { ok: true, ...created });
      return true;
    }

    if (pathname === '/api/workspace/clone' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const created = await cloneWorkspaceRepository(body?.parentPath, body?.name, body?.remoteUrl);
      sendJson(res, 201, { ok: true, ...created });
      return true;
    }

    if (pathname === '/api/workspace/git-status' && req.method === 'GET') {
      const workspaceRoot = searchParams.get('workspaceRoot')?.trim() || undefined;
      const status = await getWorkspaceGitStatus(workspaceRoot);
      sendJson(res, 200, { ok: true, ...status });
      return true;
    }

    if (pathname === '/api/workspace/ensure-baseline-gitignore' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const workspaceRoot =
        typeof body?.workspaceRoot === 'string' && body.workspaceRoot.trim()
          ? body.workspaceRoot.trim()
          : undefined;
      const result = await ensureBaselineGitignore(workspaceRoot);
      if (!result.ok) {
        sendJson(res, 400, { ok: false, created: false, error: result.error ?? 'failed' });
        return true;
      }
      sendJson(res, 200, { ok: true, created: result.created, path: result.path });
      return true;
    }

    if (pathname === '/api/workspace/initialize-git' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const workspaceRoot =
        typeof body?.workspaceRoot === 'string' && body.workspaceRoot.trim()
          ? body.workspaceRoot.trim()
          : undefined;
      const result = await initializeWorkspaceGit(workspaceRoot);
      if (!result.ok) {
        sendJson(res, 400, { ok: false, error: result.error ?? 'failed' });
        return true;
      }
      sendJson(res, 200, result);
      return true;
    }

    if (pathname === '/api/workspace/reveal-in-explorer' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const userPath = body?.path;
      if (typeof userPath !== 'string' || !userPath.trim()) {
        sendJson(res, 400, { ok: false, error: 'path is required' });
        return true;
      }
      const workspaceRootOverride =
        typeof body?.workspaceRoot === 'string' && body.workspaceRoot.trim()
          ? body.workspaceRoot.trim()
          : undefined;
      const openViaHostShell = body?.openViaHostShell === true;

      const absolutePath = workspaceRootOverride
        ? await runWithToolContext(
            async () => resolveSafePath(userPath.trim()),
            { workspaceRoot: await validateAllowedWorkspaceRoot(workspaceRootOverride) },
          )
        : await runWithPathAccess(async () => resolveSafePath(userPath.trim()));

      const result = await revealInSystemExplorer(absolutePath, {
        skipSpawn: openViaHostShell,
      });
      sendJson(res, 200, result);
      return true;
    }

    if (pathname === '/api/workspace/loc' && req.method === 'GET') {
      const result = await countWorkspaceLoc();
      if (!result.ok) {
        sendJson(res, 200, { ok: false, lines: null, files: null, error: result.error ?? 'unavailable' });
        return true;
      }
      sendJson(res, 200, { ok: true, lines: result.lines, files: result.files });
      return true;
    }

    if (pathname === '/api/workspace/startup' && req.method === 'GET') {
      const startup = await readStartupGuide();
      const status = await getDevServerStatus();
      sendJson(res, 200, {
        ok: true,
        exists: startup.exists,
        parsed: Boolean(startup.guide),
        guide: startup.guide,
        parseError: startup.parseError ?? null,
        status: status.status,
        runId: status.runId,
        error: status.error,
      });
      return true;
    }

    if (pathname === '/api/workspace/dev-server/status' && req.method === 'GET') {
      const status = await getDevServerStatus();
      sendJson(res, 200, { ok: true, ...status });
      return true;
    }

    if (pathname === '/api/workspace/dev-server/start' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body?.port != null || body?.network != null) {
        await writeDevServerSettings(getEffectiveWorkspaceRoot(), {
          port: body?.port,
          network: body?.network,
        });
      }
      const result = await startDevServer();
      sendJson(res, result.ok ? 200 : 400, result);
      return true;
    }

    if (pathname === '/api/workspace/dev-server/stop' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const workspaceRoot =
        typeof body?.workspaceRoot === 'string' && body.workspaceRoot.trim()
          ? body.workspaceRoot.trim()
          : undefined;
      const result = await stopDevServer(workspaceRoot);
      sendJson(res, 200, result);
      return true;
    }

    if (pathname === '/api/workspace/dev-server/settings' && req.method === 'GET') {
      const settings = await readDevServerSettings(getEffectiveWorkspaceRoot());
      sendJson(res, 200, { ok: true, settings });
      return true;
    }

    if (pathname === '/api/workspace/dev-server/settings' && req.method === 'PUT') {
      const body = await readJsonBody(req);
      const settings = await writeDevServerSettings(getEffectiveWorkspaceRoot(), {
        port: body?.port,
        network: body?.network,
      });
      sendJson(res, 200, { ok: true, settings });
      return true;
    }

    if (pathname === '/api/workspace/dev-servers' && req.method === 'GET') {
      const listed = await listDevServerStatuses();
      sendJson(res, 200, { ok: true, ...listed });
      return true;
    }

    if (pathname === '/api/workspace/dev-servers' && req.method === 'POST') {
      const body = await readJsonBody(req);
      try {
        const created = await createDevServer(getEffectiveWorkspaceRoot(), {
          name: typeof body?.name === 'string' ? body.name : 'server',
          command: typeof body?.command === 'string' ? body.command : '',
          cwd: typeof body?.cwd === 'string' ? body.cwd : undefined,
          port: body?.port,
          network: body?.network,
          healthUrl: typeof body?.healthUrl === 'string' ? body.healthUrl : undefined,
          autoStart: Boolean(body?.autoStart),
          worktreeRoot:
            typeof body?.worktreeRoot === 'string' ? body.worktreeRoot : undefined,
        });
        sendJson(res, 201, { ok: true, server: created });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(res, 400, { ok: false, error: message });
      }
      return true;
    }

    if (pathname === '/api/workspace/ports' && req.method === 'GET') {
      const ports = await listListeningPorts();
      sendJson(res, 200, { ok: true, ports });
      return true;
    }

    if (pathname === '/api/workspace/ports/kill' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await killPortOwner(body?.pid, body?.port);
      sendJson(res, result.ok ? 200 : 400, result);
      return true;
    }

    if (pathname === '/api/workspace/ports/next-free' && req.method === 'GET') {
      const base = Number(searchParams.get('base') || 3000);
      const ports = await listListeningPorts();
      const used = ports.map((p) => p.port);
      const port = findFreePort(Number.isFinite(base) ? base : 3000, used);
      sendJson(res, 200, { ok: true, port });
      return true;
    }

    {
      const matched = matchDevServerIdRoute(pathname);
      if (matched) {
        const root = getEffectiveWorkspaceRoot();
        if (matched.action == null && req.method === 'PUT') {
          const body = await readJsonBody(req);
          try {
            const updated = await updateDevServer(root, matched.id, body ?? {});
            sendJson(res, 200, { ok: true, server: updated });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            sendJson(res, 400, { ok: false, error: message });
          }
          return true;
        }
        if (matched.action == null && req.method === 'DELETE') {
          try {
            await stopDevServerById(root, matched.id).catch(() => undefined);
            const result = await deleteDevServer(root, matched.id);
            sendJson(res, 200, { ok: true, ...result });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            sendJson(res, 400, { ok: false, error: message });
          }
          return true;
        }
        if (matched.action === 'start' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const worktreeRoot =
            typeof body?.worktreeRoot === 'string' && body.worktreeRoot.trim()
              ? body.worktreeRoot.trim()
              : undefined;
          const result = await startDevServerById(root, matched.id, { worktreeRoot });
          sendJson(res, result.ok ? 200 : 400, result);
          return true;
        }
        if (matched.action === 'stop' && req.method === 'POST') {
          const result = await stopDevServerById(root, matched.id);
          sendJson(res, 200, result);
          return true;
        }
        if (matched.action === 'restart' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const worktreeRoot =
            typeof body?.worktreeRoot === 'string' && body.worktreeRoot.trim()
              ? body.worktreeRoot.trim()
              : undefined;
          const result = await restartDevServerById(root, matched.id, { worktreeRoot });
          sendJson(res, result.ok ? 200 : 400, result);
          return true;
        }
      }
    }

    if (pathname === '/api/workspace/project-location' && req.method === 'PUT') {
      const body = await readJsonBody(req);
      const newProjectParent = await saveDefaultProjectsParent(body?.path);
      sendJson(res, 200, { ok: true, newProjectParent });
      return true;
    }

    if (pathname === '/api/workspace' && req.method === 'GET') {
      const viewRoot = getEffectiveWorkspaceRoot();
      const recent = await buildRecentWorkspaceList(viewRoot);
      const sandbox = await buildSandboxWorkspaceItem(viewRoot);
      const newProjectParent = await ensureDefaultProjectsParent();
      sendJson(res, 200, {
        ok: true,
        ...getWorkspaceInfo(viewRoot),
        recent,
        sandbox,
        newProjectParent,
        open: listOpenWorkspaces().map((entry) => ({
          path: entry.path,
          label: workspaceLabel(entry.path),
        })),
      });
      return true;
    }

    // Electron main (and the headless CLI) claim and release the folders their
    // views are on. Membership here is the filesystem security boundary — see
    // server/workspace/open-workspaces.js.
    if (pathname === '/api/workspace/open' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const userPath = body?.path;
      if (typeof userPath !== 'string' || !userPath.trim()) {
        sendJson(res, 400, { error: 'path is required' });
        return true;
      }
      const resolved = await validateWorkspacePath(userPath);
      openWorkspace(resolved);
      sendJson(res, 200, {
        ok: true,
        path: resolved,
        label: workspaceLabel(resolved),
        open: listOpenWorkspaces().map((entry) => entry.path),
      });
      return true;
    }

    if (pathname === '/api/workspace/open' && req.method === 'DELETE') {
      const body = await readJsonBody(req);
      const userPath = body?.path;
      if (typeof userPath !== 'string' || !userPath.trim()) {
        sendJson(res, 400, { error: 'path is required' });
        return true;
      }
      const closed = closeWorkspace(userPath);
      sendJson(res, 200, {
        ok: true,
        closed,
        open: listOpenWorkspaces().map((entry) => entry.path),
      });
      return true;
    }

    if (pathname === '/api/workspace/recent' && req.method === 'DELETE') {
      const body = await readJsonBody(req);
      const userPath = body?.path;
      if (typeof userPath !== 'string' || !userPath.trim()) {
        sendJson(res, 400, { error: 'path is required' });
        return true;
      }
      await removeRecentWorkspacePath(userPath);
      const recent = await buildRecentWorkspaceList();
      const sandbox = await buildSandboxWorkspaceItem();
      sendJson(res, 200, { ok: true, recent, sandbox });
      return true;
    }

    // No longer a global repoint of live work. It records the folder a cold boot
    // should land in and touches the MRU; the calling view already carries its
    // own workspace on every request.
    if (pathname === '/api/workspace' && req.method === 'PUT') {
      const body = await readJsonBody(req);
      const userPath = body?.path;
      if (typeof userPath !== 'string' || !userPath.trim()) {
        sendJson(res, 400, { error: 'path is required' });
        return true;
      }
      const resolved = await setDefaultWorkspaceRoot(userPath);
      const info = getWorkspaceInfo(resolved);
      sendJson(res, 200, {
        ok: true,
        path: resolved,
        label: info.label,
        isDefault: info.isDefault,
      });
      return true;
    }

    if (pathname === '/api/workspace/pick' && req.method === 'POST') {
      const pick = await pickWorkspaceFolder();
      if (pick.error) {
        sendJson(res, 500, { error: pick.error, cancelled: false });
        return true;
      }
      if (pick.cancelled || !pick.path) {
        sendJson(res, 200, { ok: true, cancelled: true, path: null });
        return true;
      }
      const resolved = await validateWorkspacePath(pick.path);
      await setDefaultWorkspaceRoot(resolved);
      const info = getWorkspaceInfo(resolved);
      sendJson(res, 200, {
        ok: true,
        cancelled: false,
        path: resolved,
        label: info.label,
        isDefault: info.isDefault,
      });
      return true;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 400, { error: message });
    return true;
  }

  if (pathname.startsWith('/api/workspace')) {
    sendJson(res, 404, { error: 'Not found' });
    return true;
  }

  return false;
}

/** Vite connect middleware factory. */
export function createWorkspaceMiddleware() {
  return async (req, res, next) => {
    const rawUrl = req.url ?? '/';
    const parsed = new URL(rawUrl, 'http://127.0.0.1');
    if (!parsed.pathname.startsWith('/api/workspace')) {
      next();
      return;
    }
    const handled = await handleWorkspaceRequest(req, res, parsed.pathname, parsed.searchParams);
    if (!handled) {
      next();
    }
  };
}
