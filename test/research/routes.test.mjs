/**
 * Deep Research HTTP routes — start, SSE, status, result, library, delete.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { describe, it, before, after } from 'node:test';

import { createResearchMiddleware } from '../../server/research/routes.js';
import { engineDeps } from '../../server/research/engine.js';
import { getResearchFilePath } from '../../server/research/store.js';
import { setTestHome, rmTestHome, httpRequest } from '../config/test-helpers.js';

/** @type {typeof engineDeps.llmCall} */
let originalLlmCall;
/** @type {typeof engineDeps.searchStructured} */
let originalSearch;
/** @type {typeof engineDeps.fetchAndExtract} */
let originalExtract;

/**
 * @param {Record<string, string | string[]>} routes
 * @returns {typeof engineDeps.llmCall}
 */
function mockLlmCall(routes) {
  return async ({ messages }) => {
    const content = messages.map((m) => m.content).join('\n');
    for (const [needle, value] of Object.entries(routes)) {
      if (!content.includes(needle)) {
        continue;
      }
      if (Array.isArray(value)) {
        const idx = value.findIndex((v) => v !== '__USED__');
        if (idx === -1) {
          return typeof value[value.length - 1] === 'string' ? value[value.length - 1] : '';
        }
        const next = value[idx];
        value[idx] = '__USED__';
        return next;
      }
      return value;
    }
    return '';
  };
}

function mockSearch() {
  return async (query) => [
    {
      title: `Hit for ${query}`,
      url: `https://example.com/${encodeURIComponent(query)}`,
      snippet: 'snippet',
    },
  ];
}

function mockExtract() {
  return async ({ url, title }) => ({
    url,
    title: title || 'Page',
    rational: 'Relevant',
    evidence: 'Evidence text',
    summary: 'Useful summary with enough detail.',
  });
}

function installFastResearchMocks() {
  originalLlmCall = engineDeps.llmCall;
  originalSearch = engineDeps.searchStructured;
  originalExtract = engineDeps.fetchAndExtract;

  engineDeps.llmCall = mockLlmCall({
    'research strategist': '{"sub_questions":["a"],"key_topics":["b"],"success_criteria":"ok"}',
    'planning web searches': '["route-test-query"]',
    'evolving research report': '## Draft\n\nSynthesized body.',
    'comprehensive enough': 'YES — complete.',
    'long, detailed, comprehensive': '# Final Report\n\nCompleted research output.',
  });
  engineDeps.searchStructured = mockSearch();
  engineDeps.fetchAndExtract = mockExtract();
}

function restoreResearchMocks() {
  engineDeps.llmCall = originalLlmCall;
  engineDeps.searchStructured = originalSearch;
  engineDeps.fetchAndExtract = originalExtract;
}

function createResearchTestServer() {
  const researchMw = createResearchMiddleware();
  return http.createServer((req, res) => {
    researchMw(req, res, () => {
      res.statusCode = 404;
      res.end('not found');
    });
  });
}

