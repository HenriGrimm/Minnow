import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSessionsSchema } from '../../server/config/sessions-schema.js';
import { createChatRepository } from '../../server/chats/repository.js';
import { createChatCheckpointCoordinator } from '../../server/chats/checkpoints.js';
import { canonicalWorktreeMutationKey, withCoordinatedWorktreeMutation, withWorktreeMutation } from '../../server/git/action-run-lock.js';
import { executeServerTool } from '../../server/runtime/tools-middleware.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { openWorkspace, closeWorkspace } from '../../server/workspace/open-workspaces.js';

const gate = () => Promise.withResolvers();
async function fixture(t, capture) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-chat-checkpoint-'));
  const db = new Database(':memory:'); initSessionsSchema(db);
  const repository = createChatRepository({ db });
  t.after(async () => { db.close(); await fs.rm(cwd, { recursive: true, force: true, maxRetries: 5 }); });
  const coordinator = createChatCheckpointCoordinator({ repository, capture });
  async function prepare(id, signal) {
    repository.createChat({ id, name: id, workspacePath: cwd });
    const fence = repository.claimExecution({ chatId: id, executionId: id, ownerId: 'host' });
    return coordinator.prepare({ chatId: id, executionId: id, cwd, fence, signal });
  }
  return { cwd, db, repository, coordinator, prepare };
}

test('slow baseline overlaps model work but no mutation starts before it is durable', async t => {
  const capturing = gate(), release = gate(); let captures = 0, effects = 0;
  const f = await fixture(t, async () => { if (++captures === 1) { capturing.resolve(); await release.promise; } return { ok: true, sha: String(captures) }; });
  const turn = await f.prepare('first');
  await capturing.promise;
  let modelStarted = false;
  const model = Promise.resolve().then(() => { modelStarted = true; }); await model;
  const effect = turn.effect('write-1', async () => { effects++; return 'saved'; });
  assert.equal(modelStarted, true); assert.equal(effects, 0);
  release.resolve(); assert.equal(await effect, 'saved');
  await turn.finalize();
  assert.equal(f.coordinator.read('first', 'write-1').state, 'settled');
  assert.equal(captures, 3);
});

test('Stop releases a baseline waiter without admitting a write or cancelling another capture', async t => {
  const started = gate(), release = gate(); let effects = 0;
  const f = await fixture(t, async () => { started.resolve(); await release.promise; return { ok: true, sha: 's' }; });
  const stop = new AbortController(), turn = await f.prepare('first', stop.signal);
  await started.promise;
  const effect = turn.effect('never-started', async () => { effects++; });
  const finalizing = turn.finalize();
  stop.abort();
  await assert.rejects(effect, { name: 'AbortError' });
  await assert.rejects(finalizing, { name: 'AbortError' });
  assert.equal(effects, 0);
  release.resolve(); await turn.baseline;
});

test('Stop after a complete pre/effect/post receipt finalizes without inventing uncertainty', async t => {
  const f = await fixture(t, async () => ({ ok: true, sha: 'saved' }));
  const stop = new AbortController(), turn = await f.prepare('first', stop.signal);
  await turn.effect('saved-write', async () => 'done'); stop.abort();
  await turn.finalize();
  assert.equal(f.coordinator.read('first', 'saved-write').state, 'settled');
});

test('two chats serialize complete pre/effect/post segments, while parent waits hold no checkout lock', async t => {
  let disk = 0; const observations = [];
  const f = await fixture(t, async () => { observations.push(disk); return { ok: true, sha: 'snapshot-' + disk }; });
  const parent = await f.prepare('parent'), child = await f.prepare('child');
  await Promise.all([parent.baseline, child.baseline]);
  await parent.effect('parent-first', async () => { disk++; });
  // This is a causal wait, not a filesystem mutation. The child must be able to run.
  await child.effect('child-write', async () => { disk++; });
  await Promise.all([parent.effect('parent-second', async () => { disk++; }), child.effect('child-second', async () => { disk++; })]);
  assert.deepEqual(observations.slice(2), [0, 1, 1, 2, 2, 3, 3, 4]);
  assert.equal(f.coordinator.read('parent', 'parent-second').pre.sha, 'snapshot-2');
  await Promise.all([parent.finalize(), child.finalize()]);
});

test('failed post capture retains uncertainty and blocks another chat from mutating or replaying it', async t => {
  let captures = 0, effects = 0;
  const f = await fixture(t, async () => ++captures === 3 ? { ok: false, error: 'disk unavailable' } : { ok: true, sha: 's' + captures });
  const first = await f.prepare('first');
  await assert.rejects(first.effect('uncertain-write', async () => { effects++; }), error => error.checkpointUncertain === true);
  assert.equal(f.coordinator.read('first', 'uncertain-write').state, 'uncertain');
  const next = await f.prepare('next');
  await assert.rejects(next.effect('another-write', async () => { effects++; }), /explicit recovery/);
  assert.equal(effects, 1);
});

