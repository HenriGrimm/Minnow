import assert from 'node:assert/strict';
import { test, before, after, afterEach } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { cliHash, cliCacheDir, queueCliCheckpoint, readCliCheckpoint, checkpointMatches, pruneCliCaches, removeCliCache } from '../../server/generations/agent-cli/checkpoints.js';
import { createCliSessionPool, reserveCliProcess, retainCliSession } from '../../server/generations/agent-cli/lifecycle.js';
import { cliAccountIdentity } from '../../server/generations/agent-cli/auth-identity.js';
import { closeCodexSession, codexSessionStats } from '../../server/generations/codex-app-server/manager.js';

let root;
const previous = process.env.MINNOW_HOME, closed = [], closingA = new Set(), closingB = new Set();
const closeA = async row => { closed.push('A'); clearTimeout(row.timer); row.closed = true; poolA.delete(row.key); };
const closeB = async row => { closed.push('B'); clearTimeout(row.timer); row.closed = true; poolB.delete(row.key); };
const poolA = createCliSessionPool('fixture-A', closingA, closeA), poolB = createCliSessionPool('fixture-B', closingB, closeB);
before(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-cli-checkpoints-')); process.env.MINNOW_HOME = root; resetMinnowHomeCache(); });
afterEach(() => { for (const row of [...poolA.values(), ...poolB.values()]) clearTimeout(row.timer); poolA.clear(); poolB.clear(); closingA.clear(); closingB.clear(); closed.length = 0; });
after(async () => { if (previous == null) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = previous;
  resetMinnowHomeCache(); await fs.rm(root, { recursive: true, force: true }); });

test('checkpoint writes are ordered, atomic and independent of transient credentials', async () => {
  const providerId = 'fixture', chatId = 'atomic', session = { cacheDir: cliCacheDir(providerId, chatId), secretValues: ['transient-bridge-token'] };
  const accepted = [{ role: 'user', content: 'A' }, { role: 'assistant', content: 'B' }];
  const record = { providerId, chatId, fingerprint: 'same', clean: true, acceptedCount: 2, acceptedHash: cliHash(accepted) };
  const dirty = queueCliCheckpoint(session, { ...record, clean: false });
  const clean = queueCliCheckpoint(session, record); await Promise.all([dirty, clean]);
  const saved = await readCliCheckpoint(providerId, chatId);
  assert.equal(saved.clean, true); assert.equal(saved.version, 1);
  assert.equal(checkpointMatches(saved, 'same', [...accepted, { role: 'user', content: 'C' }]), true);
  assert.equal(checkpointMatches(saved, 'changed', [...accepted, { role: 'user', content: 'C' }]), false);
  assert.equal(checkpointMatches(saved, 'same', [...accepted, { role: 'tool', content: 'C' }]), false);
  assert.equal(checkpointMatches(saved, 'same', [{ role: 'user', content: 'Edited' }, accepted[1], { role: 'user', content: 'C' }]), false);
  const data = await fs.readFile(path.join(session.cacheDir, 'checkpoint.json'), 'utf8');
  assert.equal(data.includes('transient-bridge-token'), false);
  assert.deepEqual(await fs.readdir(session.cacheDir), ['checkpoint.json']);
});

test('unused caches expire after thirty days and cleanup rejects paths outside the cache root', async () => {
  const dir = cliCacheDir('fixture', 'expired');
  await queueCliCheckpoint({ cacheDir: dir }, { providerId: 'fixture', chatId: 'expired', clean: false });
  const old = new Date(Date.now() - 31 * 86400000); await fs.utimes(path.join(dir, 'checkpoint.json'), old, old);
  await pruneCliCaches(); await assert.rejects(fs.access(dir));
  const outside = path.join(root, 'retained'); await fs.mkdir(outside);
  await assert.rejects(removeCliCache(outside), /escaped its private root/); await fs.access(outside);
});

test('handoff recovery requires all recorded results and an unchanged accepted prefix', () => {
  const accepted = [{ role: 'user', content: 'Original request' }, { role: 'assistant', content: '', tool_calls: [
    { id: 'one', type: 'function', function: { name: 'read_file', arguments: '{}' } },
    { id: 'two', type: 'function', function: { name: 'read_file', arguments: '{}' } },
  ] }];
  const record = { clean: true, fingerprint: 'same', acceptedCount: 2, acceptedHash: cliHash(accepted), pendingCalls: ['one', 'two'] };
  const first = { role: 'tool', tool_call_id: 'one', content: 'First result' };
  const second = { role: 'tool', tool_call_id: 'two', content: 'Second result' };
  const user = { role: 'user', content: 'Continue after the crash.' };
  const matches = tail => checkpointMatches(record, 'same', [...accepted, ...tail]);
  assert.equal(matches([first, second]), true);
  assert.equal(matches([second, first, user]), true);
  assert.equal(matches([first]), false);
  assert.equal(matches([user]), false);
  assert.equal(matches([first, user, second]), false);
  assert.equal(matches([first, first, second]), false);
  assert.equal(matches([first, { ...second, tool_call_id: 'unknown' }]), false);
  assert.equal(matches([first, second, { role: 'system', content: 'Changed instructions' }]), false);
  assert.equal(checkpointMatches(record, 'changed', [...accepted, first, second]), false);
  assert.equal(checkpointMatches(record, 'same', [{ ...accepted[0], content: 'Edited' }, accepted[1], first, second]), false);
  assert.equal(matches([first, { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } }] }, second]), true);
});

