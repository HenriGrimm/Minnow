import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals, setupMinimalComposerDom } from '../os/dom-helpers.mts';
import { defaultSessionState } from '../../src/config/defaults.ts';
import { createEmptyChatObject, removeChatById, removeChatByIdAsync, resetSessionPersistenceForTests, sessionState, setSessionStateForTests, waitForSessionSaveForTests } from '../../src/state/sessions.ts';
import { resetWorkspaceStateForTests, setWorkspaceFromServer } from '../../src/state/workspace.ts';
import { assignChatToGroup, setChatPinned } from '../../src/state/chat-groups.ts';
import { agentChatStatusLabel, chatIdFromLink, chatLink, chatReadOnlyReason, isAgentChatActive, projectChatRelationships } from '../../src/state/chat-relationships.ts';
import { deleteChat, renderSidebar, resetSidebarAgentNavigationForTests } from '../../src/ui/sidebar.ts';
import { CHAT_DRAG_MIME } from '../../src/attachments/chat-drag.ts';
import { resetSidebarChatDnDForTests, wireSidebarChatDragDrop } from '../../src/ui/sidebar-chat-dnd.ts';
import { getConversationStorageCapabilitySync, readAgentConversationsCapability, setAgentConversationsCapabilityForTests } from '../../src/config/agent-conversations-enabled.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { syncComposerFromStreamingState, syncComposerReadOnlyState } from '../../src/ui/composer-send.ts';
import { parseOsHash } from '../../src/os/router.ts';
import { classifyMarkdownHref } from '../../src/markdown/links.ts';
import { launchCodeWithChat } from '../../src/os/chat-launch.ts';
import type { Chat, SessionState } from '../../src/types.ts';

const WS = 'C:\\workspace\\agent-navigation';
let win: Window | undefined;
const originalFetch = globalThis.fetch;

function chat(id: string, parentId?: string): Chat {
  const value = createEmptyChatObject('model', WS);
  value.id = id; value.name = id; value.providerId = 'fixture'; value.historyLoaded = false;
  value.messageCount = parentId ? 0 : 1; value.lastMessageAt = 10; value.updatedAt = 10;
  if (parentId) {
    value.chatCommandVersion = 1;
    value.agentConversation = { version: 1, childChatId: id, parentChatId: parentId, rootChatId: 'root', journalOwnerId: 'root', origin: 'delegated', createdAt: 1,
      capabilities: { canSend: true, canStop: true, canChooseModel: true } };
  }
  return value;
}

function setup(chats: Chat[], activeId = chats[0]!.id, groups: SessionState['groups'] = []): HTMLElement {
  win = new Window({ url: 'http://localhost:9473/#/app/code/chat' });
  installHappyDomGlobals(win, { fetch: (async () => new Response('{}', { status: 404 })) as typeof fetch });
  document.body.innerHTML = '<div id="chatList"></div>';
  setWorkspaceFromServer({ path: WS, label: 'Navigation fixture', isDefault: false });
  setSessionStateForTests({ ...defaultSessionState(), chats, activeId, groups });
  return document.getElementById('chatList')!;
}

afterEach(() => {
  resetSidebarAgentNavigationForTests(); resetSidebarChatDnDForTests();
  resetSessionPersistenceForTests();
  setStorageModeForTests(null); globalThis.fetch = originalFetch;
  setAgentConversationsCapabilityForTests(); setSessionStateForTests(null); resetWorkspaceStateForTests();
  win?.close(); win = undefined;
});

test('lightweight relationships list each child once, promote missing parents, and break imported cycles deterministically', () => {
  const root = chat('root'), child = chat('child', 'root'), orphan = chat('orphan', 'deleted');
  const a = chat('cycle-a', 'cycle-b'), b = chat('cycle-b', 'cycle-a');
  const rows = [root, child, orphan, b, a];
  for (const row of rows) Object.defineProperty(row, 'history', { get() { throw new Error('Relationship projection must never read transcripts'); } });
  const projection = projectChatRelationships(rows);
  assert.deepEqual(projection.roots.map(row => row.id), ['root', 'orphan', 'cycle-a']);
  assert.deepEqual(projection.children.get('root')?.map(row => row.id), ['child']);
  assert.deepEqual(projection.ancestors('child').map(row => row.id), ['root']);
  assert.deepEqual(projection.ancestors('cycle-b').map(row => row.id), ['cycle-a']);
});

