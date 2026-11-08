import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEmptyChatObject } from '../../src/state/sessions.ts';
import {
  buildFollowupSuggestionMessages,
  followupSuggestionReply,
  sanitizeFollowupSuggestion,
} from '../../src/chat/followup-suggestion.ts';

test('only completed assistant prose seeds a suggestion', () => {
  const chat = createEmptyChatObject('model');
  assert.equal(followupSuggestionReply(chat), null);
  chat.history = [{ role: 'user', content: 'Fix the bug' }];
  assert.equal(followupSuggestionReply(chat), null);
  const reply = { role: 'assistant' as const, content: 'Fixed and tested.' };
  chat.history.push(reply);
  assert.equal(followupSuggestionReply(chat), reply);
  for (const flag of ['stopped', 'failed', 'truncated'] as const) {
    chat.history[1] = { ...reply, [flag]: true };
    assert.equal(followupSuggestionReply(chat), null, flag);
  }
  chat.history[1] = { ...reply, tool_calls: [] };
  assert.equal(followupSuggestionReply(chat), null);
  chat.history[1] = { ...reply, content: '  ' };
  assert.equal(followupSuggestionReply(chat), null);
});

test('canonical completion takes precedence over an older legacy run and rejects incomplete executions', () => {
  const chat = createEmptyChatObject('model');
  const reply = { role: 'assistant' as const, content: 'Finished the new managed turn.' };
  chat.history = [{ role: 'user', content: 'Continue' }, reply];
  chat.runs = [{ runId: 'old', branchId: 'old', forkHistoryIndex: 0, status: 'failed', createdAt: 1 }];
  chat.chatCommandVersion = 1;
  chat.agentExecution = { executionId: 'current', status: 'completed' };
  assert.equal(followupSuggestionReply(chat), reply);
  for (const status of ['running', 'waiting_for_input', 'failed', 'stopped', 'recovery_required']) {
    chat.agentExecution.status = status;
    assert.equal(followupSuggestionReply(chat), null, status);
  }
});

test('prompt excludes tool results, hidden prompts, injections and reasoning, and bounds context', () => {
  const chat = createEmptyChatObject('model');
  chat.history = [
    { role: 'user', content: 'Old request' },
    { role: 'user', content: 'Hidden instruction', hiddenFromTranscript: true },
    { role: 'assistant', content: 'Tool rationale', tool_calls: [] },
    { role: 'tool', content: 'Secret tool output', tool_call_id: 'call' },
    ...Array.from({ length: 8 }, (_, index) => ({ role: 'user' as const, content: `${index}: ${'x'.repeat(5000)}` })),
    { role: 'assistant', content: 'Fixed the parser.', thinking: ['Private reasoning'] },
  ];
  const messages = buildFollowupSuggestionMessages(chat);
  const context = JSON.parse(messages[1].content as string);
  assert.equal(context.length, 6);
  assert.ok(context.every((row: { text: string }) => row.text.length <= 4000));
  assert.equal(context.at(-1).text, 'Fixed the parser.');
  assert.doesNotMatch(messages[1].content as string, /Old request|Hidden instruction|Tool rationale|Secret tool output|Private reasoning/);
  assert.match(messages[0].content as string, /USER/);
  assert.match(messages[0].content as string, /consent/);
});

test('suggestion parser accepts plain user text and rejects empty, oversized or structured output', () => {
  assert.equal(sanitizeFollowupSuggestion('  Show me the diff.  '), 'Show me the diff.');
  assert.equal(sanitizeFollowupSuggestion('“Can you add a regression test?”'), 'Can you add a regression test?');
  for (const text of ['', 'NONE', 'null', 'x'.repeat(241), 'One\nTwo', '```json\n{}\n```', '/git-commit', '* Apply it', '1. Apply it', 'User: Apply it']) {
    assert.equal(sanitizeFollowupSuggestion(text), null, text);
  }
});
