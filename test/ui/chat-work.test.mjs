import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';
import DOMPurify from 'dompurify';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { createEmptyChatObject, setSessionStateForTests } from '../../src/state/sessions.ts';
import { renderChatFromHistory, cancelChatHistoryBackfill, appendStreamingAssistantRow } from '../../src/ui/messages.ts';
import { setStreaming } from '../../src/app-state.ts';
import { attachToolStartIndicator } from '../../src/ui/stream-status.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { installChatWorkView, disposeChatWorkView } from '../../src/ui/chat-work.ts';
import { setChatView } from '../../src/appearance/chat-view.ts';
import { collectTranscriptTurns } from '../../src/chat/transcript-turns.ts';
import { getPerFileChangeSummary } from '../../src/usage/code-change-ledger.ts';

let win, mount, chat;
const originalFetch = globalThis.fetch;
const tool = (id, path) => [
  { role: 'assistant', content: 'I’ll update the file.', thinking: ['Checking the existing implementation.'],
    tool_calls: [{ id, type: 'function', function: { name: 'replace_text_in_file', arguments: JSON.stringify({ path, old_text: 'old', new_text: 'new' }) } }] },
  { role: 'tool', tool_call_id: id, content: 'Updated file',
    codeChange: { path, additions: 2, deletions: 1, diffLines: [{ type: 'remove', text: 'old' }, { type: 'add', text: 'new' }] } },
];