function collectSseStream(baseUrl, pathname, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    const chunks = [];
    let settled = false;
    const finish = (buf) => {
      if (settled) return;
      settled = true;
      resolve(buf);
    };
    const req = http.request(
      url,
      {
        method: 'GET',
        agent: new http.Agent({ keepAlive: false }),
        headers: { Accept: 'text/event-stream' },
      },
      (res) => {
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => finish(Buffer.concat(chunks)));
      },
    );
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    req.end();
    setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`SSE stream timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
  });
}

async function waitForResearchStatus(baseUrl, researchId, status, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = await httpRequest(baseUrl, 'GET', `/api/research/status/${researchId}`);
    assert.equal(snap.status, 200, snap.text);
    if (snap.json?.status === status) {
      return snap.json;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  const last = await httpRequest(baseUrl, 'GET', `/api/research/status/${researchId}`);
  assert.fail(`Timed out waiting for status "${status}" (last: ${JSON.stringify(last.json)})`);
}

let homeDir;
let baseUrl;
/** @type {import('node:http').Server | undefined} */
let server;

before(async () => {
  homeDir = setTestHome(process.env, 'minnow-test-research-routes');
  installFastResearchMocks();
  server = createResearchTestServer();
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = /** @type {import('net').AddressInfo} */ (server.address()).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  restoreResearchMocks();
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await rmTestHome(homeDir);
});

describe('POST /api/research/start lifecycle', () => {
  it('start → SSE progress → status done → result persisted → library → delete', async () => {
    const start = await httpRequest(baseUrl, 'POST', '/api/research/start', {
      query: 'What is Minnow routing test?',
      providerId: 'mock-provider',
      model: 'mock-model',
      minRounds: 1,
      maxEmptyRounds: 2,
    });
    assert.equal(start.status, 201, start.text);
    assert.match(start.json?.researchId, /^rs-[a-f0-9]{12}$/);
    const researchId = start.json.researchId;

    const streamPromise = collectSseStream(baseUrl, `/api/research/stream/${researchId}`);

    await waitForResearchStatus(baseUrl, researchId, 'done');

    const streamBuf = await streamPromise;
    const streamText = streamBuf.toString('utf8');
    assert.match(streamText, /"phase":"planning"/);
    assert.match(streamText, /"final":true/);
    assert.match(streamText, /"status":"done"/);

    const result = await httpRequest(baseUrl, 'GET', `/api/research/result/${researchId}`);
    assert.equal(result.status, 200, result.text);
    assert.match(String(result.json?.result), /Final Report/);
    assert.ok(Array.isArray(result.json?.sources));
    assert.ok(Array.isArray(result.json?.rawFindings));

    const filePath = getResearchFilePath(researchId);
    const onDisk = JSON.parse(await fs.readFile(filePath, 'utf8'));
    assert.equal(onDisk.status, 'done');
    assert.match(String(onDisk.result), /Final Report/);

    const library = await httpRequest(baseUrl, 'GET', '/api/research/library');
    assert.equal(library.status, 200);
    assert.ok(library.json?.research?.some((row) => row.id === researchId));

    const detail = await httpRequest(baseUrl, 'GET', `/api/research/detail/${researchId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json?.id ?? researchId, researchId);

    const report = await httpRequest(baseUrl, 'GET', `/api/research/report/${researchId}`);
    assert.equal(report.status, 200);
    assert.match(report.text, /<!DOCTYPE html|<html/i);

    const archive = await httpRequest(
      baseUrl,
      'POST',
      `/api/research/${researchId}/archive?archived=true`,
    );
    assert.equal(archive.status, 200);
    assert.equal(archive.json?.archived, true);

    const hidden = await httpRequest(baseUrl, 'GET', '/api/research/library');
    assert.ok(!hidden.json?.research?.some((row) => row.id === researchId));

    const archivedList = await httpRequest(
      baseUrl,
      'GET',
      '/api/research/library?archived=true',
    );
    assert.ok(archivedList.json?.research?.some((row) => row.id === researchId));

    const del = await httpRequest(baseUrl, 'DELETE', `/api/research/${researchId}`);
    assert.equal(del.status, 200);
    await assert.rejects(() => fs.access(filePath));
    await new Promise((resolve) => setTimeout(resolve, 75));
    await assert.rejects(() => fs.access(filePath), 'a late checkpoint must not recreate a deleted result');
  });

  it('rejects invalid research id format', async () => {
    const bad = await httpRequest(baseUrl, 'GET', '/api/research/status/not-an-id');
    assert.equal(bad.status, 400);
  });

  it('continueFrom loads prior research context', async () => {
    const first = await httpRequest(baseUrl, 'POST', '/api/research/start', {
      query: 'Initial research topic',
      providerId: 'mock-provider',
      model: 'mock-model',
      minRounds: 1,
    });
    assert.equal(first.status, 201);
    const firstId = first.json.researchId;
    await waitForResearchStatus(baseUrl, firstId, 'done');

    installFastResearchMocks();
    const second = await httpRequest(baseUrl, 'POST', '/api/research/start', {
      query: 'Refine the initial topic',
      providerId: 'mock-provider',
      model: 'mock-model',
      minRounds: 1,
      continueFrom: firstId,
    });
    assert.equal(second.status, 201);
    await waitForResearchStatus(baseUrl, second.json.researchId, 'done');

    const detail = await httpRequest(
      baseUrl,
      'GET',
      `/api/research/detail/${second.json.researchId}`,
    );
    assert.equal(detail.status, 200);
    assert.match(String(detail.json?.result), /Final Report/);
  });

  it('library lists in-memory running tasks before persistence', async () => {
    originalLlmCall = engineDeps.llmCall;
    engineDeps.llmCall = async () => {
      await new Promise((r) => setTimeout(r, 400));
      return '{"sub_questions":["slow"],"key_topics":["x"],"success_criteria":"y"}';
    };

    const start = await httpRequest(baseUrl, 'POST', '/api/research/start', {
      query: 'Library running row test',
      providerId: 'mock-provider',
      model: 'mock-model',
      minRounds: 5,
    });
    assert.equal(start.status, 201);
    const researchId = start.json.researchId;

    await new Promise((r) => setTimeout(r, 30));
    const library = await httpRequest(baseUrl, 'GET', '/api/research/library');
    assert.equal(library.status, 200);
    const row = library.json?.research?.find((item) => item.id === researchId);
    assert.ok(row, 'expected running research in library');
    assert.equal(row.status, 'running');

    await waitForResearchStatus(baseUrl, researchId, 'done', 15_000);

    restoreResearchMocks();
    installFastResearchMocks();
  });
});

describe('POST /api/research/cancel', () => {
  it('cooperatively cancels a running task', async () => {
    originalLlmCall = engineDeps.llmCall;
    engineDeps.llmCall = async () => {
      await new Promise((r) => setTimeout(r, 500));
      return '{"sub_questions":["slow"],"key_topics":["x"],"success_criteria":"y"}';
    };

    const start = await httpRequest(baseUrl, 'POST', '/api/research/start', {
      query: 'Slow cancel test',
      providerId: 'mock-provider',
      model: 'mock-model',
      minRounds: 5,
    });
    assert.equal(start.status, 201);
    const researchId = start.json.researchId;

    await new Promise((r) => setTimeout(r, 50));
    const cancel = await httpRequest(baseUrl, 'POST', `/api/research/cancel/${researchId}`);
    assert.equal(cancel.status, 200);
    assert.equal(cancel.json?.cancelled, true);

    const status = await waitForResearchStatus(
      baseUrl,
      researchId,
      'cancelled',
      10_000,
    );
    assert.equal(status.status, 'cancelled');
    const persisted = JSON.parse(await fs.readFile(getResearchFilePath(researchId), 'utf8'));
    assert.equal(persisted.status, 'cancelled');

    restoreResearchMocks();
    installFastResearchMocks();
  });
});
