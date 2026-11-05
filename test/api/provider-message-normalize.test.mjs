/**
 * LM Studio / Qwen Jinja compatibility: fold assistant-before-user preambles.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { repairUnpairedToolCalls, foldLeadingAssistantPreamble } from '../../src/api/provider-message-normalize.ts';

it('keeps each real tool receipt once, within its own assistant batch', () => {
  const calls = id => ({ role: 'assistant', tool_calls: [{ id }] });
  const result = id => ({ role: 'tool', tool_call_id: id, content: id });
  const [a, b] = [calls('a'), calls('b')];
  assert.deepEqual(repairUnpairedToolCalls([a, result('a'), result('a'), b, result('a'), result('b')]), [a, result('a'), b, result('b')]);
});

describe('foldLeadingAssistantPreamble', () => {
  it('folds assistant greeting before the first user turn into system', () => {
    const input = [
      { role: 'system', content: 'You are a writer.' },
      { role: 'assistant', content: 'Hi — I am **Creative writer**.' },
      { role: 'user', content: 'write a story about a cat' },
    ];
    const out = foldLeadingAssistantPreamble(input);
    assert.equal(out.length, 2);
    assert.equal(out[0].role, 'system');
    assert.match(out[0].content, /Creative writer/);
    assert.match(out[0].content, /greeted the user/);
    assert.deepEqual(out[1], { role: 'user', content: 'write a story about a cat' });
  });

  it('keeps an opening tool batch and its receipt when folding a greeting', () => {
    const batch = [{ role: 'assistant', content: 'Checking now', tool_calls: [{ id: 'check' }] },
      { role: 'tool', tool_call_id: 'check', content: 'actual result' }];
    const normalized = repairUnpairedToolCalls(foldLeadingAssistantPreamble([{ role: 'assistant', content: 'Hello' }, ...batch]));
    assert.deepEqual(normalized.slice(1), batch);
  });

  it('leaves normal user-first histories unchanged', () => {
    const input = [
      { role: 'system', content: 'Base' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    assert.deepEqual(foldLeadingAssistantPreamble(input), input);
  });
});
