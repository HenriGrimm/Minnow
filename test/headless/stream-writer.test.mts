import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHeadlessStreamWriter, createHeadlessJsonStreamWriter } from '../../src/headless/stream-writer.ts';
import { parseRunArgs } from '../../src/headless/argv.ts';

test('streams incremental response and reasoning without repeating cumulative text', () => {
  const chunks: string[] = [];
  const emit = createHeadlessStreamWriter(text => chunks.push(text));
  emit({ type: 'round_start', index: 0 });
  emit({ type: 'thinking', text: 'Consider' });
  assert.match(chunks.join(''), /Thinking:\nConsider$/);
  emit({ type: 'thinking', text: 'Consider the tests.' });
  emit({ type: 'delta', text: 'I will' });
  assert.match(chunks.join(''), /Response:\nI will$/);
  emit({ type: 'delta', text: 'I will build a timer.' });
  emit({ type: 'delta', text: 'I will build a timer.' });
  assert.equal(chunks.join('').match(/I will/g)?.length, 1);
  assert.equal(chunks.join('').match(/Consider/g)?.length, 1);
  emit({ type: 'tool_call', name: 'save_file', arguments: '{"path":"src/main.ts","content":"private file contents"}' });
  emit({ type: 'tool_result', name: 'save_file', content: 'Saved' });
  assert.match(chunks.join(''), /Running save_file · src\/main.ts\nsave_file: finished/);
  assert.ok(!chunks.join('').includes('private file contents'));
  emit({ type: 'round_start', index: 1 });
  emit({ type: 'delta', text: 'I will verify it.' });
  assert.match(chunks.join(''), /Agent turn 2\n\n\nResponse:\nI will verify it\.$/);
});

test('stream handles model loading, restarts, tool errors and terminal-only response text', () => {
  let output = '';
  const emit = createHeadlessStreamWriter(text => { output += text; });
  emit({ type: 'loading_model' });
  emit({ type: 'delta', text: 'Old partial response' });
  emit({ type: 'response_restart', warning: 'Trying another model' });
  emit({ type: 'delta', text: 'New response' });
  emit({ type: 'tool_streaming', name: 'read_file' });
  emit({ type: 'tool_result', name: 'read_file', content: 'Error: missing file' });
  emit({ type: 'round_start', index: 1 });
  emit({ type: 'round_end', index: 1, text: 'Final text', reasoning: '', toolCallCount: 0, t0: 1, tFirst: null, tEnd: 2 });
  assert.match(output, /Loading model/);
  assert.match(output, /Response restarted: Trying another model/);
  assert.match(output, /New response/);
  assert.match(output, /Preparing read_file/);
  assert.match(output, /read_file: failed/);
  assert.match(output, /Response:\nFinal text\n$/);
});

test('stream output is opt-in and JSON result files can accompany it', () => {
  const plain = parseRunArgs(['--prompt', 'test']);
  assert.ok(plain.ok); assert.equal(plain.options.stream, false);
  const streaming = parseRunArgs(['--prompt', 'test', '--stream', '--quiet', '--json-out', 'result.json']);
  assert.ok(streaming.ok); assert.equal(streaming.options.stream, true); assert.equal(streaming.options.jsonOut, 'result.json');
  assert.equal(parseRunArgs(['--prompt', 'test', '--stream', '--json']).ok, false);
});

test('JSON stream preserves reasoning, tool ids, arguments and results as distinct events', () => {
  let output = '';
  const emit = createHeadlessJsonStreamWriter(text => { output += text; });
  emit({ type: 'thinking', text: 'Think about Unicode 🐟\nand tests' });
  emit({ type: 'tool_call', id: 'call-1', name: 'save_file', arguments: { path: 'main.ts', content: 'const x = 1;' } });
  emit({ type: 'tool_result', id: 'call-1', name: 'save_file', content: 'Saved' });
  const events = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.length, 3); assert.equal(events[0].text, 'Think about Unicode 🐟\nand tests');
  assert.equal(events[1].id, events[2].id); assert.equal(events[1].arguments.path, 'main.ts');
  const args = parseRunArgs(['--prompt', 'test', '--stream-json', '--json-out', 'out.json']);
  assert.ok(args.ok); assert.equal(args.options.streamJson, true);
  assert.equal(parseRunArgs(['--prompt', 'test', '--stream-json', '--stream']).ok, false);
  assert.equal(parseRunArgs(['--prompt', 'test', '--stream-json', '--json']).ok, false);
});
