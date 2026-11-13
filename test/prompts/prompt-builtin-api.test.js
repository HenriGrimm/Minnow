/**
 * GET ?baseline=builtin ignores ~/.minnow file overrides.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { after, before, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { handleConfigRequest } from '../../server/config/middleware.js';
import { handlePromptRequest } from '../../server/prompts/middleware.js';

function setTestHome(env) {
  resetMinnowHomeCache();
  const dir = path.join(os.tmpdir(), `minnow-builtin-api-${process.pid}`);
  env.MINNOW_HOME = dir;
  return dir;
}

function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void handleConfigRequest(req, res, url.pathname).then((handled) => {
      if (handled) return;
      void handlePromptRequest(req, res, url.pathname, url.search).then((h3) => {
        if (!h3) {
          res.statusCode = 404;
          res.end('not found');
        }
      });
    });
  });
}

function httpGet(baseUrl, pathname) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    http
      .get(url, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            json: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          });
        });
      })
      .on('error', reject);
  });
}

describe('prompt builtin baseline API', () => {
  let server;
  let baseUrl;
  let homeDir;

  before(async () => {
    homeDir = setTestHome(process.env);
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    resetMinnowHomeCache();
  });

  test('GET baseline=builtin returns builtin even when override exists', async () => {
    const overrideDir = path.join(homeDir, 'prompts', 'modes');
    await fs.mkdir(overrideDir, { recursive: true });
    await fs.writeFile(
      path.join(overrideDir, 'build.full.md'),
      'USER OVERRIDE ONLY\n',
      'utf8',
    );

    const normal = await httpGet(
      baseUrl,
      '/api/prompts/modes/build/prompt',
    );
    assert.equal(normal.status, 200);
    assert.equal(normal.json.source, 'override');
    assert.match(normal.json.content, /USER OVERRIDE/);

    const builtin = await httpGet(
      baseUrl,
      '/api/prompts/modes/build/prompt?baseline=builtin',
    );
    assert.equal(builtin.status, 200);
    assert.equal(builtin.json.source, 'builtin');
    assert.ok(!builtin.json.content.includes('USER OVERRIDE ONLY'));
    assert.ok(builtin.json.content.length > 20);
  });
  test('rejects requests for a legacy variant without changing the canonical prompt', async () => {
    const path = '/api/prompts/modes/build/prompt';
    const retired = await httpGet(baseUrl, path + '?profile=lite');
    assert.equal(retired.status, 400);
    assert.equal((await httpGet(baseUrl, path)).status, 200);
  });
});
