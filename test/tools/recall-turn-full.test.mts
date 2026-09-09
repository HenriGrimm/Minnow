/**
 * recall_turn_full — a tool-heavy turn replayed whole re-injects its tool history,
 * so tool bodies are elided and the text is windowed unless the caller opts in.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { setSessionStateForTests } from '../../src/state/sessions.ts';
import {
  reassembleTurnFromChat,
  renderTurnParts,
  toolRecallTurnFull,
} from '../../src/tools/recall-turn-full.ts';
import type { Chat, Message } from '../../src/types.ts';

const CHAT_ID = '44444444-4444-4444-4444-444444444444';

const TOOL_BODY = 'y'.repeat(5_000);

function history(): Message[] {
  return [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'looking that up' },
    { role: 'tool', tool_call_id: 'call_1', content: TOOL_BODY },
    { role: 'assistant', content: 'here is the answer' },
    { role: 'user', content: 'second question' },
    { role: 'assistant', content: 'second answer' },
  ] as Message[];
}

function makeChat(): Chat {
  return {
    id: CHAT_ID,
    name: 'Recall',
    workspacePath: '/workspace',
    modelId: 'test',
    modeId: 'build',
    history: history(),
    lastStats: null,
    modelInfo: {},
    updatedAt: 1,
  } as Chat;
}

describe('recall-turn-full', () => {
  beforeEach(() => {
    setSessionStateForTests({
      version: 2,
      activeId: CHAT_ID,
      sidebarCollapsed: false,
      chats: [makeChat()],
    });
  });

  test('reassembleTurnFromChat splits a turn into messages and tool results', () => {
    const result = reassembleTurnFromChat(makeChat(), 0);
    assert.ok(result);
    assert.equal(result.source, 'history');
    assert.equal(result.parts.filter((part) => part.kind === 'tool').length, 1);
    assert.equal(result.parts.filter((part) => part.kind === 'message').length, 3);
  });

  test('renderTurnParts elides tool bodies by default', () => {
    const parts = reassembleTurnFromChat(makeChat(), 0)!.parts;

    const elided = renderTurnParts(parts, false);
    assert.equal(elided.toolCount, 1);
    assert.equal(elided.toolChars, TOOL_BODY.length);
    assert.doesNotMatch(elided.text, /yyyy/);
    assert.match(elided.text, /\[tool call_1\] 5000 chars elided/);

    const included = renderTurnParts(parts, true);
    assert.match(included.text, /yyyy/);
  });

  test('the tool omits tool results and reports what it dropped', () => {
    const out = toolRecallTurnFull({ turnIndex: 0 });
    assert.match(out, /Turn 0 \(source: history\)/);
    assert.match(out, /1 tool result\(s\) elided \(5000 chars\)/);
    assert.match(out, /include_tool_results: true/);
    assert.match(out, /looking that up/);
    assert.doesNotMatch(out, /yyyy/);
  });

  test('include_tool_results brings the bodies back', () => {
    const out = toolRecallTurnFull({ turnIndex: 0, include_tool_results: true, max_chars: 120_000 });
    assert.match(out, /yyyy/);
    assert.match(out, /1 tool result\(s\) included/);
  });

  test('windows long output and offers the next slice', () => {
    const out = toolRecallTurnFull({
      turnIndex: 0,
      include_tool_results: true,
      max_chars: 500,
    });
    assert.match(out, /Truncated — pass offset_chars: 500/);

    const next = toolRecallTurnFull({
      turnIndex: 0,
      include_tool_results: true,
      max_chars: 500,
      offset_chars: 500,
    });
    assert.match(next, /chars 500-1000 of/);
  });

  test('rejects a bad index', () => {
    assert.match(toolRecallTurnFull({ turnIndex: -1 }), /non-negative integer/);
    assert.match(toolRecallTurnFull({ turnIndex: 9 }), /no turn found at index 9/);
  });
});