test('sidebar root counts, pinning, and manual groups ignore nested agent rows', () => {
  const root = chat('root'), other = chat('other'), child = chat('child', 'root');
  root.pinnedAt = 20; child.pinnedAt = 30;
  child.agentExecution = { executionId: 'execution', status: 'running' };
  const list = setup([root, child, other]);
  renderSidebar();
  assert.ok(list.querySelector('[data-section="pinned"]'));
  assert.deepEqual([...list.querySelectorAll<HTMLElement>(':scope > .chat-item-row')].map(row => row.dataset.chatId), ['root', 'other']);
  assert.equal(list.querySelectorAll('[data-chat-id="child"]').length, 1);
  assert.ok(list.querySelector('.chat-agent-children [data-chat-id="child"]'));
  assert.equal((list.querySelector('[data-chat-id="child"]') as HTMLElement).draggable, false);
  assert.equal(child.historyLoaded, false);
});

test('settled children use Previous agents; opening one reveals its ancestor without losing keyed rows or focus', () => {
  const root = chat('root'), child = chat('child', 'root');
  child.agentExecution = { executionId: 'execution', status: 'completed' };
  const list = setup([root, child], 'child');
  renderSidebar();
  const rootRow = list.querySelector<HTMLElement>('[data-chat-id="root"]')!;
  const childRow = list.querySelector<HTMLElement>('[data-chat-id="child"]')!;
  const previous = list.querySelector<HTMLButtonElement>('.chat-agent-previous-toggle')!;
  assert.equal(previous.getAttribute('aria-expanded'), 'true');
  previous.focus(); root.name = 'Parent renamed'; renderSidebar();
  assert.equal(list.querySelector('[data-chat-id="root"]'), rootRow);
  assert.equal(list.querySelector('[data-chat-id="child"]'), childRow);
  assert.equal(document.activeElement, previous);
  previous.click();
  assert.equal(sessionState?.activeId, child.id, 'disclosure must not activate a row');
  assert.equal(list.querySelector('[data-chat-id="child"]'), null);
  assert.match(rootRow.querySelector('.chat-agent-toggle')!.getAttribute('aria-label')!, /Parent renamed/);
});

test('children move from active to Previous in place and a settled parent with working descendants stays reachable', () => {
  const root = chat('root'), child = chat('child', 'root'), grandchild = chat('grandchild', 'child');
  child.agentExecution = { executionId: 'first', status: 'completed' };
  grandchild.agentExecution = { executionId: 'second', status: 'running' };
  const list = setup([root, child, grandchild]);
  renderSidebar();
  const row = list.querySelector('[data-chat-id="grandchild"]'); assert.ok(row);
  sessionState!.activeId = grandchild.id; renderSidebar();
  grandchild.agentExecution.status = 'completed'; renderSidebar();
  assert.equal(list.querySelector('[data-chat-id="grandchild"]'), row);
  assert.match(row!.getAttribute('aria-label')!, /Complete/);
  assert.equal((row as HTMLElement).dataset.agentState, 'done');
  assert.ok(row!.querySelector('.chat-item-agent-done'), 'settled agents end with a check');
});

