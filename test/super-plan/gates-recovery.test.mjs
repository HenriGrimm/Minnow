import assert from 'node:assert/strict';
import { test } from 'node:test';
import { derive, normalizeAddressed } from '../../server/super-plan/derive.js';
import { plan } from '../../server/super-plan/plan.js';
import { createJournaledAsk, answerJournaledGate } from '../../server/super-plan/ask-bridge.js';
const initial = [
  { type: 'run.created', runId: 'gate-test', prompt: 'test', config: { interview: false } },
  { type: 'run.started' },
  { type: 'stage.started', stage: 'gate', attemptId: 'gate-1', seedKind: 'spec' },
];
function memoryEngine(events) {
  return { getState: () => derive(events), append: async (rows) => { events.push(...rows); } };
}
test('gate is durable before delivery; answering unblocks the awaiting runner', async () => {
  const events = [...initial];
  const engine = memoryEngine(events);
  const ask = createJournaledAsk({ engine, runId: 'gate-test', attemptId: 'gate-1', deliver: () => assert.equal(engine.getState().gate.gateId, 'gate-1:1') });
  const pending = ask({ kind: 'spec', question: 'Confirm?' });
  await Promise.resolve();
  await answerJournaledGate({ engine, runId: 'gate-test', gateId: 'gate-1:1', answer: 'confirm' });
  assert.equal(await pending, 'confirm');
  assert.equal(engine.getState().stage, 'research');
});
test('a gate reaped after crash is re-asked and a late answer cannot advance it', () => {
  const journal = [...initial, { type: 'gate.opened', kind: 'spec', gateId: 'gate-1:1', attemptId: 'gate-1' }, { type: 'stage.ended', stage: 'gate', attemptId: 'gate-1', outcome: 'crashed' }];
  assert.deepEqual(plan(derive(journal)), [{ taskId: 'gate-test', role: 'gate', seedKind: 'spec' }]);
  const state = derive([...journal, { type: 'gate.answered', kind: 'spec', verdict: 'confirm', gateId: 'gate-1:1', attemptId: 'gate-1' }]);
  assert.equal(state.pendingGate, 'spec');
  assert.equal(state.stage, null);
});
test('pausing while a gate is open does not turn an aborted ask into a terminal run', async () => {
  const events = [...initial];
  const engine = memoryEngine(events);
  const controller = new AbortController();
  const pending = createJournaledAsk({ engine, runId: 'gate-test', attemptId: 'gate-1', deliver: () => {} })({ kind: 'spec', question: 'Confirm?' }, { signal: controller.signal });
  await Promise.resolve();
  await engine.append([{ type: 'run.stopped', reason: 'paused' }]);
  controller.abort();
  assert.match(await pending, /Error:/);
  assert.equal(engine.getState().finished, false);
});
test('draft finding claims normalize without introducing impure or undefined state', () => {
  assert.deepEqual(normalizeAddressed({ findingIds: ['a', 'a'], dispositions: { a: 'fixed' } }), { findingIds: ['a'], dispositions: { a: 'fixed' } });
});

test('automatic polish uses saved draft UI evidence before successful draft advancement', () => {
  const base = [{ type: 'run.created', runId: 'auto', prompt: 'Update storage', config: { interview: false, research: false, reviewRounds: 0, polish: 'auto' } }, { type: 'run.started' }, { type: 'gate.opened', kind: 'spec' }, { type: 'gate.answered', kind: 'spec', verdict: 'confirm' }, { type: 'stage.started', stage: 'draft', attemptId: 'd' }];
  const end = { type: 'stage.ended', stage: 'draft', attemptId: 'd', outcome: 'ok' };
  assert.equal(derive([...base, { type: 'plan.written', path: 'documentation/plans/a.md', involvesUi: true }, end]).stage, 'polish');
  assert.equal(derive([...base, { type: 'plan.written', path: 'documentation/plans/a.md', involvesUi: false }, end]).pendingGate, 'accept');
});
