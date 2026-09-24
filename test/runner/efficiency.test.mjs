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

test('investigation checkpoints continue through an edit', () => {
  const budget = createProgressBudget(true, 12);
  for (let i = 0; i < 11; i++) budget.note('read_file', { content: `observation ${i}` });
  assert.match(budget.note('read_file', { content: 'new file' }), /12\/12/);
  for (let i = 0; i < 12; i++) budget.note('read_file', { content: `another observation ${i}` });
  assert.equal(budget.note('read_file', { content: 'more evidence' }), null);
  budget.note('apply_patch', { content: 'ok', codeChange: { additions: 1, deletions: 1 } });
  assert.equal(budget.note('read_file', { content: 'follow-up' }), null);
});
test('failed or no-op edits do not reset; read-only runs are unrestricted', () => {
  const budget = createProgressBudget(true, 12);
  for (let i = 0; i < 12; i++) budget.note('apply_patch', { content: 'Error: mismatch', codeChange: { additions: 1 } });
  assert.equal(budget.note('read_file', { content: 'still investigating' }), null);
  budget.reset();
  assert.equal(budget.note('read_file', { content: 'new attempt' }), null);
  const review = createProgressBudget(false);
  for (let i = 0; i < 100; i++) review.note('read_file', { content: 'file' });
  assert.equal(review.note('read_file', { content: 'file' }), null);
});
test('browser probes receive advice without being denied', () => {
  const budget = createProgressBudget(true);
  for (let i = 0; i < 15; i++) budget.note('browser_eval', { content: `probe ${i}` });
  assert.match(budget.note('browser_eval', { content: 'probe 16' }), /16 browser calls/);
  budget.note('apply_patch', { content: 'ok', codeChange: { additions: 2 } });
  assert.equal(budget.note('browser_eval', { content: 'new probe' }), null);
  for (let i = 0; i < 2; i++) budget.note('browser_eval', { content: 'Error: invalid expression' });
  assert.match(budget.note('browser_eval', { content: 'Error: invalid expression' }), /3 consecutive failures/);
  const review = createProgressBudget(false);
  for (let i = 0; i < 30; i++) assert.equal(review.note('browser_eval', { content: 'probe' }), null);
});

test('model window sets the default ceiling and an explicit cap can lower it', () => {
  assert.equal(resolveContextBudget({ modelLimit: 1_000_000, reservedTokens: 4000 }).effectiveLimit, 996000);
  assert.equal(resolveContextBudget({ modelLimit: 1_000_000 }).modelLimit, 1_000_000);
  assert.equal(resolveContextBudget({ modelLimit: 8192 }).effectiveLimit, 8192);
  assert.equal(resolveContextBudget({ modelLimit: 1_000_000, effectiveLimitOverride: 100000 }).effectiveLimit, 100000);
  assert.equal(resolveContextBudget({ modelLimit: 1_000_000, effectiveLimitOverride: 12000 }).effectiveLimit, 12000);
  assert.equal(resolveContextBudget({ modelLimit: 1_000_000, agentConfig: { workingContextTokens: 0 } }).effectiveLimit, 1_000_000);
  assert.equal(resolveContextBudget({ modelLimit: 1_000_000, reservedTokens: 4000, agentConfig: { workingContextTokens: 160_000 } }).effectiveLimit, 156000);
  assert.equal(resolveContextBudget({ modelLimit: 8192, agentConfig: { workingContextTokens: 160_000 } }).effectiveLimit, 8192);
  assert.equal(resolveContextBudget({ modelLimit: null }).effectiveLimit, null);
  assert.equal(resolveContextBudget({ modelLimit: null, agentConfig: { workingContextTokens: 160_000 } }).effectiveLimit, 160000);
});
test('timings use monotonic durations and never need request or tool payloads', () => {
  let time = 10;
  const events = [];
  const timing = createRunnerTiming(event => events.push(event), () => time, () => 1000);
  const start = timing.start(); time = 35;
  timing.end('tool', start, { name: 'read_file', id: 'call' });
  assert.deepEqual(events, [{ type: 'runner_timing', startedAt: 1000, at: 1000, stage: 'tool', durationMs: 25, name: 'read_file', id: 'call' }]);
});