test('completion preserves the parent disclosure and an in-progress title edit while children update', () => {
  const root = chat('rename-root'), child = chat('rename-child', root.id); child.agentExecution = { executionId: 'rename-execution', status: 'running' };
  const list = setup([root, child]); renderSidebar();
  const row = list.querySelector<HTMLElement>('[data-chat-id="rename-root"]')!;
  row.dispatchEvent(new win!.MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
  const rename = [...document.querySelectorAll<HTMLButtonElement>('#chatItemContextMenu button')].find(button => button.textContent === 'Rename')!;
  rename.click();
  const input = row.querySelector<HTMLInputElement>('.chat-rename-input')!; input.value = 'A title being edited'; input.focus();
  child.agentExecution.status = 'completed'; renderSidebar();
  assert.equal(document.activeElement, input); assert.equal(input.value, 'A title being edited');
  assert.equal(row.querySelector('.chat-agent-toggle')?.getAttribute('aria-expanded'), 'true');
  assert.ok(list.querySelector('.chat-agent-previous-toggle'));
});

test('child expansion is bounded, Show more preserves rows, and deep selection reveals visually capped ancestry', () => {
  const root = chat('root');
  const children = Array.from({ length: 12 }, (_, i) => {
    const row = chat(`child-${String(i).padStart(2, '0')}`, 'root'); row.agentExecution = { executionId: `execution-${i}`, status: 'queued' }; return row;
  });
  const list = setup([root, ...children]); renderSidebar();
  assert.equal(list.querySelectorAll('.chat-item-row--agent').length, 8);
  const first = list.querySelector('[data-chat-id="child-00"]');
  list.querySelector<HTMLButtonElement>('.chat-agent-show-more')!.click();
  assert.equal(list.querySelectorAll('.chat-item-row--agent').length, 12);
  assert.equal(list.querySelector('[data-chat-id="child-00"]'), first);
  const chain = [root, ...Array.from({ length: 9 }, (_, i) => chat(`depth-${i}`, i ? `depth-${i - 1}` : 'root'))];
  setSessionStateForTests({ ...defaultSessionState(), chats: chain, activeId: 'depth-8' }); renderSidebar();
  assert.equal(list.querySelectorAll('.chat-item-row').length, 10);
  assert.equal(list.querySelector<HTMLElement>('[data-chat-id="depth-8"]')!.style.getPropertyValue('--agent-depth'), '3');
});

test('a selected child outside the first page is revealed inside a collapsed manual group', () => {
  const root = chat('root'); root.groupId = 'manual';
  const children = Array.from({ length: 15 }, (_, i) => chat(`done-${i}`, 'root'));
  const list = setup([root, ...children], 'done-14', [{ id: 'manual', name: 'My work', workspacePath: WS, collapsed: true, createdAt: 1 }]);
  renderSidebar();
  assert.equal(sessionState!.groups![0]!.collapsed, false);
  assert.ok(list.querySelector('[data-chat-id="done-14"]'));
  assert.equal(list.querySelector('.chat-group-header__count')?.textContent, '1');
});

test('parent deletion promotes surviving children without changing durable lineage', () => {
  const root = chat('root'), child = chat('child', 'root');
  const list = setup([root, child]); renderSidebar();
  sessionState!.chats = [child]; renderSidebar();
  const row = list.querySelector('[data-chat-id="child"]'); assert.ok(row);
  assert.equal(row!.parentElement, list);
  assert.match(row!.getAttribute('aria-label')!, /Parent unavailable/);
  assert.equal(child.agentConversation!.parentChatId, 'root');
  assert.equal(child.agentConversation!.journalOwnerId, 'root');
});

test('child pinning, group reassignment and forged drag events cannot reparent the conversation', () => {
  const root = chat('root'), child = chat('child', 'root');
  child.agentExecution = { executionId: 'execution', status: 'running' };
  const list = setup([root, child], root.id, [{ id: 'group', name: 'Group', workspacePath: WS, collapsed: false, createdAt: 1 }]);
  renderSidebar(); wireSidebarChatDragDrop();
  setChatPinned(child, true); assignChatToGroup(child.id, 'group');
  assert.equal(child.pinnedAt, undefined); assert.equal(child.groupId, undefined);
  const event = new win!.Event('dragstart', { bubbles: true, cancelable: true });
  list.querySelector('[data-chat-id="child"]')!.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(child.agentConversation!.parentChatId, root.id);
});

test('sidebar chat drops append a reference to the target draft while group drops still move', () => {
  const source = chat('source'), target = chat('target'); target.composerDraft = 'Existing draft';
  const list = setup([source, target], source.id, [{ id: 'group', name: 'Group', workspacePath: WS, collapsed: false, createdAt: 1 }]);
  renderSidebar(); wireSidebarChatDragDrop();
  const data = new Map<string, string>();
  const transfer = { types: [CHAT_DRAG_MIME, 'text/plain'], effectAllowed: 'none', dropEffect: 'none',
    setData(type: string, value: string) { data.set(type, value); }, getData(type: string) { return data.get(type) ?? ''; } };
  const dispatch = (element: Element, type: string) => {
    const event = new win!.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: transfer }); element.dispatchEvent(event); return event;
  };
  const sourceRow = list.querySelector('[data-chat-id="source"]')!;
  const targetRow = list.querySelector('[data-chat-id="target"]')!;
  dispatch(sourceRow, 'dragstart');
  assert.equal(transfer.effectAllowed, 'linkMove');
  assert.equal(dispatch(targetRow, 'dragover').defaultPrevented, true);
  assert.equal(transfer.dropEffect, 'link');
  assert.ok(targetRow.classList.contains('chat-item-row--drop-target'));
  dispatch(targetRow, 'drop'); dispatch(targetRow, 'drop');
  assert.equal(target.composerDraft, 'Existing draft\n#/app/code/chat?chatId=source');
  assert.equal(sessionState!.activeId, source.id);
  assert.equal(source.groupId, undefined); assert.equal(source.composerDraft, undefined);
  assert.equal(target.history.length, 0);
  assert.equal(dispatch(sourceRow, 'dragover').defaultPrevented, false);
  const group = list.querySelector('.chat-group-header[data-group-id="group"]')!;
  dispatch(group, 'dragover'); assert.equal(transfer.dropEffect, 'move'); dispatch(group, 'drop');
  assert.equal(source.groupId, 'group');
  dispatch(sourceRow, 'dragend');
  assert.equal(list.querySelector('.chat-item-row--drop-target'), null);
});

