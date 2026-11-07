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
import { closeCodexSession, codexSessionStats, checkpointCodexSession, dirtyCodexSession } from '../../server/generations/codex-app-server/manager.js';

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

test('duplicate Codex checkpoints share verification, later checkpoints re-read, and dirty epochs cannot become clean', async () => {
  const session = { providerId: 'fixture', chatId: 'codex-coalesce', threadId: 'thread', signature: 'same',
    cacheDir: cliCacheDir('fixture', 'codex-coalesce'), accepted: [{ role: 'user', content: 'Hello' }] };
  let reads = 0, finish;
  session.rpc = { request: async (method, params, options) => {
    reads++;
    assert.equal(method, 'thread/read');
    assert.equal(params.includeTurns, true);
    assert.equal(options.timeoutMs, 2000);
    return new Promise(resolve => { finish = resolve; });
  } };
  const first = checkpointCodexSession(session), duplicate = checkpointCodexSession(session);
  assert.equal(first, duplicate);
  await Promise.resolve();
  finish({ thread: { turns: [{ id: 'one' }] } });
  await Promise.all([first, duplicate]);
  assert.equal(reads, 1);
  assert.equal(session.clean, true);
  const stale = checkpointCodexSession(session);
  await Promise.resolve();
  await dirtyCodexSession(session);
  finish({ thread: { turns: [{ id: 'stale' }] } });
  await assert.rejects(stale, /superseded/);
  assert.equal(reads, 2);
  assert.equal(session.clean, false);
  assert.equal((await readCliCheckpoint('fixture', session.chatId)).clean, false);
  const retry = checkpointCodexSession(session);
  await Promise.resolve();
  finish({ thread: { turns: [{ id: 'fresh' }] } });
  await retry;
  assert.equal(reads, 3);
  assert.equal(session.clean, true);
});

test('Codex checkpoint failures/closed sessions never claim a verified clean state', async () => {
  const session = { providerId: 'fixture', chatId: 'codex-failure', threadId: 'thread', signature: 'same',
    cacheDir: cliCacheDir('fixture', 'codex-failure'), accepted: [], clean: true,
    rpc: { request: async () => { throw new Error('Fixture RPC deadline'); } } };
  await assert.rejects(checkpointCodexSession(session), /deadline/);
  assert.equal(session.clean, false);
  assert.equal(session.checkpointRead, null);
  session.rpc.request = async () => { session.closed = true; return { thread: { turns: [] } }; };
  await assert.rejects(checkpointCodexSession(session), /closed/);
  assert.equal(session.clean, false);
  assert.equal(await readCliCheckpoint('fixture', session.chatId), null);
});

test('large Codex histories retain full digest verification while four concurrent checkpoints read once', async t => {
  const turns = Array.from({ length: 10_000 }, (_, index) => ({ id: `turn-${index}`, status: 'completed',
    items: [{ type: 'agentMessage', text: `Synthetic response ${index}: ${'x'.repeat(200)}` }] }));
  const session = { providerId: 'fixture', chatId: 'codex-large', threadId: 'thread', signature: 'same',
    cacheDir: cliCacheDir('fixture', 'codex-large'), accepted: [{ role: 'user', content: 'Synthetic context' }] };
  let reads = 0;
  session.rpc = { request: async () => { reads++; await new Promise(resolve => setTimeout(resolve, 20)); return { thread: { turns } }; } };
  await Promise.all(Array.from({ length: 4 }, () => checkpointCodexSession(session)));
  assert.equal(reads, 1);
  assert.equal((await readCliCheckpoint('fixture', session.chatId)).nativeDigest, cliHash(turns));
  turns[5000].items[0].text = 'Changed native history';
  await checkpointCodexSession(session);
  assert.equal(reads, 2, 'later checkpoints must not reuse a stat-only history digest');
  assert.equal((await readCliCheckpoint('fixture', session.chatId)).nativeDigest, cliHash(turns));
  for (const value of Object.values(session.checkpointTimings)) assert.ok(Number.isFinite(value) && value >= 0);
  t.diagnostic(JSON.stringify({ turns: turns.length, bytes: Buffer.byteLength(JSON.stringify(turns)),
    concurrentRequests: 4, sharedReads: 1, laterReads: reads, timings: session.checkpointTimings }));
});

test('unused caches expire after thirty days and cleanup rejects paths outside the cache root', async () => {
  const dir = cliCacheDir('fixture', 'expired');
  await queueCliCheckpoint({ cacheDir: dir }, { providerId: 'fixture', chatId: 'expired', clean: false });
  const old = new Date(Date.now() - 31 * 86400000); await fs.utimes(path.join(dir, 'checkpoint.json'), old, old);
  await pruneCliCaches(); await assert.rejects(fs.access(dir));
  const outside = path.join(root, 'retained'); await fs.mkdir(outside);
  await assert.rejects(removeCliCache(outside), /escaped its private root/); await fs.access(outside);
});

test('unsupported native histories cannot become clean and their recovery receipts do not expire', async () => {
  const session = { providerId: 'fixture', chatId: 'native-uncertain', threadId: 'thread', signature: 'same',
    cacheDir: cliCacheDir('fixture', 'native-uncertain'), accepted: [{ role: 'user', content: 'Start' }], clean: true,
    rpc: { request: async () => ({ thread: { turns: [{ items: [{ type: 'commandExecution', command: 'not retained in receipt' }] }] } }) } };
  await assert.rejects(checkpointCodexSession(session), error => error.cliNativeRecoveryRequired === true);
  assert.equal(session.clean, false);
  assert.equal(session.nativeRecoveryRequired, true);
  await assert.rejects(checkpointCodexSession(session), /Recovery required/);
  const saved = await readCliCheckpoint('fixture', session.chatId);
  assert.equal(saved.clean, false);
  assert.equal(saved.nativeRecoveryRequired, true);
  assert.equal(JSON.stringify(saved).includes('not retained in receipt'), false);
  const file = path.join(session.cacheDir, 'checkpoint.json');
  const old = Date.now() - 31 * 86400000;
  await fs.writeFile(file, JSON.stringify({ ...saved, updatedAt: old }));
  await fs.utimes(file, new Date(old), new Date(old));
  await pruneCliCaches();
  assert.equal((await readCliCheckpoint('fixture', session.chatId)).nativeRecoveryRequired, true);
});

test('quarantined homes retain native evidence but cannot copy credentials back to the source', async () => {
  const home = path.join(root, 'quarantined-native'); await fs.mkdir(home);
  await fs.writeFile(path.join(home, 'auth.json'), 'fixture changed credential');
  await fs.writeFile(path.join(home, 'rollout.json'), 'fixture evidence');
  let synced = false;
  const session = { key: 'quarantined-auth', home, homeRoot: root, nativeRecoveryRequired: true, clean: false,
    syncAuth: async () => { synced = true; } };
  await closeCodexSession(session);
  assert.equal(synced, false);
  await assert.rejects(fs.access(path.join(home, 'auth.json')));
  assert.equal(await fs.readFile(path.join(home, 'rollout.json'), 'utf8'), 'fixture evidence');
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
