import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { mountReefChat } from '../../src/ui/reef-chat.ts';
import { launchInstance } from '../../src/os/instances.ts';
import { getActiveComposerSurface } from '../../src/ui/composer-surface.ts';
import { createEmptyChatObject, setSessionStateForTests, getActiveChat } from '../../src/state/sessions.ts';
import type { ReefApp } from '../../src/reef/types.ts';

test('scoped Reef composer dispatch preserves Code chat and draft, and blocks edits during builds', async () => {
  const dom = new Window();
  globalThis.window = dom as unknown as Window & typeof globalThis;
  globalThis.document = dom.document as unknown as Document;
  globalThis.HTMLElement = dom.HTMLElement as unknown as typeof HTMLElement;
  const code = createEmptyChatObject('11111111-1111-1111-1111-111111111111');
  code.composerDraft = 'unfinished Code request';
  setSessionStateForTests({ version: 3, activeId: code.id, chats: [code], sidebarCollapsed: false });
  document.body.innerHTML = '<textarea id="msgInput">unfinished Code request</textarea><button id="sendBtn"></button><aside></aside>';
  const sent: string[] = [];
  const host = document.querySelector('aside')!;
  const chat = mountReefChat(host, async text => { sent.push(text); });
  const app = { messages: [] } as unknown as ReefApp;
  try {
    launchInstance('reef');
    const surface = getActiveComposerSurface();
    assert.equal(surface.inputEl, host.querySelector('textarea'));
    surface.inputEl!.value = 'Add a tip percentage';
    chat.update(app, true);
    surface.onPrimaryAction!();
    assert.deepEqual(sent, []);
    assert.equal(surface.inputEl!.disabled, true);
    chat.update(app, false);
    surface.onPrimaryAction!();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(sent, ['Add a tip percentage']);
    assert.equal(getActiveChat().id, code.id);
    assert.equal(code.composerDraft, 'unfinished Code request');
    launchInstance('code');
    assert.equal(getActiveComposerSurface().inputEl!.value, 'unfinished Code request');
  } finally { chat.dispose(); setSessionStateForTests(null); dom.happyDOM.abort(); }
});