test('native saved conversations remain inspect-only while disabled creation leaves managed saved children writable', async () => {
  const root = chat('root'), native = chat('native', 'root'); native.agentConversation!.origin = 'native';
  setup([root, native], native.id); setupMinimalComposerDom(document);
  setAgentConversationsCapabilityForTests({ version: 1, capability: 'agentConversationsV1', creationEnabled: false, recoveryEnabled: true, reason: 'not_released' });
  const input = document.getElementById('msgInput') as HTMLTextAreaElement; input.value = 'A retained draft';
  const mic = document.createElement('button'); mic.id = 'btnComposerMic'; document.body.append(mic);
  const attachment = document.createElement('button'); attachment.id = 'btnChatAppAttach'; document.body.append(attachment);
  syncComposerFromStreamingState();
  assert.equal(input.disabled, true); assert.equal(input.value, 'A retained draft');
  assert.equal((document.getElementById('sendBtn') as HTMLButtonElement).disabled, true);
  assert.equal(mic.disabled, true); assert.equal(attachment.disabled, true);
  assert.match(document.getElementById('chatReadOnlyNotice')!.textContent!, /original host/);
  assert.equal(document.querySelector('#chatReadOnlyNotice a')?.getAttribute('href'), chatLink(root.id));
  const { sendProgrammaticChatText } = await import('../../src/chat/messaging.ts');
  await assert.rejects(sendProgrammaticChatText(native, 'Do not create editable history'), /original host/);
  native.agentConversation!.origin = 'delegated'; syncComposerFromStreamingState();
  assert.equal(chatReadOnlyReason(native), null); assert.equal(input.disabled, false);
  assert.equal(mic.disabled, false); assert.equal(attachment.disabled, false);
  assert.equal(document.getElementById('chatReadOnlyNotice'), null);
  assert.equal(native.messageCount, 0);
});

test('a loaded legacy relationship without a canonical send marker cannot start a renderer turn', () => {
  const legacy = chat('legacy', 'root'); delete legacy.chatCommandVersion; legacy.agentConversation!.origin = 'legacy_import';
  setup([legacy], legacy.id); setupMinimalComposerDom(document);
  assert.equal(syncComposerReadOnlyState(), true);
  assert.match(chatReadOnlyReason(legacy)!, /inspect-only/);
});

test('waiting state has honest text and no working spinner; pending descendant work prevents parent deletion', async () => {
  const root = chat('root'), child = chat('child', 'root');
  child.agentExecution = { executionId: 'execution', status: 'waiting_for_host' };
  const list = setup([root, child]); renderSidebar();
  assert.equal(isAgentChatActive(child), true); assert.equal(agentChatStatusLabel(child), 'Waiting for host');
  assert.equal(list.querySelector('[data-chat-id="child"] .chat-item-dot__spinner'), null);
  await deleteChat(root.id);
  assert.equal(sessionState!.chats.length, 2);
  assert.match(document.body.textContent!, /Stop this conversation and its agents/);
});

test('stable chat links route by id, preserve current titles and use the common launch path in Markdown', () => {
  const link = chatLink('child-ID_12');
  assert.equal(link, '#/app/code/chat?chatId=child-ID_12');
  assert.equal(chatIdFromLink(link), 'child-ID_12');
  assert.equal(chatIdFromLink(`${link}&chatId=other`), null);
  assert.equal(chatIdFromLink('#/app/code/chat?chatId=%2Fetc%2Ffile'), null);
  assert.deepEqual(parseOsHash(link), { view: 'app', appId: 'code', codeSection: 'chat', chatId: 'child-ID_12' });
  assert.deepEqual(classifyMarkdownHref(link, null), { type: 'chat', chatId: 'child-ID_12' });
});

