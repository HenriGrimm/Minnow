import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';
import DOMPurify from 'dompurify';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { createEmptyChatObject, setSessionStateForTests } from '../../src/state/sessions.ts';
import { renderChatFromHistory, renderEmbeddedChatTranscript, cancelChatHistoryBackfill } from '../../src/ui/messages.ts';
import { installChatWorkView, disposeChatWorkView } from '../../src/ui/chat-work.ts';
import { setStreaming } from '../../src/app-state.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';

let win, mount, chat;
const originalFetch = globalThis.fetch;
const calls = (ids, content = '') => [
  { role: 'assistant', content, tool_calls: ids.map(id => ({ id, type: 'function',
    function: { name: 'read_file', arguments: JSON.stringify({ path: `src/${id}.ts` }) } })) },
  ...ids.map(id => ({ role: 'tool', tool_call_id: id, content: `Contents of ${id}` })),
];
const toolIds = root => [...root.querySelectorAll('.tool-call-msg')].map(row => row.dataset.toolCallId);
const groups = () => [...mount.querySelectorAll(':scope > .tool-call-batch')];

beforeEach(() => {
  win = new Window();
  installHappyDomGlobals(win);
  DOMPurify.sanitize = DOMPurify(win).sanitize;
  setStorageModeForTests('localStorage');
  globalThis.fetch = async () => Response.json([]);
  mount = document.createElement('div');
  mount.id = 'chatArea';
  document.body.append(mount);
  chat = createEmptyChatObject('');
  chat.history = [{ role: 'user', content: 'Inspect the implementation.' }, ...calls(['a']), ...calls(['b']),
    { role: 'assistant', content: 'Finished.' }];
  setSessionStateForTests({ version: 2, activeId: chat.id, sidebarCollapsed: false, chats: [chat] });
});

afterEach(() => {
  disposeChatWorkView(mount);
  cancelChatHistoryBackfill();
  setSessionStateForTests(null);
  setStreaming(false, chat.id);
  setStorageModeForTests(null);
  globalThis.fetch = originalFetch;
  win.close();
});

test('reopened work combines single-call rounds and retains original results and disclosure choices', () => {
  chat.history[4].content = 'Error: file not found';
  const saved = JSON.stringify(chat.history);
  renderChatFromHistory(chat);
  const batch = groups()[0];
  const work = mount.querySelector('.chat-work');
  assert.equal(groups().length, 1);
  assert.equal(batch.open, false);
  assert.equal(batch.classList.contains('chat-work-hidden'), true);
  work.click();
  assert.equal(batch.classList.contains('chat-work-hidden'), false);
  assert.equal(batch.querySelector('.tool-call-batch__label').textContent, 'Explored 2 files, 1 failed');
  assert.deepEqual(toolIds(batch), ['a', 'b']);
  assert.equal(batch.querySelectorAll('.tool-call-msg.chat-work-hidden').length, 0);
  assert.equal(batch.querySelectorAll('.tool-call-details').length, 2);
  batch.open = true;
  const row = batch.querySelector('.tool-call-msg');
  const details = row.querySelector('.tool-call-details');
  details.open = true;
  assert.match(row.textContent, /Contents of a/);
  work.click();
  work.click();
  assert.equal(groups()[0], batch);
  assert.equal(batch.querySelector('.tool-call-msg'), row);
  assert.equal(batch.open, true);
  assert.equal(details.open, true);
  assert.equal(JSON.stringify(chat.history), saved);
  renderChatFromHistory(chat);
  assert.equal(groups().length, 1);
  assert.deepEqual(toolIds(groups()[0]), ['a', 'b']);
});

test('narration, reasoning, and user turns remain boundaries between tool groups', () => {
  const thinkingRound = calls(['e']);
  thinkingRound[0].thinking = ['Check another area.'];
  chat.history = [{ role: 'user', content: 'Inspect.' }, ...calls(['a']), ...calls(['b']),
    ...calls(['c'], 'Now inspect the other area.'), ...calls(['d']), ...thinkingRound,
    ...calls(['f']), { role: 'assistant', content: 'First task done.' },
    { role: 'user', content: 'Inspect again.' }, ...calls(['g']), ...calls(['h']),
    { role: 'assistant', content: 'All done.' }];
  renderChatFromHistory(chat);
  assert.deepEqual(groups().map(toolIds), [['a', 'b'], ['c', 'd'], ['e', 'f'], ['g', 'h']]);
  assert.equal(mount.querySelectorAll('.thoughts-panel-wrap').length, 1);
  assert.match(mount.textContent, /Now inspect the other area/);
  assert.equal(mount.querySelectorAll('.chat-work').length, 2);
  assert.equal(mount.querySelectorAll('.tool-call-batch .tool-call-batch').length, 0);
});

test('existing round batches combine with adjacent calls after completion without changing active rows', () => {
  chat.history = [{ role: 'user', content: 'Inspect.' }, ...calls(['a', 'b']), ...calls(['c']),
    { role: 'assistant', content: 'Done.' }];
  setStreaming(true, chat.id);
  renderChatFromHistory(chat);
  const originalBatch = groups()[0];
  const single = mount.querySelector(':scope > .tool-call-msg');
  assert.deepEqual(toolIds(originalBatch), ['a', 'b']);
  assert.equal(single.dataset.toolCallId, 'c');
  originalBatch.open = true;
  setStreaming(false, chat.id);
  installChatWorkView(mount, chat, () => false);
  assert.equal(groups()[0], originalBatch);
  assert.equal(originalBatch.querySelector('[data-tool-call-id="c"]'), single);
  assert.equal(originalBatch.open, true);
  assert.deepEqual(toolIds(originalBatch), ['a', 'b', 'c']);
});

test('older history pages merge into the existing group in order and preserve its open state', async () => {
  chat.history = [{ role: 'user', content: 'Inspect many files.' },
    ...Array.from({ length: 45 }, (_, i) => calls([`file-${i}`])).flat(),
    { role: 'assistant', content: 'Done.' }];
  renderChatFromHistory(chat);
  mount.querySelector('.chat-work').click();
  const batch = groups()[0];
  batch.open = true;
  const lastRow = batch.querySelector('.tool-call-msg:last-child');
  for (let page = 0; Number(mount.dataset.historyStart) > 0 && page < 10; page++) {
    mount.dispatchEvent(new win.WheelEvent('wheel', { deltaY: -40 }));
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  assert.equal(mount.dataset.historyStart, '0');
  assert.equal(groups().length, 1);
  assert.equal(groups()[0], batch);
  assert.equal(batch.open, true);
  assert.equal(batch.querySelector('.tool-call-msg:last-child'), lastRow);
  assert.deepEqual(toolIds(batch), Array.from({ length: 45 }, (_, i) => `file-${i}`));
  assert.equal(mount.querySelectorAll('.chat-work').length, 1);
});

test('secondary chat surfaces use the same completed tool groups', () => {
  const rendered = renderEmbeddedChatTranscript(chat, mount, new Set());
  try {
    assert.equal(groups().length, 1);
    mount.querySelector('.chat-work').click();
    assert.equal(groups()[0].classList.contains('chat-work-hidden'), false);
    assert.deepEqual(toolIds(groups()[0]), ['a', 'b']);
  } finally { rendered.dispose(); }
});
