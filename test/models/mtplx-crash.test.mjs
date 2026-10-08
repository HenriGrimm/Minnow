import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { descriptorFromInspect } from '../../server/models/mtplx-descriptor.js';

let home, modelPath, alive = false, sequence = 0;
const listeners = new Map();
const launches = [];
const previousHome = process.env.MINNOW_HOME;
const terminal = await import('../../server/terminal-runner.js');
mock.module('../../server/terminal-runner.js', { namedExports: { ...terminal,
  readRunLogTail: async () => 'Runtime contract verified — profile: sustained\nModel loaded; memory limit: 64GB',
} });
const actual = await import('../../server/models/mtplx-serve.js');
mock.module('../../server/models/mtplx-serve.js', { namedExports: {
  ...actual,
  startMtplxServe: (body, deps) => actual.startMtplxServe({ ...body, async: false }, {
    ...deps,
    status: async () => ({ supported: true, installed: true, path: '/fixture/mtplx' }),
    descriptor: async () => descriptorFromInspect({ compatibility: { can_run: true } }, modelPath),
    findPort: async port => port,
    probe: async () => alive ? { ok: true, model_path: modelPath, profile: { name: 'sustained' }, depth: 2, context_window: 4096 } : null,
    wait: async () => ({ ok: true }),
    models: async () => ({ data: [{ id: 'fixture-model' }] }),
  }),
} });
const serve = await import('../../server/models/serve.js');
before(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-mtplx-crash-'));
  process.env.MINNOW_HOME = home; resetMinnowHomeCache();
  modelPath = await fs.realpath(home);
  await fs.writeFile(path.join(home, 'config.json'), '{}');
  serve.setServeBackgroundRunOverrideForTests(async spec => {
    sequence++; alive = true; launches.push(spec);
    return { runId: `fixture-${sequence}`, pid: process.pid };
  });
  serve.setSubscribeRunOverrideForTests((id, fn) => { listeners.set(id, fn); return () => listeners.delete(id); });
  serve.setServeRestartDelayMsForTests(0);
});
after(async () => {
  await serve.waitForServeCrashHandlersForTests(); await serve.waitForServeRestartsForTests();
  await serve.resetServesForTests();
  if (previousHome === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = previousHome;
  resetMinnowHomeCache(); await fs.rm(home, { recursive: true, force: true });
});
async function running(id) {
  for (let i = 0; i < 100; i++) {
    const row = await serve.getServe(id);
    if (row.status !== 'starting') { assert.equal(row.status, 'running', row.error); return row; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('fixture load did not settle');
}
test('owned MTPLX crash restarts once with its port, settings and admission weights', async () => {
  const first = await serve.startServe({ runtime: 'mtplx', modelPath, port: 19488, libraryId: 'mtplx:Org/Fixture',
    hardware: { ramGb: 128 }, weightsGb: 2, async: true,
    mtplx: { profile: 'sustained', depth: 2, context_window: 4096, idle_ttl_ms: 0 } });
  await running(first.id);
  serve.patchServeRowForTests(first.id, { lastHealthyAt: Date.now() - 31000 });
  alive = false; listeners.get(first.runId)({ type: 'exit', code: null });
  await serve.waitForServeCrashHandlersForTests(); await serve.waitForServeRestartsForTests();
  const rows = await serve.listServes();
  const next = rows.find(row => row.id !== first.id); assert.ok(next);
  await running(next.id);
  assert.equal(next.ownership, 'minnow'); assert.equal(next.port, 19488);
  assert.equal(next.libraryId, 'mtplx:Org/Fixture'); assert.equal(next.mtplxSettings.profile, 'sustained');
  assert.equal(next.mtplxSettings.context_window, 4096); assert.equal(next.mtplxSettings.idle_ttl_ms, 0);
  assert.equal(serve.peekServeRowForTests(next.id).launchPlan.weightsBytes, 2 * 1024 ** 3);
  assert.deepEqual(serve.peekServeRowForTests(next.id).launchPlan.hardware, { ramGb: 128 });
  assert.equal(launches.length, 2);
  serve.patchServeRowForTests(next.id, { lastHealthyAt: Date.now() - 31000 });
  alive = false; listeners.get(next.runId)({ type: 'exit', code: 1 });
  await serve.waitForServeCrashHandlersForTests(); await serve.waitForServeRestartsForTests();
  assert.equal(launches.length, 2); assert.equal((await serve.getServe(next.id)).status, 'crashed');
});