test('a deleted direct link explains the missing conversation without selecting another chat', async () => {
  const root = chat('root'); setup([root]);
  await launchCodeWithChat('deleted-child');
  assert.equal(sessionState!.activeId, root.id);
  assert.match(document.body.textContent!, /conversation is unavailable|Could not load this conversation/);
});

test('a cross-workspace link forwards its exact child id to the existing Code window bridge', async () => {
  const root = chat('root'), child = chat('child', 'foreign-parent'); child.workspacePath = 'C:\\workspace\\another-project';
  setup([root, child]); const sent: unknown[] = [];
  window.minnow = { viewContext: { workspacePath: WS }, window: { sendCodeCommand: async (command: unknown) => { sent.push(command); return { ok: true }; } } } as typeof window.minnow;
  await launchCodeWithChat(child.id);
  assert.deepEqual(sent, [{ kind: 'chat', workspacePath: child.workspacePath, chatId: child.id }]);
  assert.equal(sessionState!.activeId, root.id);
});

test('a rejected Code window bridge keeps navigation and drafts and displays its explanation', async () => {
  const root = chat('root'), child = chat('child', 'foreign-parent'); child.workspacePath = 'C:\\workspace\\another-project'; root.composerDraft = 'Keep this draft';
  setup([root, child]);
  window.minnow = { viewContext: { workspacePath: WS }, window: { sendCodeCommand: async () => ({ ok: false, error: 'Checkout is unavailable' }) } } as typeof window.minnow;
  await launchCodeWithChat(child.id);
  assert.equal(sessionState!.activeId, root.id); assert.equal(root.composerDraft, 'Keep this draft');
  assert.match(document.body.textContent!, /Checkout is unavailable/);
});

test('managed deletion keeps local state and worktree untouched until its guarded receipt is acknowledged', async () => {
  const root = chat('delete-root'), child = chat('delete-child', root.id); child.chatWorktreeManaged = true; child.composerDraft = 'Keep this draft';
  setup([root, child], child.id);
  assert.equal(removeChatById(child.id, 'model').ok, false, 'synchronous paths cannot bypass server admission');
  const requests: { route: string; body: any }[] = [];
  let reject = true, complete: ((value: Response) => void) | undefined;
  globalThis.fetch = (async (route, options) => {
    requests.push({ route: String(route), body: JSON.parse(String(options?.body)) });
    if (reject) return new Response(JSON.stringify({ error: { message: 'Queued work is still pending' } }), { status: 409 });
    return new Promise<Response>(resolve => { complete = resolve; });
  }) as typeof fetch;
  await assert.rejects(removeChatByIdAsync(child.id, 'model'), /Queued work is still pending/);
  assert.equal(sessionState!.activeId, child.id); assert.equal(sessionState!.chats.length, 2); assert.equal(child.composerDraft, 'Keep this draft');
  reject = false; const removing = removeChatByIdAsync(child.id, 'model');
  for (let i = 0; !complete && i < 30; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(complete); assert.equal(sessionState!.chats.length, 2);
  assert.equal(requests[1]!.body.clientRequestId, requests[0]!.body.clientRequestId);
  complete!(new Response(JSON.stringify({ receipt: { chatId: child.id, clientRequestId: requests[1]!.body.clientRequestId, disposition: 'deleted', revision: 9, retainedWorktree: true } })));
  assert.equal((await removing).ok, true);
  assert.deepEqual(sessionState!.chats.map(row => row.id), [root.id]);
  assert.equal(requests.every(request => request.route === `/api/chats/${child.id}`), true, 'no worktree removal is dispatched');
});

test('a lost deletion acknowledgement retries the same receipt before unlinking the saved chat', async () => {
  const root = chat('lost-root'), child = chat('lost-child', root.id); setup([root, child]);
  const ids: string[] = [];
  globalThis.fetch = (async (_route, options) => {
    const { clientRequestId } = JSON.parse(String(options?.body)); ids.push(clientRequestId);
    if (ids.length === 1) throw new Error('Lost acknowledgement');
    return new Response(JSON.stringify({ receipt: { chatId: child.id, clientRequestId, disposition: 'deleted', revision: 10, retainedWorktree: true } }));
  }) as typeof fetch;
  assert.equal((await removeChatByIdAsync(child.id, 'model')).ok, true);
  assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]);
  assert.deepEqual(sessionState!.chats.map(row => row.id), [root.id]);
});

