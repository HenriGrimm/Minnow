import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BoardState } from '../../server/orchestrator/core/types.d.ts';
import { boardUsage, roundSpeed } from '../../src/orchestrator/board-usage.ts';

const stateWith = (...attempts: Record<string, unknown>[]): BoardState => ({
  tasks: new Map([['A', { attempts }]]),
} as unknown as BoardState);

test('board metrics combine completed attempts and exclude synthetic merge work', () => {
  const state = stateWith(
    { attemptId: 'a', role: 'builder', ended: true, usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 }, speed: { tokens: 20, seconds: 1 } },
    { attemptId: 'b', role: 'tester', ended: true, usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }, speed: { tokens: 10, seconds: 2 } },
    { attemptId: 'c', role: 'builder', ended: false },
    { attemptId: 'merge#A#1', role: 'merge', ended: false },
  );
  assert.deepEqual(boardUsage(state), {
    usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
    stats: { tokens_per_second: 10 },
    measured: 2,
    active: 1,
  });
});

test('live round usage is keyed by round and replaced by final attempt usage', () => {
  const rounds = new Map([['a', new Map([
    [0, { usage: { prompt_tokens: 20, completion_tokens: 10 }, stats: { tokens_per_second: 10, generation_time: 1 } }],
    [1, { usage: { prompt_tokens: 30, completion_tokens: 20 }, stats: { tokens_per_second: 20, generation_time: 1 } }],
  ])]]);
  const active = stateWith({ attemptId: 'a', role: 'builder', ended: false });
  assert.deepEqual(boardUsage(active, rounds), {
    usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
    stats: { tokens_per_second: 15 },
    measured: 2,
    active: 1,
  });
  const ended = stateWith({ attemptId: 'a', role: 'builder', ended: true,
    usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
    speed: { tokens: 30, seconds: 2 } });
  assert.deepEqual(boardUsage(ended, rounds), {
    usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
    stats: { tokens_per_second: 15 },
    measured: 1,
    active: 0,
  });
});

test('partial provider counts remain unknown across the board', () => {
  const state = stateWith(
    { attemptId: 'a', role: 'builder', ended: true, usage: { prompt_tokens: 20 } },
    { attemptId: 'b', role: 'tester', ended: true, usage: { total_tokens: 40 } },
  );
  assert.deepEqual(boardUsage(state), { usage: {}, stats: {}, measured: 2, active: 0 });
});

test('round speed uses generation time and excludes hidden reasoning from timing fallback', () => {
  assert.deepEqual(roundSpeed({ usage: { completion_tokens: 100 }, stats: { tokens_per_second: 20, generation_time: 2 } }),
    { tokens: 40, seconds: 2 });
  assert.deepEqual(roundSpeed({ usage: { completion_tokens: 10 }, tFirst: 100, tEnd: 1100 }),
    { tokens: 10, seconds: 1 });
  assert.equal(roundSpeed({ usage: { completion_tokens: 10, completion_tokens_details: { reasoning_tokens: 5 } }, tFirst: 100, tEnd: 1100 }), null);
});

test('board metrics never reuse another chat when no attempt reports usage', () => {
  const state = stateWith({ attemptId: 'a', role: 'builder', ended: false });
  assert.deepEqual(boardUsage(state), { usage: {}, stats: {}, measured: 0, active: 1 });
});
