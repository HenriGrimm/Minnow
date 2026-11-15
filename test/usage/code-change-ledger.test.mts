/**
 * Per-chat code change totals ledger.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Chat } from '../../src/types.ts';
import type { SessionState } from '../../src/types.ts';
import {
  EMPTY_CODE_CHANGE_TOTALS,
  ensureCodeChangeTotals,
  formatCodeChangeTotalsText,
  getChatCodeChangeTotals,
  getPerFileChangeSummary,
  getWorkspaceCodeChangeTotals,
  hasCodeChangeTotals,
  recordCodeChange,
  recordWorkspaceCodeChange,
  resetCodeChangeTotals,
  runHadCodeChanges,
  sumChatCodeChangeTotalsForWorkspace,
} from '../../src/usage/code-change-ledger.ts';
import type { TurnRunRecord } from '../../src/types.ts';

function makeChat(): Chat {
  return {
    id: 'chat-code-ledger',
    name: 'Test',
    workspacePath: '',
    modelId: 'm1',
    history: [],
    lastStats: null,
    modelInfo: {},
    updatedAt: 1_700_000_000_000,
  };
}

describe('code-change-ledger', () => {
  test('recordCodeChange increments totals', () => {
    const chat = makeChat();
    recordCodeChange(chat, { additions: 12, deletions: 3, path: 'src/a.ts' });
    recordCodeChange(chat, { additions: 1, deletions: 0 });
    assert.deepEqual(chat.codeChangeTotals, { additions: 13, deletions: 3 });
  });

  test('skips zero stats', () => {
    const chat = makeChat();
    recordCodeChange(chat, { additions: 0, deletions: 0 });
    assert.equal(chat.codeChangeTotals, undefined);
  });

  test('canonical display totals come from each chat\'s recorded results, not stale legacy totals', () => {
    const a = { ...makeChat(), chatCommandVersion: 1 as const, codeChangeTotals: { additions: 0, deletions: 0 } };
    a.history = [{ role: 'tool', tool_call_id: 'a', content: '', codeChange: {
      additions: 7, deletions: 2, paths: ['a.ts', 'shared.ts'],
    } }];
    const b = { ...makeChat(), id: 'other', agentConversation: true } as Chat;
    b.history = [{ role: 'tool', tool_call_id: 'b', content: '', codeChange: {
      additions: 3, deletions: 1, path: 'shared.ts',
    } }];
    assert.deepEqual(getChatCodeChangeTotals(a), { additions: 7, deletions: 2 });
    assert.deepEqual(getChatCodeChangeTotals(b), { additions: 3, deletions: 1 });
    assert.deepEqual(getChatCodeChangeTotals(JSON.parse(JSON.stringify(a))), { additions: 7, deletions: 2 });
    assert.deepEqual(a.codeChangeTotals, { additions: 0, deletions: 0 });
    assert.equal(b.codeChangeTotals, undefined);
    a.history = [];
    assert.deepEqual(getChatCodeChangeTotals(a), EMPTY_CODE_CHANGE_TOTALS);
  });

  test('display totals do not read unloaded history and preserve legacy backfilled counts', () => {
    const chat = makeChat();
    chat.codeChangeTotals = { additions: 5, deletions: 1 };
    assert.deepEqual(getChatCodeChangeTotals(chat), chat.codeChangeTotals);
    chat.chatCommandVersion = 1;
    chat.historyLoaded = false;
    Object.defineProperty(chat, 'history', { get() { throw new Error('History must remain lazy'); } });
    assert.deepEqual(getChatCodeChangeTotals(chat), { additions: 5, deletions: 1 });
  });

  test('reset restores empty totals', () => {
    const chat = makeChat();
    recordCodeChange(chat, { additions: 5, deletions: 1 });
    resetCodeChangeTotals(chat);
    assert.deepEqual(chat.codeChangeTotals, EMPTY_CODE_CHANGE_TOTALS);
  });

  test('ensureCodeChangeTotals initializes object', () => {
    const chat = makeChat();
    const totals = ensureCodeChangeTotals(chat);
    assert.deepEqual(totals, EMPTY_CODE_CHANGE_TOTALS);
  });

  test('format and has helpers', () => {
    assert.equal(hasCodeChangeTotals(undefined), false);
    assert.equal(hasCodeChangeTotals({ additions: 0, deletions: 0 }), false);
    assert.equal(
      formatCodeChangeTotalsText({ additions: 10, deletions: 2 }),
      '+10 −2',
    );
    assert.equal(hasCodeChangeTotals({ additions: 1, deletions: 0 }), true);
  });

  test('recordWorkspaceCodeChange and sum across chats', () => {
    const state: SessionState = {
      version: 5,
      activeId: null,
      sidebarCollapsed: false,
      chats: [],
    };
    recordWorkspaceCodeChange(state, '/proj', { additions: 3, deletions: 1 });
    assert.deepEqual(getWorkspaceCodeChangeTotals(state, '/proj'), {
      additions: 3,
      deletions: 1,
    });

    const chatA = makeChat();
    chatA.workspacePath = '/proj';
    chatA.codeChangeTotals = { additions: 2, deletions: 0 };
    const chatB = { ...makeChat(), id: 'b', codeChangeTotals: { additions: 1, deletions: 2 } };
    chatB.workspacePath = '/proj';
    state.chats = [chatA, chatB];
    assert.deepEqual(sumChatCodeChangeTotalsForWorkspace(state, '/proj'), {
      additions: 3,
      deletions: 2,
    });
  });

  test('getPerFileChangeSummary groups by path and sorts by total changes', () => {
    const chat = makeChat();
    chat.history = [
      {
        role: 'tool',
        tool_call_id: 'tc1',
        content: 'Saved a.ts',
        codeChange: {
          additions: 4,
          deletions: 1,
          path: 'src/a.ts',
          diffLines: [{ type: 'add', text: 'line' }],
        },
      },
      {
        role: 'tool',
        tool_call_id: 'tc2',
        content: 'Saved b.ts',
        codeChange: {
          additions: 2,
          deletions: 8,
          path: 'src/b.ts',
        },
      },
      {
        role: 'tool',
        tool_call_id: 'tc3',
        content: 'Updated a.ts again',
        codeChange: {
          additions: 1,
          deletions: 0,
          path: 'src/a.ts',
        },
      },
      {
        role: 'assistant',
        content: 'done',
      },
    ];

    const summaries = getPerFileChangeSummary(chat);
    assert.equal(summaries.length, 2);
    assert.equal(summaries[0].path, 'src/b.ts');
    assert.equal(summaries[0].additions, 2);
    assert.equal(summaries[0].deletions, 8);
    assert.equal(summaries[1].path, 'src/a.ts');
    assert.equal(summaries[1].additions, 5);
    assert.equal(summaries[1].deletions, 1);
    assert.equal(summaries[1].diffChunks.length, 1);
    assert.equal(summaries[1].diffChunks[0].lines[0].text, 'line');
  });

  test('runHadCodeChanges detects tool mutations in output span', () => {
    const chat = makeChat();
    chat.history = [
      { role: 'user', content: 'edit files' },
      {
        role: 'tool',
        tool_call_id: 'tc1',
        content: 'Saved',
        codeChange: { additions: 2, deletions: 0, path: 'src/a.ts' },
      },
      { role: 'assistant', content: 'done' },
    ];
    const run: TurnRunRecord = {
      runId: 'run-1',
      branchId: 'main',
      forkHistoryIndex: 0,
      status: 'completed',
      createdAt: 1,
      snapshot: {} as TurnRunRecord['snapshot'],
      outputHistoryStart: 1,
      outputHistoryEnd: 2,
    };
    assert.equal(runHadCodeChanges(chat, run), true);

    const chatOnly = makeChat();
    chatOnly.history = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ];
    const chatOnlyRun: TurnRunRecord = {
      ...run,
      runId: 'run-2',
      outputHistoryStart: 1,
      outputHistoryEnd: 1,
    };
    assert.equal(runHadCodeChanges(chatOnly, chatOnlyRun), false);
  });

  test('getPerFileChangeSummary skips unloaded chats without reading history', () => {
    const chat = makeChat();
    chat.historyLoaded = false;
    chat.codeChangeTotals = { additions: 4, deletions: 1 };
    let historyReads = 0;
    Object.defineProperty(chat, 'history', {
      configurable: true,
      enumerable: true,
      get() {
        historyReads += 1;
        return [];
      },
    });

    assert.deepEqual(getPerFileChangeSummary(chat), []);
    assert.equal(historyReads, 0);
  });

  test('runHadCodeChanges is false while history is unloaded', () => {
    const chat = makeChat();
    chat.historyLoaded = false;
    const run: TurnRunRecord = {
      runId: 'run-unloaded',
      branchId: 'main',
      forkHistoryIndex: 0,
      status: 'completed',
      createdAt: 1,
      snapshot: {} as TurnRunRecord['snapshot'],
      outputHistoryStart: 1,
      outputHistoryEnd: 2,
    };
    let historyReads = 0;
    Object.defineProperty(chat, 'history', {
      configurable: true,
      enumerable: true,
      get() {
        historyReads += 1;
        return [];
      },
    });

    assert.equal(runHadCodeChanges(chat, run), false);
    assert.equal(historyReads, 0);
  });

  test('getPerFileChangeSummary expands paths array entries', () => {
    const chat = makeChat();
    chat.history = [
      {
        role: 'tool',
        tool_call_id: 'tc1',
        content: 'Committed',
        codeChange: {
          additions: 3,
          deletions: 2,
          paths: ['src/x.ts', 'src/y.ts'],
        },
      },
    ];

    const summaries = getPerFileChangeSummary(chat);
    assert.equal(summaries.length, 2);
    assert.deepEqual(
      summaries.map((s) => s.path).sort(),
      ['src/x.ts', 'src/y.ts'],
    );
    assert.equal(summaries[0].additions, 0);
    assert.equal(summaries[0].countsKnown, false);
    assert.equal(summaries[0].deletions, 0);
  });
});
