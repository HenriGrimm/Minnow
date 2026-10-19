import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { getRouterWorkspace, resolveRouterId } from '../../server/model-routers/store.js';
import { normalizeWorkspacePathKey } from '../../server/workspace/root.js';

const pool = (model) => ({ id: 'same-id', name: 'Coding', enabled: true, policy: 'priority', entries: [{ id: 'entry', providerId: 'cloud', modelId: model, concurrencyLimit: 2, enabled: true }] });
const scope = (root) => createHash('sha256').update(normalizeWorkspacePathKey(path.resolve(root))).digest('hex');

test('global migration preserves conflicting project pools, assignments and original files', async () => {
  const previous = process.env.MINNOW_HOME;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-pool-migration-'));
  process.env.MINNOW_HOME = home; resetMinnowHomeCache();
  try {
    const directory = path.join(home, 'model-routers'); await fs.mkdir(directory);
    for (const [root, model] of [['/project-a', 'a'], ['/project-b', 'b']]) {
      await fs.writeFile(path.join(directory, `${scope(root)}.json`), JSON.stringify({ routers: [pool(model)], revision: 3, defaultRouterId: 'same-id', assignments: { old: { routerId: 'same-id', chatId: model, assignedEntryId: 'entry', assignmentMode: 'override', overrideEntryId: 'entry' } } }));
    }
    const global = await getRouterWorkspace();
    assert.equal(global.routers.length, 2);
    const a = await resolveRouterId('same-id', '/project-a'), b = await resolveRouterId('same-id', '/project-b');
    assert.notEqual(a, b);
    assert.equal(global.routers.find((pool) => pool.id === a).entries[0].modelId, 'a');
    assert.equal(global.scheduler.assignments[JSON.stringify([a, 'a'])].overrideEntryId, 'entry');
    assert.equal((await getRouterWorkspace()), global);
    assert.equal((await fs.readdir(directory)).filter((name) => name.endsWith('.json')).length, 3);
    const saved = JSON.parse(await fs.readFile(path.join(directory, 'global-v2.json'), 'utf8'));
    assert.equal(saved.version, 2); assert.equal(saved.defaultRouterId, null);
    await assert.rejects(global.save({ routers: [], revision: -1 }), /another window/);
  } finally { if (previous === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = previous; resetMinnowHomeCache(); await fs.rm(home, { recursive: true, force: true }); }
});

test('a corrupt legacy input is retained and prevents committing a partial catalog', async () => {
  const previous = process.env.MINNOW_HOME;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-pool-corrupt-'));
  process.env.MINNOW_HOME = home; resetMinnowHomeCache();
  try {
    const directory = path.join(home, 'model-routers'); await fs.mkdir(directory);
    const source = path.join(directory, `${'a'.repeat(64)}.json`); await fs.writeFile(source, '{invalid');
    await assert.rejects(getRouterWorkspace());
    assert.equal(await fs.readFile(source, 'utf8'), '{invalid');
    await assert.rejects(fs.access(path.join(directory, 'global-v2.json')));
    await fs.writeFile(source, JSON.stringify({ routers: [pool('fixed')] }));
    assert.equal((await getRouterWorkspace()).routers.length, 1);
  } finally { if (previous === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = previous; resetMinnowHomeCache(); await fs.rm(home, { recursive: true, force: true }); }
});

test('global admission shares the strictest provider capacity and only definition writes advance revision', async () => {
  const previous = process.env.MINNOW_HOME;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-pool-admission-'));
  process.env.MINNOW_HOME = home; resetMinnowHomeCache();
  let releaseFirst, releaseSecond;
  try {
    const store = await getRouterWorkspace();
    const first = { ...pool('shared'), id: 'first', entries: [{ ...pool('shared').entries[0], concurrencyLimit: 1 }] };
    const second = { ...pool('shared'), id: 'second', entries: [{ ...pool('shared').entries[0], concurrencyLimit: 3 }] };
    await store.save({ routers: [first, second], revision: 0 });
    const firstEntry = store.scheduler.select(first, 'project-a-chat', () => true);
    const secondEntry = store.scheduler.select(second, 'project-b-chat', () => true);
    releaseFirst = await store.scheduler.acquire(first, 'project-a-chat', firstEntry);
    let admitted = false;
    const waiting = store.scheduler.acquire(second, 'project-b-chat', secondEntry).then((release) => { admitted = true; releaseSecond = release; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(admitted, false);
    assert.equal(store.revision, 1);
    releaseFirst(); releaseFirst = undefined; await waiting; releaseSecond(); releaseSecond = undefined;
    await store.flush();
    const saves = await Promise.allSettled([store.save({ routers: [first], revision: 1 }), store.save({ routers: [second], revision: 1 })]);
    assert.equal(saves[0].status, 'fulfilled'); assert.equal(saves[1].status, 'rejected');
    const disk = JSON.parse(await fs.readFile(path.join(home, 'model-routers/global-v2.json'), 'utf8'));
    assert.equal(disk.revision, 2); assert.equal(disk.routers[0].id, 'first');
    assert.equal(Object.keys(disk.assignments).length, 2);
  } finally {
    releaseFirst?.(); releaseSecond?.();
    if (previous === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = previous;
    resetMinnowHomeCache(); await fs.rm(home, { recursive: true, force: true });
  }
});

test('migration retains more than one former workspace limit of pools and disambiguates pre-suffixed names', async () => {
  const previous = process.env.MINNOW_HOME;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-pool-many-'));
  process.env.MINNOW_HOME = home; resetMinnowHomeCache();
  try {
    const directory = path.join(home, 'model-routers'); await fs.mkdir(directory);
    for (const [scopeId, offset] of [['a', 0], ['b', 100]]) {
      const routers = Array.from({ length: 100 }, (_, index) => ({ ...pool(`model-${offset + index}`), id: `pool-${offset + index}`, name: index === 1 ? 'Coding (2)' : 'Coding' }));
      await fs.writeFile(path.join(directory, `${scopeId.repeat(64)}.json`), JSON.stringify({ routers }));
    }
    const store = await getRouterWorkspace();
    assert.equal(store.routers.length, 200);
    assert.equal(new Set(store.routers.map((row) => row.name)).size, 200);
    await store.save({ routers: store.routers, revision: store.revision });
  } finally {
    if (previous === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = previous;
    resetMinnowHomeCache(); await fs.rm(home, { recursive: true, force: true });
  }
});
