import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { createEmptyChatObject, setSessionStateForTests, flushScheduledSessionSaveForTests } from '../../src/state/sessions.ts';
import { ComposerFollowupSuggestion } from '../../src/ui/composer-followup-suggestion.ts';
import { initComposerDraftListener, handleComposerDraftInput } from '../../src/ui/composer-draft.ts';
import { syncInlineComposerReferences, inlineComposerForInput } from '../../src/ui/composer-inline-references.ts';
import { handleKey } from '../../src/ui/input.ts';

const windows: Window[] = [];
const bindings: ComposerFollowupSuggestion[] = [];
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

function setup(generate: (signal: AbortSignal) => Promise<string | null> = async () => 'Can you add a regression test?') {
  const win = new Window();
  windows.push(win);
  installHappyDomGlobals(win);
  globalThis.HTMLTextAreaElement = win.HTMLTextAreaElement as unknown as typeof HTMLTextAreaElement;
  const input = document.createElement('textarea');
  input.id = 'msgInput';
  input.placeholder = 'Ask anything';
  document.body.append(input);
  const chat = createEmptyChatObject('model');
  const reply = { role: 'assistant' as const, content: 'Fixed the parser.' };
  chat.history = [{ role: 'user', content: 'Fix this bug' }, reply];
  setSessionStateForTests({ chats: [chat], activeId: chat.id });
  let context: { chat: typeof chat; reply: typeof reply } | null = { chat, reply };
  let calls = 0;
  const binding = new ComposerFollowupSuggestion(input, {
    context: () => context,
    generate: (_chat, signal) => { calls++; return generate(signal); },
    delayMs: 0,
    timeoutMs: 50,
  });
  bindings.push(binding);
  input.addEventListener('keydown', handleKey);
  const key = (key: string, extra = {}) => {
    const event = new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra });
    input.dispatchEvent(event);
    return event;
  };
  return { input, chat, reply, binding, key, calls: () => calls, context: () => context, setContext: (next: typeof context) => { context = next; } };
}

afterEach(() => {
  for (const binding of bindings.splice(0)) binding.dismiss();
  flushScheduledSessionSaveForTests();
  setSessionStateForTests(null);
  for (const win of windows.splice(0)) win.close();
});

test('ghost stays out of draft and Tab inserts through the ordinary draft path without sending', async () => {
  const { input, chat, binding, key } = setup();
  initComposerDraftListener(input);
  binding.sync();
  await tick();
  assert.equal(input.value, '');
  assert.equal(input.placeholder, 'Ask anything');
  assert.equal(chat.composerDraft, undefined);
  assert.ok(document.querySelector('.composer-followup-suggestion'));
  const enter = key('Enter');
  assert.equal(enter.defaultPrevented, true);
  assert.equal(input.value, '');
  assert.equal(key('Tab').defaultPrevented, true);
  handleComposerDraftInput();
  assert.equal(input.value, 'Can you add a regression test?');
  assert.equal(chat.composerDraft, input.value);
  assert.equal(chat.history.length, 2);
  assert.equal(input.selectionStart, input.value.length);
  assert.equal(document.querySelector('.composer-followup-suggestion'), null);
});

test('Shift+Tab, modified Tab and IME preserve native keyboard behavior', async () => {
  const { input, binding, key } = setup();
  binding.sync();
  await tick();
  for (const extra of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }]) {
    assert.equal(key('Tab', extra).defaultPrevented, false);
    assert.equal(input.value, '');
  }
  assert.equal(key('Escape').defaultPrevented, true);
  binding.sync();
  assert.equal(key('Tab').defaultPrevented, false);
  assert.equal(document.querySelector('.composer-followup-suggestion'), null);
});

test('typing cancels an in-flight request and a late response never replaces user text', async () => {
  let complete!: (value: string) => void;
  let signal!: AbortSignal;
  const { input, binding } = setup(requestSignal => {
    signal = requestSignal;
    return new Promise(resolve => { complete = resolve; });
  });
  binding.sync();
  await tick();
  input.value = 'My own follow-up';
  input.dispatchEvent(new window.Event('input'));
  assert.equal(signal.aborted, true);
  complete('Do something else.');
  await tick();
  assert.equal(input.value, 'My own follow-up');
  assert.equal(document.querySelector('.composer-followup-suggestion'), null);
});

