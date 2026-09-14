/**
 * Context notice persistence.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  appendContextNoticeIfNeeded,
  contextNoticeAction,
  contextNoticeOutcome,
  recordCompactionCheckpoint,
  recordContextTrim,
} from '../../src/chat/context/context-notice.ts';
import {
  compactMessages,
  latestCompactionCheckpoint,
} from '../../server/runner/compaction/index.js';
import { applyContextBudget, resolveContextBudget } from '../../src/chat/context-budget.ts';
import { isUiOnlyTranscriptMessage } from '../../server/runner/injection-notice.js';
import { historyToApiMessagesForEstimate } from '../../src/chat/prompts/token-estimate-core.ts';
import type { ApiMessage, Chat, Message } from '../../src/types.ts';

describe('context notice', () => {
  test('contextNoticeAction and outcome format transcript row copy', () => {
    assert.equal(contextNoticeAction('compact'), 'Context compacted');
    assert.equal(contextNoticeAction('summarize'), 'Context summarized', 'rows from before v2 keep their label');
    assert.equal(contextNoticeOutcome(2), '2 turns omitted');
    assert.equal(contextNoticeOutcome(0, 'line one\nline two'), '2 line summary');
  });

  test('appendContextNoticeIfNeeded dedupes identical consecutive notices', () => {
    const chat: Chat = {
      id: 'c1',
      name: 'Test',
      history: [],
      createdAt: 1,
      updatedAt: 1,
    };
    appendContextNoticeIfNeeded(chat, {
      policy: 'summarize',
      droppedTurns: 3,
      summaryText: 'Prior work summary',
    });
    appendContextNoticeIfNeeded(chat, {
      policy: 'summarize',
      droppedTurns: 3,
      summaryText: 'Prior work summary',
    });
    assert.equal(chat.history.length, 1);
    assert.equal(chat.history[0].role, 'context');
  });

  test('recordContextTrim persists a UI-only notice and lastContextTrim after an auto trim', () => {
    const history: Message[] = [{ role: 'user', content: 'Please refactor the settings panel' }];
    const api: ApiMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Please refactor the settings panel' }];
    for (let i = 0; i < 12; i += 1) {
      const call = { id: `c${i}`, type: 'function' as const, function: { name: 'read_file', arguments: '{}' } };
      api.push({ role: 'assistant', content: null, tool_calls: [call] });
      api.push({ role: 'tool', tool_call_id: `c${i}`, content: 'export const v = 1;\n'.repeat(400) });
    }
    const trimmed = applyContextBudget(
      api,
      resolveContextBudget({ agentConfig: { enforcementPolicy: 'slide' }, modelLimit: 12_000 }),
      { enforcementPolicy: 'slide', minRecentTurns: 2 },
    );
    const chat: Chat = { id: 'c2', name: 'Trim', history, createdAt: 1, updatedAt: 1 };

    assert.equal(recordContextTrim(chat, trimmed), true);
    const notice = chat.history.at(-1);
    assert.equal(notice?.role, 'context');
    assert.ok(notice?.role === 'context' && (notice.droppedRounds ?? 0) > 0);
    assert.equal(isUiOnlyTranscriptMessage(notice!), true, 'the notice is never sent to the model');
    assert.equal(historyToApiMessagesForEstimate(chat.history).length, 1);
    assert.equal(chat.lastContextTrim?.policy, 'slide');

    assert.equal(recordContextTrim(chat, { ...trimmed, applied: false }), false);
    assert.equal(chat.history.length, 2);
    assert.match(contextNoticeOutcome(0, undefined, 3), /3 tool rounds omitted/);
  });

  test('recordCompactionCheckpoint appends a checkpoint row and never rewrites history', () => {
    const history: Message[] = [];
    for (let t = 0; t < 6; t += 1) {
      history.push({ role: 'user', content: `request ${t} `.repeat(80) });
      history.push({ role: 'assistant', content: `answer ${t} `.repeat(160) });
    }
    const before = JSON.stringify(history);
    const chat: Chat = { id: 'c3', name: 'Compact', history, createdAt: 1, updatedAt: 1 };
    const out = compactMessages({ messages: history as ApiMessage[], limit: 1500, window: 2000 });
    assert.ok(out.checkpoint);
    const notice = recordCompactionCheckpoint(chat, {
      checkpoint: out.checkpoint,
      droppedTurns: out.droppedTurns,
      droppedRounds: out.droppedRounds,
      elidedRows: out.elidedRows,
      truncated: false,
      tokensBefore: out.tokensBefore,
      tokensAfter: out.tokensAfter,
    });
    assert.equal(JSON.stringify(chat.history.slice(0, -1)), before, 'folded rows stay in history');
    assert.equal(notice.policy, 'compact');
    assert.equal(notice.compaction?.foldThroughIndex, out.checkpoint.foldThroughRow);
    assert.equal(isUiOnlyTranscriptMessage(notice), true);
    assert.equal(latestCompactionCheckpoint(chat.history)?.index, chat.history.length - 1);
    assert.equal(chat.lastContextTrim?.policy, 'compact');
  });

  test('historyToApiMessagesForEstimate skips context notices', () => {
    const api = historyToApiMessagesForEstimate([
      { role: 'user', content: 'hello' },
      {
        role: 'context',
        policy: 'summarize',
        droppedTurns: 2,
        summaryText: 'hidden',
        createdAt: 1,
      },
      { role: 'assistant', content: 'hi' },
    ]);
    assert.deepEqual(
      api.map((m) => m.role),
      ['user', 'assistant'],
    );
  });
});
