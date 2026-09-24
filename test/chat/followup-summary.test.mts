/**
 * MIN-206 — deterministic /followup context summary.
 */

import assert from 'node:assert/strict';
import { afterEach, before, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import {
  createEmptyChatObject,
  flushScheduledSessionSaveForTests,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import {
  MAX_FOLLOWUP_SUMMARY_CHARS,
  buildFollowupContextSummary,
} from '../../src/chat/followup/summary.ts';
import type { Chat, Message } from '../../src/types.ts';

let activeWindow: Window | undefined;

before(() => {
  const win = new Window();
  activeWindow = win;
  installHappyDomGlobals(win);
});

function makeChat(history: Message[], workspacePath = 'C:\\ws\\min-206'): Chat {
  const chat = createEmptyChatObject('m1', workspacePath);
  chat.name = 'Build the widget';
  chat.history = history;
  chat.historyLoaded = true;
  return chat;
}

afterEach(() => {
  flushScheduledSessionSaveForTests();
  setSessionStateForTests(null);
});

describe('buildFollowupContextSummary', () => {
  test('includes the chat, the user requests, and where it ended', () => {
    const chat = makeChat([
      { role: 'user', content: 'Add a widget' },
      { role: 'assistant', content: 'Added the widget' },
      { role: 'user', content: 'Now style it' },
      { role: 'assistant', content: 'Styled the widget with tokens' },
    ]);

    const summary = buildFollowupContextSummary(chat);

    assert.match(summary, /Chat: Build the widget/);
    // Workspace paths normalize to forward slashes in the chat record.
    assert.match(summary, /Workspace: C:\/ws\/min-206/);
    assert.match(summary, /User requests:\n- Add a widget\n- Now style it/);
    assert.match(summary, /Where it ended:\nStyled the widget with tokens/);
  });

  test('includes the folded summary when the transcript was compacted', () => {
    const chat = makeChat([
      {
        role: 'context',
        policy: 'compact',
        droppedTurns: 3,
        compaction: { version: 1, foldThroughIndex: 1, summary: 'FOLDED CONTEXT' },
        createdAt: 1,
      } as unknown as Message,
      { role: 'user', content: 'Carry on' },
      { role: 'assistant', content: 'Carrying on' },
    ]);

    const summary = buildFollowupContextSummary(chat);
    assert.match(summary, /Earlier context \(folded\):\nFOLDED CONTEXT/);
    assert.match(summary, /Carry on/);
  });

  test('keeps recent work when the folded checkpoint exceeds the cap', () => {
    const chat = makeChat([
      {
        role: 'context',
        policy: 'compact',
        droppedTurns: 3,
        compaction: { version: 1, foldThroughIndex: 1, summary: 'F'.repeat(9000) },
        createdAt: 1,
      } as unknown as Message,
      { role: 'user', content: 'Fix the latest regression' },
      { role: 'assistant', content: 'The regression is fixed, but tests remain' },
    ]);

    const summary = buildFollowupContextSummary(chat);
    assert.match(summary, /Fix the latest regression/);
    assert.match(summary, /The regression is fixed, but tests remain/);
    assert.ok(summary.length <= MAX_FOLLOWUP_SUMMARY_CHARS + 1);
  });

  test('truncates a long final reply', () => {
    const chat = makeChat([
      { role: 'user', content: 'Explain everything' },
      { role: 'assistant', content: 'z'.repeat(5000) },
    ]);

    const summary = buildFollowupContextSummary(chat);
    assert.ok(summary.includes(`${'z'.repeat(1200)}…`));
    assert.ok(!summary.includes('z'.repeat(1201)));
  });

  test('never exceeds the summary cap', () => {
    const history: Message[] = [];
    for (let i = 0; i < 20; i += 1) {
      history.push({ role: 'user', content: `request ${i} ${'u'.repeat(400)}` });
      history.push({ role: 'assistant', content: `reply ${i} ${'a'.repeat(1200)}` });
    }
    const summary = buildFollowupContextSummary(makeChat(history));
    assert.ok(summary.length <= MAX_FOLLOWUP_SUMMARY_CHARS + 1, `got ${summary.length}`);
  });

  test('keeps only the last six user requests', () => {
    const history: Message[] = [];
    for (let i = 1; i <= 9; i += 1) {
      history.push({ role: 'user', content: `request ${i}` });
      history.push({ role: 'assistant', content: `reply ${i}` });
    }
    const summary = buildFollowupContextSummary(makeChat(history));
    assert.ok(!summary.includes('request 1'));
    assert.ok(!summary.includes('request 3'));
    assert.ok(summary.includes('request 4'));
    assert.ok(summary.includes('request 9'));
  });

  test('lists changed files from the code-change ledger', () => {
    const chat = makeChat([
      { role: 'user', content: 'Touch a file' },
      { role: 'assistant', content: 'Done' },
      {
        role: 'tool',
        tool_call_id: 'call-1',
        content: 'ok',
        codeChange: { path: 'src/widget.ts', additions: 3, deletions: 1 },
      } as unknown as Message,
    ]);

    const summary = buildFollowupContextSummary(chat);
    assert.match(summary, /Files changed:\n- src\/widget\.ts \(\+3\/-1\)/);
  });

  test('an empty chat still returns a string', () => {
    const chat = makeChat([]);
    assert.equal(typeof buildFollowupContextSummary(chat), 'string');
    assert.match(buildFollowupContextSummary(chat), /Chat: Build the widget/);
  });
});
