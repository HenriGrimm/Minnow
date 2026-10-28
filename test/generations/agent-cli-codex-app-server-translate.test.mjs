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

test('summary deltas and completed snapshots identify their format independently of raw content', () => {
  const chunks = [];
  const translate = createCodexTranslator((delta, format) => chunks.push({ delta, format }));
  translate({ method: 'item/reasoning/summaryTextDelta', params: { itemId: 'r1', delta: 'Checking.' } });
  translate({ method: 'item/reasoning/textDelta', params: { itemId: 'r1', delta: 'Raw content.' } });
  translate({ method: 'item/completed', params: { item: { id: 'r2', type: 'reasoning', summary: ['Another summary.'] } } });
  assert.deepEqual(chunks.map(chunk => chunk.format), ['summary', undefined, 'summary']);
});

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

test('changed completed reasoning preserves streamed reasoning without terminating the turn', () => {
  const s = stream();
  s.send('item/reasoning/textDelta', { itemId: 'r1', delta: 'Original' });
  s.send('item/completed', { item: { type: 'reasoning', id: 'r1', content: ['Changed'] } });
  s.send('item/completed', { item: { type: 'agentMessage', id: 'm1', text: 'Done.' } });
  assert.equal(s.reasoning(), 'Original');
  assert.equal(s.content(), 'Done.');
});

test('empty and shorter snapshots do not replay or truncate streamed sections', () => {
  const s = stream();
  s.send('item/agentMessage/delta', { itemId: 'm1', delta: 'Complete text.' });
  for (const text of ['', 'Complete', 'Complete text.']) s.send('item/completed', { item: { type: 'agentMessage', id: 'm1', text } });
  assert.equal(s.content(), 'Complete text.');
});

test('revised prose replaces the ordered round snapshot once, without concatenating conflicting answers', () => {
  const chunks = [], diagnostics = [];
  const translate = createCodexTranslator(delta => chunks.push(delta), { onDivergence: d => diagnostics.push(d) });
  const send = (method, params) => translate({ method, params });
  send('item/agentMessage/delta', { itemId: 'm1', delta: 'Intro. ' });
  send('item/agentMessage/delta', { itemId: 'm2', delta: 'Wrong.' });
  send('item/completed', { item: { id: 'm2', type: 'agentMessage', text: 'Correct.' } });
  send('item/completed', { item: { id: 'm2', type: 'agentMessage', text: 'Correct.' } });
  send('item/agentMessage/delta', { itemId: 'm3', delta: ' Next.' });
  assert.deepEqual(chunks, [{ content: 'Intro. ' }, { content: 'Wrong.' }, { content_snapshot: 'Intro. Correct.' }, { content: ' Next.' }]);
  assert.deepEqual(diagnostics, [{ channel: 'content', previousLength: 6, snapshotLength: 8, kind: 'revised' }]);
});
