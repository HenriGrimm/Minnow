import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranscriptBuilder, describeToolTarget } from '../../server/scheduler/live-runs.js';
import { isNothingToDoReply } from '../../server/scheduler/runner.js';

test('runner events fold into chat history the renderer can paint', () => {
  const builder = createTranscriptBuilder({ prompt: 'Check CI' });
  builder.apply({ type: 'round_start', index: 0 });
  builder.apply({ type: 'delta', text: 'Looking at the' });
  assert.equal(builder.live().lastDelta, 'Looking at the');
  builder.apply({ type: 'round_end', index: 0, text: 'Looking at the log.', reasoning: 'plan', toolCallCount: 1, t0: 0, tFirst: 0, tEnd: 1 });
  builder.apply({ type: 'tool_call', name: 'execute_command', id: 'c1', arguments: { command: 'npm test' } });
  assert.equal(builder.step(), 'execute_command › npm test');
  builder.apply({ type: 'tool_result', name: 'execute_command', id: 'c1', content: '5 passing' });
  builder.apply({ type: 'round_start', index: 1 });
  builder.apply({ type: 'round_end', index: 1, text: 'All green.', reasoning: '', toolCallCount: 0, t0: 0, tFirst: 0, tEnd: 1 });

  const messages = builder.messages();
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(messages[1].tool_calls[0].function.name, 'execute_command');
  assert.equal(messages[2].tool_call_id, 'c1');
  assert.deepEqual(messages[1].thinking, ['plan']);
  assert.equal(builder.stats().commands, 1);
});

test('sealing closes tool calls that never returned', () => {
  const builder = createTranscriptBuilder();
  builder.apply({ type: 'tool_call', name: 'read_file', arguments: '{"path":"a.js"}' });
  builder.seal('Stopped.');
  const messages = builder.messages();
  assert.equal(messages.at(-1).role, 'tool');
  assert.equal(messages.at(-1).tool_call_id, messages[0].tool_calls[0].id);
});

test('tool targets and the nothing-to-do marker', () => {
  assert.equal(describeToolTarget('read_file', '{"path":"src/x.ts"}'), 'read_file › src/x.ts');
  assert.equal(describeToolTarget('get_datetime', {}), 'get_datetime');
  assert.equal(isNothingToDoReply('  NOTHING_TO_DO. '), true);
  assert.equal(isNothingToDoReply('Nothing to do today, but…'), false);
});
