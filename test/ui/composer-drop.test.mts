/**
 * Composer drop: OS files as this-turn attachments; editor/browser tabs as durable chat links.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { Window } from 'happy-dom';
import { clearAttachments, getPendingAttachments } from '../../src/attachments/store.ts';
import { PREVIEW_TAB_MIME, VIEWER_TAB_MIME, resetTabDragForTests } from '../../src/attachments/tab-drag.ts';
import { initComposerDrop } from '../../src/ui/composer-drop.ts';
import { syncChatLinkChipsFromChat } from '../../src/ui/chat-link-chips.ts';
import {
  createEmptyChatObject,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';

function setupNestedCodeComposerDom(): { input: HTMLTextAreaElement; window: Window } {
  const window = new Window();
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.HTMLTextAreaElement = window.HTMLTextAreaElement;
  globalThis.window = window as unknown as Window & typeof globalThis.window;
  globalThis.File = window.File;
  globalThis.DragEvent = window.DragEvent;

  const viewport = document.createElement('div');
  viewport.className = 'chat-viewport';
  const chatArea = document.createElement('main');
  chatArea.id = 'chatArea';
  viewport.appendChild(chatArea);
  document.body.appendChild(viewport);

  const inputBar = document.createElement('div');
  inputBar.className = 'input-bar';

  const composer = document.createElement('div');
  composer.className = 'input-bar-composer';

  const chips = document.createElement('div');
  chips.id = 'chatLinkChips';
  chips.className = 'chat-link-chips hidden';

  const input = document.createElement('textarea');
  input.id = 'msgInput';

  composer.appendChild(chips);
  composer.appendChild(input);
  inputBar.append(composer);
  document.body.appendChild(inputBar);

  return { input, window };
}

function seedChat() {
  const chat = createEmptyChatObject('');
  chat.id = 'chat-drop-links';
  setSessionStateForTests({
    version: 6,
    activeId: chat.id,
    sidebarCollapsed: false,
    chats: [chat],
  });
  return chat;
}

/** Minimal DataTransfer for drop simulation (happy-dom lacks full DnD APIs). */
function makeFileDropTransfer(file: File): DataTransfer {
  const files = Object.assign([file], {
    item: (index: number) => [file][index] ?? null,
  });
  return {
    types: ['Files'],
    files: files as unknown as FileList,
    getData: () => '',
    dropEffect: 'none',
    effectAllowed: 'all',
  } as DataTransfer;
}

function makeTypedTransfer(data: Record<string, string>): DataTransfer {
  return {
    types: Object.keys(data),
    files: [] as unknown as FileList,
    getData: (type: string) => data[type] ?? '',
    dropEffect: 'none',
    effectAllowed: 'copyMove',
  } as DataTransfer;
}

describe('initComposerDrop', () => {
  let testWindow: Window | undefined;

  afterEach(() => {
    clearAttachments();
    resetTabDragForTests();
    setSessionStateForTests(null);
    document.body.replaceChildren();
    testWindow?.close();
    testWindow = undefined;
  });

  it('a disabled inspect-only composer rejects files and durable tab links before any mutation', async () => {
    const setup = setupNestedCodeComposerDom(); testWindow = setup.window;
    const chat = seedChat(); setup.input.disabled = true; initComposerDrop();
    const target = setup.input.closest('.input-bar')!;
    for (const transfer of [makeFileDropTransfer(new File(['text'], 'a.txt', { type: 'text/plain' })),
      makeTypedTransfer({ [VIEWER_TAB_MIME]: JSON.stringify({ kind: 'file', path: 'src/a.ts', label: 'a.ts' }) })]) {
      const event = new window.DragEvent('drop', { bubbles: true, cancelable: true }); Object.defineProperty(event, 'dataTransfer', { value: transfer });
      target.dispatchEvent(event); assert.equal(event.defaultPrevented, true);
    }
    await Promise.resolve();
    assert.deepEqual(getPendingAttachments(), []); assert.equal(chat.links, undefined);
    assert.equal(target.classList.contains('composer-drop-active'), false);
  });

  it('adds one attachment when an external file is dropped on a nested composer', async () => {
    const { input, window } = setupNestedCodeComposerDom();
    testWindow = window;
    initComposerDrop();

    const file = new File(['hello'], 'note.txt', { type: 'text/plain' });
    const transfer = makeFileDropTransfer(file);
    const event = new DragEvent('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });

    input.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(getPendingAttachments().length, 1);
    assert.equal(getPendingAttachments()[0]?.name, 'note.txt');
  });

  it('pins a file chip when an editor tab is dropped on the composer', () => {
    const { input, window } = setupNestedCodeComposerDom();
    testWindow = window;
    const chat = seedChat();
    initComposerDrop();

    const transfer = makeTypedTransfer({
      [VIEWER_TAB_MIME]: JSON.stringify({
        kind: 'file',
        path: 'src/main.ts',
        label: 'main.ts',
      }),
      'text/plain': 'file:src/main.ts',
    });
    const event = new DragEvent('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    input.dispatchEvent(event);

    assert.equal(chat.links?.length, 1);
    assert.equal(chat.links?.[0]?.kind, 'file');
    assert.equal(chat.links?.[0]?.path, 'src/main.ts');
    assert.equal(getPendingAttachments().length, 0);
    const chip = document.querySelector('#chatLinkChips .code-ref-link');
    assert.ok(chip);
    assert.match(chip.textContent ?? '', /main\.ts/);
  });

  it('pins a URL chip when a browser tab is dropped on the transcript', () => {
    const { window } = setupNestedCodeComposerDom();
    testWindow = window;
    const chat = seedChat();
    initComposerDrop();

    const transfer = makeTypedTransfer({
      [PREVIEW_TAB_MIME]: JSON.stringify({
        kind: 'url',
        url: 'https://example.com/docs',
        label: 'example.com',
      }),
      'text/plain': 'preview:tab-1',
    });
    const event = new DragEvent('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: transfer });
    document.querySelector('.chat-viewport')!.dispatchEvent(event);

    assert.equal(chat.links?.length, 1);
    assert.equal(chat.links?.[0]?.kind, 'url');
    assert.equal(chat.links?.[0]?.url, 'https://example.com/docs');
    const chip = document.querySelector('#chatLinkChips .code-ref-link');
    assert.ok(chip);
    assert.match(chip.textContent ?? '', /example\.com/);
  });

  it('paints persisted links after a simulated reload', () => {
    const { window } = setupNestedCodeComposerDom();
    testWindow = window;
    const chat = seedChat();
    chat.links = [
      {
        id: '11111111-1111-1111-1111-111111111111',
        kind: 'file',
        path: 'src/main.ts',
        label: 'main.ts',
        addedAt: 1,
      },
    ];
    syncChatLinkChipsFromChat(chat);
    const chip = document.querySelector('#chatLinkChips .code-ref-link');
    assert.ok(chip);
    assert.match(chip.textContent ?? '', /main\.ts/);
    assert.equal(document.getElementById('chatLinkChips')?.classList.contains('hidden'), false);
  });
});
