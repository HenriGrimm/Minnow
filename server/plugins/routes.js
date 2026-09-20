import { connectionSettings, listPackages, panelContent } from './manager.js';
import { inspectPlugins, pluginManage } from './authoring.js';
import { runWithPathAccess } from '../runtime/path-access.js';

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error('Request exceeds 256 KiB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export async function handlePackageRequest(req, res, pathname) {
  if (!pathname.startsWith('/api/plugins/packages')) return false;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const tail = pathname.slice('/api/plugins/packages'.length);
    let result;
    if (tail === '' && req.method === 'GET') result = await listPackages();
    else if (tail === '/inspect' && req.method === 'POST') result = await runWithPathAccess(async () => inspectPlugins(await readBody(req)));
    else if (tail === '/manage' && req.method === 'POST') result = await runWithPathAccess(async () => pluginManage(await readBody(req)));
    else {
      const connections = /^\/([a-z0-9-]+)\/connections$/.exec(tail);
      const panel = /^\/([a-z0-9-]+)\/panels\/([a-z0-9_]+)$/.exec(tail);
      if (connections && ['GET', 'PUT'].includes(req.method)) result = await connectionSettings(connections[1], req.method === 'PUT' ? (await readBody(req)).connections : undefined);
      else if (panel && req.method === 'GET') result = await panelContent(panel[1], panel[2]);
      else { res.statusCode = 404; result = { error: 'Plugin endpoint not found' }; }
    }
    res.end(JSON.stringify(result));
  } catch (error) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
  return true;
}
