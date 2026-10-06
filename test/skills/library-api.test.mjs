/**
 * Skills Library server routes (MIN-475).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { readConfigJson } from '../../server/config/store.js';
import { handleSkillsRequest } from '../../server/skills/middleware.js';
import { readProvenance } from '../../server/skills/library/provenance.js';

const FIXTURE_SKILL_MD = `---
name: grill-me
label: Grill Me
description: Practice explaining ideas out loud with focused follow-up questions.
---

# Grill Me

Try /review after grilling.
`;

const FIXTURE_ASK_MINNOW_MD = `---
name: ask-matt
description: Router over skills.
---

# Ask Matt

Use /setup-matt-pocock-skills and ask-matt.
- **\`/compact\`** (built-in) — between phases.
`;

const FIXTURE_TREE = [
  { path: 'skills/productivity/grill-me/SKILL.md', type: 'blob', size: FIXTURE_SKILL_MD.length },
  { path: 'skills/productivity/grill-me/notes.md', type: 'blob', size: 12 },
  {
    path: 'skills/engineering/ask-matt/SKILL.md',
    type: 'blob',
    size: FIXTURE_ASK_MINNOW_MD.length,
  },
];

/**
 * @param {string} baseUrl
 * @param {string} method
 * @param {string} pathname
 * @param {unknown} [body]
 */
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
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = text;
          }
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * @param {string | URL | Request} input
 */
function createMockFetch(input) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

  if (url.includes('/git/trees/')) {
    return Promise.resolve(
      new Response(JSON.stringify({ tree: FIXTURE_TREE }), { status: 200 }),
    );
  }

  if (
    url.includes('raw.githubusercontent.com') &&
    url.includes('skills/engineering/ask-matt/SKILL.md')
  ) {
    return Promise.resolve(new Response(FIXTURE_ASK_MINNOW_MD, { status: 200 }));
  }

  if (url.includes('raw.githubusercontent.com') && url.endsWith('SKILL.md')) {
    return Promise.resolve(new Response(FIXTURE_SKILL_MD, { status: 200 }));
  }

  if (url.includes('raw.githubusercontent.com') && url.endsWith('notes.md')) {
    return Promise.resolve(new Response('# Notes\n', { status: 200 }));
  }

  if (url.includes('/commits/')) {
    return Promise.resolve(
      new Response(
        JSON.stringify({ sha: '5d78bd0903420f97c791f834201e550c765699f8' }),
        { status: 200 },
      ),
    );
  }

  return Promise.resolve(new Response('not found', { status: 404 }));
}