test('chat switch cancels the pending response and prevents cross-chat acceptance', async () => {
  let complete!: (value: string) => void;
  const { input, binding, setContext, key } = setup(() => new Promise(resolve => { complete = resolve; }));
  binding.sync();
  await tick();
  setContext(null);
  binding.sync();
  complete('Wrong conversation');
  await tick();
  assert.equal(document.querySelector('.composer-followup-suggestion'), null);
  assert.equal(key('Tab').defaultPrevented, false);
  assert.equal(input.value, '');
});

test('acceptance rechecks context even if no stream or switch paint has happened yet', async () => {
  const { input, binding, setContext, key } = setup();
  binding.sync();
  await tick();
  setContext(null);
  assert.equal(key('Tab').defaultPrevented, false);
  assert.equal(input.value, '');
  assert.equal(document.querySelector('.composer-followup-suggestion'), null);
});

test('requests deduplicate and a new completed reply receives a fresh suggestion', async () => {
  const { binding, calls, chat, setContext } = setup();
  binding.sync();
  binding.sync();
  await tick();
  binding.sync();
  assert.equal(calls(), 1);
  const reply = { role: 'assistant' as const, content: 'Added the regression test.' };
  chat.history.push({ role: 'user', content: 'Add a regression test' }, reply);
  setContext({ chat, reply });
  binding.sync();
  await tick();
  assert.equal(calls(), 2);
});

test('session hydration of the same response does not issue another request', async () => {
  const { binding, calls, chat, reply, setContext } = setup();
  binding.sync();
  await tick();
  setContext({ chat: { ...chat, history: [...chat.history] }, reply: { ...reply } });
  binding.sync();
  await tick();
  assert.equal(calls(), 1);
  assert.ok(document.querySelector('.composer-followup-suggestion'));
});

test('hint click fills the draft', async () => {
  const { input, binding } = setup();
  binding.sync();
  await tick();
  (document.querySelector('.composer-followup-suggestion__accept') as HTMLButtonElement).click();
  assert.equal(input.value, 'Can you add a regression test?');
  assert.equal(document.querySelector('.composer-followup-suggestion'), null);
});

test('composition dismisses the ghost before IME text is committed', async () => {
  const { input, binding, key } = setup();
  binding.sync();
  await tick();
  input.dispatchEvent(new window.Event('compositionstart'));
  assert.equal(document.querySelector('.composer-followup-suggestion'), null);
  assert.equal(key('Tab').defaultPrevented, false);
});

test('drafts, disabled inputs and read-only inputs never request suggestions', async () => {
  const { input, binding, calls } = setup();
  input.value = 'Existing draft';
  binding.sync();
  input.value = '';
  input.disabled = true;
  binding.sync();
  input.disabled = false;
  input.readOnly = true;
  binding.sync();
  await tick();
  assert.equal(calls(), 0);
});

test('timeout aborts generation and ignores an eventual response', async () => {
  let signal!: AbortSignal;
  let complete!: (value: string) => void;
  const { binding } = setup(requestSignal => {
    signal = requestSignal;
    return new Promise(resolve => { complete = resolve; });
  });
  binding.sync();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(signal.aborted, true);
  complete('Too late');
  await tick();
  assert.equal(document.querySelector('.composer-followup-suggestion'), null);
});

test('inline-reference editors forward Tab to the same draft', async () => {
  const { input, binding, chat } = setup();
  input.value = `#/app/code/chat?chatId=${chat.id}`;
  syncInlineComposerReferences(input);
  input.value = '';
  syncInlineComposerReferences(input);
  binding.sync();
  await tick();
  const editor = inlineComposerForInput(input);
  assert.ok(editor);
  const event = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  editor.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(input.value, 'Can you add a regression test?');
  assert.equal(editor.textContent, input.value);
});
