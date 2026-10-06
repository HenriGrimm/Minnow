import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Window } from 'happy-dom';
import { buildCodeMapChatRequest } from '../../src/ui/code-map/chat-request.ts';
import { renderUserMessageBubble } from '../../src/ui/user-message-bubble.ts';

const win = new Window();
Object.assign(globalThis, { window: win, document: win.document, HTMLElement: win.HTMLElement });
after(() => win.happyDOM.abort());

test('the agent receives the question, source, location and relationships behind the card', () => {
  const request = buildCodeMapChatRequest({
    question: 'What calls this?', title: 'start', kind: 'function', path: 'src/main.ts', line: 12,
    summary: 'Starts the workspace.',
  }, {
    workspaceRoot: 'C:/repo', symbol: { name: 'start', line_start: 12 },
    source: 'export function start() {}', usedBy: [{ path: 'src/boot.ts', count: 3 }],
  });
  assert.match(request.prompt, /What calls this\?/);
  assert.match(request.prompt, /C:\/repo/);
  assert.match(request.prompt, /export function start/);
  assert.match(request.prompt, /src\/boot.ts/);
  assert.match(request.prompt, /UNTRUSTED_SOURCE_DATA/);
  const bubble = document.createElement('div');
  const persisted = JSON.parse(JSON.stringify({ role: 'user', content: request.prompt, codeMap: request.card }));
  renderUserMessageBubble(bubble, persisted.content, { codeMap: persisted.codeMap });
  assert.equal(bubble.querySelector('article strong')?.textContent, 'start');
  assert.match(bubble.textContent!, /src\/main.ts:12/);
  assert.match(bubble.textContent!, /What calls this\?/);
  assert.ok(!bubble.textContent!.includes('export function start'));
  assert.ok(!bubble.textContent!.includes('Code Map context'));
});

test('large source context is bounded and hostile card text cannot create markup', () => {
  const request = buildCodeMapChatRequest({
    question: '<script>question</script>', title: '<img src=x onerror=evil()>', kind: 'file',
  }, { source: 'x'.repeat(100_000) });
  assert.ok(request.prompt.length < 30_000);
  assert.match(request.prompt, /truncated/);
  const bubble = document.createElement('div');
  renderUserMessageBubble(bubble, request.prompt, { codeMap: request.card });
  assert.equal(bubble.querySelector('img,script'), null);
  assert.match(bubble.textContent!, /<script>question<\/script>/);
});