test('restart converts an executing journal to uncertainty without replaying effects', async t => {
  const f = await fixture(t, async () => ({ ok: true, sha: 'baseline' }));
  const turn = await f.prepare('first'); await turn.baseline;
  f.db.prepare("INSERT INTO chat_workspace_checkpoints SELECT execution_id,'interrupted',chat_id,workspace_key,'executing','{}' FROM chat_workspace_checkpoints LIMIT 1").run();
  f.coordinator.recoverInterrupted();
  assert.equal(f.coordinator.read('first', 'interrupted').state, 'uncertain');
  const next = await f.prepare('next'); await assert.rejects(next.baseline, /explicit recovery/);
});

test('explicit human retirement includes checkpoint evidence and releases the reviewed uncertain boundary', async t => {
  let captures = 0;
  const f = await fixture(t, async () => ++captures === 3 ? { ok: false, error: 'disk unavailable' } : { ok: true, sha: 's' + captures });
  const turn = await f.prepare('first');
  await assert.rejects(turn.effect('effect', async () => 'finished'), /reconciliation/);
  const fence = f.repository.getLease('first');
  f.repository.updateExecution('first', { status: 'recovery_required' }, { fence });
  f.repository.recoverExecution('first', { fence, quiescence: { verified: true, source: 'test-quiescent', checkedAt: Date.now() } });
  const review = f.repository.inspectRecovery('first');
  assert.equal(review.checkpoints[0].checkpointId, 'effect');
  assert.equal(review.checkpoints[0].pre.sha, 's2');
  f.repository.retireInterruptedExecution('first', { executionId: 'first', revision: review.revision,
    clientRequestId: 'human-review', note: 'Verified the saved file and stopped its process.' }, () => true);
  assert.equal(f.coordinator.read('first', 'effect').state, 'retired');
  const next = await f.prepare('next'); await next.baseline;
  assert.equal(await next.effect('new', async () => 'new work'), 'new work');
});

test('checkout mutation lock is reentrant for guarded Git helpers and abortable without breaking FIFO', async t => {
  const f = await fixture(t, async () => ({ ok: true, sha: 'unused' }));
  const started = gate(), release = gate(); const order = [];
  const first = withCoordinatedWorktreeMutation(f.cwd, async () => { started.resolve(); await release.promise; await withWorktreeMutation(f.cwd, async () => order.push(1)); });
  await started.promise;
  const stop = new AbortController();
  const cancelled = withCoordinatedWorktreeMutation(f.cwd, async () => order.push(2), { signal: stop.signal });
  const third = withCoordinatedWorktreeMutation(f.cwd, async () => order.push(3));
  stop.abort(); await assert.rejects(cancelled, { name: 'AbortError' });
  assert.deepEqual(order, []); release.resolve(); await Promise.all([first, third]);
  assert.deepEqual(order, [1, 3]);
});

test('repository subdirectory chats share the checkout boundary; linked checkouts remain distinct', async t => {
  const f = await fixture(t, async () => ({ ok: true, sha: 'unused' }));
  await fs.mkdir(path.join(f.cwd, '.git'));
  const nested = path.join(f.cwd, 'nested'); await fs.mkdir(nested);
  assert.equal(canonicalWorktreeMutationKey(nested), canonicalWorktreeMutationKey(f.cwd));
  const linked = path.join(nested, 'linked'); await fs.mkdir(linked);
  await fs.writeFile(path.join(linked, '.git'), 'gitdir: fixture');
  assert.notEqual(canonicalWorktreeMutationKey(linked), canonicalWorktreeMutationKey(f.cwd));
  let inside = false;
  await withCoordinatedWorktreeMutation(f.cwd, () => withWorktreeMutation(nested, async () => { inside = true; }));
  assert.equal(inside, true);
});

test('a legacy renderer file mutation cannot run inside a server checkpoint boundary', async t => {
  const f = await fixture(t, async () => ({ ok: true, sha: 'unused' }));
  const previousHome = process.env.MINNOW_HOME;
  process.env.MINNOW_HOME = path.join(f.cwd, 'fixture-home'); resetMinnowHomeCache(); openWorkspace(f.cwd);
  t.after(() => { closeWorkspace(f.cwd); if (previousHome === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = previousHome; resetMinnowHomeCache(); });
  const started = gate(), release = gate();
  const boundary = withCoordinatedWorktreeMutation(f.cwd, async () => { started.resolve(); await release.promise; });
  await started.promise;
  const writing = executeServerTool('save_file', { path: 'legacy.txt', content: 'saved after checkpoint' },
    { workspaceRoot: f.cwd, filesystemAccessCeiling: 'workspace' });
  await new Promise(resolve => setTimeout(resolve, 20));
  await assert.rejects(fs.access(path.join(f.cwd, 'legacy.txt')), { code: 'ENOENT' });
  release.resolve(); await boundary;
  assert.doesNotMatch((await writing).result, /^Error:/);
  assert.equal(await fs.readFile(path.join(f.cwd, 'legacy.txt'), 'utf8'), 'saved after checkpoint');
});
