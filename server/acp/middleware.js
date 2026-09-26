/** HTTP API for local ACP agent registration, validation, and prompt runs. */

import {
  deleteAcpAgent,
  listAcpAgents,
  saveAcpAgent,
} from './store.js';
import {
  cancelAcpRun,
  getAcpRun,
  startAcpRun,
  validateAcpAgent,
} from './runtime.js';

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) {
        reject(new Error('Request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
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

export async function handleAcpRequest(req, res, pathname) {
  const isAcpPath = pathname === '/api/models/acp-agents'
    || pathname.startsWith('/api/models/acp-agents/')
    || pathname.startsWith('/api/models/acp-runs/');
  if (!isAcpPath) return false;
  if (req.minnowAuth?.kind !== 'host') {
    sendJson(res, 403, { error: 'Host session required' });
    return true;
  }
  try {
    if (pathname === '/api/models/acp-agents' && req.method === 'GET') {
      sendJson(res, 200, { agents: await listAcpAgents() });
      return true;
    }
    if (pathname === '/api/models/acp-agents' && req.method === 'POST') {
      sendJson(res, 201, { agent: await saveAcpAgent(await readJsonBody(req)) });
      return true;
    }

    const runMatch = pathname.match(/^\/api\/models\/acp-runs\/([^/]+)(?:\/(cancel))?$/);
    if (runMatch) {
      const runId = decodeURIComponent(runMatch[1]);
      if (runMatch[2] === 'cancel' && req.method === 'POST') {
        const ok = await cancelAcpRun(runId);
        sendJson(res, ok ? 200 : 404, ok ? { run: getAcpRun(runId) } : { error: 'ACP run not found' });
        return true;
      }
      if (!runMatch[2] && req.method === 'GET') {
        const params = new URL(req.url ?? '', 'http://localhost').searchParams;
        const run = getAcpRun(runId, Number(params.get('since') ?? 0));
        sendJson(res, run ? 200 : 404, run ? { run } : { error: 'ACP run not found' });
        return true;
      }
      return false;
    }

    const agentMatch = pathname.match(
      /^\/api\/models\/acp-agents\/([^/]+)(?:\/(verify|runs))?$/,
    );
    if (!agentMatch) return false;
    const id = decodeURIComponent(agentMatch[1]);
    const action = agentMatch[2];
    if (!action && req.method === 'PUT') {
      const body = await readJsonBody(req);
      sendJson(res, 200, { agent: await saveAcpAgent({ ...body, id }) });
      return true;
    }
    if (!action && req.method === 'DELETE') {
      await deleteAcpAgent(id);
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (action === 'verify' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const validation = await validateAcpAgent(id, body?.workspaceRoot);
      sendJson(res, validation.ok ? 200 : 422, { validation });
      return true;
    }
    if (action === 'runs' && req.method === 'POST') {
      sendJson(res, 202, { run: await startAcpRun(id, await readJsonBody(req)) });
      return true;
    }
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  } catch (error) {
    const status = error?.code === 'ENOENT' ? 404 : 400;
    sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
    return true;
  }
}
