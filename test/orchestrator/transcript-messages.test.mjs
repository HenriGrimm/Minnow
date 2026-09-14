/**
 * TurnEvent JSONL → API-message mapper used by the sub-agent drawer
 * and continue-seed hydrate. Pure: no I/O.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  applyTurnEventToMessages,
  countToolCalls,
  turnEventsToMessages,
} from '../../server/orchestrator/transcript-messages.js';

describe('turnEventsToMessages', () => {
  test('maps tool_call + tool_result + round_end onto API messages', () => {
    const messages = turnEventsToMessages([
      { type: 'delta', text: 'ignored' },
      { type: 'phase', phase: 'tools' },
      {
        type: 'tool_call',
        name: 'read_file',
        id: 'call_read',
        arguments: { path: 'src/a.ts' },
      },
      { type: 'tool_result', id: 'call_read', content: 'export const a = 1;' },
      { type: 'round_end', text: 'Here is what I found in src/.' },
    ]);
    assert.equal(messages.length, 3);
    assert.equal(messages[0].role, 'assistant');
    assert.equal(messages[0].tool_calls[0].id, 'call_read');
    assert.equal(messages[0].tool_calls[0].function.name, 'read_file');
    assert.equal(messages[1].role, 'tool');
    assert.equal(messages[1].tool_call_id, 'call_read');
    assert.equal(messages[1].content, 'export const a = 1;');
    assert.equal(messages[2].role, 'assistant');
    assert.equal(messages[2].content, 'Here is what I found in src/.');
    assert.equal(countToolCalls(messages), 1);
  });

  test('skips high-frequency types and empty round_end', () => {
    const messages = turnEventsToMessages([
      { type: 'delta', text: 'tok' },
      { type: 'round_end', text: '   ' },
    ]);
    assert.deepEqual(messages, []);
  });

  test('maps coalesced thinking onto assistant reasoning', () => {
    const messages = turnEventsToMessages([
      { type: 'thinking', text: 'I should look at src/ next.' },
    ]);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'assistant');
    assert.equal(messages[0].reasoning, 'I should look at src/ next.');
  });

  test('keeps post-tool thinking after tools (chronological Activity order)', () => {
    const messages = turnEventsToMessages([
      { type: 'thinking', text: 'Let me list the top-level entries.' },
      {
        type: 'tool_call',
        name: 'list_directory',
        id: 'call_list',
        arguments: { path: '.' },
      },
      { type: 'tool_result', id: 'call_list', content: 'agents\nsrc\npackage.json' },
      {
        type: 'thinking',
        text: 'The task is complete. Reply with sub-agent-ok then report.',
      },
      {
        type: 'tool_call',
        name: 'report_outcome',
        id: 'call_report',
        arguments: { status: 'pass', summary: 'listed entries' },
      },
      { type: 'tool_result', id: 'call_report', content: 'ok' },
      {
        type: 'round_end',
        text: 'sub-agent-ok — Workspace contains a Node/TypeScript project.',
      },
    ]);

    assert.equal(messages.length, 7);
    assert.equal(messages[0].reasoning, 'Let me list the top-level entries.');
    assert.equal(messages[0].tool_calls, undefined);
    assert.equal(messages[1].tool_calls[0].function.name, 'list_directory');
    assert.equal(messages[2].role, 'tool');
    assert.equal(
      messages[3].reasoning,
      'The task is complete. Reply with sub-agent-ok then report.',
    );
    assert.equal(messages[3].tool_calls, undefined);
    assert.equal(messages[4].tool_calls[0].function.name, 'report_outcome');
    assert.equal(messages[5].role, 'tool');
    assert.equal(
      messages[6].content,
      'sub-agent-ok — Workspace contains a Node/TypeScript project.',
    );
  });

  test('coalesces growing thinking on the open stub only', () => {
    const messages = turnEventsToMessages([
      { type: 'thinking', text: 'Let me' },
      { type: 'thinking', text: 'Let me list the top-level entries.' },
      {
        type: 'tool_call',
        name: 'list_directory',
        id: 'call_list',
        arguments: { path: '.' },
      },
    ]);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].reasoning, 'Let me list the top-level entries.');
    assert.equal(messages[1].tool_calls[0].function.name, 'list_directory');
  });

  test('maps attempt_end summary when no later prose exists', () => {
    const messages = turnEventsToMessages([
      { type: 'thinking', text: 'file looks small' },
      {
        type: 'tool_call',
        name: 'read_file',
        id: 'call_read',
        arguments: { path: 'src/a.ts' },
      },
      { type: 'tool_result', id: 'call_read', content: 'export const a = 1;' },
      { type: 'attempt_end', name: 'pass', summary: 'Here is what I found in src/.' },
    ]);
    assert.equal(messages.length, 4);
    assert.equal(messages[0].role, 'assistant');
    assert.equal(messages[0].reasoning, 'file looks small');
    assert.equal(messages[1].role, 'assistant');
    assert.equal(messages[1].tool_calls[0].id, 'call_read');
    assert.equal(messages[2].role, 'tool');
    assert.equal(messages[3].role, 'assistant');
    assert.equal(messages[3].content, 'Here is what I found in src/.');
  });

  test('attempt_end does not overwrite existing assistant prose', () => {
    const messages = turnEventsToMessages([
      { type: 'round_end', text: 'Already wrote this.' },
      { type: 'attempt_end', name: 'pass', summary: 'ignored duplicate' },
    ]);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, 'Already wrote this.');
  });

  test('applyTurnEventToMessages is additive', () => {
    const first = applyTurnEventToMessages([], {
      type: 'tool_call',
      name: 'grep',
      id: 'call_grep',
    });
    const second = applyTurnEventToMessages(first, {
      type: 'tool_result',
      id: 'call_grep',
      content: 'no matches',
    });
    assert.equal(first.length, 1);
    assert.equal(second.length, 2);
  });

  test('context_compaction becomes a UI-only context row carrying the checkpoint', () => {
    const messages = turnEventsToMessages([
      { type: 'tool_call', name: 'read_file', id: 'c1', arguments: '{}' },
      { type: 'tool_result', id: 'c1', content: 'x' },
      {
        type: 'context_compaction',
        trigger: 'overflow',
        foldThroughRow: 7,
        elideThroughRow: null,
        droppedTurns: 2,
        droppedRounds: 1,
        elidedRows: 0,
        truncated: false,
        tokensBefore: 42000,
        tokensAfter: 9000,
        summary: '## Prior context (compacted)',
      },
      { type: 'round_end', text: 'Done.' },
    ]);
    assert.equal(messages.length, 4);
    const row = messages[2];
    assert.equal(row.role, 'context');
    assert.equal(row.droppedTurns, 2);
    assert.equal(row.droppedRounds, 1);
    assert.equal(row.compaction.version, 1);
    assert.equal(row.compaction.trigger, 'overflow');
    assert.equal(row.compaction.foldThroughIndex, 7);
    assert.equal(row.compaction.tokensAfter, 9000);
    assert.equal(row.summaryText, '## Prior context (compacted)');
    assert.equal(countToolCalls(messages), 1);
  });
});
