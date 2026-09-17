/**
 * Context-priced file reads: a window-scaled read budget and the unchanged-read stub.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MIN_READ_BUDGET_CHARS,
  isUnchangedReadStub,
  readBudgetCharsForContext,
  unchangedReadStub,
  withReadBudget,
} from '../../server/runner/read-context.js';

const BODY = Array.from({ length: 200 }, (_, i) => `${i + 1}: const line${i} = ${i};`).join('\n');

/** An assistant tool call row plus its tool result row. */
function readRound(id, name, content) {
  return [
    { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }] },
    { role: 'tool', tool_call_id: id, content },
  ];
}

describe('readBudgetCharsForContext', () => {
  it('scales with the window and has a floor', () => {
    const small = readBudgetCharsForContext(32_000);
    const large = readBudgetCharsForContext(200_000);
    assert.ok(small < large);
    assert.ok(small < 20_000, `32k window should get well under 20k chars, got ${small}`);
    assert.equal(readBudgetCharsForContext(1_000), MIN_READ_BUDGET_CHARS);
  });

  it('is null when the window is unknown', () => {
    assert.equal(readBudgetCharsForContext(null), null);
    assert.equal(readBudgetCharsForContext(undefined), null);
    assert.equal(readBudgetCharsForContext(0), null);
  });
});

describe('withReadBudget', () => {
  it('sets max_output_chars on read tools only', () => {
    assert.deepEqual(withReadBudget('read_file', { path: 'a' }, 9_000), { path: 'a', max_output_chars: 9_000 });
    assert.deepEqual(withReadBudget('grep', { pattern: 'x' }, 9_000), { pattern: 'x' });
  });

  it('keeps a smaller caller budget and leaves full_result alone', () => {
    assert.equal(withReadBudget('read_file', { path: 'a', max_output_chars: 2_000 }, 9_000).max_output_chars, 2_000);
    assert.equal(withReadBudget('read_file', { path: 'a', max_output_chars: 50_000 }, 9_000).max_output_chars, 9_000);
    assert.deepEqual(withReadBudget('read_file', { path: 'a', full_result: true }, 9_000), { path: 'a', full_result: true });
  });

  it('does nothing without a budget', () => {
    const args = { path: 'a' };
    assert.equal(withReadBudget('read_file', args, null), args);
  });
});

describe('unchangedReadStub', () => {
  it('stubs a read identical to an earlier read still in context', () => {
    const messages = [{ role: 'system', content: 's' }, ...readRound('c1', 'read_file', BODY)];
    const stub = unchangedReadStub(messages, 'read_file', { path: 'src/a.ts' }, BODY);
    assert.ok(stub);
    assert.ok(isUnchangedReadStub(stub));
    assert.match(stub, /read_file of src\/a\.ts/);
    assert.ok(stub.length < 400);
  });

  it('matches across read tools with identical output', () => {
    const messages = readRound('c1', 'read_file_range', BODY);
    assert.ok(unchangedReadStub(messages, 'read_file', { path: 'a', offset: 1, limit: 200 }, BODY));
  });

  it('sends the full result when the file changed', () => {
    const messages = readRound('c1', 'read_file', BODY);
    assert.equal(unchangedReadStub(messages, 'read_file', { path: 'a' }, `${BODY}\n201: extra`), null);
  });

  it('sends the full result when the earlier copy was elided', () => {
    const messages = readRound('c1', 'read_file', '[tool result elided from context — row 4, read_file, 5000 chars]');
    assert.equal(unchangedReadStub(messages, 'read_file', { path: 'a' }, BODY), null);
  });

  it('ignores identical text from a non-read tool, small results and errors', () => {
    assert.equal(unchangedReadStub(readRound('c1', 'execute_command', BODY), 'read_file', {}, BODY), null);
    assert.equal(unchangedReadStub(readRound('c1', 'read_file', 'short'), 'read_file', {}, 'short'), null);
    const error = `Error: ${'x'.repeat(2_000)}`;
    assert.equal(unchangedReadStub(readRound('c1', 'read_file', error), 'read_file', {}, error), null);
    assert.equal(unchangedReadStub(readRound('c1', 'read_file', BODY), 'grep', {}, BODY), null);
  });
});
