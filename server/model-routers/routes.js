import { getRouterWorkspace } from './store.js';
import { routerAvailability } from './availability.js';

export async function handleRouterRequest(req, res, pathname, readJsonBody, sendJson) {
  if (!pathname.startsWith('/api/generations/routers')) return false;
  try {
    const workspace = await getRouterWorkspace();
    if (pathname === '/api/generations/routers') {
      if (req.method === 'PUT') await workspace.save(await readJsonBody(req));
      else if (req.method !== 'GET') { sendJson(res, 405, { error: 'Method not allowed' }); return true; }
      sendJson(res, 200, { routers: workspace.routers, defaultRouterId: workspace.defaultRouterId, revision: workspace.revision, assignments: Object.values(workspace.scheduler.assignments), decisions: [...workspace.scheduler.decisions.values()] });
      return true;
    }
    const match = pathname.match(/^\/api\/generations\/routers\/([\w-]+)\/(activity|override|reevaluate)$/);
    const router = workspace.routers.find((r) => r.id === match?.[1]);
    if (!router) { sendJson(res, 404, { error: 'Router not found' }); return true; }
    if ((match[2] === 'override' || match[2] === 'reevaluate') && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (typeof body.chatId !== 'string' || !body.chatId || body.chatId.length > 200) throw new Error('Chat id is required');
      if (match[2] === 'reevaluate') workspace.scheduler.requestReevaluation(router, body.chatId);
      else workspace.scheduler.override(router, body.chatId, body.entryId || null);
      await workspace.flush();
    } else if (req.method !== 'GET' || match[2] !== 'activity') { sendJson(res, 405, { error: 'Method not allowed' }); return true; }
    sendJson(res, 200, { ...workspace.scheduler.activity(router), availability: await routerAvailability(router) });
  } catch (error) { sendJson(res, 400, { error: error.message }); }
  return true;
}
