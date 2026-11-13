/**
 * GET/PUT /api/config/appearance — resource route + disk round-trip.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  createConfigTestServer,
  httpRequest,
  rmTestHome,
  setTestHome,
} from './test-helpers.js';

let homeDir;
let baseUrl;
let server;

before(async () => {
  homeDir = setTestHome(process.env, 'minnow-test-appearance');
  server = createConfigTestServer();
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = /** @type {import('net').AddressInfo} */ (server.address()).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rmTestHome(homeDir);
});

describe('appearance config API', () => {
  test('GET returns default blob when the file is missing', async () => {
    const res = await httpRequest(baseUrl, 'GET', '/api/config/appearance');
    assert.equal(res.status, 200);
    assert.equal(res.json.themeId, 'graphite-dark');
    assert.equal(res.json.updatedAt, null);
  });

  test('PUT round-trips a chosen theme and stamps updatedAt', async () => {
    const put = await httpRequest(baseUrl, 'PUT', '/api/config/appearance', {
      themeId: 'ocean-dark',
      family: 'ocean',
      followSystem: false,
      colorIntensity: 37,
      graphiteAccent: 'rose',
      density: 'compact',
      reduceMotion: true,
    });
    assert.equal(put.status, 200);
    assert.equal(put.json.ok, true);
    assert.equal(put.json.data.themeId, 'ocean-dark');
    assert.ok(typeof put.json.data.updatedAt === 'string');

    const get = await httpRequest(baseUrl, 'GET', '/api/config/appearance');
    assert.equal(get.status, 200);
    assert.equal(get.json.themeId, 'ocean-dark');
    assert.equal(get.json.family, 'ocean');
    assert.equal(get.json.colorIntensity, 37);
    assert.equal(get.json.graphiteAccent, 'rose');
    assert.equal(get.json.density, 'compact');
    assert.equal(get.json.reduceMotion, true);

    const raw = JSON.parse(await fs.readFile(path.join(homeDir, 'appearance.json'), 'utf8'));
    assert.equal(raw.themeId, 'ocean-dark');
  });
});
