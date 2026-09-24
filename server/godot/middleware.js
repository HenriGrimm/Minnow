/** Read-only Godot project and engine status for the request-scoped workspace. */

import path from 'node:path';
import { getEffectiveWorkspaceRoot } from '../runtime/path-access.js';
import { findGodotExecutable, probeGodotExecutable } from './engine.js';
import { readGodotProjectInfo, resolveGodotProject } from './project.js';
import { readSceneOutline } from './scene-outline.js';
import { resolveGodotResourcePath } from './resource-path.js';

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
  if (!['/api/godot/status', '/api/godot/scene-outline', '/api/godot/resolve-resource'].includes(url.pathname)) {
    sendJson(res, 404, { error: 'Not found' });
    return true;
  }
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }
  try {
    const workspaceRoot = getEffectiveWorkspaceRoot();
    const selected = url.searchParams.has('project')
      ? url.searchParams.get('project')
      : undefined;
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
    const base = {
      ok: true,
      workspaceRoot,
      projects: result.projects,
      truncated: result.truncated,
    };
    if (result.status !== 'selected') {
      sendJson(res, result.status === 'invalid-selection' ? 400 : 200, {
        ...base,
        status: result.status,
      });
      return true;
    }
    const projectInfo = await readGodotProjectInfo(result.project.root);
    const engine = await findGodotExecutable();
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
    const probe = await probeGodotExecutable(engine.path);
    sendJson(res, 200, {
      ...base,
      status: probe.ok ? 'ready' : 'engine-unsupported',
      project: result.project,
      projectInfo,
      engine: { ...engine, ...probe },
    });
    return true;
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
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
