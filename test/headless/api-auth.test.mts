import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, test } from 'node:test';
import { closeWorkspace, openWorkspace } from '../../src/headless/preflight.ts';
import { headlessApiUrl, installHeadlessFetch } from '../../src/headless/server-context.ts';

const workspace = 'C:/projects/headless-fixture';
const token = 'headless-test-token';
const requests: Array<{ path: string; token: string | undefined; workspace: string | undefined }> = [];
let host: Server | undefined;
let external: Server | undefined;
let restoreFetch: (() => void) | undefined;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test listener');
  return `http://127.0.0.1:${address.port}`;
}

after(async () => {
  restoreFetch?.();
  await Promise.all([host, external].filter(Boolean).map((server) => new Promise<void>((resolve) => server!.close(() => resolve()))));
});

test('absolute Minnow API requests carry auth and workspace, external origins do not', async () => {
  host = createServer((req, res) => {
    requests.push({ path: req.url ?? '', token: req.headers['x-minnow-token'] as string | undefined, workspace: req.headers['x-minnow-workspace'] as string | undefined });
    if (req.headers['x-minnow-token'] !== token || req.headers['x-minnow-workspace'] !== workspace) {
      res.writeHead(401).end('Missing Minnow scope');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
  });
  external = createServer((req, res) => {
    requests.push({ path: '/external', token: req.headers['x-minnow-token'] as string | undefined, workspace: req.headers['x-minnow-workspace'] as string | undefined });
    res.writeHead(200).end('ok');
  });
  const base = await listen(host);
  const externalBase = await listen(external);
  restoreFetch = installHeadlessFetch(base, token, workspace);

  await openWorkspace(base, workspace);
  for (const request of [headlessApiUrl('/api/mcp/tools'), new URL('/api/plugins/tools', base), new Request(headlessApiUrl('/api/tools'), { headers: { 'X-Custom': 'preserved' } })]) {
    const response = await fetch(request);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  await closeWorkspace(base, workspace);
  const externalResponse = await fetch(`${externalBase}/api/tools`);
  assert.equal(externalResponse.status, 200);
  await externalResponse.arrayBuffer();

  assert.equal(requests.length, 6);
  for (const request of requests.slice(0, 5)) {
    assert.equal(request.token, token, request.path);
    assert.equal(request.workspace, workspace, request.path);
  }
  assert.equal(requests[5].token, undefined);
  assert.equal(requests[5].workspace, undefined);
});
