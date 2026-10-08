/** API paths are relative to /api/. Use context.dataDir for app-owned persistence. */
export async function handle(req, res, context) {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unknown operation' }));
}
