/**
 * Composer ArrowUp/ArrowDown prompt history (MIN-338).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Window } from 'happy-dom';

const {
  __resetComposerPromptHistoryForTests,
  collectChatUserPrompts,
  composerPromptHistoryDraft,
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

function keydown(input: HTMLTextAreaElement, key: string, options: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  return handleComposerPromptHistoryKeydown(event, input);
}

describe('composer-prompt-history', () => {
  function setupHistory(): HTMLTextAreaElement {
    const window = new Window();
    globalThis.document = window.document;
    globalThis.HTMLElement = window.HTMLElement;
    globalThis.KeyboardEvent = window.KeyboardEvent;
    globalThis.Event = window.Event;
    __resetComposerPromptHistoryForTests();
    const chat = createEmptyChatObject('model');
    chat.history = [{ role: 'user', content: 'older' }, { role: 'user', content: 'newest' }];
    setSessionStateForTests({ activeId: chat.id, chats: [chat], lastActiveChatIdByWorkspace: {} });
    return mountInput('msgInput');
  }

  it('Down on a fresh draft never clears it or emits input', () => {
    const input = setupHistory();
    input.value = 'unsent work';
    input.setSelectionRange(input.value.length, input.value.length);
    let changes = 0;
    input.addEventListener('input', () => changes++);
    assert.equal(keydown(input, 'ArrowDown'), false);
    assert.equal(keydown(input, 'ArrowDown', { altKey: true }), false);
    assert.equal(input.value, 'unsent work');
    assert.equal(changes, 0);
  });

  it('Up then Down restores the typed draft and caret, keeping the draft durable during recall', () => {
    const input = setupHistory();
    input.value = '  unfinished prompt  ';
    input.setSelectionRange(0, 0);
    assert.equal(keydown(input, 'ArrowUp'), true);
    assert.equal(input.value, 'newest');
    assert.equal(composerPromptHistoryDraft(input), '  unfinished prompt  ');
    assert.equal(keydown(input, 'ArrowDown'), true);
    assert.equal(input.value, '  unfinished prompt  ');
    assert.equal(input.selectionStart, 0);
    input.setSelectionRange(input.value.length, input.value.length);
    assert.equal(keydown(input, 'ArrowDown'), false);
  });

  it('Alt+arrows preserve multiline drafts, selection, scrolling, and edits to recalled entries', () => {
    const input = setupHistory();
    input.value = 'first line\nsecond line';
    input.setSelectionRange(2, 8, 'backward');
    input.scrollTop = 60;
    assert.equal(keydown(input, 'ArrowUp', { altKey: true }), true);
    input.value = 'edited newest';
    assert.equal(keydown(input, 'ArrowUp', { altKey: true }), true);
    assert.equal(input.value, 'older');
    assert.equal(keydown(input, 'ArrowUp', { altKey: true }), false);
    assert.equal(keydown(input, 'ArrowDown', { altKey: true }), true);
    assert.equal(input.value, 'edited newest');
    assert.equal(keydown(input, 'ArrowDown', { altKey: true }), true);
    assert.equal(input.value, 'first line\nsecond line');
    assert.equal(input.selectionStart, 2);
    assert.equal(input.selectionEnd, 8);
    assert.equal(input.selectionDirection, 'backward');
    assert.equal(input.scrollTop, 60);
  });

  it('leaves plain arrows to multiline and wrapped text, including the edges', () => {
    const input = setupHistory();
    input.value = 'first\nlast';
    input.setSelectionRange(0, 0);
    assert.equal(keydown(input, 'ArrowUp'), false);
    input.setSelectionRange(input.value.length, input.value.length);
    assert.equal(keydown(input, 'ArrowDown'), false);
    input.value = 'a long line that wraps';
    Object.defineProperty(input, 'scrollHeight', { value: 100 });
    input.setSelectionRange(0, 0);
    assert.equal(keydown(input, 'ArrowUp'), false);
  });

  it('ignores held keys and IME composition', () => {
    const input = setupHistory();
    assert.equal(keydown(input, 'ArrowUp', { repeat: true }), false);
    assert.equal(keydown(input, 'ArrowUp', { isComposing: true }), false);
    assert.equal(input.value, '');
  });

  it('persists explicit edits to recalled text while retaining the original for Down', () => {
    const input = setupHistory();
    input.value = 'original draft';
    input.setSelectionRange(0, 0);
    keydown(input, 'ArrowUp');
    input.value = 'new wording typed after recall';
    assert.equal(composerPromptHistoryDraft(input), 'new wording typed after recall');
    keydown(input, 'ArrowUp', { altKey: true });
    assert.equal(composerPromptHistoryDraft(input), 'new wording typed after recall');
    keydown(input, 'ArrowDown', { altKey: true });
    assert.equal(input.value, 'new wording typed after recall');
    keydown(input, 'ArrowDown', { altKey: true });
    assert.equal(input.value, 'original draft');
    keydown(input, 'ArrowUp', { altKey: true });
    assert.equal(input.value, 'new wording typed after recall');
  });

  it('reset after send discards the saved draft', () => {
    const input = setupHistory();
    input.value = 'sent draft';
    input.setSelectionRange(0, 0);
    keydown(input, 'ArrowUp');
    resetComposerPromptHistory();
    input.value = '';
    keydown(input, 'ArrowUp');
    keydown(input, 'ArrowDown');
    assert.equal(input.value, '');
  });

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