test('only an explicit JSON-store capability preserves the legacy session deletion path', async () => {
  const root = chat('json-root'), other = chat('json-other'); setup([root, other]); setStorageModeForTests('server');
  const feature = { version: 1, capability: 'agentConversationsV1', creationEnabled: false, recoveryEnabled: true, reason: 'not_released', conversationStorage: 'json' };
  assert.ok(readAgentConversationsCapability(feature));
  assert.ok(readAgentConversationsCapability({ ...feature, clientProtocol: { version: 1, minReaderVersion: 1, minWriterVersion: 1 } }));
  assert.equal(readAgentConversationsCapability({ ...feature, clientProtocol: { version: 1, minReaderVersion: 2, minWriterVersion: 2 } }), null);
  setAgentConversationsCapabilityForTests(feature);
  assert.equal(getConversationStorageCapabilitySync(), 'json');
  const methods: string[] = [];
  globalThis.fetch = (async (_route, options) => { methods.push(options?.method ?? 'GET'); return Response.json({ ok: true, revision: 12 }); }) as typeof fetch;
  assert.equal((await removeChatByIdAsync(root.id, 'model')).ok, true);
  await waitForSessionSaveForTests();
  assert.equal(methods.includes('DELETE'), false);
  assert.ok(methods.includes('PATCH'));
});

test('a cached conversation deleted in another window is verified without loading a transcript or changing selection', async () => {
  const root = chat('verified-root'), child = chat('verified-child', root.id); setup([root, child]); setStorageModeForTests('server');
  root.composerDraft = 'Keep composing';
  setAgentConversationsCapabilityForTests({ version: 1, capability: 'agentConversationsV1', creationEnabled: false, recoveryEnabled: true, reason: 'not_released', conversationStorage: 'sqlite' });
  const urls: string[] = [];
  globalThis.fetch = (async url => { urls.push(String(url)); return Response.json({ error: 'Deleted' }, { status: 404 }); }) as typeof fetch;
  await launchCodeWithChat(child.id);
  assert.deepEqual(urls, [`/api/chats/${child.id}?view=navigation`]);
  assert.equal(sessionState!.activeId, root.id); assert.equal(root.composerDraft, 'Keep composing');
  assert.match(document.body.textContent!, /conversation is unavailable/);
});

test('ledger rows: one line each, the producer logo leads, agents read time then a check', () => {
  const root = chat('root'), working = chat('working', 'root'), done = chat('done', 'root');
  root.modelId = 'gpt-5';
  working.modelId = 'claude-sonnet-5-5'; working.agentTypeId = 'explore';
  working.agentExecution = { executionId: 'live', status: 'running', createdAt: Date.now() - 65_000 };
  done.modelId = 'gpt-5'; done.agentExecution = { executionId: 'old', status: 'completed', createdAt: 1_000, settledAt: 42_000 };
  const list = setup([root, working, done]);
  renderSidebar();
  const rootRow = list.querySelector<HTMLElement>('[data-chat-id="root"]')!;
  assert.equal(rootRow.querySelector('.chat-item-model'), null, 'the model moves to the label and tooltip');
  assert.ok(rootRow.querySelector('.chat-item-logo svg'), 'the picker logo leads the row');
  assert.ok(rootRow.querySelector('.chat-item-logo > .chat-item-dot'), 'status rides the logo');
  assert.equal(rootRow.querySelector('.chat-item-title-row > .chat-agent-toggle')!.textContent, '▾ 2');
  assert.ok(rootRow.querySelector('.chat-item-archive'), 'root chats archive from the row');

  const live = list.querySelector<HTMLElement>('[data-chat-id="working"]')!;
  assert.equal(live.dataset.agentState, 'running');
  assert.equal(live.querySelector('.chat-item-archive'), null, 'agents archive with their parent');
  const clock = live.querySelector<HTMLElement>('.chat-item-agent-clock')!;
  assert.ok(clock.dataset.startedAt); assert.match(clock.textContent!, /1m/);
  assert.match(live.getAttribute('aria-label')!, /explore · claude-sonnet-5-5 · Working/);

  list.querySelector<HTMLButtonElement>('.chat-agent-previous-toggle')!.click();
  const settled = list.querySelector<HTMLElement>('[data-chat-id="done"]')!;
  assert.equal(settled.querySelector<HTMLElement>('.chat-item-agent-clock')!.dataset.startedAt, undefined);
  assert.equal(settled.querySelector('.chat-item-agent-clock')!.textContent, '41s');
  assert.ok(settled.querySelector('.chat-item-agent-done'));
});
