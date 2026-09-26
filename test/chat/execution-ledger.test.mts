import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { projectExecutionLedger } from '../../src/chat/execution-ledger.ts';
import { createEmptyChatObject } from '../../src/state/sessions.ts';
import type { Chat, TurnRunRecord, TurnSnapshot } from '../../src/types.ts';

function snapshot(overrides: Partial<TurnSnapshot> = {}): TurnSnapshot {
  return {
    forkHistoryIndex: 0,
    userContent: 'Implement the ledger',
    skillId: null,
    providerId: 'local',
    modelId: 'test-model',
    temperature: 0.2,
    maxTokens: 4096,
    thinkingMode: 'off',
    modeId: 'build',
    workAgentId: 'builder',
    workAgentAuto: false,
    composedSystemPrompt: '',
    enabledToolNames: ['execute_command', 'save_file', 'spawn_sub_agent'],
    historyPrefixHash: 'hash',
    ...overrides,
  };
}

function run(overrides: Partial<TurnRunRecord> = {}): TurnRunRecord {
  return {
    runId: 'run-1',
    branchId: 'branch-1',
    forkHistoryIndex: 0,
    status: 'completed',
    createdAt: 1000,
    endedAt: 5000,
    snapshot: snapshot(),
    outputHistoryStart: 1,
    outputHistoryEnd: 5,
    parentTurnId: 'parent-turn-1',
    ...overrides,
  };
}

function chat(): Chat {
  const value = createEmptyChatObject('Ledger task', 'C:\\workspace');
  value.id = 'chat-1';
  value.name = 'Ledger task';
  value.modeId = 'build';
  return value;
}

describe('execution ledger projection', () => {
  test('projects ordered actions, command failures, changes, agents, and outcome from saved records', () => {
    const value = chat();
    value.history = [
      { role: 'user', content: 'Implement the ledger' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'cmd-1', type: 'function', function: { name: 'execute_command', arguments: '{"command":"npm test"}' } },
          { id: 'write-1', type: 'function', function: { name: 'save_file', arguments: '{"path":"src/ledger.ts"}' } },
          { id: 'agent-1', type: 'function', function: { name: 'spawn_sub_agent', arguments: '{"task":"Review the implementation"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'cmd-1', content: 'npm test (exit 1)\n\nstdout:\n1 failing' },
      {
        role: 'tool',
        tool_call_id: 'write-1',
        content: 'Saved src/ledger.ts',
        codeChange: { additions: 8, deletions: 2, path: 'src/ledger.ts', source: 'file-tool' },
      },
      { role: 'tool', tool_call_id: 'agent-1', content: 'Review complete' },
      { role: 'assistant', content: 'Implemented the execution ledger. Tests still need attention.' },
    ];
    value.runs = [run()];
    value.subAgentRuns = [{
      runId: 'sub-1',
      parentTurnId: 'parent-turn-1',
      parentToolCallId: 'agent-1',
      type: 'reviewer',
      task: 'Review the implementation',
      status: 'completed',
      summary: 'Looks sound',
      toolTurns: 1,
      messages: [],
    }];

    const ledger = projectExecutionLedger(value);
    const turn = ledger.turns[0];
    assert.equal(ledger.title, 'Ledger task');
    assert.equal(turn.status, 'completed');
    assert.equal(turn.modeLabel, 'Build');
    assert.equal(turn.durationMs, 4000);
    assert.deepEqual(turn.actions.map((action) => action.toolName), [
      'execute_command',
      'save_file',
      'spawn_sub_agent',
    ]);
    assert.equal(turn.actions[0].status, 'failed');
    assert.equal(turn.actions[0].exitCode, 1);
    assert.equal(turn.actions[0].isCommand, true);
    assert.deepEqual(turn.files.map((file) => file.path), ['src/ledger.ts']);
    assert.equal(turn.agents[0].runId, 'sub-1');
    assert.equal(turn.completion, 'Implemented the execution ledger.');
    assert.equal(turn.canUndo, true);
  });

  test('surfaces issue, board, task, and plan references without enabling unsafe board undo', () => {
    const value = chat();
    value.boardGroupId = 'board-7';
    value.boardTaskId = 'W2-B';
    value.orchestratePlanPath = 'documentation/plans/ledger.md';
    value.history = [
      {
        role: 'user',
        content: 'Work on MIN-900',
        issue: {
          id: 'MIN-900',
          type: 'feature',
          title: 'Execution history',
          description: 'Add a ledger',
          status: 'in_progress',
          priority: 'high',
          labels: ['ux'],
        },
      },
      { role: 'assistant', content: 'Done.' },
    ];
    value.runs = [run({
      outputHistoryEnd: 1,
      snapshot: snapshot({ orchestratePlanPath: 'documentation/plans/ledger.md' }),
    })];

    const ledger = projectExecutionLedger(value);
    assert.deepEqual(ledger.references.map((ref) => [ref.kind, ref.label, ref.value]), [
      ['issue', 'MIN-900', 'Execution history'],
      ['plan', 'Plan', 'documentation/plans/ledger.md'],
      ['board', 'Board', 'board-7'],
      ['board-task', 'Board task', 'W2-B'],
    ]);
    assert.equal(ledger.turns[0].canUndo, false);
  });

  test('keeps older stored sessions useful without inventing missing run metadata', () => {
    const value = chat();
    value.modeId = 'debug';
    value.history = [
      { role: 'user', content: 'Why does this fail?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'cmd-legacy',
          type: 'function',
          function: { name: 'execute_command', arguments: '{"command":"npm test"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'cmd-legacy', content: 'npm test (exit 0)\n\nstdout:\nok' },
      { role: 'assistant', content: 'The test passes now.' },
    ];
    value.runs = undefined;

    const ledger = projectExecutionLedger(value);
    const turn = ledger.turns[0];
    assert.equal(turn.status, 'recorded');
    assert.equal(turn.modeLabel, 'Debug');
    assert.equal(turn.modeSource, 'chat');
    assert.equal(turn.createdAt, undefined);
    assert.equal(turn.actions[0].status, 'succeeded');
    assert.match(ledger.unavailable.join(' '), /Older turns without run records/);
  });
});
