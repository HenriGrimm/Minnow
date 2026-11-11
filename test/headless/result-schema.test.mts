/**
 * HeadlessRunResult JSON shape and stable key ordering.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  HEADLESS_RESULT_VERSION,
  serializeHeadlessRunResult,
  type HeadlessRunResult,
} from '../../src/headless/result.ts';

const FIXTURE: HeadlessRunResult = {
  version: HEADLESS_RESULT_VERSION,
  ok: true,
  exitCode: 0,
  startedAt: '2026-05-22T12:00:00.000Z',
  finishedAt: '2026-05-22T12:00:05.000Z',
  workspace: '/tmp/ws',
  modeId: 'build',
  workAgentId: 'builder',
  providerId: 'mock-provider',
  modelId: 'mock-model',
  userPrompt: 'hello',
  assistantFinal: 'OK',
  turns: [
    {
      generationId: 'gen-1',
      finishReason: 'stop',
      assistantText: 'OK',
      toolCalls: [],
    },
  ],
  stats: { toolRounds: 1, durationMs: 5000 },
  error: null,
  chatId: null,
};

describe('HeadlessRunResult schema', () => {
  it('serializeHeadlessRunResult uses stable top-level key order', () => {
    const text = serializeHeadlessRunResult(FIXTURE);
    const keys = Object.keys(JSON.parse(text) as Record<string, unknown>);
    assert.deepEqual(keys, [
      'version',
      'ok',
      'exitCode',
      'startedAt',
      'finishedAt',
      'workspace',
      'modeId',
      'workAgentId',
      'providerId',
      'modelId',
      'userPrompt',
      'assistantFinal',
      'turns',
      'stats',
      'error',
      'chatId',
    ]);
  });

  it('includes version 1', () => {
    const parsed = JSON.parse(serializeHeadlessRunResult(FIXTURE)) as { version: number };
    assert.equal(parsed.version, 1);
  });
});
