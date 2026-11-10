import assert from 'node:assert/strict';
import { test } from 'node:test';
import { graphiteSideChatKey } from '../../src/lib/graphite-side-chat.mjs';
import { isSidebarListedChat } from '../../src/state/session-workspace-scope';
import type { Chat } from '../../src/types';
import { sideChatContext } from '../../src/ui/surfaces/graphite-side-chat';

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