beforeEach(() => {
  win = new Window();
  installHappyDomGlobals(win);
  DOMPurify.sanitize = DOMPurify(win).sanitize;
  setStorageModeForTests('localStorage');
  globalThis.fetch = async () => new Response('[]', { headers: { 'Content-Type': 'application/json' } });
  mount = document.createElement('div');
  mount.id = 'chatArea';
  document.body.append(mount);
  chat = createEmptyChatObject('');
  chat.history = [{ role: 'user', content: 'Update the chat.' }, ...tool('a', 'src/chat.ts'),
    { role: 'assistant', content: 'Updated the chat. Tests pass.', thinking: ['Verify the change.'] }];
  chat.runs = [{ runId: 'r1', branchId: 'b1', forkHistoryIndex: 0, status: 'completed', createdAt: 1000, endedAt: 182000 }];
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

test('compact history keeps the final answer visible and groups tools and thoughts without replacing nodes', () => {
  renderChatFromHistory(chat);
  const work = mount.querySelector('.chat-work');
  const toolRow = mount.querySelector('.tool-call-msg');
  const final = mount.querySelector('.chat-turn-final');
  assert.match(work.textContent, /Worked for 3m 1s/);
  assert.equal(work.getAttribute('aria-expanded'), 'false');
  assert.ok(toolRow.classList.contains('chat-work-hidden'));
  assert.ok(!final.classList.contains('chat-work-hidden'));
  assert.ok(final.querySelector('.thoughts-panel-wrap').classList.contains('chat-work-hidden'));
  assert.match(mount.querySelector('.chat-turn-changes').textContent, /Edited 1 file/);
  work.click();
  assert.equal(work.getAttribute('aria-expanded'), 'true');
  assert.equal(mount.querySelector('.tool-call-msg'), toolRow);
  assert.ok(!toolRow.classList.contains('chat-work-hidden'));
  work.click();
  assert.ok(toolRow.classList.contains('chat-work-hidden'));
});

test('full view keeps tool calls and thoughts collapsed and stays open through completion', () => {
  renderChatFromHistory(chat);
  setChatView('full');
  assert.equal(mount.dataset.chatView, 'full');
  assert.equal(mount.querySelector('.chat-work').disabled, true);
  assert.equal(mount.querySelectorAll('.chat-work-hidden').length, 0);
  assert.ok([...mount.querySelectorAll('.tool-call-msg > .tool-call-details')].every((el) => !el.open));
  assert.ok([...mount.querySelectorAll('.thoughts-toggle')].every((el) => el.getAttribute('aria-expanded') === 'false'));
  renderChatFromHistory(chat);
  assert.equal(mount.dataset.chatView, 'full');
  setChatView('compact');
  assert.equal(mount.querySelector('.chat-work').disabled, false);
  assert.ok(mount.querySelector('.tool-call-msg').classList.contains('chat-work-hidden'));
});

test('the expanded transcript survives a history repaint', () => {
  renderChatFromHistory(chat);
  mount.querySelector('.chat-work').click();
  renderChatFromHistory(chat);
  assert.equal(mount.querySelector('.chat-work').getAttribute('aria-expanded'), 'true');
});

test('file summaries belong only to the turn that made the changes', () => {
  chat.history.push({ role: 'user', content: 'Now update settings.' }, ...tool('b', 'src/settings.ts'),
    { role: 'assistant', content: 'Settings updated.' });
  renderChatFromHistory(chat);
  const cards = mount.querySelectorAll('.chat-turn-changes');
  assert.equal(cards.length, 2);
  assert.match(cards[0].textContent, /src\/chat.ts/);
  assert.doesNotMatch(cards[0].textContent, /src\/settings.ts/);
  assert.match(cards[1].textContent, /src\/settings.ts/);
  assert.doesNotMatch(cards[1].textContent, /src\/chat.ts/);
});

test('live work settles automatically and exposes the final answer', async () => {
  renderChatFromHistory(chat);
  let live = true;
  disposeChatWorkView(mount);
  installChatWorkView(mount, chat, () => live);
  assert.match(mount.querySelector('.chat-work').textContent, /Working/);
  assert.ok(mount.querySelector('[data-history-index="3"]').classList.contains('chat-work-hidden'));
  live = false;
  await new Promise((resolve) => setTimeout(resolve, 1150));
  assert.match(mount.querySelector('.chat-work').textContent, /Worked for/);
  assert.ok(!mount.querySelector('[data-history-index="3"]').classList.contains('chat-work-hidden'));
});

test('failed and stopped partial replies remain visible with recovery controls', () => {
  chat.history[3].failed = true;
  chat.runs[0].status = 'failed';
  renderChatFromHistory(chat);
  assert.match(mount.querySelector('.chat-work').textContent, /Failed for/);
  assert.ok(!mount.querySelector('.msg--failed').classList.contains('chat-work-hidden'));
  chat.history[3].failed = false;
  chat.history[3].stopped = true;
  chat.runs[0].status = 'stopped';
  renderChatFromHistory(chat);
  assert.match(mount.querySelector('.chat-work').textContent, /Stopped for/);
  assert.ok(!mount.querySelector('.msg--stopped').classList.contains('chat-work-hidden'));
});

test('a plain live reply becomes visible when work completes without tools or thoughts', () => {
  chat.history = [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hello there.' }];
  renderChatFromHistory(chat);
  let live = true;
  disposeChatWorkView(mount);
  installChatWorkView(mount, chat, () => live);
  assert.ok(mount.querySelector('.msg.assistant').classList.contains('chat-work-hidden'));
  live = false;
  installChatWorkView(mount, chat, () => live);
  assert.ok(!mount.querySelector('.msg.assistant').classList.contains('chat-work-hidden'));
});

test('the actual streaming shell reports thinking, runtime progress, and tools as arguments arrive', async () => {
  chat.history = [{ role: 'user', content: 'Run the tests.' }];
  chat.runs = [];
  setStreaming(true, chat.id);
  renderChatFromHistory(chat);
  const row = appendStreamingAssistantRow(chat.id);
  row.streamStatus.setPhase('thinking');
  row.streamStatus.setRuntimeDetail('24 tokens');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.match(mount.querySelector('.chat-work__detail').textContent, /Thinking.*24 tokens/);
  const toolStart = attachToolStartIndicator(row);
  toolStart.show('execute_command');
  for (let i = 0; i < 25 && !mount.querySelector('.chat-work__detail').textContent.includes('Calling'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(mount.querySelector('.chat-work__detail').textContent, /Calling.*command/i);
  assert.ok(row.wrap.classList.contains('chat-work-hidden'));
  mount.querySelector('.chat-work').click();
  assert.ok(!row.wrap.classList.contains('chat-work-hidden'));
  assert.equal(mount.querySelector('.tool-start-indicator').parentElement, row.wrap);
  toolStart.dispose();
  row.streamStatus.dispose();
});

test('review expands recorded diffs and more files is reversible', async () => {
  chat.history = [{ role: 'user', content: 'Update four files' }, ...['a', 'b', 'c', 'd'].flatMap((name) => tool(name, `${name}.ts`)),
    { role: 'assistant', content: 'Updated four files.' }];
  renderChatFromHistory(chat);
  const rows = [...mount.querySelectorAll('.chat-turn-changes__file')];
  assert.equal(rows.filter((row) => !row.hidden).length, 3);
  mount.querySelector('.chat-turn-changes__more').click();
  assert.equal(rows.filter((row) => !row.hidden).length, 4);
  mount.querySelector('.chat-turn-changes__review').click();
  assert.ok(rows.every((row) => row.open));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(mount.querySelector('.chat-turn-changes__diff'));
});

test('long-history backfill merges work into one disclosure per turn', async () => {
  chat.history = [{ role: 'user', content: 'Many steps' }, ...Array.from({ length: 25 }, (_, i) => tool(String(i), `${i}.ts`)).flat(),
    { role: 'assistant', content: 'Finished all steps.' }];
  renderChatFromHistory(chat);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(mount.querySelectorAll('.chat-work').length, 1);
  assert.equal(mount.querySelectorAll('.tool-call-msg').length, 25);
  assert.equal(mount.querySelectorAll('.tool-call-msg.chat-work-hidden').length, 25);
  assert.equal(mount.querySelectorAll('.chat-turn-changes').length, 1);
});

test('selected branches supply duration and tool-only tails have no final answer', () => {
  chat.runs.push({ ...chat.runs[0], runId: 'r2', branchId: 'b2', createdAt: 2000, endedAt: 8000 });
  chat.activeBranchByFork = { '0': 'b1' };
  assert.equal(collectTranscriptTurns(chat)[0].run.runId, 'r1');
  chat.history.push(...tool('last', 'last.ts'));
  assert.equal(collectTranscriptTurns(chat)[0].finalIndex, null);
});

test('unloaded histories are never read for grouping or change summaries', () => {
  const unloaded = { historyLoaded: false, get history() { throw new Error('History must remain lazy'); } };
  assert.deepEqual(collectTranscriptTurns(unloaded), []);
  assert.deepEqual(getPerFileChangeSummary(unloaded), []);
});
