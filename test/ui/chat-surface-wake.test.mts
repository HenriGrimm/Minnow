import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { initRenderIdleTracking } from '../../src/boot/render-idle';
import { startChatSurfaceWake } from '../../src/ui/chat-surface-wake';
import { renderChatFromHistory } from '../../src/ui/messages';
import { createEmptyChatObject, markChatDirty, setSessionStateForTests } from '../../src/state/sessions';
import { launchInstance, resetInstancesForTests } from '../../src/os/instances';
import { initChatScroll } from '../../src/ui/chat-scroll';
import { streamingChatIds } from '../../src/app-state';
import { registerStreamDomRemount } from '../../src/tools/stream-chat-dom';

let stopWake = () => {};
let stopTracking = () => {};
let chatId = '';
const originalFetch = globalThis.fetch;
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
function visibility(value: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value });
  document.dispatchEvent(new window.Event('visibilitychange'));
}
function setup() {
  globalThis.fetch = async () => new Response('{}', { status: 503 });
  document.body.innerHTML = '<div id="chatArea"></div>';
  visibility('visible');
  resetInstancesForTests(); launchInstance('code');
  const chat = createEmptyChatObject(''); chatId = chat.id;
  chat.history = [{ role: 'user', content: 'Work while hidden' }];
  setSessionStateForTests({ version: 6, activeId: chat.id, sidebarCollapsed: false, chats: [chat] });
  initChatScroll(); renderChatFromHistory(chat);
  stopTracking = initRenderIdleTracking();
  return chat;
}
afterEach(() => {
  stopWake(); stopTracking();
  streamingChatIds.clear(); registerStreamDomRemount(chatId, null);
  setSessionStateForTests(null); resetInstancesForTests();
  globalThis.fetch = originalFetch;
});

test('a completed hidden turn repaints on wake; later idle wakes retain its DOM', () => {
  const chat = setup();
  let paints = 0;
  stopWake = startChatSurfaceWake(() => { paints += 1; renderChatFromHistory(chat); });
  visibility('hidden');
  chat.history.push({ role: 'assistant', content: 'Finished while the window was hidden.' });
  markChatDirty(chat);
  assert.doesNotMatch(document.getElementById('chatArea')!.textContent!, /Finished/);
  visibility('visible');
  assert.equal(paints, 1);
  assert.match(document.getElementById('chatArea')!.textContent!, /Finished/);
  const answer = document.querySelector('.msg.assistant');
  visibility('hidden'); visibility('visible');
  assert.equal(paints, 1);
  assert.equal(document.querySelector('.msg.assistant'), answer);
});

test('waking a live unchanged conversation retargets the painter without rebuilding history', () => {
  const chat = setup();
  let remounts = 0;
  const first = document.querySelector('.msg.user');
  streamingChatIds.add(chat.id);
  registerStreamDomRemount(chat.id, () => { remounts += 1; });
  stopWake = startChatSurfaceWake(() => assert.fail('unchanged history must be preserved'));
  visibility('hidden'); visibility('visible');
  assert.equal(remounts, 1);
  assert.equal(document.querySelector('.msg.user'), first);
});

test('a hidden Code conversation does not repaint over another foreground app on window wake', () => {
  const chat = setup();
  stopWake = startChatSurfaceWake(() => assert.fail('Code is not being presented'));
  visibility('hidden');
  chat.history.push({ role: 'assistant', content: 'Background result' }); markChatDirty(chat);
  launchInstance('settings');
  visibility('visible');
  assert.doesNotMatch(document.getElementById('chatArea')!.textContent!, /Background result/);
});
