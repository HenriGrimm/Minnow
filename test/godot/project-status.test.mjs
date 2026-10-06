import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { findGodotExecutable, parseGodotVersion, probeGodotExecutable } from '../../server/godot/engine.js';
import { handleGodotRequest } from '../../server/godot/middleware.js';
import { listGodotProjects, readGodotProjectInfo, resolveGodotProject } from '../../server/godot/project.js';
import { runWithViewWorkspace } from '../../server/runtime/path-access.js';

describe('Godot project status', () => {
  let temp;
  let workspaceA;
  let workspaceB;

  before(async () => {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-godot-'));
    workspaceA = path.join(temp, 'workspace-a');
    workspaceB = path.join(temp, 'workspace-b');
    await fs.mkdir(path.join(workspaceA, 'game', 'scenes'), { recursive: true });
    await fs.mkdir(path.join(workspaceA, '.godot', 'cache'), { recursive: true });
    await fs.mkdir(path.join(workspaceB, 'other'), { recursive: true });
    await fs.writeFile(path.join(workspaceA, 'game', 'project.godot'),
      'config_version=5\n[application]\nconfig/name="Minnow Game"\nrun/main_scene="res://scenes/main.tscn"\n');
    await fs.writeFile(path.join(workspaceA, '.godot', 'cache', 'project.godot'), 'cache');
    await fs.writeFile(path.join(workspaceB, 'other', 'project.godot'), '[application]\n');
  });

  after(async () => {
    await fs.rm(temp, { recursive: true, force: true });
  });

  test('discovers a nested project, excluding Godot cache', async () => {
    const result = await listGodotProjects(workspaceA);
    assert.deepEqual(result.projects.map((project) => project.relativeRoot), ['game']);
    assert.equal(result.truncated, false);
    assert.equal((await resolveGodotProject(workspaceA)).status, 'selected');
  });

  test('reads project name and saved main-scene setting without starting Godot', async () => {
    assert.deepEqual(await readGodotProjectInfo(path.join(workspaceA, 'game')), {
      name: 'Minnow Game',
      mainScene: 'res://scenes/main.tscn',
      configVersion: 5,
    });
  });

  test('requires selection when there are multiple projects', async () => {
    await fs.mkdir(path.join(workspaceA, 'second'), { recursive: true });
    await fs.writeFile(path.join(workspaceA, 'second', 'project.godot'), '[application]\n');
    const result = await resolveGodotProject(workspaceA);
    assert.equal(result.status, 'select-project');
    assert.deepEqual(result.projects.map((project) => project.relativeRoot), ['game', 'second']);
    assert.equal((await resolveGodotProject(workspaceA, 'second')).project.relativeRoot, 'second');
    assert.equal((await resolveGodotProject(workspaceA, '../workspace-b/other')).status, 'invalid-selection');
  });

  test('honors the directory budget', async () => {
    const result = await listGodotProjects(workspaceA, { maxDirectories: 1 });
    assert.equal(result.truncated, true);
    assert.deepEqual(result.projects, []);
    assert.equal((await resolveGodotProject(workspaceA, undefined, { maxDirectories: 1 })).status, 'scan-incomplete');
    assert.equal((await resolveGodotProject(workspaceA, 'game', { maxDirectories: 1 })).status, 'selected');
  });

  test('uses the requesting workspace rather than a global root', async () => {
    const server = http.createServer((req, res) => {
      const root = req.headers['x-test-root'];
      runWithViewWorkspace(String(root), () => {
        void handleGodotRequest(req, res, new URL(req.url, 'http://127.0.0.1'));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      const url = `http://127.0.0.1:${address.port}/api/godot/status`;
      const [a, b] = await Promise.all([
        fetch(url, { headers: { 'x-test-root': workspaceA } }).then((res) => res.json()),
        fetch(url, { headers: { 'x-test-root': workspaceB } }).then((res) => res.json()),
      ]);
      assert.equal(a.status, 'select-project');
      assert.deepEqual(a.projects.map((project) => project.relativeRoot), ['game', 'second']);
      assert.equal(b.project.relativeRoot, 'other');
      assert.deepEqual(b.projectInfo, { name: null, mainScene: null, configVersion: null });
      assert.ok(['engine-missing', 'ready', 'engine-unsupported'].includes(b.status));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('configured engine path takes precedence and reports a missing override', async () => {
    const missing = path.join(temp, 'missing-godot');
    const result = await findGodotExecutable({
      env: { MINNOW_GODOT_PATH: missing, PATH: '' },
      homeDir: temp,
    });
    assert.deepEqual(result, {
      path: null,
      source: 'configured',
      configuredPath: missing,
    });
  });

  test('discovers an official versioned Windows binary on PATH', async () => {
    const binDir = path.join(temp, 'portable-bin');
    await fs.mkdir(binDir, { recursive: true });
    const binary = path.join(binDir, 'Godot_v4.6.1-stable_win64.exe');
    await fs.writeFile(binary, 'fixture');
    const result = await findGodotExecutable({
      env: { PATH: binDir },
      platform: 'win32',
      homeDir: temp,
    });
    assert.equal(result.path, binary);
    assert.equal(result.source, 'path');
  });

  test('discovers the .NET edition under the official godot-mono command', async () => {
    const binDir = path.join(temp, 'mono-bin');
    await fs.mkdir(binDir, { recursive: true });
    const binary = path.join(binDir, 'godot-mono.exe');
    await fs.writeFile(binary, 'fixture');
    const result = await findGodotExecutable({
      env: { PATH: binDir }, platform: 'win32', homeDir: temp,
    });
    assert.equal(result.path, binary);
  });

  test('parses Godot editions and rejects a different executable', async () => {
    assert.deepEqual(parseGodotVersion('4.6.1.stable.mono.official.abcdef\n'), {
      raw: '4.6.1.stable.mono.official.abcdef',
      major: 4,
      minor: 6,
      patch: 1,
      dotNet: true,
    });
    assert.equal(parseGodotVersion('not-godot'), null);
    assert.equal((await probeGodotExecutable(process.execPath)).ok, false);
  });
});
