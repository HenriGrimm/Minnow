/**
 * Brain HTTP API smoke tests.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer, request as httpRequestNode } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { closeSessionsDb } from '../../server/config/sessions-db.js';
import { closeCodeDbForTests } from '../../server/brain/code/schema.js';
import { handleBrainRequest, initBrainApi } from '../../server/brain/routes.js';
import { shutdownAllLsp } from '../../server/lsp/manager.js';

const PAGE_ID = '11111111-1111-1111-1111-111111111111';

function httpRequest(baseUrl, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    const payload = body ? JSON.stringify(body) : undefined;
    const req = httpRequestNode(
      url,
      {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = { raw };
          }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function startBrainServer(homeDir) {
  process.env.MINNOW_HOME = homeDir;
  resetMinnowHomeCache();
  await fs.rm(homeDir, { recursive: true, force: true });
  await fs.mkdir(homeDir, { recursive: true });
  await initBrainApi();

  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const handled = await handleBrainRequest(req, res, pathname);
    if (!handled) {
      res.statusCode = 404;
      res.end('not found');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe('brain API', () => {
  let homeDir;
  let server;
  let baseUrl;

  before(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-brain-api-'));
    ({ server, baseUrl } = await startBrainServer(homeDir));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    shutdownAllLsp();
    closeCodeDbForTests();
    // initBrainApi opens sessions.db via readAllChatIds — close before rm (Windows EBUSY).
    closeSessionsDb();
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  test('ping returns ok', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/brain/ping');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
  });

  test('page CRUD via HTTP enforces sandbox paths', async () => {
    const put = await httpRequest(baseUrl, 'PUT', '/api/brain/page', {
      path: 'facts/api-note.md',
      id: PAGE_ID,
      title: 'API note',
      body: 'Brain route test body.',
      tags: ['test'],
      source: 'user',
    });
    assert.equal(put.status, 201);

    const get = await httpRequest(
      baseUrl,
      'GET',
      `/api/brain/page?path=${encodeURIComponent('facts/api-note.md')}`,
    );
    assert.equal(get.status, 200);
    assert.equal(get.json.meta.id, PAGE_ID);

    const bad = await httpRequest(baseUrl, 'PUT', '/api/brain/page', {
      path: '../../../etc/passwd.md',
      title: 'Nope',
      body: 'x',
    });
    assert.equal(bad.status, 400);

    const del = await httpRequest(
      baseUrl,
      'DELETE',
      `/api/brain/page?path=${encodeURIComponent('facts/api-note.md')}`,
    );
    assert.equal(del.status, 200);
  });

  test('retrieve respects workspaceKey scoping', async () => {
    await httpRequest(baseUrl, 'PUT', '/api/brain/page', {
      path: 'facts/global-fact.md',
      id: PAGE_ID,
      title: 'Global npm command',
      body: 'Run npm start for the dev server.',
      source: 'user',
    });
    await httpRequest(baseUrl, 'PUT', '/api/brain/page', {
      path: 'workspaces/ws-a/secret.md',
      id: '22222222-2222-2222-2222-222222222222',
      title: 'Workspace secret',
      body: 'Only for workspace A.',
      source: 'user',
    });
    await httpRequest(baseUrl, 'PUT', '/api/brain/page', {
      path: 'workspaces/ws-b/other.md',
      id: '33333333-3333-3333-3333-333333333333',
      title: 'Workspace B note',
      body: 'Only for workspace B.',
      source: 'user',
    });

    const scopedA = await httpRequest(baseUrl, 'POST', '/api/brain/retrieve', {
      query: 'workspace',
      workspaceKey: 'ws-a',
      limit: 10,
    });
    assert.equal(scopedA.status, 200);
    assert.ok(scopedA.json.ids.includes('22222222-2222-2222-2222-222222222222'));
    assert.ok(!scopedA.json.ids.includes('33333333-3333-3333-3333-333333333333'));

    const scopedGlobal = await httpRequest(baseUrl, 'POST', '/api/brain/retrieve', {
      query: 'npm',
      workspaceKey: 'ws-a',
      limit: 10,
    });
    assert.ok(scopedGlobal.json.ids.includes(PAGE_ID));
    assert.ok(!scopedGlobal.json.ids.includes('33333333-3333-3333-3333-333333333333'));

    const unrelatedInjection = await httpRequest(baseUrl, 'POST', '/api/brain/retrieve', {
      query: 'Lets make a chess web game',
      workspaceKey: 'ws-a',
      autoInject: true,
    });
    assert.equal(unrelatedInjection.status, 200);
    assert.deepEqual(unrelatedInjection.json.ids, []);

    const relevantInjection = await httpRequest(baseUrl, 'POST', '/api/brain/retrieve', {
      query: 'Fix npm command',
      workspaceKey: 'ws-a',
      autoInject: true,
    });
    assert.deepEqual(relevantInjection.json.ids, [PAGE_ID]);
  });

  test('clear routes require confirmed', async () => {
    const proposals = await httpRequest(baseUrl, 'POST', '/api/brain/proposals/clear', {
      scope: 'pending',
    });
    assert.equal(proposals.status, 400);

    const code = await httpRequest(baseUrl, 'POST', '/api/brain/code/clear', {});
    assert.equal(code.status, 400);

    const sources = await httpRequest(baseUrl, 'POST', '/api/brain/sources/clear', {});
    assert.equal(sources.status, 400);
  });

  test('proposals and sources clear round-trip', async () => {
    const { addMemoryProposal } = await import('../../server/brain/proposals.js');
    await addMemoryProposal({
      title: 'Pending fact',
      body: 'Proposal body',
      category: 'fact',
    });

    const clearedProposals = await httpRequest(baseUrl, 'POST', '/api/brain/proposals/clear', {
      scope: 'pending',
      confirmed: true,
    });
    assert.equal(clearedProposals.status, 200);
    assert.ok(clearedProposals.json.removed >= 1);
    assert.ok(clearedProposals.json.removedMemory >= 1);

    const pendingAfter = await httpRequest(
      baseUrl,
      'GET',
      '/api/brain/proposals?status=pending',
    );
    assert.equal(pendingAfter.json.proposals.length, 0);

    const { addSkillProposal } = await import('../../server/skills/proposals.js');
    await addSkillProposal({
      title: 'Pending skill',
      skillMdDraft: '# Skill draft',
    });

    const clearedSkills = await httpRequest(baseUrl, 'POST', '/api/brain/proposals/clear', {
      scope: 'pending',
      confirmed: true,
    });
    assert.equal(clearedSkills.status, 200);
    assert.ok(clearedSkills.json.removed >= 1);
    assert.ok(clearedSkills.json.removedSkill >= 1);

    const sourcesDir = path.join(homeDir, 'brain', 'sources');
    await fs.mkdir(sourcesDir, { recursive: true });
    await fs.writeFile(path.join(sourcesDir, 'abc-test.txt'), 'raw source', 'utf8');

    const clearedSources = await httpRequest(baseUrl, 'POST', '/api/brain/sources/clear', {
      confirmed: true,
    });
    assert.equal(clearedSources.status, 200);
    assert.ok(clearedSources.json.removed >= 1);
    const remaining = await fs.readdir(sourcesDir).catch(() => []);
    assert.equal(remaining.length, 0);
  });
});
