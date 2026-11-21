import { getCell, getRunDetail, listRunSummaries } from './run-store.js';

export function createLegacyEvalResultsMiddleware() {
  return async (req, res, next) => {
    const url = req.url?.split('?')[0] ?? '';
    const match = /^\/api\/evals\/runs(?:\/([^/]+)(?:\/cells\/([^/]+))?)?$/.exec(url);
    if (url !== '/api/evals' && !url.startsWith('/api/evals/')) return next();
    const send = (status, body) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(body));
    };
    if (!match || req.method !== 'GET') return send(410, { error: 'Evals execution is retired. Only saved results can be read.' });
    if (req.minnowAuth?.kind !== 'host') return send(403, { error: 'Local host required.' });
    try {
      if (!match[1]) return send(200, { runs: await listRunSummaries() });
      const id = decodeURIComponent(match[1]);
      const result = match[2] ? await getCell(id, decodeURIComponent(match[2])) : await getRunDetail(id);
      return result ? send(200, match[2] ? { cell: result } : result) : send(404, { error: 'Eval result not found.' });
    } catch {
      return send(400, { error: 'Invalid eval result request.' });
    }
  };
}
