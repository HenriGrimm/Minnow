import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { test } from 'node:test';
import { invalidateNativePolicyBeforeWrite, invalidateNativeProviderBeforeWrite, subscribeNativePolicyChanges } from '../../server/chats/native-policy-monitor.js';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-native-watch-')));
  const home = path.join(root, 'home'), cwd = path.join(root, 'workspace');
  await fs.mkdir(home); await fs.mkdir(cwd);
  const watches = []; let invalidations = 0;
  const dispose = subscribeNativePolicyChanges({ home, cwd,
    onInvalidate() { invalidations++; }, watchPath(root, options, change) {
      const emitter = new EventEmitter(); emitter.close = () => emitter.emit('close');
      watches.push({ root, options, change, emitter }); return emitter;
    } });
  t.after(async () => { dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { watches, cwd, dispose, get invalidations() { return invalidations; } };
}

test('native admissions invalidate synchronously before policy writes, but not transcript or preference-only saves', async t => {
  const f = await fixture(t);
  for (const key of ['sessions/state.json', 'providers/codex-cli/profile.json', 'issues/state.json']) invalidateNativePolicyBeforeWrite(key);
  assert.equal(f.invalidations, 0);
  invalidateNativePolicyBeforeWrite('tools.json');
  assert.equal(f.invalidations, 1);
  invalidateNativePolicyBeforeWrite('config.json'); assert.equal(f.invalidations, 1, 'revocation is irreversible for this admission');
});

test('provider preference changes preserve active admissions but provider disable revokes before commit', async t => {
  const f = await fixture(t);
  const before = { enabled: true, agentCli: { kind: 'codex', nativeCodingTools: false, maxConcurrent: 1 } };
  invalidateNativeProviderBeforeWrite(before, { ...before, updatedAt: 'later', agentCli: { ...before.agentCli, nativeCodingTools: true, maxConcurrent: 2 } });
  assert.equal(f.invalidations, 0);
  invalidateNativeProviderBeforeWrite(before, { ...before, enabled: false });
  assert.equal(f.invalidations, 1);
});

test('external policy edits, replaced checkout and watcher loss invalidate; ordinary native files do not', async t => {
  for (const cause of ['policy', 'checkout', 'error', 'close']) {
    const f = await fixture(t);
    f.watches[0].change('change', 'sessions/sessions.db-wal');
    f.watches[0].change('change', 'tmp/codex-app-server/native/rollout.jsonl');
    f.watches[0].change('change', 'providers/codex-cli/profile.json');
    assert.equal(f.invalidations, 0);
    if (cause === 'policy') f.watches[0].change('rename', 'work-agents/builder/agent.full.md');
    if (cause === 'checkout') {
      await fs.rename(f.cwd, f.cwd + '-old');
      f.watches[1].change('rename', 'workspace');
    }
    if (cause === 'error') f.watches[0].emitter.emit('error', Error('watcher failed'));
    if (cause === 'close') f.watches[0].emitter.emit('close');
    assert.equal(f.invalidations, 1, cause);
    f.dispose(); invalidateNativePolicyBeforeWrite('tools.json'); assert.equal(f.invalidations, 1);
  }
});

test('unsupported monitoring fails closed and removes its synchronous subscription', () => {
  let calls = 0;
  assert.throws(() => subscribeNativePolicyChanges({ home: '.', cwd: path.resolve('fixture'), onInvalidate() { calls++; },
    watchPath() { throw Error('unsupported'); } }), /cannot monitor/);
  invalidateNativePolicyBeforeWrite('config.json'); assert.equal(calls, 0);
});

test('real filesystem monitoring ignores native workspace/SQLite writes and observes external policy edits', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-native-monitor-')));
  const home = path.join(root, 'home'), cwd = path.join(root, 'workspace');
  await fs.mkdir(home); await fs.mkdir(cwd);
  let invalidations = 0;
  const dispose = subscribeNativePolicyChanges({ home, cwd, onInvalidate: () => { invalidations++; } });
  t.after(async () => { dispose(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  await fs.mkdir(path.join(home, 'sessions'));
  await fs.writeFile(path.join(home, 'sessions', 'sessions.db'), 'fixture database');
  await fs.writeFile(path.join(cwd, 'native.txt'), 'fixture write');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(invalidations, 0);
  await fs.writeFile(path.join(home, 'tools.json'), '{}');
  const deadline = Date.now() + 2000;
  while (!invalidations && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(invalidations, 1);
});

async function targetedFixture(t, { directories = ['mcp', 'plugins', 'prompts', 'tools', 'providers'], watchFailure } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-targeted-native-monitor-')));
  const home = path.join(root, 'home'), cwd = path.join(root, 'workspace');
  await fs.mkdir(home); await fs.mkdir(cwd);
  for (const name of directories) await fs.mkdir(path.join(home, name), { recursive: true });
  const watches = []; let invalidations = 0, dispose;
  t.after(async () => { dispose?.(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  const subscribe = (patch = {}) => subscribeNativePolicyChanges({ home, cwd,
    onInvalidate() { invalidations++; }, watchPath(file, options, change) {
      if (watchFailure?.(file, options)) throw new Error('Fixture watch unsupported');
      const emitter = new EventEmitter(); emitter.close = () => { emitter.closed = true; emitter.emit('close'); };
      watches.push({ root: file, options, change, emitter }); return emitter;
    }, ...patch });
  dispose = subscribe();
  return { root, home, cwd, watches, subscribe, dispose, get invalidations() { return invalidations; } };
}

test('recursive monitoring covers only existing policy roots, not the full home or SQLite/rollouts', async t => {
  const f = await targetedFixture(t, { directories: ['mcp', 'plugins', 'prompts', 'tools', 'providers', 'sessions', 'tmp'] });
  const recursive = f.watches.filter(row => row.options.recursive).map(row => path.relative(f.home, row.root)).sort();
  assert.deepEqual(recursive, ['mcp', 'plugins', 'prompts', 'providers', 'tools']);
  const home = f.watches.find(row => row.root === f.home);
  assert.notEqual(home.options.recursive, true);
  assert.equal(f.watches.filter(row => row.root === f.root).length, 1, 'Home and checkout share one identity-parent watch.');
  home.change('change', 'sessions'); home.change('change', 'tmp');
  assert.equal(f.invalidations, 0);
  f.watches.find(row => row.root === path.join(f.home, 'prompts')).change('change', 'work-agents/builder/agent.full.md');
  assert.equal(f.invalidations, 1);
});

test('a policy directory created after admission invalidates before it can silently acquire unmonitored descendants', async t => {
  const f = await targetedFixture(t, { directories: [] });
  const home = f.watches.find(row => row.root === f.home);
  home.change('rename', 'agent-packs'); home.change('change', 'agent-packs');
  assert.equal(f.invalidations, 1);
});

test('targeted watcher errors and home/checkout replacement irreversibly invalidate each admission', async t => {
  for (const cause of ['error', 'close', 'home', 'checkout', 'null']) {
    await t.test(cause, async t => {
      const f = await targetedFixture(t);
      const policy = f.watches.find(row => row.root === path.join(f.home, 'plugins'));
      const parent = f.watches.find(row => row.root === f.root);
      if (cause === 'error') policy.emitter.emit('error', new Error('lost coverage'));
      if (cause === 'close') policy.emitter.emit('close');
      if (cause === 'home') { await fs.rename(f.home, f.home + '-old'); parent.change('rename', 'home'); }
      if (cause === 'checkout') { await fs.rename(f.cwd, f.cwd + '-old'); parent.change('rename', 'workspace'); }
      if (cause === 'null') policy.change('change', null);
      assert.equal(f.invalidations, 1);
      invalidateNativePolicyBeforeWrite('tools.json');
      assert.equal(f.invalidations, 1);
    });
  }
});

test('unavailable targeted coverage fails a new admission and closes every partially installed watcher', async t => {
  const f = await targetedFixture(t);
  f.dispose();
  const before = f.watches.length;
  assert.throws(() => f.subscribe({ watchPath(file, options, change) {
    if (options.recursive) throw new Error('No recursive watch available.');
    const emitter = new EventEmitter(); emitter.close = () => { emitter.closed = true; emitter.emit('close'); };
    f.watches.push({ root: file, options, change, emitter }); return emitter;
  } }), /cannot monitor/);
  assert.ok(f.watches.slice(before).every(row => row.emitter.closed));
  invalidateNativePolicyBeforeWrite('config.json');
  assert.equal(f.invalidations, 0);
});

test('policy source categories revoke synchronously, including legacy tool and pack definitions', async t => {
  for (const key of ['config.json', 'tools.json', 'sub-agents.json', 'work-agents.json', 'mcp.json',
    'mcp/servers/scope.json', 'plugins/index.json', 'tools/legacy/manifest.json', 'agent-packs/installed.json',
    'profiles/custom.json', 'providers/codex-cli/secrets.json']) {
    const f = await fixture(t);
    invalidateNativePolicyBeforeWrite(key);
    assert.equal(f.invalidations, 1, key);
    f.dispose();
  }
});

test('external policy revoke/regrant events never restore an already invalidated admission', async t => {
  const f = await targetedFixture(t);
  const home = f.watches.find(row => row.root === f.home);
  home.change('change', 'tools.json');
  home.change('change', 'tools.json');
  assert.equal(f.invalidations, 1);
});

test('provider directory replacement invalidates instead of relying on a stale profile-file watch', async t => {
  const f = await targetedFixture(t);
  f.dispose();
  await fs.mkdir(path.join(f.home, 'providers', 'codex-cli'));
  await fs.writeFile(path.join(f.home, 'providers', 'codex-cli', 'profile.json'), JSON.stringify({ enabled: true, agentCli: { kind: 'codex' } }));
  const dispose = f.subscribe({ providerId: 'codex-cli' }); t.after(dispose);
  const providers = f.watches.find(row => row.root === path.join(f.home, 'providers') && !row.emitter.closed);
  providers.change('rename', 'codex-cli');
  assert.equal(f.invalidations, 1);
});

test('a coalesced external provider revoke/regrant retires authority even when the final profile is unchanged', async t => {
  const f = await targetedFixture(t);
  f.dispose();
  const dir = path.join(f.home, 'providers', 'codex-cli');
  await fs.mkdir(dir);
  const file = path.join(dir, 'profile.json');
  const original = JSON.stringify({ enabled: true, agentCli: { kind: 'codex' } });
  await fs.writeFile(file, original);
  const dispose = f.subscribe({ providerId: 'codex-cli' }); t.after(dispose);
  await fs.writeFile(file, JSON.stringify({ enabled: false }));
  await fs.writeFile(file, original);
  const providers = f.watches.find(row => row.root === path.join(f.home, 'providers') && !row.emitter.closed);
  providers.change('change', 'codex-cli/profile.json');
  assert.equal(f.invalidations, 1);
});

test('raw MCP and plugin writers invalidate before committing a revocation', async t => {
  const { readFileSync } = await import('node:fs');
  const { setMcpServerEnabled, reloadMcp } = await import('../../server/mcp/registry.js');
  const { managePackage } = await import('../../server/plugins/manager.js');
  const { resetMinnowHomeCache } = await import('../../server/config/home.js');
  const f = await targetedFixture(t); f.dispose();
  const previousHome = process.env.MINNOW_HOME;
  process.env.MINNOW_HOME = f.home; resetMinnowHomeCache();
  t.after(async () => {
    await reloadMcp();
    if (previousHome === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = previousHome;
    resetMinnowHomeCache();
  });
  await fs.mkdir(path.join(f.home, 'mcp', 'servers'));
  const mcpFile = path.join(f.home, 'mcp', 'servers', 'fixture.json');
  await fs.writeFile(mcpFile, JSON.stringify({ id: 'fixture', enabled: true, transport: { type: 'stdio', command: 'unused' } }));
  await fs.writeFile(path.join(f.home, 'mcp.json'), JSON.stringify({ servers: { fixture: { enabled: true, configFile: 'servers/fixture.json' } } }));
  const pluginFile = path.join(f.home, 'plugins', 'registry.json');
  await fs.writeFile(pluginFile, JSON.stringify({ version: 1, revision: 1, plugins: { fixture: { manifest: { id: 'fixture' }, enabled: true } } }));
  for (const [file, mutate] of [[mcpFile, () => setMcpServerEnabled('fixture', false)],
    [pluginFile, () => managePackage({ id: 'fixture', action: 'disable' })]]) {
    const observed = [];
    const dispose = f.subscribe({ onInvalidate() { observed.push(JSON.parse(readFileSync(file, 'utf8'))); } });
    try {
      await mutate();
      assert.equal(observed.length, 1);
      assert.equal(file === mcpFile ? observed[0].enabled : observed[0].plugins.fixture.enabled, true);
      const current = JSON.parse(await fs.readFile(file, 'utf8'));
      assert.equal(file === mcpFile ? current.enabled : current.plugins.fixture.enabled, false);
    } finally { dispose(); }
  }
});

test('policy directory junctions and watcher loss during setup cannot admit new native authority', async t => {
  const f = await targetedFixture(t, { directories: [] });
  f.dispose();
  const external = path.join(f.root, 'external'); await fs.mkdir(external);
  await fs.symlink(external, path.join(f.home, 'mcp'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => f.subscribe(), /cannot monitor/);
  await fs.rm(path.join(f.home, 'mcp'));
  assert.throws(() => f.subscribe({ watchPath() {
    const watcher = new EventEmitter(); watcher.close = () => watcher.emit('close');
    const on = watcher.on.bind(watcher);
    watcher.on = (event, callback) => { on(event, callback); if (event === 'error') callback(Error('coverage lost during setup')); return watcher; };
    return watcher;
  } }), /cannot monitor/);
  assert.equal(f.invalidations, 1);
  invalidateNativePolicyBeforeWrite('tools.json'); assert.equal(f.invalidations, 1);
});

test('the actual config writer invalidates before replacing the previous policy file', async t => {
  const { readFileSync } = await import('node:fs');
  const { writeConfigJson } = await import('../../server/config/store.js');
  const { resetMinnowHomeCache } = await import('../../server/config/home.js');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-policy-before-write-')));
  const home = path.join(root, 'home'), cwd = path.join(root, 'workspace'); await fs.mkdir(cwd);
  const previousHome = process.env.MINNOW_HOME;
  process.env.MINNOW_HOME = home; resetMinnowHomeCache();
  let dispose;
  t.after(async () => {
    dispose?.();
    if (previousHome === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = previousHome;
    resetMinnowHomeCache(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  await writeConfigJson('tools.json', { marker: 'before' });
  const atInvalidation = [];
  dispose = subscribeNativePolicyChanges({ home, cwd,
    onInvalidate() { atInvalidation.push(JSON.parse(readFileSync(path.join(home, 'tools.json'), 'utf8'))); },
    watchPath() { const watcher = new EventEmitter(); watcher.close = () => watcher.emit('close'); return watcher; } });
  await writeConfigJson('tools.json', { marker: 'after' });
  assert.deepEqual(atInvalidation, [{ marker: 'before' }]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(home, 'tools.json'), 'utf8')), { marker: 'after' });
});
