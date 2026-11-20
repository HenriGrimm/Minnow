/**
 * POST /api/memory/synthesis/run — throttle, board-chat skip, and force behavior.
 * Only skill synthesis runs; memories are never written in the background.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer, request as httpRequestNode } from 'node:http';
import { after, before, describe, mock, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';

let memoryRunCount = 0;
let skillRunCount = 0;

mock.module('../../server/brain/synthesis.js', {
  namedExports: {
    runMemorySynthesis: async () => {
      memoryRunCount += 1;
      return { memoryProposals: [], pages: [], skipped: [] };
    },
    writeSynthesisFactPage: async () => ({}),
    slugifyFactTitle: (title) =>
      String(title ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'fact',
  },
});

mock.module('../../server/brain/skill-synthesis.js', {
  namedExports: {
    runSkillSynthesis: async () => {
      skillRunCount += 1;
      return { skillProposal: null, skipped: [] };
    },
  },
});

const { handleSynthesisRequest } = await import('../../server/brain/synthesis-routes.js');
const { getMessagePairs } = await import('../../server/brain/synthesis-state.js');
const { saveSynthesisConfig } = await import('../../server/brain/synthesis-config.js');

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
          resolve({
            status: res.statusCode,
            json: raw ? JSON.parse(raw) : null,
          });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function handleRoute(baseUrl, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequestNode(
      `${baseUrl}/api/memory/synthesis/run`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode,
            json: raw ? JSON.parse(raw) : null,
          });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('synthesis run route', () => {
  /** @type {string} */
  let homeDir;
  /** @type {import('node:http').Server} */
  let server;
  /** @type {string} */
  let baseUrl;

  before(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-synthesis-run-'));
    process.env.MINNOW_HOME = homeDir;
    resetMinnowHomeCache();
    await saveSynthesisConfig({ enabled: true, throttleMessagePairs: 4 });

    server = createServer(async (req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      const handled = await handleSynthesisRequest(req, res, pathname);
      if (!handled) {
        res.statusCode = 404;
        res.end('not found');
      }
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  after(async () => {
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test('throttles when pair count is not on throttle boundary', async () => {
    memoryRunCount = 0;
    skillRunCount = 0;
    const chatId = '11111111-1111-1111-1111-111111111111';
    const res = await handleRoute(baseUrl, {
      chatId,
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }],
      roundCount: 1,
      toolCount: 0,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.skipped, ['throttled']);
    assert.equal(skillRunCount, 0);
    assert.equal(memoryRunCount, 0);
  });

  test('force bypasses throttle and runs skill synthesis only', async () => {
    memoryRunCount = 0;
    skillRunCount = 0;
    const chatId = '22222222-2222-2222-2222-222222222222';
    const res = await handleRoute(baseUrl, {
      chatId,
      force: true,
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }],
      roundCount: 1,
      toolCount: 0,
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.deepEqual(res.json.memoryProposals, []);
    assert.deepEqual(res.json.memoryPages, []);
    assert.deepEqual(res.json.memorySkipped, ['retired']);
    assert.equal(skillRunCount, 1);
    assert.equal(memoryRunCount, 0);
  });

  test('boardChat skips when includeBoardChats is false', async () => {
    memoryRunCount = 0;
    skillRunCount = 0;
    await saveSynthesisConfig({ includeBoardChats: false, throttleMessagePairs: 1 });
    const chatId = '33333333-3333-3333-3333-333333333333';
    const res = await handleRoute(baseUrl, {
      chatId,
      boardChat: true,
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }],
      roundCount: 1,
      toolCount: 0,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.skipped, ['board-chat']);
    assert.equal(skillRunCount, 0);
    assert.equal(memoryRunCount, 0);
  });

  test('boardChat runs when includeBoardChats is true', async () => {
    memoryRunCount = 0;
    skillRunCount = 0;
    await saveSynthesisConfig({ includeBoardChats: true, throttleMessagePairs: 1 });
    const chatId = '44444444-4444-4444-4444-444444444444';
    const res = await handleRoute(baseUrl, {
      chatId,
      boardChat: true,
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }],
      roundCount: 1,
      toolCount: 0,
    });
    assert.equal(res.status, 200);
    assert.equal(skillRunCount, 1);
    assert.equal(memoryRunCount, 0);
  });

  test('boardChat with force always runs', async () => {
    memoryRunCount = 0;
    skillRunCount = 0;
    await saveSynthesisConfig({ includeBoardChats: false, throttleMessagePairs: 4 });
    const chatId = '55555555-5555-5555-5555-555555555555';
    const res = await handleRoute(baseUrl, {
      chatId,
      boardChat: true,
      force: true,
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }],
      roundCount: 1,
      toolCount: 0,
    });
    assert.equal(res.status, 200);
    assert.equal(skillRunCount, 1);
    assert.equal(memoryRunCount, 0);
  });

  test('forced runs do not increment synthesis-state counter', async () => {
    const chatId = '66666666-6666-6666-6666-666666666666';
    await handleRoute(baseUrl, {
      chatId,
      force: true,
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }],
      roundCount: 1,
      toolCount: 0,
    });
    const pairsAfterForce = await getMessagePairs(chatId);
    assert.equal(pairsAfterForce, 0);
  });
});
