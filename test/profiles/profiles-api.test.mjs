/**
 * Setup profiles API CRUD against temp MINNOW_HOME.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { after, before, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { handleProfilesRequest } from '../../server/profiles/middleware.js';

function setTestHome(env) {
  resetMinnowHomeCache();
  const dir = path.join(os.tmpdir(), `minnow-profiles-test-${process.pid}`);
  env.MINNOW_HOME = dir;
  return dir;
}

function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void handleProfilesRequest(req, res, url.pathname).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end('not found');
      }
    });
  });
}

function httpRequest(baseUrl, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    const payload = body != null ? JSON.stringify(body) : undefined;
    const req = http.request(
      url,
      {
        method,
        headers: payload ? { 'Content-Type': 'application/json' } : undefined,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = text;
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

const SAMPLE_BUNDLE = {
  id: 'backend-strict',
  label: 'Backend strict',
  schemaVersion: 1,
  prompt: {
    promptProfile: 'full',
    activePromptConfigId: null,
    activeInfoPresetId: 'general-assistant',
    planGranularity: 'medium',
    source: 'full',
  },
  agents: { workAgents: {}, subAgents: {} },
  tools: {
    permissions: { save_file: 'ask', execute_command: 'off' },
    replaceAll: false,
  },
};

describe('profiles API', () => {
  let server;
  let baseUrl;

  before(async () => {
    setTestHome(process.env);
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    resetMinnowHomeCache();
  });

  test('PUT and GET round-trip', async () => {
    const put = await httpRequest(baseUrl, 'PUT', '/api/profiles/backend-strict', SAMPLE_BUNDLE);
    assert.equal(put.status, 200);

    const get = await httpRequest(baseUrl, 'GET', '/api/profiles/backend-strict');
    assert.equal(get.status, 200);
    assert.equal(get.json.id, 'backend-strict');
    assert.equal('permissions' in get.json.tools, false);
  });

  test('import rejects invalid id', async () => {
    const bad = {
      ...SAMPLE_BUNDLE,
      id: '../escape',
    };
    const res = await httpRequest(baseUrl, 'POST', '/api/profiles/import', {
      bundle: bad,
      mode: 'create',
    });
    assert.equal(res.status, 500);
  });

  test('capture creates profile from live settings', async () => {
    const cap = await httpRequest(baseUrl, 'POST', '/api/profiles/capture', {
      id: 'captured',
      label: 'Captured',
    });
    assert.equal(cap.status, 200);
    assert.equal(cap.json.profile.id, 'captured');
  });
});
