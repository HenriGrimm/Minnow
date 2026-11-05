import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { handleGodotRequest } from '../../server/godot/middleware.js';
import { getGodotStatus, resetGodotSessionsForTest, runGodotScene, setGodotControllerHooksForTest, stopGodot } from '../../server/godot/controller.js';
import { runWithViewWorkspace } from '../../server/runtime/path-access.js';

describe('Godot control API', () => {
  let root;
  let previousGodotPath;

  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-godot-control-'));
    await fs.writeFile(path.join(root, 'project.godot'), '[application]\nconfig/name="Control Test"\n');
    previousGodotPath = process.env.MINNOW_GODOT_PATH;
    process.env.MINNOW_GODOT_PATH = path.join(root, 'missing-godot');
  });

  after(async () => {
    if (previousGodotPath == null) delete process.env.MINNOW_GODOT_PATH;
    else process.env.MINNOW_GODOT_PATH = previousGodotPath;
    await fs.rm(root, { recursive: true, force: true });
  });

  test('reports project and missing configured engine without launching', async () => {
    const status = await getGodotStatus(root);
    assert.equal(status.status, 'selected');
    assert.equal(status.projectInfo.name, 'Control Test');
    assert.equal(status.engine.path, null);
    assert.equal(status.session, null);
  });

  test('stop is idempotent when no managed process exists', async () => {
    const stopped = await stopGodot(root, { target: 'all' });
    assert.deepEqual(stopped.stopped, []);
  });

  test('a delayed exit from a replaced game cannot clear or stop its successor', async t => {
    const children = [];
    t.after(resetGodotSessionsForTest);
    setGodotControllerHooksForTest({
      findExecutable: async () => ({ path: 'fake-godot' }),
      probeExecutable: async () => ({ ok: true }),
      spawn() {
        const child = new EventEmitter();
        child.pid = 100 + children.length;
        child.kill = () => { child.killed = true; return true; };
        children.push(child);
        return child;
      },
    });
    await runGodotScene(root);
    await assert.rejects(runGodotScene(root), /already running/);
    const restarted = await runGodotScene(root, { restart: true });
    assert.equal(restarted.session.game.pid, 101);
    children[0].emit('error', new Error('late error'));
    children[0].emit('exit', 0);
    children[0].emit('close', 0);
    assert.equal((await getGodotStatus(root)).session.game.pid, 101);
    assert.deepEqual((await stopGodot(root)).stopped, ['game']);
    assert.equal(children[1].killed, true);
  });

  test('control route returns a useful conflict when Godot is unavailable', async () => {
    const server = http.createServer((req, res) => {
      runWithViewWorkspace(root, () => {
        void handleGodotRequest(req, res, new URL(req.url, 'http://127.0.0.1'));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      const response = await fetch(`http://127.0.0.1:${address.port}/api/godot/editor`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(response.status, 409);
      assert.match((await response.json()).error, /Godot executable not found/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
