import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { showToolApprovalModal } from '../../src/ui/tool-approval-modal.ts';
import {
  createEmptyChatObject,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import { installHappyDomGlobals, teardownHappyDomAsync } from '../os/dom-helpers.mts';

describe('companion tool approval UI', () => {
  let win: import('happy-dom').Window;

  before(async () => {
    const { Window } = await import('happy-dom');
    win = new Window({ url: 'http://localhost/#/desktop' });
    installHappyDomGlobals(win);
  });

  after(async () => {
    setSessionStateForTests(null);
    await teardownHappyDomAsync(win);
  });

  test('offers only one-call approval or denial on a paired phone', { timeout: 3_000 }, async () => {
    document.documentElement.classList.add('minnow-companion');
    const chat = createEmptyChatObject('Phone task', 'C:\\workspace');
    chat.id = 'phone-chat';
    setSessionStateForTests({ version: 6, activeId: chat.id, chats: [chat] });
    document.body.innerHTML = `
      <div id="mainColumn">
        <div id="toolApprovalHost" hidden></div>
        <textarea id="msgInput"></textarea>
        <button id="sendBtn"></button>
      </div>
    `;
    const abort = new AbortController();
    const decision = showToolApprovalModal({
      chatId: 'phone-chat',
      toolName: 'save_file',
      title: 'Save file',
      argsJson: '{"path":"src/app.ts"}',
      signal: abort.signal,
    });
    const labels = [...document.querySelectorAll<HTMLElement>('.tool-approval-action__label')];
    assert.deepEqual(labels.filter((label) => !label.closest<HTMLButtonElement>('button')?.hidden).map((label) => label.textContent), [
      'Allow once',
      'Cancel',
    ]);
    assert.match(document.querySelector('.tool-approval-hints')?.textContent ?? '', /Companion approvals apply once/);
    abort.abort();
    assert.equal(await decision, 'cancel');
  });
});
