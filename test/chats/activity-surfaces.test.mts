import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createEmptyChatObject, resetSessionPersistenceForTests, setSessionStateForTests } from '../../src/state/sessions.ts';
import { notifyManagedChatMetadata } from '../../src/chat/managed-chat-view.ts';
import { initAgentActivityMenubar, stopAgentActivityItem, acknowledgeAgentActivityItems } from '../../src/ui/agent-activity-panel.ts';
import { initElectronTrayBridge, disposeElectronTrayBridge } from '../../src/electron-tray-bridge.ts';
import { buildAgentActivitySnapshot } from '../../src/state/agent-activity-registry.ts';
import { buildActivityFeed } from '../../src/state/activity-feed.ts';
import { __testHooks as legacyProducer } from '../../src/notifications/producers.ts';
import { getNotifications, resetNotificationStoreForTests } from '../../src/notifications/store.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';

Object.assign(globalThis, { localStorage: window.localStorage, sessionStorage: window.sessionStorage });
const originalFetch = globalThis.fetch;
let disposePanel: (() => void) | undefined;
afterEach(() => {
  disposePanel?.(); disposePanel = undefined; disposeElectronTrayBridge(); delete window.minnow;
  globalThis.fetch = originalFetch; resetSessionPersistenceForTests(); setSessionStateForTests(null); resetNotificationStoreForTests();
  setStorageModeForTests(null); document.body.replaceChildren();
});
function setup() {
  const chat = createEmptyChatObject('next-model'); chat.id = 'activity-child'; chat.chatCommandVersion = 1;
  chat.profileReference = { profileId: 'profile', profileVersion: 1 };
  chat.agentConversation = { version: 1, childChatId: chat.id, parentChatId: 'parent', rootChatId: 'parent', journalOwnerId: 'parent', origin: 'delegated', createdAt: 1,
    capabilities: { canSend: true, canStop: true, canChooseModel: true } };
  chat.agentExecution = { executionId: 'pinned', status: 'running', createdAt: 100, updatedAt: 200, runId: 'task', modelSelection: { providerId: 'provider', modelId: 'captured' } };
  setSessionStateForTests({ version: 6, activeId: chat.id, sidebarCollapsed: false, chats: [chat] });
  return chat;
}
test('Activity Stop pins its displayed execution, stops its descendant tree, and never cancels the task mirror or replacement', async () => {
  const chat = setup(), bodies: any[] = [];
  const rows = buildAgentActivitySnapshot({ nowMs: 1000, chats: [chat], mainTurns: [], subAgents: [], titleJobs: [] });
  const item = buildActivityFeed({ chats: [chat], live: rows, notifications: [], pendingChatIds: new Set(), workspacePath: '' }).running[0];
  chat.agentExecution = { executionId: 'replacement', status: 'running' };
  globalThis.fetch = async (url, options) => { bodies.push({ url: String(url), body: JSON.parse(String(options?.body)) }); return Response.json({}); };
  await stopAgentActivityItem(item);
  assert.equal(bodies.length, 1); assert.equal(bodies[0].url, '/api/chats/activity-child/commands');
  assert.equal(bodies[0].body.executionId, 'pinned'); assert.equal(bodies[0].body.scope, 'tree'); assert.equal(bodies[0].body.action, 'stop');
  item.live!.canStop = false; await stopAgentActivityItem(item); assert.equal(bodies.length, 1);
});
test('panel metadata subscription is singular, responds to canonical waiting states, and releases on disposal', async () => {
  const chat = setup(); globalThis.fetch = async () => Response.json({ providers: [], serves: [], data: [] });
  const first = document.createElement('button'); document.body.append(first); disposePanel = initAgentActivityMenubar(first);
  assert.equal(first.dataset.agentCount, '1');
  const second = document.createElement('button'); document.body.append(second); disposePanel = initAgentActivityMenubar(second);
  chat.agentExecution!.status = 'waiting_for_model'; notifyManagedChatMetadata(chat.id);
  await new Promise(resolve => setTimeout(resolve, 130));
  assert.equal(second.dataset.agentCount, '0'); assert.equal(second.classList.contains('is-running'), false);
  assert.equal(first.dataset.agentCount, '1', 'replaced mount no longer receives metadata');
  disposePanel(); chat.agentExecution!.status = 'running'; notifyManagedChatMetadata(chat.id);
  await new Promise(resolve => setTimeout(resolve, 130)); assert.equal(second.dataset.agentCount, '0');
});
test('tray uses the same canonical running count and cleans up its metadata and command subscriptions', async () => {
  const chat = setup(), published: any[] = []; let commands = 0;
  setStorageModeForTests('server');
  globalThis.fetch = async () => Response.json({ providers: [], activeProviderId: '', serves: [], data: [] });
  window.minnow = { tray: { publishStatus: value => published.push(value), notifyReady() {}, onCommand: () => { commands++; return () => { commands--; }; } } } as any;
  initElectronTrayBridge(); initElectronTrayBridge();
  for (let count = 0; count < 100 && !published.length; count++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(commands, 1); assert.equal(published.at(-1)?.agentCount, 1);
  chat.agentExecution!.status = 'waiting_for_agents'; notifyManagedChatMetadata(chat.id);
  await new Promise(resolve => setTimeout(resolve, 460)); assert.equal(published.at(-1)?.agentCount, 0);
  disposeElectronTrayBridge(); const count = published.length;
  chat.agentExecution!.status = 'running'; notifyManagedChatMetadata(chat.id);
  await new Promise(resolve => setTimeout(resolve, 460)); assert.equal(published.length, count); assert.equal(commands, 0);
});
test('a persistent task mirror cannot produce a second legacy outcome notification', () => {
  setup(); resetNotificationStoreForTests();
  legacyProducer.handleSubAgentRun({ childChatId: 'activity-child', runId: 'task', parentChatId: 'parent', status: 'completed', summary: 'Duplicate result' } as any);
  assert.equal(getNotifications().length, 0);
});

test('late Activity acknowledgment cannot overwrite a newer execution or clear its unread failure', async () => {
  const chat = setup(); chat.agentActivityCursor = { messageSeq: 8, executionId: 'pinned' }; chat.unread = true;
  let release!: () => void; const sent: any[] = [];
  globalThis.fetch = async (_url, options) => {
    sent.push(JSON.parse(String(options?.body))); await new Promise<void>(resolve => { release = resolve; });
    return Response.json({ chatId: chat.id, activity: { agentActivityCursor: { messageSeq: 8, executionId: 'pinned' }, unread: false, turnError: false,
      agentExecution: { executionId: 'pinned', status: 'completed' } } });
  };
  const item = { id: 'execution:pinned', chatId: chat.id, activityCursor: structuredClone(chat.agentActivityCursor), notifications: [] } as any;
  const acknowledgment = acknowledgeAgentActivityItems([item]);
  chat.agentActivityCursor = { messageSeq: 9, executionId: 'new-failure' }; chat.agentExecution = { executionId: 'new-failure', status: 'failed' }; chat.turnError = true;
  release(); await acknowledgment;
  assert.deepEqual(sent, [{ messageSeq: 8, executionId: 'pinned' }]);
  assert.equal(chat.agentExecution.executionId, 'new-failure'); assert.equal(chat.unread, true); assert.equal(chat.turnError, true);
});
