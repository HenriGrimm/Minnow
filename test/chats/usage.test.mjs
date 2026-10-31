import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { initSessionsSchema } from '../../server/config/sessions-schema.js';
import { createChatRepository } from '../../server/chats/repository.js';
import { createChatUsage } from '../../server/chats/usage.js';
import { sumSessionLedgerTotals } from '../../server/usage/ledger.js';

const turn = { providerId: 'pool', modelId: 'requested', streamMeta: { usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }, t0: 0, tFirst: 100, tEnd: 1000 };
function fixture(t) {
  const scratch = mkdtempSync(join(tmpdir(), 'minnow-usage-')), filename = join(scratch, 'sessions.db');
  let db, repository, usage, pricingReads = 0;
  function open() {
    db = new Database(filename); db.pragma('foreign_keys=ON'); initSessionsSchema(db);
    repository = createChatRepository({ db, now: () => 1000 });
    for (const id of ['parent', 'child']) if (!db.prepare('SELECT 1 FROM chats WHERE id=?').get(id)) repository.createChat({ id, name: id, modeId: 'build', agentTypeId: 'researcher' });
    usage = createChatUsage({ repository, now: () => 1000, readProviderPricing: async providerId => {
      assert.equal(providerId, 'actual'); pricingReads++; return { models: { resolved: { inputPer1M: 1, outputPer1M: 2 } } };
    } });
  }
  open(); const fence = repository.claimExecution({ chatId: 'child', executionId: 'execution', ownerId: 'host', runId: 'task', captured: {
    modelSelection: { providerId: 'minnow-router', modelId: 'requested-pool' } } });
  t.after(() => { if (db.open) db.close(); rmSync(scratch, { recursive: true, force: true }); });
  return { get db() { return db; }, get repository() { return repository; }, get usage() { return usage; }, fence,
    get pricingReads() { return pricingReads; }, reopen() { db.close(); open(); },
    input(index = 0, extra = {}) { return { executionId: 'execution', fence, roundIndex: index, turn,
      modelSelection: { providerId: 'actual', modelId: 'resolved' }, ...extra }; } };
}

test('usage receipts persist actual per-round model attribution on the child and never double count the parent', async t => {
  const f = fixture(t); const first = await f.usage.recordRound(f.input());
  assert.equal(first.replayed, false); assert.equal(first.entry.providerId, 'actual'); assert.equal(first.entry.modelId, 'resolved');
  assert.equal(first.entry.source.runId, 'task'); assert.equal(first.entry.source.subAgentType, 'researcher');
  assert.equal(first.entry.costUsd, 0.0002);
  assert.equal((await f.usage.recordRound(f.input())).replayed, true); assert.equal(f.pricingReads, 1);
  const native = { ...turn, streamMeta: { ...turn.streamMeta, minnow_cli: { cost_usd: 0.125 } } };
  await f.usage.recordRound(f.input(1, { turn: native }));
  const child = f.repository.getChat('child'), parent = f.repository.getChat('parent');
  assert.equal(parent.tokenLedger, undefined); assert.equal(child.tokenLedger.entries.length, 2);
  assert.equal(sumSessionLedgerTotals([parent, child]).totalTokens, 300);
  assert.equal(sumSessionLedgerTotals([parent, child]).costUsd, 0.1252);
  const activity = f.repository.getActivity('child');
  assert.equal(activity.agentExecution.modelSelection.providerId, 'minnow-router');
  assert.deepEqual(activity.agentExecution.resolvedModel, { providerId: 'actual', modelId: 'resolved' });
  f.reopen(); assert.equal(f.usage.nextRoundIndex('execution'), 2);
  assert.equal((await f.usage.recordRound(f.input())).entry.id, first.entry.id);
  assert.equal(f.repository.getChat('child').tokenLedger.totals.completionCount, 2);
  await assert.rejects(f.usage.recordRound(f.input(0, { turn: { ...turn, streamMeta: { usage: { total_tokens: 999 } } } })), error => error.code === 'idempotency_conflict');
});

test('usage receipt and ledger rollup commit atomically and a lost post-commit acknowledgement replays exactly once', async t => {
  const f = fixture(t);
  f.db.exec("CREATE TRIGGER usage_fail BEFORE UPDATE OF meta_json ON chats WHEN NEW.id='child' BEGIN SELECT RAISE(FAIL,'Injected ledger failure'); END");
  await assert.rejects(f.usage.recordRound(f.input()), /Injected ledger failure/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM chat_usage_receipts').get().n, 0);
  assert.equal(f.repository.getChat('child').tokenLedger, undefined);
  f.db.exec('DROP TRIGGER usage_fail');
  const atomic = f.repository.atomic; let lost = true;
  f.repository.atomic = work => { const result = atomic(work); if (lost) { lost = false; throw new Error('Lost usage ACK'); } return result; };
  await assert.rejects(f.usage.recordRound(f.input()), /Lost usage ACK/);
  f.repository.atomic = atomic;
  const replay = await f.usage.recordRound(f.input()); assert.equal(replay.replayed, true);
  assert.equal(f.repository.getChat('child').tokenLedger.totals.completionCount, 1);
  f.repository.updateExecution('execution', { status: 'completed' }, { fence: f.fence }); f.repository.releaseLease('child', f.fence);
  await assert.rejects(f.usage.recordRound(f.input(1)), error => error.code === 'ownership_conflict');
});

test('empty usage creates no invented completion and invalid token counts do not corrupt canonical totals', async t => {
  const f = fixture(t);
  assert.equal(await f.usage.recordRound(f.input(0, { turn: { ...turn, streamMeta: {} } })), null);
  assert.equal(f.repository.getChat('child').tokenLedger, undefined);
  await assert.rejects(f.usage.recordRound(f.input(0, { turn: { ...turn, streamMeta: { usage: { prompt_tokens: -1, completion_tokens: 5 } } } })), error => error.code === 'invalid_request');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM chat_usage_receipts').get().n, 0);
});