test('idle eviction calls the owning adapter and preserves pending handoffs', async () => {
  for (let i = 0; i < 8; i++) poolA.set(`idle-${i}`, { key: `idle-${i}`, providerId: 'same', active: false, waiting: false, idleAt: i });
  poolB.set('pending', { key: 'pending', providerId: 'same', active: false, waiting: true });
  await reserveCliProcess(poolB, closingB, 'same', 1, closeB);
  assert.deepEqual(closed, ['A']); assert.equal(poolB.has('pending'), true); assert.equal(poolA.size, 7);
  for (let i = 8; i < 11; i++) {
    const row = { key: `idle-${i}`, providerId: 'same', active: false, waiting: false };
    poolB.set(row.key, row); retainCliSession(row, poolB, closeB);
  }
  assert.equal(poolA.size + poolB.size, 9, 'eight idle processes plus one handoff');
  assert.equal(poolB.has('pending'), true);
});

test('closing children and pending handoffs count against the process ceiling', async () => {
  for (let i = 0; i < 8; i++) poolA.set(`${i}`, { key: `${i}`, providerId: 'busy', waiting: true });
  closingB.add({ key: 'closing', providerId: 'busy', closed: true });
  await assert.rejects(reserveCliProcess(poolA, closingA, 'busy', 1, closeA), /process limit reached/);
  assert.equal(closed.length, 0);
});

test('credential refresh preserves stable account identity while sign-in changes invalidate it', () => {
  const token = sub => `header.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.signature`;
  const auth = (sub, refresh) => JSON.stringify({ tokens: { account_id: 'account', id_token: token(sub), refresh_token: refresh }, last_refresh: refresh });
  assert.equal(cliAccountIdentity(auth('one', 'old')), cliAccountIdentity(auth('one', 'new')));
  assert.notEqual(cliAccountIdentity(auth('one', 'old')), cliAccountIdentity(auth('two', 'new')));
  assert.notEqual(cliAccountIdentity('unknown-old'), cliAccountIdentity('unknown-new'));
});

test('late process exit releases its reservation and completes deferred private-home cleanup', async () => {
  const home = path.join(root, 'late-codex-child'); await fs.mkdir(home);
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null });
  const session = { key: 'late-exit', providerId: 'fixture-late', home, homeRoot: root, clean: false,
    rpc: { child, close: async () => { throw new Error('Termination not confirmed.'); } } };
  await assert.rejects(closeCodexSession(session), /Termination not confirmed/);
  await fs.access(home); assert.equal(codexSessionStats().total, 1);
  child.exitCode = 0; child.emit('close', 0);
  for (let i = 0; i < 20 && codexSessionStats().total; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(codexSessionStats().total, 0); await assert.rejects(fs.access(home));
});
