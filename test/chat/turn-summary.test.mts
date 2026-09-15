/**
 * Compact chat turn tally (documentation/plans/compact-chat-turn-summary.md).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { formatTurnSummary, narrationSentence, summarizeTurn } from '../../src/chat/turn-summary.ts';
import type { Message } from '../../src/types.ts';

let seq = 0;
function call(name: string, args: Record<string, unknown>, result: string, extra: Record<string, unknown> = {}): Message[] {
  const id = `c${++seq}`;
  return [
    { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
    { role: 'tool', tool_call_id: id, content: result, ...extra } as Message,
  ];
}

function turn(...rows: Message[][]): Message[] {
  return [{ role: 'user', content: 'Go' }, ...rows.flat(), { role: 'assistant', content: 'Done.' }];
}

const summarize = (history: Message[], options = {}) => summarizeTurn(history, 0, history.length - 1, options);
const texts = (history: Message[], options = {}) => formatTurnSummary(summarize(history, options));

describe('summarizeTurn', () => {
  test('counts distinct targets in fixed family order', () => {
    const history = turn(
      call('execute_command', { command: 'npm test' }, 'ok'),
      call('read_file', { path: 'src/a.ts' }, 'a'),
      call('read_file', { path: './src/a.ts' }, 'a'),
      call('read_file_range', { path: 'src/b.ts', start_line: 1, end_line: 2 }, 'b'),
      call('grep', { pattern: 'foo' }, 'x'),
      call('replace_text_in_file', { path: 'src/a.ts' }, 'Updated', { codeChange: { path: 'src/a.ts', additions: 1, deletions: 0 } }),
    );
    assert.equal(texts(history), 'Read 2 files · 1 search · Edited 1 file · Ran 1 command');
  });

  test('a failure recovered by the same tool and target leaves no trace', () => {
    const history = turn(
      call('execute_command', { command: 'npm test' }, 'Error: exit 1'),
      call('execute_command', { command: 'npm test' }, 'passed'),
    );
    assert.deepEqual(summarize(history).entries, [{ kind: 'run', count: 1, failed: 0, text: 'Ran 1 command' }]);
  });

  test('unrecovered failures attach to their family and are never folded into +N more', () => {
    const history = turn(
      call('read_file', { path: 'a.ts' }, 'a'),
      call('grep', { pattern: 'x' }, 'x'),
      call('save_file', { path: 'b.ts' }, 'ok'),
      call('execute_command', { command: 'ls' }, 'ok'),
      call('web_search', { query: 'q' }, 'ok'),
      call('fetch_web_content', { url: 'https://x' }, 'Error: 404'),
      call('execute_command', { command: 'npm test' }, 'Error: exit 1'),
      call('execute_command', { command: 'npm run build' }, 'ok'),
    );
    const summary = summarize(history);
    assert.deepEqual(summary.entries.map((e) => [e.kind, e.failed]), [['read', 0], ['search', 0], ['run', 1], ['web', 1]]);
    assert.equal(summary.overflow, 1);
    assert.equal(formatTurnSummary(summary), 'Read 1 file · 1 search · Ran 3 commands, 1 failed · 2 web lookups, 1 failed · +1 more');
  });

  test('retrying a different target does not recover the failure', () => {
    const history = turn(
      call('read_file', { path: 'missing.ts' }, 'Error: not found'),
      call('read_file', { path: 'found.ts' }, 'ok'),
    );
    assert.equal(texts(history), 'Read 2 files, 1 failed');
  });

  test('Impeccable detect findings are not failures', () => {
    const history = turn(call('execute_command', { command: 'detect' }, 'Error: impeccable detect exited 2\n3 anti-patterns found.'));
    assert.equal(summarize(history).entries[0].failed, 0);
  });

  test('agents, questions, browser, unknown tools and bookkeeping', () => {
    const history = turn(
      call('spawn_sub_agent', { task: 'x' }, 'started'),
      call('get_sub_agent_status', {}, 'running'),
      call('todo_write', {}, 'ok'),
      call('ask_question', { questions: [{ id: 'a' }, { id: 'b' }] }, '{}'),
      call('browser_click', {}, 'ok'),
      call('mcp__linear__save_issue', {}, 'ok'),
    );
    assert.equal(texts(history), '1 browser action · Spawned 1 agent · Asked 2 questions · 1 other action');
  });

  test('superseded checkpoints fold into the tally; the active one does not', () => {
    const notice = (n: number): Message => ({ role: 'context', policy: 'compact', droppedTurns: n, createdAt: n, compaction: { version: 1 } } as unknown as Message);
    const history = turn([notice(1)], call('read_file', { path: 'a.ts' }, 'a'), [notice(2)]);
    assert.equal(texts(history), 'Read 1 file · Compacted');
    assert.equal(texts(history, { activeCompactions: new Set<number>() }), 'Read 1 file · Compacted 2×');
  });

  test('thinking-only turns read as Thought, with duration when recorded', () => {
    const history: Message[] = [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello', thinking: ['hm'], thinkingDurationMs: 12_400 }];
    assert.equal(texts(history), 'Thought for 12s');
    history[1] = { role: 'assistant', content: 'Hello', thinking: ['hm'] };
    assert.equal(texts(history), 'Thought');
    history[1] = { role: 'assistant', content: 'Hello' };
    assert.deepEqual(summarize(history), { entries: [], overflow: 0 });
  });

  test('calls still waiting for a result are not counted', () => {
    const history: Message[] = [{ role: 'user', content: 'Go' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'p', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] }];
    assert.deepEqual(summarize(history).entries, []);
  });

  test('only rows inside the turn are read', () => {
    const history = [...turn(call('read_file', { path: 'a.ts' }, 'a')), ...turn(call('grep', { pattern: 'x' }, 'x'))];
    assert.equal(formatTurnSummary(summarizeTurn(history, 0, 3)), 'Read 1 file');
  });
});

describe('narrationSentence', () => {
  test('first sentence, markdown stripped, file names intact', () => {
    assert.equal(narrationSentence('Let me check `chat-work.ts`. Then **fix** it.'), 'Let me check chat-work.ts.');
    assert.equal(narrationSentence('## Plan\n- read [the file](x.md)'), 'Plan');
    assert.equal(narrationSentence('```ts\ncode\n```\nRunning the tests now'), 'Running the tests now');
    assert.equal(narrationSentence('a'.repeat(200), 20), `${'a'.repeat(19)}…`);
  });
});
