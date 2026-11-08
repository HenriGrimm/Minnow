/**
 * Hidden transcript user rows (sub-agent resume, Super Plan pipeline, etc.).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  hiddenTranscriptUserMessage,
  isHiddenTranscriptUserMessage,
  isSubAgentResumeUserMessage,
} from '../../src/chat/hidden-transcript-user-messages.ts';
import { buildSubAgentParentResumeMessage } from '../../src/agents/sub-agent-resume-message.ts';
import type { SubAgentRun } from '../../src/agents/types.ts';

describe('hidden transcript user messages', () => {
  test('isSubAgentResumeUserMessage matches completion and check-in prefixes', () => {
    const completion = buildSubAgentParentResumeMessage('completion', [
      {
        runId: '11111111-1111-1111-1111-111111111111',
        type: 'generalPurpose',
        task: 'scan',
        status: 'completed',
        parentChatId: '22222222-2222-2222-2222-222222222222',
        parentToolCallId: null,
        parentTurnId: null,
        summary: 'done',
        structuredOutcome: null,
        budgetEvents: [],
        error: null,
        startedAt: null,
        endedAt: null,
        toolTurns: 0,
        cancelled: false,
        messages: [],
      } satisfies SubAgentRun,
    ]);
    assert.equal(
      isSubAgentResumeUserMessage({ role: 'user', content: completion }),
      true,
    );
    assert.equal(
      isSubAgentResumeUserMessage({
        role: 'user',
        content: '[Sub-agent check-in] Sub-agent `explore` has run 120s and has not finished yet.',
      }),
      true,
    );
    assert.equal(
      isSubAgentResumeUserMessage({ role: 'user', content: 'Hello there' }),
      false,
    );
  });

  test('hiddenFromTranscript flag hides programmatic resume rows', () => {
    const row = hiddenTranscriptUserMessage('internal resume');
    assert.equal(isHiddenTranscriptUserMessage(row), true);
  });

  test('system delegation results hide by provenance without depending on their content', () => {
    for (const content of ['A completed review.', '[Sub-agent finished] Saved results.']) {
      assert.equal(isHiddenTranscriptUserMessage({ role: 'user', content,
        provenance: { version: 1, actor: 'system', source: 'task_delivery', kind: 'delegation_result' } }), true);
      assert.equal(isHiddenTranscriptUserMessage({ role: 'user', content,
        provenance: { version: 1, actor: 'agent', source: 'agent_tool', kind: 'peer_message' } }), false);
    }
  });

  test('legacy sub-agent rows without hiddenFromTranscript still hide via prefix', () => {
    assert.equal(
      isHiddenTranscriptUserMessage({
        role: 'user',
        content: '[Sub-agent finished] One sub-agent run completed.',
      }),
      true,
    );
  });

  test('leaked multimodal user content does not throw on load', () => {
    const partsRow = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'Check the UI' }],
    };
    assert.equal(isSubAgentResumeUserMessage(partsRow as never), false);
    assert.equal(isHiddenTranscriptUserMessage(partsRow as never), false);
  });

  test('leaked tool screenshot follow-ups stay hidden from the transcript', () => {
    assert.equal(
      isHiddenTranscriptUserMessage({
        role: 'user',
        content: [
          { type: 'text', text: '[tool screenshot] Visual result of the preceding tool call.' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,aaa' } },
        ],
        toolImageFollowUp: true,
      } as never),
      true,
    );
  });
});
