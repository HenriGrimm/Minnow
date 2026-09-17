import { getEffectiveWorkspaceRoot } from '../runtime/path-access.js';
import { validateAllowedWorkspaceRoot } from '../chats-workspace/paths.js';
import { readCodeActivity, recordCodeActivity } from './store.js';

export function createActivityMiddleware() {
  return async (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api/activity') return next();
    res.setHeader('Content-Type', 'application/json');
    try {
      const root = url.searchParams.has('workspace')
        ? await validateAllowedWorkspaceRoot(url.searchParams.get('workspace'))
        : getEffectiveWorkspaceRoot();
      if (req.method === 'GET') {
        res.end(JSON.stringify(readCodeActivity(root, {
          source: url.searchParams.get('source') ?? 'all', day: url.searchParams.get('day') ?? undefined,
          timeZone: url.searchParams.get('tz') || undefined,
        })));
      } else if (req.method === 'POST') {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 32_768) { res.statusCode = 413; res.end(JSON.stringify({ error: 'Body too large' })); return; }
          chunks.push(chunk);
        }
        const event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof event.id !== 'string' || !event.id || event.id.length > 160) throw new Error('Missing event id');
        res.end(JSON.stringify({ ok: true, recorded: recordCodeActivity(root, event) }));
      } else { res.statusCode = 405; res.end(JSON.stringify({ error: 'Method not allowed' })); }
    } catch (error) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Activity unavailable' }));
    }
  };
}