describe('Skills Library API', () => {
  /** @type {string} */
  let homeDir;
  /** @type {import('node:http').Server} */
  let server;
  /** @type {string} */
  let baseUrl;
  /** @type {typeof fetch} */
  let originalFetch;

  before(async () => {
    homeDir = path.join(os.tmpdir(), `minnow-skills-library-${process.pid}`);
    process.env.MINNOW_HOME = homeDir;
    resetMinnowHomeCache();

    originalFetch = globalThis.fetch;
    globalThis.fetch = createMockFetch;

    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      void handleSkillsRequest(req, res, url.pathname).then((handled) => {
        if (!handled) {
          res.statusCode = 404;
          res.end('not found');
        }
      });
    });

    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    globalThis.fetch = originalFetch;
    delete process.env.MINNOW_HOME;
    resetMinnowHomeCache();
    await fs.rm(homeDir, { recursive: true, force: true });
  });

  test('GET /api/skills/library/packs returns registry with counts', async () => {
    const { status, json } = await httpRequest(baseUrl, 'GET', '/api/skills/library/packs');
    assert.equal(status, 200);
    assert.ok(Array.isArray(json.packs));
    assert.ok(json.packs.length >= 5);

    const matt = json.packs.find((pack) => pack.id === 'matt-pocock');
    assert.ok(matt);
    assert.equal(matt.installedCount, 0);
    assert.ok(matt.totalCount > 0);
    assert.equal(matt.source.repo, 'mattpocock/skills');
  });

  test('GET /api/skills/library/packs/:id/index serves shipped index offline', async () => {
    const { status, json } = await httpRequest(
      baseUrl,
      'GET',
      '/api/skills/library/packs/matt-pocock/index',
    );
    assert.equal(status, 200);
    assert.equal(json.index.packId, 'matt-pocock');
    assert.ok(Array.isArray(json.index.skills));
    assert.ok(json.index.skills.some((skill) => skill.skillId === 'grill-me'));
  });

  test('GET /api/skills/library/search queries shipped indexes', async () => {
    const { status, json } = await httpRequest(
      baseUrl,
      'GET',
      '/api/skills/library/search?q=grill-me',
    );
    assert.equal(status, 200);
    assert.ok(json.results.some((row) => row.skill.skillId === 'grill-me'));
  });

  test('POST /api/skills/library/install installs pack skill and enables it', async () => {
    const { status, json } = await httpRequest(baseUrl, 'POST', '/api/skills/library/install', {
      pack: 'matt-pocock',
      skillIds: ['grill-me'],
    });
    assert.equal(status, 201);
    assert.equal(json.ok, true);
    assert.equal(json.installed.length, 1);
    assert.equal(json.installed[0].skillId, 'grill-me');

    const skillPath = path.join(homeDir, 'skills', 'grill-me', 'SKILL.md');
    const content = await fs.readFile(skillPath, 'utf8');
    assert.match(content, /name: grill-me/);
    assert.match(content, /\/code-review/);
    assert.equal(/\b\/review\b/.test(content), false);

    const provenance = await readProvenance();
    assert.equal(provenance['grill-me']?.pack, 'matt-pocock');
    assert.equal(provenance['grill-me']?.subpath, 'skills/productivity/grill-me');

    const skillsConfig = await readConfigJson('skills.json');
    assert.equal(skillsConfig.enabled['grill-me'], true);
  });

  test('POST /api/skills/library/install rejects non-GitHub repoUrl hosts', async () => {
    const { status, json } = await httpRequest(baseUrl, 'POST', '/api/skills/library/install', {
      repoUrl: 'https://example.com/some/repo',
    });
    assert.equal(status, 400);
    assert.match(json.error, /github\.com URL|not allowed/i);
  });

  test('POST /api/skills/library/install supports add-from-URL on GitHub', async () => {
    const { status, json } = await httpRequest(baseUrl, 'POST', '/api/skills/library/install', {
      repoUrl:
        'https://github.com/mattpocock/skills/tree/5d78bd0903420f97c791f834201e550c765699f8/skills/productivity/grill-me',
    });
    assert.equal(status, 201);
    assert.equal(json.installed[0].skillId, 'grill-me');

    const provenance = await readProvenance();
    assert.equal(provenance['grill-me']?.repo, 'mattpocock/skills');
    assert.ok(!provenance['grill-me']?.pack);
  });

  test('POST /api/skills/library/install applies matt-pocock post-install patch', async () => {
    const { status, json } = await httpRequest(baseUrl, 'POST', '/api/skills/library/install', {
      pack: 'matt-pocock',
      skillIds: ['ask-minnow'],
    });
    assert.equal(status, 201);
    assert.equal(json.installed[0].skillId, 'ask-minnow');

    const skillPath = path.join(homeDir, 'skills', 'ask-minnow', 'SKILL.md');
    const content = await fs.readFile(skillPath, 'utf8');
    assert.match(content, /name: ask-minnow/);
    assert.match(content, /\/setup-minnow-skills/);
    assert.match(content, /Minnow has no `\/compact` command/);
    assert.equal(/\bname:\s*ask-matt\b/.test(content), false);
    assert.match(content, /Upstream: https:\/\/github.com\/mattpocock\/skills @ skills\/engineering\/ask-matt\/SKILL.md/);
  });

  test('POST /api/skills/library/remove deletes installed skill and provenance', async () => {
    const { status, json } = await httpRequest(baseUrl, 'POST', '/api/skills/library/remove', {
      skillId: 'grill-me',
    });
    assert.equal(status, 200);
    assert.equal(json.removed, true);

    const provenance = await readProvenance();
    assert.equal(provenance['grill-me'], undefined);

    const skillPath = path.join(homeDir, 'skills', 'grill-me', 'SKILL.md');
    await assert.rejects(() => fs.access(skillPath));
  });

  test('POST /api/skills/library/remove supports remove all from pack', async () => {
    const installRes = await httpRequest(baseUrl, 'POST', '/api/skills/library/install', {
      pack: 'matt-pocock',
      skillIds: ['grill-me', 'ask-minnow'],
    });
    assert.equal(installRes.status, 201);

    const { status, json } = await httpRequest(baseUrl, 'POST', '/api/skills/library/remove', {
      pack: 'matt-pocock',
      all: true,
    });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.removed.length, 2);

    const provenance = await readProvenance();
    assert.equal(provenance['grill-me'], undefined);
    assert.equal(provenance['ask-minnow'], undefined);
  });

  test('bulk install reports each success and conflict without replacing local files', async () => {
    const collision = path.join(homeDir, 'skills', 'grill-me');
    await fs.mkdir(collision, { recursive: true });
    await fs.writeFile(path.join(collision, 'SKILL.md'), 'local skill');
    const { status, json } = await httpRequest(baseUrl, 'POST', '/api/skills/library/install', {
      pack: 'matt-pocock', skillIds: ['grill-me', 'ask-minnow'],
    });
    assert.equal(status, 207);
    assert.equal(json.ok, false);
    assert.deepEqual(json.installed.map((row) => row.skillId), ['ask-minnow']);
    assert.equal(json.failed[0].skillId, 'grill-me');
    assert.match(json.failed[0].error, /already exists outside the library/);
    assert.equal(await fs.readFile(path.join(collision, 'SKILL.md'), 'utf8'), 'local skill');

    const again = await httpRequest(baseUrl, 'POST', '/api/skills/library/install', {
      pack: 'matt-pocock', all: true,
    });
    assert.equal(again.status, 207);
    assert.ok(again.json.skipped.some((row) => row.skillId === 'ask-minnow'));

    await fs.rm(collision, { recursive: true, force: true });
    const grill = await httpRequest(baseUrl, 'POST', '/api/skills/library/install', {
      pack: 'matt-pocock', skillIds: ['grill-me'],
    });
    assert.equal(grill.status, 201);
    await fs.appendFile(path.join(collision, 'SKILL.md'), '\nlocal change');
    const remove = await httpRequest(baseUrl, 'POST', '/api/skills/library/remove', {
      pack: 'matt-pocock', all: true,
    });
    assert.equal(remove.status, 207);
    assert.deepEqual(remove.json.removed.map((row) => row.skillId), ['ask-minnow']);
    assert.equal(remove.json.failed[0].skillId, 'grill-me');
    assert.match(await fs.readFile(path.join(collision, 'SKILL.md'), 'utf8'), /local change/);
  });
});
