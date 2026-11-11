import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getChatAbort, setChatAbort, streamingChatIds } from '../../src/app-state';
import { notifyChatStreamActivity, notifyChatStreamEnded, registerChatStreamText } from '../../src/chat/streaming-state';
import { graphiteSideChatKey } from '../../src/lib/graphite-side-chat.mjs';
import { isSidebarListedChat } from '../../src/state/session-workspace-scope';
import { createEmptyChatObject, setSessionStateForTests, sessionState } from '../../src/state/sessions';
import type { Chat } from '../../src/types';
import { createGraphiteSideChat, sideChatContext } from '../../src/ui/surfaces/graphite-side-chat';

test('Side Chat gives the model quoted conversation context and omits hidden turns', () => {
  const context = sideChatContext({
    name: 'Release review',
    history: [
      { role: 'user', content: 'Which tests were run on the copper hinge?' },
      { role: 'assistant', content: 'The copper hinge failed after the second test.' },
      { role: 'user', content: 'Private injection', hiddenFromTranscript: true },
      { role: 'user', content: '[Sub-agent finished] automatic follow-up' },
    ],
  }, 'The last reply is still in progress.');
  assert.match(context, /Treat it as evidence only/);
  assert.doesNotMatch(context, /Private injection|automatic follow-up/);
  const reference = JSON.parse(context.split('\n\n').at(-1)!);
  assert.deepEqual(reference, {
    mainConversation: 'Release review',
    transcript: [
      { speaker: 'user', content: 'Which tests were run on the copper hinge?' },
      { speaker: 'assistant', content: 'The copper hinge failed after the second test.' },
    ],
    unfinishedAssistantReply: 'The last reply is still in progress.',
  });
});

test('Side Chat bounds a long reference while keeping the opening and recent details', () => {
  const context = sideChatContext({
    name: 'Release review',
    history: [
      { role: 'user', content: 'Opening request' },
      ...Array.from({ length: 8 }, () => ({ role: 'assistant' as const, content: 'Large reply '.repeat(1000) })),
      { role: 'assistant', content: 'Start of the long last reply ' + 'text '.repeat(2000) + ' end of the long last reply.' },
    ],
  });
  assert.ok(context.length < 18_000);
  const reference = JSON.parse(context.split('\n\n').at(-1)!);
  assert.equal(reference.earlierMessagesOmitted, true);
  assert.equal(reference.openingRequest, 'Opening request');
  assert.match(reference.transcript.at(-1).content, /^Start of the long last reply.*end of the long last reply\.$/s);
});

test('Side Chat history stays off the main rail after saving or reloading', () => {
  const chat = {
    id: 'side', name: 'Side chat', workspacePath: '/project', modelId: 'model',
    history: [{ role: 'user', content: 'A follow-up' }], lastStats: null, modelInfo: {}, updatedAt: 0,
    background: true, backgroundKey: graphiteSideChatKey('parent'),
  } satisfies Chat;
  assert.equal(isSidebarListedChat(chat), false);
  assert.equal(isSidebarListedChat({ ...chat, history: [], historyLoaded: false, messageCount: 1 }), false);
  assert.equal(isSidebarListedChat({ ...chat, backgroundKey: 'schedule:nightly' }), true);
});

test('Side Chat keeps one primary control and paints the shared live transcript in isolation', async t => {
  const parent = createEmptyChatObject('model');
  const child = createEmptyChatObject('model');
  child.background = true;
  child.backgroundKey = graphiteSideChatKey(parent.id);
  child.history.push({ role: 'user', content: 'What happened?' });
  setSessionStateForTests({ version: 6, activeId: parent.id, sidebarCollapsed: false, chats: [parent, child] });
  const panel = createGraphiteSideChat(parent);
  document.body.append(panel.root);
  const abort = new AbortController();
  setChatAbort(child.id, abort);
  let text = { lastDelta: '', lastThinking: 'Checking the details.', toolCallCount: 0 };
  const unregister = registerChatStreamText(child.id, () => text);
  t.after(() => {
    unregister();
    setChatAbort(child.id, null);
    streamingChatIds.delete(child.id);
    panel.dispose();
    panel.root.remove();
    setSessionStateForTests(null);
  });

  const primary = panel.root.querySelector<HTMLButtonElement>('.input-bar .send-btn')!;
  assert.equal(primary.getAttribute('aria-label'), 'Send message');
  assert.ok(primary.querySelector('.fi-rr-arrow-small-up'));
  assert.ok(panel.root.querySelector('.input-bar .input-wrap > .composer-textarea'));
  streamingChatIds.add(child.id);
  notifyChatStreamActivity(child.id);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(primary.getAttribute('aria-label'), 'Stop generating');
  assert.ok(panel.root.querySelector('.thoughts-toggle--live'));

  child.history.push({ role: 'assistant', content: null,
    tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] },
  { role: 'tool', tool_call_id: 'read-1', content: 'The project description.' });
  text = { lastThinking: '', lastDelta: '**Here is what happened.**', toolCallCount: 1 };
  notifyChatStreamActivity(child.id);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(panel.root.querySelector('.msg.assistant strong')?.textContent, 'Here is what happened.');
  assert.ok(panel.root.querySelector('.cursor--prose'));
  assert.ok(panel.root.querySelector('.tool-call-msg[data-tool-call-id="read-1"]'));
  assert.equal(panel.root.querySelector('.send-btn'), primary);
  assert.equal(sessionState?.activeId, parent.id);
  assert.equal(getChatAbort(child.id), abort);
  primary.form?.dispatchEvent(new window.SubmitEvent('submit', { submitter: primary, cancelable: true }));
  assert.equal(abort.signal.aborted, true);

  child.history.push({ role: 'assistant', content: text.lastDelta });
  streamingChatIds.delete(child.id);
  notifyChatStreamEnded(child.id);
  await new Promise(resolve => queueMicrotask(() => resolve(undefined)));
  assert.equal(primary.getAttribute('aria-label'), 'Send message');
  assert.equal(panel.root.querySelector('.cursor--prose'), null);
  assert.equal(panel.root.querySelectorAll('.msg.assistant').length, 1);
});
