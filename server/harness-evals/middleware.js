import { createHarnessManager } from './manager.js';

export function createHarnessEvalsMiddleware(manager) {
  if (!manager) {
    manager = createHarnessManager();
    process.once('exit', () => manager.stop());
  }
  return async (req, res, next) => {
    const pathname = (req.url || '').split('?')[0];
    if (!pathname.startsWith('/api/harness-evals/')) return next();
    const send = (code, value) => {
      res.statusCode = code;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(value));
    };
    try {
      if (req.method === 'GET' && pathname === '/api/harness-evals/status') return send(200, await manager.status());
      if (req.method === 'GET' && pathname === '/api/harness-evals/checks') return send(200, await manager.check());
      if (req.method !== 'POST') return send(405, { error: 'Method not allowed' });
      const action = pathname.slice('/api/harness-evals/'.length);
      if (action === 'stop') return send(200, manager.stop());
      if (!['setup', 'runtime', 'run'].includes(action)) return send(404, { error: 'Unknown benchmark action' });
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 8192) return send(413, { error: 'Request too large' });
      }
      return send(202, await manager.start(action, raw ? JSON.parse(raw) : {}));
    } catch (error) { send(400, { error: error.message }); }
  };
}
