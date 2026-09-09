/**
 * Board attempt transcripts → API-shaped messages.
 *
 * The board records turn events; the chat transcript renderer takes messages.
 * The property under test is that the seam between them loses nothing: every
 * thought lands on the turn it belongs to, every tool call finds its result,
 * and a live attempt still renders from a stream that just stops mid-round.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  adaptAttemptTranscript,
  liveTailPhase,
  transcriptStructureKey,
} from '../../src/orchestrator/transcript-adapter.ts';

type Msg = Record<string, unknown>;

const asMessages = (events: Record<string, unknown>[]): Msg[] =>
  adaptAttemptTranscript(events).messages as Msg[];

describe('adaptAttemptTranscript', () => {
  it('pairs a tool call with its result by id', () => {
    const messages = asMessages([
      { type: 'tool_call', id: 't1', name: 'read_file', arguments: '{"path":"a.ts"}' },
      { type: 'tool_result', id: 't1', name: 'read_file', content: 'contents' },
      { type: 'round_end', index: 1, toolCallCount: 1, text: 'Read it.' },
    ]);

    assert.equal(messages.length, 2);
    const assistant = messages[0];
    assert.equal(assistant.role, 'assistant');
    assert.equal(assistant.content, 'Read it.');
    assert.deepEqual(assistant.tool_calls, [
      { id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
    ]);

    assert.deepEqual(messages[1], {
      role: 'tool',
      tool_call_id: 't1',
      name: 'read_file',
      content: 'contents',
    });
  });

  it('keeps two calls in one round distinct, and matches each to its own result', () => {
    const messages = asMessages([
      { type: 'tool_call', id: 'a', name: 'read_file' },
      { type: 'tool_call', id: 'b', name: 'save_file' },
      { type: 'tool_result', id: 'b', name: 'save_file', content: 'wrote' },
      { type: 'tool_result', id: 'a', name: 'read_file', content: 'read' },
      { type: 'round_end', index: 1, toolCallCount: 2, text: '' },
    ]);

    // Results arrive out of order; each still lands on its own call.
    const results = messages.filter((m) => m.role === 'tool');
    assert.deepEqual(
      results.map((m) => [m.tool_call_id, m.content]),
      [
        ['a', 'read'],
        ['b', 'wrote'],
      ],
    );
  });

  it('carries thinking onto the turn it belongs to, whole', () => {
    const long = 'I should check whether the scaffold exists first. '.repeat(20);
    const messages = asMessages([
      { type: 'thinking', text: long },
      { type: 'round_end', index: 1, toolCallCount: 0, text: 'Done.' },
    ]);

    assert.equal(messages.length, 1);
    // Nothing is clipped at a character count on the way through.
    assert.equal(messages[0].reasoning, long.trim());
  });

  it('joins several thinking fragments in one round rather than keeping the last', () => {
    const messages = asMessages([
      { type: 'thinking', text: 'First.' },
      { type: 'tool_call', id: 't1', name: 'read_file' },
      { type: 'tool_result', id: 't1', content: 'ok' },
      { type: 'thinking', text: 'Second.' },
      { type: 'round_end', index: 1, toolCallCount: 1, text: '' },
    ]);
    assert.equal(messages[0].reasoning, 'First.\n\nSecond.');
  });

  it('does not fold two rounds into one turn', () => {
    const messages = asMessages([
      { type: 'round_end', index: 1, toolCallCount: 0, text: 'One.' },
      { type: 'round_end', index: 2, toolCallCount: 0, text: 'Two.' },
    ]);
    assert.deepEqual(
      messages.map((m) => m.content),
      ['One.', 'Two.'],
    );
  });

  it('renders a live attempt whose last round never closed', () => {
    // The stream just stops: no round_end, no attempt_end. The work in flight
    // still has to appear, or a running agent looks like it did nothing.
    const messages = asMessages([
      { type: 'thinking', text: 'Looking at the config.' },
      { type: 'tool_call', id: 't1', name: 'read_file', arguments: '{"path":"vite.config.ts"}' },
    ]);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].reasoning, 'Looking at the config.');
    assert.equal((messages[0].tool_calls as unknown[]).length, 1);
    // No result yet, so the row is present and empty rather than missing.
    assert.equal(messages[1].content, '');
  });

  it('reports how the attempt ended, separately from the messages', () => {
    const { end } = adaptAttemptTranscript([
      { type: 'round_end', index: 1, toolCallCount: 0, text: 'Built it.' },
      { type: 'attempt_end', name: 'pass', summary: 'Created the scaffold.' },
    ]);
    assert.deepEqual(end, { outcome: 'pass', summary: 'Created the scaffold.' });
  });

  it('survives a tool call with no id', () => {
    const messages = asMessages([
      { type: 'tool_call', name: 'read_file' },
      { type: 'tool_result', name: 'read_file', content: 'ok' },
      { type: 'round_end', index: 1, toolCallCount: 1, text: '' },
    ]);
    const call = (messages[0].tool_calls as Array<{ id: string }>)[0];
    assert.ok(call.id, 'a synthetic id, rather than dropping the row');
    assert.equal(messages[1].tool_call_id, call.id);
    assert.equal(messages[1].content, 'ok');
  });

  it('turns object arguments into the JSON string the renderer expects', () => {
    const messages = asMessages([
      { type: 'tool_call', id: 't1', name: 'save_file', arguments: { path: 'a.ts' } },
      { type: 'round_end', index: 1, toolCallCount: 1, text: '' },
    ]);
    const call = (messages[0].tool_calls as Array<{ function: { arguments: string } }>)[0];
    assert.equal(call.function.arguments, '{"path":"a.ts"}');
  });

  it('has nothing to say about an empty transcript', () => {
    const { messages, end } = adaptAttemptTranscript([]);
    assert.deepEqual(messages, []);
    assert.equal(end, null);
  });
});

describe('liveTailPhase', () => {
  it('says which tool is running when a call is the last thing recorded', () => {
    assert.deepEqual(
      liveTailPhase([
        { type: 'thinking', text: 'hm' },
        { type: 'tool_call', id: 't1', name: 'execute_command' },
      ]),
      { phase: 'tools', toolName: 'execute_command' },
    );
  });

  it('names the tool while its arguments are still streaming', () => {
    // The gap between the last thought and the finished call is where a task
    // looked stuck; the thread must say what is being written, not re-thought.
    assert.deepEqual(
      liveTailPhase([
        { type: 'thinking', text: 'I will rewrite it' },
        { type: 'tool_streaming', name: 'save_file' },
      ]),
      { phase: 'tools', toolName: 'save_file' },
    );
  });

  it('is thinking, with the thought, when that is the last thing recorded', () => {
    const tail = liveTailPhase([
      { type: 'tool_result', id: 't1', content: 'ok' },
      { type: 'thinking', text: 'Now I can write the file.' },
    ]);
    assert.equal(tail.phase, 'thinking');
    assert.equal(tail.reasoning, 'Now I can write the file.');
  });

  it('is generating once a tool has come back', () => {
    assert.equal(
      liveTailPhase([
        { type: 'tool_call', id: 't1', name: 'read_file' },
        { type: 'tool_result', id: 't1', content: 'ok' },
      ]).phase,
      'generating',
    );
  });

  it('is generating when nothing has been recorded at all', () => {
    assert.equal(liveTailPhase([]).phase, 'generating');
  });
});

describe('transcriptStructureKey', () => {
  it('ignores growing thinking text so a coalesced thought is the same structure', () => {
    const first = transcriptStructureKey([{ type: 'thinking', text: 'Need to' }]);
    const grown = transcriptStructureKey([
      { type: 'thinking', text: 'Need to check package.json first.' },
    ]);
    assert.equal(first, grown);
    assert.equal(first, 'thinking');
  });

  it('changes when a tool call arrives after thinking', () => {
    const thinking = transcriptStructureKey([{ type: 'thinking', text: 'hm' }]);
    const withTool = transcriptStructureKey([
      { type: 'thinking', text: 'hm' },
      { type: 'tool_call', id: 't1', name: 'read_file' },
    ]);
    assert.notEqual(thinking, withTool);
  });
});
