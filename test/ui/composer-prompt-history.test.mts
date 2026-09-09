/**
 * Composer ArrowUp/ArrowDown prompt history (MIN-338).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Window } from 'happy-dom';

const {
  __resetComposerPromptHistoryForTests,
  collectChatUserPrompts,
  handleComposerPromptHistoryKeydown,
  isComposerCaretAtEnd,
  isComposerCaretAtStart,
  resetComposerPromptHistory,
} = await import('../../src/ui/composer-prompt-history.ts');
const { setSessionStateForTests, createEmptyChatObject } = await import(
  '../../src/state/sessions.ts'
);

function mountInput(id: string): HTMLTextAreaElement {
  const input = document.createElement('textarea');
  input.id = id;
  document.body.appendChild(input);
  return input;
}

function keydown(input: HTMLTextAreaElement, key: string): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  return handleComposerPromptHistoryKeydown(event, input);
}

describe('composer-prompt-history', () => {
  it('collectChatUserPrompts skips goal rows and restores slash skills', () => {
    const prompts = collectChatUserPrompts([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second\n[skill: git-commit]' },
      { role: 'user', content: 'done', goalAchieved: true },
      { role: 'user', content: '   ' },
      {
        role: 'user',
        content: [{ type: 'text', text: 'from a screenshot follow-up' }],
        toolImageFollowUp: true,
      } as never,
      {
        role: 'user',
        content: [{ type: 'text', text: 'visible parts row' }],
      } as never,
    ]);
    assert.deepEqual(prompts, ['first', '/git-commit second', 'visible parts row']);
  });

  it('only intercepts arrows at collapsed composer edges', () => {
    const window = new Window();
    globalThis.document = window.document;
    globalThis.HTMLElement = window.HTMLElement;
    globalThis.KeyboardEvent = window.KeyboardEvent;
    globalThis.Event = window.Event;

    const input = mountInput('msgInput');
    input.value = 'line one\nline two';
    input.setSelectionRange(3, 3);
    assert.equal(isComposerCaretAtStart(input), false);
    assert.equal(isComposerCaretAtEnd(input), false);

    input.setSelectionRange(0, 0);
    assert.equal(isComposerCaretAtStart(input), true);

    input.setSelectionRange(input.value.length, input.value.length);
    assert.equal(isComposerCaretAtEnd(input), true);
  });

  it('walks per-chat user prompts and restores empty draft at the tail', () => {
    const window = new Window();
    globalThis.document = window.document;
    globalThis.HTMLElement = window.HTMLElement;
    globalThis.KeyboardEvent = window.KeyboardEvent;
    globalThis.Event = window.Event;

    __resetComposerPromptHistoryForTests();

    const chatA = createEmptyChatObject('model-a');
    chatA.history = [
      { role: 'user', content: 'alpha' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'beta' },
    ];
    const chatB = createEmptyChatObject('model-b');
    chatB.history = [{ role: 'user', content: 'other chat' }];
    setSessionStateForTests({
      activeId: chatA.id,
      chats: [chatA, chatB],
      lastActiveChatIdByWorkspace: {},
    });

    const input = mountInput('msgInput');
    input.value = '';
    input.setSelectionRange(0, 0);

    assert.equal(keydown(input, 'ArrowUp'), true);
    assert.equal(input.value, 'beta');

    input.setSelectionRange(0, 0);
    assert.equal(keydown(input, 'ArrowUp'), true);
    assert.equal(input.value, 'alpha');

    input.setSelectionRange(input.value.length, input.value.length);
    assert.equal(keydown(input, 'ArrowDown'), true);
    assert.equal(input.value, 'beta');

    input.setSelectionRange(input.value.length, input.value.length);
    assert.equal(keydown(input, 'ArrowDown'), true);
    assert.equal(input.value, '');

    setSessionStateForTests({
      activeId: chatB.id,
      chats: [chatA, chatB],
      lastActiveChatIdByWorkspace: {},
    });
    resetComposerPromptHistory();
    input.value = '';
    input.setSelectionRange(0, 0);
    assert.equal(keydown(input, 'ArrowUp'), true);
    assert.equal(input.value, 'other chat');
  });

  it('does not steal arrows mid-multiline edit', () => {
    const window = new Window();
    globalThis.document = window.document;
    globalThis.HTMLElement = window.HTMLElement;
    globalThis.KeyboardEvent = window.KeyboardEvent;
    globalThis.Event = window.Event;

    __resetComposerPromptHistoryForTests();

    const chat = createEmptyChatObject('model');
    chat.history = [{ role: 'user', content: 'prior' }];
    setSessionStateForTests({
      activeId: chat.id,
      chats: [chat],
      lastActiveChatIdByWorkspace: {},
    });

    const input = mountInput('msgInput');
    input.value = 'line one\nline two';
    input.setSelectionRange(5, 5);
    assert.equal(keydown(input, 'ArrowUp'), false);
    assert.equal(input.value, 'line one\nline two');
  });
});
