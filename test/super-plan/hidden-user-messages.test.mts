/**
 * Stage prompts from the retired in-renderer Super Plan controller stay in old
 * sessions' history but hide from the transcript.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isSuperPlanPipelineUserMessage } from '../../src/chat/super-plan/hidden-user-messages.ts';

describe('super plan hidden user messages', () => {
  test('stamped rows are treated as pipeline prompts', () => {
    assert.equal(
      isSuperPlanPipelineUserMessage({ role: 'user', content: 'Grill stage.', superPlanStage: 'grill' }),
      true,
    );
  });

  test('legacy rows without a stamp match the pipeline prefix', () => {
    assert.equal(
      isSuperPlanPipelineUserMessage({
        role: 'user',
        content: 'Super Plan pipeline — **Build spec stage**.\nWrite the build specification…',
      }),
      true,
    );
  });

  test('normal user rows are not hidden', () => {
    assert.equal(
      isSuperPlanPipelineUserMessage({
        role: 'user',
        content: 'lets make a three.js website for a drone service company',
      }),
      false,
    );
  });

  test('leaked multimodal content does not throw trimStart', () => {
    assert.equal(
      isSuperPlanPipelineUserMessage({
        role: 'user',
        content: [{ type: 'text', text: 'lets make a three.js website' }],
      } as never),
      false,
    );
  });
});
