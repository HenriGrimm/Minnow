import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ensureMinnowLayout } from '../../server/config/home.js';
import { handleWorkspaceRequest } from '../../server/workspace/middleware.js';
import {
  dedupeRecentPaths,
  ensureScratchWorkspaceRegistered,
  getScratchWorkspacePath,
  getWorkspaceInfo,
  initWorkspaceRoot,
  isEligibleRecentWorkspacePath,
  isPlaceholderWorkspacePath,
  isWorkspaceUserChosen,
  normalizeWorkspacePathKey,
  SCRATCH_WORKSPACE_LABEL,
  setAppRoot,
  setWorkspaceRoot,
  touchRecentWorkspacePath,
  workspaceLabel,
} from '../../server/workspace/root.js';
import { rmTestHome, setTestHome } from '../config/test-helpers.js';

function createWorkspaceTestServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void handleWorkspaceRequest(req, res, url.pathname, url.searchParams).then((handled) => {
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
        headers: payload
          ? {
              'Content-Type': 'application/json',
              'Content-Length': String(Buffer.byteLength(payload)),
            }
          : undefined,
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
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('workspace API', () => {
  let homeDir;
  let server;
  let baseUrl;
  let workspaceDir;
  let workspaceDirB;

  before(async () => {
    homeDir = setTestHome(process.env, 'minnow-test-workspace');
    await ensureMinnowLayout();
    workspaceDir = path.join(homeDir, 'sample-project');
    workspaceDirB = path.join(homeDir, 'other-project');
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(workspaceDirB, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, 'README.md'), '# sample\n', 'utf8');

    await initWorkspaceRoot();

    server = createWorkspaceTestServer();
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rmTestHome(homeDir);
  });

  test('GET returns default workspace (app cwd)', async () => {
    const { status, json } = await httpRequest(baseUrl, 'GET', '/api/workspace');
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.ok(typeof json.path === 'string' && json.path.length > 0);
    assert.ok(typeof json.label === 'string');
    assert.ok(Array.isArray(json.recent));
    assert.ok(json.sandbox);
    assert.equal(json.sandbox.label, SCRATCH_WORKSPACE_LABEL);
    assert.ok(typeof json.newProjectParent === 'string' && json.newProjectParent.length > 0);
    const stat = await fs.stat(json.newProjectParent);
    assert.ok(stat.isDirectory());
  });

  test('PUT sets workspace and persists to config.json', async () => {
    const { status, json } = await httpRequest(baseUrl, 'PUT', '/api/workspace', {
      path: workspaceDir,
    });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(path.resolve(json.path), path.resolve(workspaceDir));

    const info = getWorkspaceInfo();
    assert.equal(path.resolve(info.path), path.resolve(workspaceDir));

    const configRaw = await fs.readFile(path.join(homeDir, 'config.json'), 'utf8');
    const config = JSON.parse(configRaw);
    assert.equal(path.resolve(config.workspace.path), path.resolve(workspaceDir));
    assert.ok(Array.isArray(config.workspace.recentPaths));
    assert.ok(
      config.workspace.recentPaths.some(
        (p) => normalizeWorkspacePathKey(p) === normalizeWorkspacePathKey(workspaceDir),
      ),
    );
    assert.ok(config.workspace.recentPaths.length <= 10);
  });

  test('second PUT adds both paths with newer first', async () => {
    const { status, json } = await httpRequest(baseUrl, 'PUT', '/api/workspace', {
      path: workspaceDirB,
    });
    assert.equal(status, 200);
    assert.equal(path.resolve(json.path), path.resolve(workspaceDirB));

    const configRaw = await fs.readFile(path.join(homeDir, 'config.json'), 'utf8');
    const config = JSON.parse(configRaw);
    const recents = config.workspace.recentPaths;
    assert.ok(recents.length >= 2);
    assert.equal(
      normalizeWorkspacePathKey(recents[0]),
      normalizeWorkspacePathKey(workspaceDirB),
    );
    assert.ok(
      recents.some(
        (p) => normalizeWorkspacePathKey(p) === normalizeWorkspacePathKey(workspaceDir),
      ),
    );
  });

  test('PUT same path again dedupes and keeps path first', async () => {
    await httpRequest(baseUrl, 'PUT', '/api/workspace', { path: workspaceDir });
    const configRaw = await fs.readFile(path.join(homeDir, 'config.json'), 'utf8');
    const config = JSON.parse(configRaw);
    const recents = config.workspace.recentPaths;
    const keys = recents.map((p) => normalizeWorkspacePathKey(p));
    const unique = new Set(keys);
    assert.equal(keys.length, unique.size);
    assert.equal(
      normalizeWorkspacePathKey(recents[0]),
      normalizeWorkspacePathKey(workspaceDir),
    );
  });

  test('GET recent includes exists and isCurrent', async () => {
    await setWorkspaceRoot(workspaceDir);
    const missing = path.join(homeDir, 'ghost-workspace-removed');
    const metaRaw = await fs.readFile(path.join(homeDir, 'config.json'), 'utf8');
    const meta = JSON.parse(metaRaw);
    meta.workspace.recentPaths = dedupeRecentPaths([
      workspaceDir,
      missing,
      workspaceDirB,
    ]);
    await fs.writeFile(path.join(homeDir, 'config.json'), JSON.stringify(meta), 'utf8');

    const { status, json } = await httpRequest(baseUrl, 'GET', '/api/workspace');
    assert.equal(status, 200);
    const missingRow = json.recent.find(
      (r) => normalizeWorkspacePathKey(r.path) === normalizeWorkspacePathKey(missing),
    );
    const currentRow = json.recent.find((r) => r.isCurrent);
    assert.ok(missingRow);
    assert.equal(missingRow.exists, false);
    assert.ok(currentRow);
    assert.equal(currentRow.exists, true);
    assert.equal(currentRow.isCurrent, true);
  });

  test('DELETE recent removes entry without changing active path', async () => {
    await setWorkspaceRoot(workspaceDir);
    const activeBefore = getWorkspaceInfo().path;

    const { status, json } = await httpRequest(baseUrl, 'DELETE', '/api/workspace/recent', {
      path: workspaceDirB,
    });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.ok(Array.isArray(json.recent));
    assert.ok(
      !json.recent.some(
        (r) => normalizeWorkspacePathKey(r.path) === normalizeWorkspacePathKey(workspaceDirB),
      ),
    );
    assert.equal(path.resolve(getWorkspaceInfo().path), path.resolve(activeBefore));

    const configRaw = await fs.readFile(path.join(homeDir, 'config.json'), 'utf8');
    const config = JSON.parse(configRaw);
    assert.ok(
      !config.workspace.recentPaths.some(
        (p) => normalizeWorkspacePathKey(p) === normalizeWorkspacePathKey(workspaceDirB),
      ),
    );
  });

  test('11th distinct path caps list at 10', async () => {
    const dirs = [];
    for (let i = 0; i < 11; i++) {
      const dir = path.join(homeDir, `ws-cap-${i}`);
      await fs.mkdir(dir, { recursive: true });
      dirs.push(dir);
    }
    for (const dir of dirs) {
      await httpRequest(baseUrl, 'PUT', '/api/workspace', { path: dir });
    }
    const configRaw = await fs.readFile(path.join(homeDir, 'config.json'), 'utf8');
    const config = JSON.parse(configRaw);
    assert.equal(config.workspace.recentPaths.length, 10);
    assert.equal(
      normalizeWorkspacePathKey(config.workspace.recentPaths[0]),
      normalizeWorkspacePathKey(dirs[10]),
    );
  });

  test('PUT rejects missing directory', async () => {
    const missing = path.join(homeDir, 'does-not-exist-xyz');
    const { status, json } = await httpRequest(baseUrl, 'PUT', '/api/workspace', {
      path: missing,
    });
    assert.equal(status, 400);
    assert.match(json.error, /does not exist/i);
  });

  test('initWorkspaceRoot reloads saved path', async () => {
    await setWorkspaceRoot(workspaceDir);
    await initWorkspaceRoot();
    const info = getWorkspaceInfo();
    assert.equal(path.resolve(info.path), path.resolve(workspaceDir));
    assert.equal(isWorkspaceUserChosen(), true);
    assert.equal(info.isDefault, false);
  });

  test('placeholder install root is default until user chooses', async () => {
    const priorRoot = path.resolve(process.cwd());
    const fakeAppRoot = path.join(homeDir, 'fake-install');
    await fs.mkdir(fakeAppRoot, { recursive: true });
    setAppRoot(fakeAppRoot, { packaged: true });
    await fs.writeFile(
      path.join(homeDir, 'config.json'),
      JSON.stringify({ workspace: { path: fakeAppRoot } }),
      'utf8',
    );
    await initWorkspaceRoot();
    assert.equal(isPlaceholderWorkspacePath(fakeAppRoot), true);
    const info = getWorkspaceInfo();
    assert.equal(info.isDefault, true);
    assert.equal(isWorkspaceUserChosen(), false);
    setAppRoot(priorRoot);
    await initWorkspaceRoot();
  });

  test('dev checkout app root is a real project, not a placeholder', async () => {
    const priorRoot = path.resolve(process.cwd());
    const devRoot = path.join(homeDir, 'dev-checkout');
    await fs.mkdir(devRoot, { recursive: true });
    // No `packaged` flag: this is how `node server.js` and dev Electron run,
    // where the app root is the repo the user works in.
    setAppRoot(devRoot);

    assert.equal(isPlaceholderWorkspacePath(devRoot), false);
    assert.equal(isEligibleRecentWorkspacePath(devRoot), true);

    await touchRecentWorkspacePath(devRoot);
    const configRaw = await fs.readFile(path.join(homeDir, 'config.json'), 'utf8');
    const config = JSON.parse(configRaw);
    assert.ok(
      config.workspace.recentPaths.some(
        (p) => normalizeWorkspacePathKey(p) === normalizeWorkspacePathKey(devRoot),
      ),
    );

    setAppRoot(priorRoot);
    await initWorkspaceRoot();
  });

  test('placeholder app root compare ignores Windows path casing', async () => {
    if (process.platform !== 'win32') return;
    const priorRoot = path.resolve(process.cwd());
    const fakeAppRoot = path.join(homeDir, 'case-install');
    await fs.mkdir(fakeAppRoot, { recursive: true });
    setAppRoot(fakeAppRoot.toUpperCase(), { packaged: true });

    assert.equal(isPlaceholderWorkspacePath(fakeAppRoot), true);

    setAppRoot(priorRoot);
    await initWorkspaceRoot();
  });

  test('GET browse without path returns quick roots', async () => {
    const { status, json } = await httpRequest(baseUrl, 'GET', '/api/workspace/browse');
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.path, '');
    assert.equal(json.parent, null);
    assert.ok(Array.isArray(json.entries));
    assert.ok(json.entries.length >= 1);
    const home = json.entries.find((e) => e.name === 'Home');
    assert.ok(home);
    assert.ok(typeof home.path === 'string' && home.path.length > 0);
  });

  test('GET browse lists child directories only', async () => {
    const childDir = path.join(workspaceDir, 'nested-browse');
    await fs.mkdir(childDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, 'only-file.txt'), 'x', 'utf8');

    const q = `?path=${encodeURIComponent(workspaceDir)}`;
    const { status, json } = await httpRequest(baseUrl, 'GET', `/api/workspace/browse${q}`);
    assert.equal(status, 200);
    assert.equal(path.resolve(json.path), path.resolve(workspaceDir));
    assert.ok(json.parent !== null);
    const names = json.entries.map((e) => e.name);
    assert.ok(names.includes('nested-browse'));
    assert.ok(!names.includes('only-file.txt'));
    assert.ok(!names.includes('README.md'));
  });

  test('GET browse rejects missing directory', async () => {
    const missing = path.join(homeDir, 'browse-missing-xyz');
    const q = `?path=${encodeURIComponent(missing)}`;
    const { status, json } = await httpRequest(baseUrl, 'GET', `/api/workspace/browse${q}`);
    assert.equal(status, 400);
    assert.match(json.error, /does not exist/i);
  });

  test('POST mkdir creates subfolder under parent', async () => {
    const newName = 'mkdir-test-folder';
    const expectedPath = path.join(workspaceDir, newName);
    try {
      await fs.rm(expectedPath, { recursive: true, force: true });
    } catch {
      /* absent */
    }

    const { status, json } = await httpRequest(baseUrl, 'POST', '/api/workspace/mkdir', {
      parentPath: workspaceDir,
      name: newName,
    });
    assert.equal(status, 201);
    assert.equal(json.ok, true);
    assert.equal(json.name, newName);
    assert.equal(path.resolve(json.path), path.resolve(expectedPath));

    const stat = await fs.stat(expectedPath);
    assert.ok(stat.isDirectory());

    const q = `?path=${encodeURIComponent(workspaceDir)}`;
    const browse = await httpRequest(baseUrl, 'GET', `/api/workspace/browse${q}`);
    assert.ok(browse.json.entries.some((e) => e.name === newName));
  });

  test('POST mkdir rejects duplicate folder', async () => {
    const dupName = 'mkdir-dup-folder';
    const dupPath = path.join(workspaceDir, dupName);
    await fs.mkdir(dupPath, { recursive: true });

    const { status, json } = await httpRequest(baseUrl, 'POST', '/api/workspace/mkdir', {
      parentPath: workspaceDir,
      name: dupName,
    });
    assert.equal(status, 400);
    assert.match(json.error, /already exists/i);
  });

  test('POST mkdir rejects invalid name', async () => {
    const { status, json } = await httpRequest(baseUrl, 'POST', '/api/workspace/mkdir', {
      parentPath: workspaceDir,
      name: 'bad/name',
    });
    assert.equal(status, 400);
    assert.match(json.error, /invalid characters/i);
  });

  test('POST mkdir rejects empty parentPath', async () => {
    const { status, json } = await httpRequest(baseUrl, 'POST', '/api/workspace/mkdir', {
      parentPath: '',
      name: 'orphan',
    });
    assert.equal(status, 400);
    assert.match(json.error, /parentPath is required/i);
  });

  test('POST reveal-in-explorer rejects missing path', async () => {
    const { status, json } = await httpRequest(baseUrl, 'POST', '/api/workspace/reveal-in-explorer', {
      path: '',
    });
    assert.equal(status, 400);
    assert.equal(json.ok, false);
    assert.match(json.error, /path is required/i);
  });

  test('POST reveal-in-explorer rejects path outside workspace', async () => {
    await setWorkspaceRoot(workspaceDir);
    const { status, json } = await httpRequest(baseUrl, 'POST', '/api/workspace/reveal-in-explorer', {
      path: path.join(homeDir, 'outside-file.txt'),
    });
    assert.equal(status, 400);
    assert.match(String(json.error ?? ''), /outside the workspace/i);
  });

  test('Sandbox is registered on init and stays out of recents', async () => {
    const scratchPath = await ensureScratchWorkspaceRegistered();
    assert.equal(path.resolve(scratchPath), path.resolve(getScratchWorkspacePath()));
    assert.equal(workspaceLabel(scratchPath), SCRATCH_WORKSPACE_LABEL);
    assert.equal(SCRATCH_WORKSPACE_LABEL, 'Sandbox');
    const info = getWorkspaceInfo();
    assert.equal(path.resolve(info.scratchPath), path.resolve(scratchPath));
    const configRaw = await fs.readFile(path.join(homeDir, 'config.json'), 'utf8');
    const config = JSON.parse(configRaw);
    assert.equal(path.resolve(config.workspace.scratchPath), path.resolve(scratchPath));
    assert.ok(
      !config.workspace.recentPaths?.some(
        (p) => normalizeWorkspacePathKey(p) === normalizeWorkspacePathKey(scratchPath),
      ),
    );

    const { json } = await httpRequest(baseUrl, 'GET', '/api/workspace');
    assert.ok(
      !json.recent.some(
        (r) => normalizeWorkspacePathKey(r.path) === normalizeWorkspacePathKey(scratchPath),
      ),
    );
    assert.equal(
      normalizeWorkspacePathKey(json.sandbox.path),
      normalizeWorkspacePathKey(scratchPath),
    );
  });

  test('temp dirs and worktrees are not eligible recents and prune from disk', async () => {
    const junk = path.join(os.tmpdir(), `minnow-wt-allow-${process.pid}`);
    await fs.mkdir(junk, { recursive: true });
    assert.equal(isEligibleRecentWorkspacePath(junk), false);
    assert.equal(isEligibleRecentWorkspacePath(workspaceDir), true);
    assert.equal(isEligibleRecentWorkspacePath(getScratchWorkspacePath()), false);

    await touchRecentWorkspacePath(junk);
    await touchRecentWorkspacePath(workspaceDir);

    const configRaw = await fs.readFile(path.join(homeDir, 'config.json'), 'utf8');
    const config = JSON.parse(configRaw);
    assert.ok(
      !config.workspace.recentPaths.some(
        (p) => normalizeWorkspacePathKey(p) === normalizeWorkspacePathKey(junk),
      ),
    );
    assert.ok(
      config.workspace.recentPaths.some(
        (p) => normalizeWorkspacePathKey(p) === normalizeWorkspacePathKey(workspaceDir),
      ),
    );

    const { json } = await httpRequest(baseUrl, 'GET', '/api/workspace');
    assert.ok(
      !json.recent.some(
        (r) => normalizeWorkspacePathKey(r.path) === normalizeWorkspacePathKey(junk),
      ),
    );

    await fs.rm(junk, { recursive: true, force: true });
  });

  test('GET recents do not prepend the current folder unless it is in the MRU', async () => {
    await setWorkspaceRoot(workspaceDir);
    const metaRaw = await fs.readFile(path.join(homeDir, 'config.json'), 'utf8');
    const meta = JSON.parse(metaRaw);
    meta.workspace.recentPaths = dedupeRecentPaths([workspaceDirB]);
    await fs.writeFile(path.join(homeDir, 'config.json'), JSON.stringify(meta), 'utf8');

    const { json } = await httpRequest(baseUrl, 'GET', '/api/workspace');
    assert.ok(
      !json.recent.some(
        (r) => normalizeWorkspacePathKey(r.path) === normalizeWorkspacePathKey(workspaceDir),
      ),
    );
    assert.ok(
      json.recent.some(
        (r) => normalizeWorkspacePathKey(r.path) === normalizeWorkspacePathKey(workspaceDirB),
      ),
    );
  });
});
