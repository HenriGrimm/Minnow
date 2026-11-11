/**
 * HTTP middleware for /api/profiles (setup bundles).
 */

import {
  activateProfile,
  captureProfile,
  deleteProfileFile,
  duplicateProfileFile,
  importProfileBundle,
  listProfiles,
  loadProfileFile,
  saveProfileFile,
  setWorkspaceProfileDefault,
} from './handlers.js';
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
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathname
 * @returns {Promise<boolean>}
 */
export async function handleProfilesRequest(req, res, pathname) {
  if (!pathname.startsWith('/api/profiles')) {
    return false;
  }

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }

  try {
    if (pathname === '/api/profiles' && req.method === 'GET') {
      const profiles = await listProfiles();
      sendJson(res, 200, { profiles });
      return true;
    }

    if (pathname === '/api/profiles/capture' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const saved = await captureProfile(body);
      sendJson(res, 200, { ok: true, profile: saved });
      return true;
    }

    if (pathname === '/api/profiles/import' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const mode = body.mode === 'replace' ? 'replace' : 'create';
      const saved = await importProfileBundle(body, mode);
      sendJson(res, 200, { ok: true, profile: saved });
      return true;
    }

    if (pathname === '/api/profiles/workspace-default' && req.method === 'PUT') {
      const body = await readJsonBody(req);
      const workspacePath = typeof body.workspacePath === 'string' ? body.workspacePath : '';
      const profileId =
        body.profileId === null || typeof body.profileId === 'string'
          ? body.profileId
          : null;
      if (!workspacePath.trim()) {
        sendJson(res, 400, { error: 'workspacePath is required' });
        return true;
      }
      const result = await setWorkspaceProfileDefault(workspacePath, profileId);
      sendJson(res, 200, { ok: true, ...result });
      return true;
    }

    const duplicateMatch = pathname.match(
      /^\/api\/profiles\/([a-z0-9][a-z0-9-_]{0,63})\/duplicate$/,
    );
    if (duplicateMatch && req.method === 'POST') {
      const sourceId = duplicateMatch[1];
      const body = await readJsonBody(req);
      const newId = typeof body.newId === 'string' ? body.newId : '';
      const newLabel = typeof body.newLabel === 'string' ? body.newLabel : undefined;
      if (!newId) {
        sendJson(res, 400, { error: 'newId is required' });
        return true;
      }
      const saved = await duplicateProfileFile(sourceId, newId, newLabel);
      sendJson(res, 200, { ok: true, profile: saved });
      return true;
    }

    const activateMatch = pathname.match(
      /^\/api\/profiles\/([a-z0-9][a-z0-9-_]{0,63})\/activate$/,
    );
    if (activateMatch && req.method === 'POST') {
      const id = activateMatch[1];
      const result = await activateProfile(id);
      sendJson(res, 200, result);
      return true;
    }

    const exportMatch = pathname.match(
      /^\/api\/profiles\/([a-z0-9][a-z0-9-_]{0,63})\/export$/,
    );
    if (exportMatch && req.method === 'GET') {
      const id = exportMatch[1];
      const bundle = await loadProfileFile(id);
      if (!bundle) {
        sendJson(res, 404, { error: 'Not found' });
        return true;
      }
      const filename = `${id}.minnow-profile.json`;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.end(`${JSON.stringify(bundle, null, 2)}\n`);
      return true;
    }

    const idMatch = pathname.match(/^\/api\/profiles\/([a-z0-9][a-z0-9-_]{0,63})$/);
    if (idMatch) {
      const id = idMatch[1];

      if (req.method === 'GET') {
        const bundle = await loadProfileFile(id);
        if (!bundle) {
          sendJson(res, 404, { error: 'Not found' });
          return true;
        }
        sendJson(res, 200, bundle);
        return true;
      }

      if (req.method === 'PUT') {
        const body = await readJsonBody(req);
        const withId = { ...body, id };
        const saved = await saveProfileFile(withId);
        sendJson(res, 200, { ok: true, profile: saved });
        return true;
      }

      if (req.method === 'DELETE') {
        try {
          const removed = await deleteProfileFile(id);
          if (!removed) {
            sendJson(res, 404, { error: 'Not found' });
            return true;
          }
          sendJson(res, 200, { ok: true });
          return true;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          sendJson(res, 400, { error: message });
          return true;
        }
      }
    }

    sendJson(res, 404, { error: 'Not found' });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[profiles]', message);
    sendJson(res, 500, { error: message });
    return true;
  }
}

/** Vite middleware hook. */
export function createProfilesMiddleware() {
  return async (req, res, next) => {
    const rawUrl = req.url ?? '';
    const q = rawUrl.indexOf('?');
    const pathname = q >= 0 ? rawUrl.slice(0, q) : rawUrl;
    if (!pathname.startsWith('/api/profiles')) {
      next();
      return;
    }
    const handled = await handleProfilesRequest(req, res, pathname);
    if (!handled) next();
  };
}
