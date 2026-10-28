import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { defaultSessionState } from '../../src/config/defaults.ts';
import { createEmptyChatObject, setSessionStateForTests } from '../../src/state/sessions.ts';
import { resetWorkspaceStateForTests, setWorkspaceFromServer } from '../../src/state/workspace.ts';
import { handleComposerDraftInput } from '../../src/ui/composer-draft.ts';
import { renderSidebar, subscribeSidebarRender } from '../../src/ui/sidebar.ts';

test('draft rail work waits for a typing pause, including repeat-backspace through empty', async () => {
  const win = new Window();
  installHappyDomGlobals(win);
  document.body.innerHTML = '<div id="chatList"></div><textarea id="msgInput"></textarea>';
  const workspace = 'C:/workspace/composer-draft-sidebar';
  setWorkspaceFromServer({ path: workspace, label: 'test', isDefault: false });
  const chat = createEmptyChatObject('draft-sidebar', workspace);
  setSessionStateForTests({ ...defaultSessionState(), chats: [chat], activeId: chat.id });
  renderSidebar();
  let renders = 0;
  const unsubscribe = subscribeSidebarRender(() => { renders++; });
  const input = document.getElementById('msgInput') as HTMLTextAreaElement;
  const type = (text: string): void => {
    input.value = text;
    handleComposerDraftInput();
  };
  try {
    type('hello');
    await delay(30);
    assert.equal(chat.composerDraft, 'hello', 'draft state stays current during typing');
    assert.equal(renders, 0, 'first character must not rebuild the rail');
    type('hello world');
    await delay(450);
    assert.equal(renders, 1, 'pending membership change survives subsequent characters');
    const row = document.querySelector('.chat-item-row')!;
    assert.equal(row.querySelector('.chat-item-name')?.textContent, 'hello world');

    type('hello worl');
    await delay(450);
    assert.equal(renders, 1, 'ordinary edits only patch the title');
    assert.equal(document.querySelector('.chat-item-row'), row);
    assert.equal(row.querySelector('.chat-item-name')?.textContent, 'hello worl');

    type('');
    await delay(250);
    type('');
    await delay(250);
    assert.equal(renders, 1, 'held Backspace postpones removal even after the draft is empty');
    await delay(200);
    assert.equal(renders, 2);
    assert.equal(document.querySelector('.chat-item-row'), null);

    chat.history = [{ role: 'user', content: 'Sent message' }];
    renderSidebar();
    const before = renders;
    type('follow-up');
    await delay(450);
    assert.equal(renders, before, 'draft presence does not change membership for a sent chat');
  } finally {
    unsubscribe();
    setSessionStateForTests(null);
    resetWorkspaceStateForTests();
    win.close();
  }
});
