import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { EventEmitter } from 'node:events';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { readConfigJson, writeConfigJson } from '../../server/config/store.js';
import { getPluginToolDefinitions, getPluginToolCatalog, callPluginTool, reloadPlugins } from '../../server/tools/loader.js';
import { getPluginCatalogRevision, subscribePluginCatalogChanges } from '../../server/plugins/catalog.js';
import { handlePluginsRequest } from '../../server/tools/middleware.js';
import { scaffoldPackage } from '../../server/plugins/authoring.js';
import { managePackage, connectionSettings } from '../../server/plugins/manager.js';
import { runWithToolContext } from '../../server/runtime/path-access.js';

let temp, home;
const previousHome = process.env.MINNOW_HOME;
const tick = () => new Promise(resolve => setTimeout(resolve, 60));
before(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-plugin-catalog-'));
  home = path.join(temp, 'home');
  process.env.MINNOW_HOME = home;
  resetMinnowHomeCache();
});
after(async () => {
  if (previousHome === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = previousHome;
  resetMinnowHomeCache();
  await fs.rm(temp, { recursive: true, force: true });
});

test('cold empty inventories are single-flight; unchanged rounds do zero additional scans or package registry reads', async t => {
  const readdir = fs.readdir.bind(fs), readFile = fs.readFile.bind(fs);
  let scans = 0, registries = 0;
  t.mock.method(fs, 'readdir', (...args) => { if (args[0] === path.join(home, 'tools')) scans++; return readdir(...args); });
  t.mock.method(fs, 'readFile', (...args) => { if (args[0] === path.join(home, 'plugins/registry.json')) registries++; return readFile(...args); });
  const results = await Promise.all(Array.from({ length: 12 }, () => getPluginToolDefinitions()));
  assert.ok(results.every(result => result.length === 0));
  assert.equal(scans, 1);
  assert.equal(registries, 1);
  for (let i = 0; i < 20; i++) await getPluginToolDefinitions();
  assert.equal(scans, 1);
  assert.equal(registries, 1);
});

test('discovery failures are latched and explicit reload retries once', async t => {
  await tick();
  const readFile = fs.readFile.bind(fs);
  let reads = 0;
  t.mock.method(fs, 'readFile', (...args) => {
    if (args[0] === path.join(home, 'plugins/registry.json')) { reads++; return Promise.reject(new Error('registry unavailable')); }
    return readFile(...args);
  });
  await assert.rejects(reloadPlugins(), /registry unavailable/);
  for (let i = 0; i < 10; i++) await assert.rejects(getPluginToolDefinitions(), /registry unavailable/);
  assert.equal(reads, 1);
  await assert.rejects(reloadPlugins(), /registry unavailable/);
  assert.equal(reads, 2);
});

test('package install, enable, handler reload, connections and removal publish revisions; execution rechecks policy', async () => {
  await writeConfigJson('tools.json', { enabled: {}, permissions: { default: {} }, plugins: {} });
  await runWithToolContext(async () => {
    await scaffoldPackage({ id: 'catalog', path: 'catalog' });
    let revision = getPluginCatalogRevision();
    await managePackage({ action: 'install', path: 'catalog' });
    assert.notEqual(getPluginCatalogRevision(), revision);
    const name = 'plugin__catalog__greet';
    assert.ok((await getPluginToolDefinitions()).some(t => t.function.name === name));
    revision = getPluginCatalogRevision();
    await managePackage({ action: 'disable', id: 'catalog' });
    assert.notEqual(getPluginCatalogRevision(), revision);
    assert.ok(!(await getPluginToolDefinitions()).some(t => t.function.name === name));
    assert.match(await callPluginTool(name, { name: 'Ada' }), /disabled/i);
    await managePackage({ action: 'enable', id: 'catalog' });
    const full = await readConfigJson('tools.json');
    full.permissions.default[name] = 'full';
    await writeConfigJson('tools.json', full);
    assert.ok((await getPluginToolDefinitions()).some(t => t.function.name === name));
    full.permissions.default[name] = 'off';
    await writeConfigJson('tools.json', full);
    assert.ok((await getPluginToolDefinitions()).some(t => t.function.name === name));
    assert.match(await callPluginTool(name, { name: 'Ada' }), /Hello, Ada!/);
    revision = getPluginCatalogRevision();
    await fs.writeFile(path.join(temp, 'catalog/greet.mjs'), 'export default () => "changed";');
    await managePackage({ action: 'reload', id: 'catalog' });
    assert.notEqual(getPluginCatalogRevision(), revision);
    revision = getPluginCatalogRevision();
    await connectionSettings('catalog', {});
    assert.notEqual(getPluginCatalogRevision(), revision);
    await managePackage({ action: 'remove', id: 'catalog' });
    assert.ok(!(await getPluginToolDefinitions()).some(t => t.function.name === name));
  }, { workspaceRoot: temp });
});

test('legacy handler edits invalidate discovery and a revocation during compilation prevents execution', async t => {
  await fs.cp(path.resolve('test/fixtures/plugin-tools/echo'), path.join(home, 'tools/echo'), { recursive: true });
  await reloadPlugins();
  assert.equal(await callPluginTool('plugin__echo__ping', {}), 'pong');
  const handler = path.join(home, 'tools/echo/handler.mjs');
  const changed = new Promise((resolve, reject) => {
    const stop = subscribePluginCatalogChanges(() => { clearTimeout(timer); stop(); resolve(); });
    const timer = setTimeout(() => { stop(); reject(new Error('handler watcher did not invalidate')); }, 3000);
  });
  await fs.writeFile(handler, 'export default async function handler() { return "updated"; }');
  await changed;
  await tick();
  assert.equal(await callPluginTool('plugin__echo__ping', {}), 'updated');
  await reloadPlugins();
  const readFile = fs.readFile.bind(fs);
  t.mock.method(fs, 'readFile', async (...args) => {
    const value = await readFile(...args);
    if (args[0] === handler) {
      const config = await readConfigJson('tools.json');
      config.plugins.echo = { enabled: false };
      await writeConfigJson('tools.json', config);
    }
    return value;
  });
  assert.match(await callPluginTool('plugin__echo__ping', {}), /disabled/i);
});

test('catalog API returns stable paired revisions without forcing reload; event streams snapshot and clean up', async () => {
  await tick();
  const first = await getPluginToolCatalog();
  const second = await getPluginToolCatalog();
  assert.equal(first.revision, second.revision);
  let payload;
  const response = { setHeader() {}, end(body) { payload = JSON.parse(body); } };
  await handlePluginsRequest({ method: 'GET' }, response, '/api/plugins/tools');
  assert.equal(payload.revision, first.revision, 'GET must not reload/invalidate the catalog');
  assert.deepEqual(payload.tools, first.tools);
  const res = new EventEmitter();
  const frames = [];
  res.writeHead = () => {};
  res.write = frame => frames.push(frame);
  await handlePluginsRequest({ method: 'GET' }, res, '/api/plugins/events');
  assert.match(frames[0], new RegExp(first.revision));
  const config = await readConfigJson('tools.json');
  await writeConfigJson('tools.json', config);
  assert.ok(frames.length > 1);
  res.emit('close');
  const count = frames.length;
  await reloadPlugins();
  assert.equal(frames.length, count);
});

test('an invalidation while discovery is pending discards its result and shares one trailing scan', async t => {
  await tick();
  const readdir = fs.readdir.bind(fs);
  let scans = 0, release;
  const blocked = new Promise(resolve => { release = resolve; });
  let started;
  const scanning = new Promise(resolve => { started = resolve; });
  t.mock.method(fs, 'readdir', async (...args) => {
    const result = await readdir(...args);
    if (args[0] === path.join(home, 'tools') && ++scans === 1) {
      started(); await blocked;
    }
    return result;
  });
  const initial = reloadPlugins();
  await scanning;
  const next = reloadPlugins();
  const shared = getPluginToolCatalog();
  release();
  await Promise.all([initial, next, shared]);
  assert.equal(scans, 2);
  assert.equal((await shared).revision, getPluginCatalogRevision());
});
