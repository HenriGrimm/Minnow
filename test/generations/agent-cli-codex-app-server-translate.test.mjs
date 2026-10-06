import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCodexTranslator } from '../../server/generations/codex-app-server/translate.js';

function stream() {
  const chunks = [];
  const translate = createCodexTranslator(delta => chunks.push(delta));
  return {
    send: (method, params) => translate({ method, params }),
    reasoning: () => chunks.map(chunk => chunk.reasoning ?? '').join(''),
    content: () => chunks.map(chunk => chunk.content ?? '').join(''),
  };
}

test('Codex streams the reasoning body alongside its summary heading without replaying snapshots', () => {
  const s = stream();
  s.send('item/reasoning/summaryTextDelta', { itemId: 'r1', summaryIndex: 0, delta: '**Checking options**' });
  s.send('item/reasoning/textDelta', { itemId: 'r1', contentIndex: 0, delta: 'Compare ' });
  s.send('item/reasoning/textDelta', { itemId: 'r1', contentIndex: 0, delta: 'the available options.' });
  assert.equal(s.reasoning(), '**Checking options**\n\nCompare the available options.');
  const completed = { item: { type: 'reasoning', id: 'r1', summary: ['**Checking options**'], content: ['Compare the available options.'] } };
  s.send('item/completed', completed);
  s.send('item/completed', completed);
  assert.equal(s.reasoning(), '**Checking options**\n\nCompare the available options.');
  assert.equal(s.content(), '');
});

test('Codex fills missing reasoning suffixes and completion-only content', () => {
  const s = stream();
  s.send('item/reasoning/summaryTextDelta', { itemId: 'r1', delta: 'Checking' });
  s.send('item/completed', { item: { type: 'reasoning', id: 'r1', summary: ['Checking options'], content: ['Body from completion.'] } });
  s.send('item/reasoning/textDelta', { itemId: 'r2', delta: 'Next' });
  s.send('item/completed', { item: { type: 'reasoning', id: 'r2', content: ['Next step.'] } });
  assert.equal(s.reasoning(), 'Checking options\n\nBody from completion.\n\nNext step.');
});

test('Codex separates summary sections and content indexes without empty paragraphs', () => {
  const s = stream();
  s.send('item/reasoning/summaryPartAdded', { itemId: 'r1', summaryIndex: 0 });
  s.send('item/reasoning/summaryTextDelta', { itemId: 'r1', summaryIndex: 0, delta: 'First.' });
  s.send('item/reasoning/summaryPartAdded', { itemId: 'r1', summaryIndex: 1 });
  s.send('item/reasoning/summaryTextDelta', { itemId: 'r1', summaryIndex: 1, delta: '' });
  s.send('item/reasoning/summaryTextDelta', { itemId: 'r1', summaryIndex: 1, delta: 'Second.' });
  s.send('item/completed', { item: { type: 'reasoning', id: 'r1', summary: ['First.', 'Second.'], content: ['', 'Body one.', 'Body two.'] } });
  assert.equal(s.reasoning(), 'First.\n\nSecond.\n\nBody one.\n\nBody two.');
});

test('summary-only models remain summary-only and assistant text stays separate', () => {
  const s = stream();
  s.send('item/completed', { item: { type: 'reasoning', id: 'r1', summary: ['**Checking options**'] } });
  s.send('item/agentMessage/delta', { itemId: 'm1', delta: 'Answer' });
  s.send('item/completed', { item: { type: 'agentMessage', id: 'm1', text: 'Answer.' } });
  assert.equal(s.reasoning(), '**Checking options**');
  assert.equal(s.content(), 'Answer.');
});

test('changed completed reasoning is rejected instead of corrupting streamed text', () => {
  const s = stream();
  s.send('item/reasoning/textDelta', { itemId: 'r1', delta: 'Original' });
  assert.throws(() => s.send('item/completed', { item: { type: 'reasoning', id: 'r1', content: ['Changed'] } }), /already streamed/);
});
