import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProgressBudget } from '../../server/runner/progress-budget.js';
import { createRunnerTiming } from '../../server/runner/timing.js';
import { resolveContextBudget } from '../../server/runner/context-budget.js';
import { normalizeContextCompactionConfig } from '../../server/config/validators.js';
import { normalizeChatRow } from '../../src/state/session-schema.mjs';

test('working-context settings and local chat timings survive normalization', () => {
  assert.deepEqual(normalizeContextCompactionConfig({ workingContextTokens: 0 }), { workingContextTokens: 0 });
  assert.deepEqual(normalizeContextCompactionConfig({ workingContextTokens: 96000 }), { workingContextTokens: 96000 });
  assert.equal(normalizeContextCompactionConfig({ workingContextTokens: -1 }), undefined);
  const runnerTiming = { startedAt: 1, events: [], totals: { turn: { count: 1, durationMs: 100 } }, dropped: 0 };
  assert.deepEqual(normalizeChatRow({ id: 'timing-chat', messages: [], runnerTiming }).runnerTiming, runnerTiming);
});

test('changed arguments/results do not bypass the build investigation checkpoint', () => {
  const budget = createProgressBudget(true, 12);
  for (let i = 0; i < 11; i++) assert.equal(budget.note('browser_eval', { content: `observation ${i}` }), null);
  assert.match(budget.note('read_file', { content: 'new file' }), /12\/12/);
  assert.throws(() => budget.check(), /investigation budget/);
  for (let i = 0; i < 3; i++) assert.doesNotThrow(() => budget.check(['apply_patch']));
  assert.throws(() => budget.check(['apply_patch']));
  budget.note('apply_patch', { content: 'ok', codeChange: { additions: 1, deletions: 1 } });
  assert.doesNotThrow(() => budget.check());
});
test('failed or no-op edits do not reset; read-only runs are unrestricted', () => {
  const budget = createProgressBudget(true, 12);
  for (let i = 0; i < 12; i++) budget.note('apply_patch', { content: 'Error: mismatch', codeChange: { additions: 1 } });
  assert.throws(() => budget.check());
  budget.reset();
  assert.doesNotThrow(() => budget.check());
  const review = createProgressBudget(false);
  for (let i = 0; i < 100; i++) review.note('read_file', { content: 'file' });
  assert.doesNotThrow(() => review.check());
});
test('working budget never changes reported capacity or overrides smaller physical limits', () => {
  assert.equal(resolveContextBudget({ modelLimit: 1_000_000, reservedTokens: 4000 }).effectiveLimit, 60000);
  assert.equal(resolveContextBudget({ modelLimit: 1_000_000 }).modelLimit, 1_000_000);
  assert.equal(resolveContextBudget({ modelLimit: 8192 }).effectiveLimit, Math.floor(8192 * 0.9));
  assert.equal(resolveContextBudget({ modelLimit: 1_000_000, effectiveLimitOverride: 100000 }).effectiveLimit, 64000);
  assert.equal(resolveContextBudget({ modelLimit: 1_000_000, effectiveLimitOverride: 12000 }).effectiveLimit, 12000);
  assert.equal(resolveContextBudget({ modelLimit: 1_000_000, agentConfig: { workingContextTokens: 0 } }).effectiveLimit, 900000);
  assert.equal(resolveContextBudget({ modelLimit: null }).effectiveLimit, 64000);
});
test('timings use monotonic durations and never need request or tool payloads', () => {
  let time = 10;
  const events = [];
  const timing = createRunnerTiming(event => events.push(event), () => time, () => 1000);
  const start = timing.start(); time = 35;
  timing.end('tool', start, { name: 'read_file', id: 'call' });
  assert.deepEqual(events, [{ type: 'runner_timing', startedAt: 1000, at: 1000, stage: 'tool', durationMs: 25, name: 'read_file', id: 'call' }]);
});
