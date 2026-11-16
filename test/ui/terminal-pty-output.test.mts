import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPtyOutputBuffer } from '../../src/ui/terminal-pty-output';

test('a hidden PTY batches output and preserves its order when the viewport returns', () => {
  const writes: string[] = [];
  const output = createPtyOutputBuffer(data => writes.push(data));
  output.append('prompt');
  output.setVisible(true);
  output.append('visible');
  output.setVisible(false);
  output.append('background 1\r\n');
  output.append('background 2\r\n');
  assert.deepEqual(writes, ['prompt', 'visible']);
  output.setVisible(true);
  output.setVisible(true);
  assert.deepEqual(writes, ['prompt', 'visible', 'background 1\r\nbackground 2\r\n']);
});

test('a chatty hidden PTY keeps recent output and marks the omitted section once', () => {
  const writes: string[] = [];
  const output = createPtyOutputBuffer(data => writes.push(data), 12);
  output.append('unbounded output');
  output.append(' tail');
  assert.deepEqual(writes, []);
  output.setVisible(true);
  assert.equal(writes.length, 1);
  assert.match(writes[0], /output omitted while hidden/);
  assert.match(writes[0], /output tail$/);
});

test('switching terminals discards deferred output from the previous session', () => {
  const writes: string[] = [];
  const output = createPtyOutputBuffer(data => writes.push(data), 8);
  output.append('old hidden terminal');
  output.reset();
  output.append('new');
  output.setVisible(true);
  assert.deepEqual(writes, ['new']);
});
