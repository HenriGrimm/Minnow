import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BATCH_REPEAT, BATCH_STREAK, createRoundShapeGuard } from '../../server/runner/round-shape.js';

test('single-call lookup rounds earn a batching nudge, then a sparser repeat', () => {
  const guard = createRoundShapeGuard({ batching: true });
  /** @type {number[]} */
  const nudged = [];
  for (let round = 1; round <= 30; round++) {
    if (guard.note(['read_file'], round)) nudged.push(round);
  }
  assert.deepEqual(nudged, [BATCH_STREAK, BATCH_STREAK + BATCH_REPEAT, BATCH_STREAK + 2 * BATCH_REPEAT]);
});

test('a batched round or an edit resets the streak', () => {
  const guard = createRoundShapeGuard({ batching: true });
  for (let round = 1; round < BATCH_STREAK; round++) assert.equal(guard.note(['grep'], round), null);
  assert.equal(guard.note(['read_file', 'grep'], BATCH_STREAK), null);
  for (let round = 1; round < BATCH_STREAK; round++) assert.equal(guard.note(['execute_command'], round), null);
  assert.equal(guard.note(['apply_patch'], BATCH_STREAK), null);
  for (let round = 1; round < BATCH_STREAK; round++) assert.equal(guard.note(['read_file'], round), null);
  assert.match(guard.note(['execute_command'], BATCH_STREAK), /batching checkpoint/);
});

test('verdict checkpoints ask, then insist every ten rounds', () => {
  const guard = createRoundShapeGuard({ verdictRounds: 30 });
  /** @type {Record<number, string>} */
  const notes = {};
  for (let round = 1; round <= 70; round++) {
    const note = guard.note(['read_file', 'grep'], round);
    if (note) notes[round] = note;
  }
  assert.deepEqual(Object.keys(notes).map(Number), [30, 45, 55, 65]);
  assert.match(notes[30], /Run only the remaining checks/);
  assert.match(notes[45], /Call report_outcome now/);
});

test('off by default', () => {
  const guard = createRoundShapeGuard();
  for (let round = 1; round <= 100; round++) assert.equal(guard.note(['read_file'], round), null);
});
