/** Read-only Godot project and engine status for the request-scoped workspace. */

import path from 'node:path';
import { getEffectiveWorkspaceRoot } from '../runtime/path-access.js';
import { findGodotExecutable, probeGodotExecutable } from './engine.js';
import { readGodotProjectInfo, resolveGodotProject } from './project.js';
import { readSceneOutline } from './scene-outline.js';
import { resolveGodotResourcePath } from './resource-path.js';
import {
  getGodotLogs,
  runGodotScene,
  startGodotEditor,
  stopGodot,
  validateGodotProject,
  runGodotTask,
} from './controller.js';
import { godotDebugRequest, startGodotDebug } from './dap-client.js';
import { installManagedGodot, readManagedGodotInstall } from './installer.js';

async function readJsonBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 256 * 1024) {
      throw Object.assign(new Error('Request body too large'), { statusCode: 413 });
    }
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }); }
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {URL} url
 */
export async function handleGodotRequest(req, res, url) {
  if (!url.pathname.startsWith('/api/godot')) return false;
  const readRoutes = ['/api/godot/status', '/api/godot/scene-outline', '/api/godot/resolve-resource', '/api/godot/logs'];
  const actionRoutes = ['/api/godot/install', '/api/godot/editor', '/api/godot/run', '/api/godot/stop', '/api/godot/validate', '/api/godot/task', '/api/godot/debug'];
  if (![...readRoutes, ...actionRoutes].includes(url.pathname)) {
    sendJson(res, 404, { error: 'Not found' });
    return true;
  }
  if ((readRoutes.includes(url.pathname) && req.method !== 'GET') ||
      (actionRoutes.includes(url.pathname) && !['POST', 'DELETE'].includes(req.method))) {
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }
  try {
    const workspaceRoot = getEffectiveWorkspaceRoot();
    if (actionRoutes.includes(url.pathname)) {
      const body = await readJsonBody(req);
      let payload;
      if (url.pathname === '/api/godot/install') {
        payload = await installManagedGodot({ version: body.version });
      } else if (url.pathname === '/api/godot/editor') {
        payload = req.method === 'DELETE'
          ? await stopGodot(workspaceRoot, { ...body, target: 'editor' })
          : await startGodotEditor(workspaceRoot, body);
      } else if (url.pathname === '/api/godot/run') {
        payload = await runGodotScene(workspaceRoot, body);
      } else if (url.pathname === '/api/godot/stop') {
        payload = await stopGodot(workspaceRoot, body);
      } else if (url.pathname === '/api/godot/validate') {
        payload = await validateGodotProject(workspaceRoot, body);
      } else if (url.pathname === '/api/godot/debug') {
        payload = body.action === 'start'
          ? await startGodotDebug(workspaceRoot, body)
          : await godotDebugRequest(workspaceRoot, body);
      } else {
        payload = await runGodotTask(workspaceRoot, body);
      }
      sendJson(res, 200, { ok: true, ...payload });
      return true;
    }
    const selected = url.searchParams.has('project')
      ? url.searchParams.get('project')
      : undefined;
    if (url.pathname === '/api/godot/logs') {
      const payload = await getGodotLogs(workspaceRoot, {
        project: selected,
        limit: url.searchParams.get('limit'),
      });
      sendJson(res, 200, { ok: true, ...payload });
      return true;
    }
    const result = await resolveGodotProject(workspaceRoot, selected);
    if (url.pathname === '/api/godot/scene-outline' || url.pathname === '/api/godot/resolve-resource') {
      if (result.status !== 'selected') {
        sendJson(res, result.status === 'invalid-selection' ? 400 : 409, {
          ok: false, status: result.status, projects: result.projects,
        });
        return true;
      }
      try {
        if (url.pathname === '/api/godot/scene-outline') {
          const outline = await readSceneOutline(result.project.root, url.searchParams.get('path'));
          sendJson(res, 200, { ok: true, project: result.project, outline });
        } else {
          const resource = await resolveGodotResourcePath(result.project.root, url.searchParams.get('uri'));
          const workspacePath = path.relative(workspaceRoot, path.join(result.project.root, resource.relativePath))
            .replace(/\\/g, '/');
          sendJson(res, 200, { ok: true, project: result.project, resource: { ...resource, workspacePath } });
        }
      } catch (err) {
        sendJson(res, err?.statusCode ?? (err?.code === 'ENOENT' ? 404 : 500), {
          ok: false, error: err instanceof Error ? err.message : String(err),
        });
      }
      return true;
    }
    const engineResolution = await findGodotExecutable();
    const engineProbe = engineResolution.path
      ? await probeGodotExecutable(engineResolution.path)
      : null;
    const engine = engineProbe ? { ...engineResolution, ...engineProbe } : engineResolution;
    const base = {
      ok: true,
      workspaceRoot,
      projects: result.projects,
      truncated: result.truncated,
      managedInstall: await readManagedGodotInstall(),
      installAvailable: ['win32', 'darwin', 'linux'].includes(process.platform),
      engine,
    };
    if (result.status !== 'selected') {
      sendJson(res, result.status === 'invalid-selection' ? 400 : 200, {
        ...base,
        status: result.status,
      });
      return true;
    }
    const projectInfo = await readGodotProjectInfo(result.project.root);
    if (!engine.path) {
      sendJson(res, 200, {
        ...base,
        status: 'engine-missing',
        project: result.project,
        projectInfo,
        engine,
      });
      return true;
    }
    sendJson(res, 200, {
      ...base,
      status: engineProbe?.ok ? 'ready' : 'engine-unsupported',
      project: result.project,
      projectInfo,
    });
    return true;
  } catch (err) {
    sendJson(res, err?.statusCode ?? 500, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ...(err?.details ? { details: err.details } : {}),
    });
    return true;
  }
}

export function createGodotMiddleware() {
  return (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith('/api/godot')) return next();
    void handleGodotRequest(req, res, url);
  };
}
