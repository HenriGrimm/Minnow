import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { setupMinimalComposerDom } from '../os/dom-helpers.mts';
import { captureDirtyTrackingShadowForTests, createEmptyChatObject, resetSessionPersistenceForTests, saveSessionsNow, setDirtyTrackingVerifierForcedForTests, setSessionStateForTests, getSessionDirtyTrackingForTests, waitForSessionSaveForTests } from '../../src/state/sessions.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { defaultSessionState } from '../../src/config/defaults.ts';
import { notifyManagedChatMetadata, notifyManagedChatView } from '../../src/chat/managed-chat-view.ts';
import { focusManagedChatRequest, startManagedChatRequests, syncManagedChatRequests } from '../../src/ui/managed-chat-requests.ts';
import { captureAgentConversationFocus } from '../../src/ui/agent-conversation.ts';
import { resolveAgentAncestorDotStates, resolveChatItemDotState, syncChatItemDotsInDom, type ChatItemDotContext } from '../../src/ui/chat-item-dot.ts';
import type { Chat } from '../../src/types.ts';
import type { ChatRequest } from '../../server/chats/contracts.d.ts';

const originalFetch = globalThis.fetch;
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: window.sessionStorage });
let dispose: (() => void) | undefined;
const records = new Map<string, ChatRequest[]>();
let posts: { chatId: string; requestId?: string; body: any }[] = [];
function chat(id: string, parentId?: string): Chat {
  const value = createEmptyChatObject('model', 'C:/fixture'); value.id = id; value.name = id; value.chatCommandVersion = 1;
  if (parentId) value.agentConversation = { version: 1, childChatId: id, parentChatId: parentId, rootChatId: 'parent', journalOwnerId: 'parent', origin: 'delegated', createdAt: 1, capabilities: { canSend: true, canStop: true, canChooseModel: true } };
  return value;
}
function request(chatId: string, requestId: string, kind: 'approval' | 'question' = 'question'): ChatRequest {
  return { version: 1, chatId, requestId, executionId: `execution-${chatId}`, toolCallId: `tool-${requestId}`, kind, state: 'pending', createdAt: 1, title: kind === 'approval' ? 'Allow save_file?' : 'Question from agent',
    presentation: kind === 'approval' ? { toolName: 'save_file', arguments: { path: 'src/example.ts', content: '<script>text only</script>' }, workspaceRoot: 'C:/fixture' } : { question: { questions: [{ id: 'choice', prompt: `Choose for ${chatId}`, options: [{ id: 'a', label: 'First' }, { id: 'b', label: 'Second' }] }] } } };
}
function setup(chats: Chat[], activeId = chats[0]!.id): HTMLElement {
  document.body.replaceChildren(); setupMinimalComposerDom(document); sessionStorage.clear();
  setSessionStateForTests({ ...defaultSessionState(), chats, activeId }); notifyManagedChatView(activeId);
  globalThis.fetch = (async (url, options) => {
    const path = String(url).split('?')[0]!, match = /^\/api\/chats\/([^/]+)\/requests(?:\/([^/]+)\/respond)?$/.exec(path);
    if (match) {
      const chatId = decodeURIComponent(match[1]!);
      if (match[2]) {
        const body = JSON.parse(String(options?.body)), requestId = decodeURIComponent(match[2]); posts.push({ chatId, requestId, body });
        const old = records.get(chatId)!.find(item => item.requestId === requestId)!;
        const saved: ChatRequest = { ...old, state: 'answered', settledAt: 2, answerCommandId: body.clientRequestId };
        records.set(chatId, records.get(chatId)!.map(item => item.requestId === requestId ? saved : item)); return Response.json({ request: saved });
      }
      const requests = records.get(chatId) ?? [];
      return Response.json({ requests, pendingCount: requests.filter(item => item.state === 'pending').length, nextCursor: null, truncated: false });
    }
    if (path.endsWith('/commands')) { posts.push({ chatId: path.split('/')[3]!, body: JSON.parse(String(options?.body)) }); return Response.json({ receipt: { commandId: 'stop', chatId: path.split('/')[3], state: 'settled', revision: 1 } }); }
    throw new Error(`Unexpected request ${path}`);
  }) as typeof fetch;
  return document.getElementById('chatArea')!;
}
async function idle(): Promise<void> { await new Promise(resolve => setTimeout(resolve, 10)); }
async function until(check: () => boolean): Promise<void> { for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(check(), 'Expected UI operation to settle'); }
function panel(id: string): HTMLElement { return [...document.querySelectorAll<HTMLElement>('.managed-chat-request')].find(node => node.dataset.requestId === id)!; }
function clickText(root: HTMLElement, text: string): void { const target = [...root.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text); assert.ok(target, text); target.click(); }
afterEach(() => { dispose?.(); dispose = undefined; globalThis.fetch = originalFetch; records.clear(); posts = []; setDirtyTrackingVerifierForcedForTests(false); resetSessionPersistenceForTests(); setSessionStateForTests(null); setStorageModeForTests(null); document.body.replaceChildren(); });

test('two child questions keep independent selections and answers across chat switching', async () => {
  const parent = chat('parent'), one = chat('child-one', parent.id), two = chat('child-two', parent.id);
  const first = request(one.id, 'question-one'), second = request(two.id, 'question-two'); records.set(one.id, [first]); records.set(two.id, [second]);
  one.agentRequestSummary = [{ requestId: first.requestId, kind: 'question' }]; two.agentRequestSummary = [{ requestId: second.requestId, kind: 'question' }];
  const area = setup([parent, one, two], one.id); dispose = startManagedChatRequests(); syncManagedChatRequests(one, area); await idle();
  panel(first.requestId).querySelector<HTMLInputElement>('input[value="a"]')!.click();
  const saved = panel(first.requestId); area.replaceChildren(); setSessionStateForTests({ ...defaultSessionState(), chats: [parent, one, two], activeId: two.id }); notifyManagedChatView(two.id); syncManagedChatRequests(two, area); await idle();
  panel(second.requestId).querySelector<HTMLInputElement>('input[value="b"]')!.click(); clickText(panel(second.requestId), 'Send answer'); await until(() => records.get(two.id)![0]!.state === 'answered'); await idle();
  assert.equal(records.get(two.id)![0]!.state, 'answered'); assert.equal(records.get(one.id)![0]!.state, 'pending');
  area.replaceChildren(); setSessionStateForTests({ ...defaultSessionState(), chats: [parent, one, two], activeId: one.id }); notifyManagedChatView(one.id); syncManagedChatRequests(one, area); await idle();
  assert.equal(panel(first.requestId), saved); assert.equal(saved.querySelector<HTMLInputElement>('input[value="a"]')!.checked, true);
  clickText(saved, 'Send answer'); await until(() => records.get(one.id)![0]!.state === 'answered'); await idle();
  assert.deepEqual(posts.map(item => [item.chatId, item.requestId, item.body.answer.answers[0].selectedIds]), [[two.id, second.requestId, ['b']], [one.id, first.requestId, ['a']]]);
  assert.deepEqual(getSessionDirtyTrackingForTests().dirtyChatIds, []);
});

test('approvals show exact arguments safely and only Allow once or Deny for their owning request', async () => {
  const owner = chat('approval-child'), first = request(owner.id, 'approval-one', 'approval'), second = request(owner.id, 'approval-two', 'approval'); records.set(owner.id, [first, second]);
  owner.agentRequestSummary = [first, second].map(item => ({ requestId: item.requestId, kind: item.kind }));
  const area = setup([owner]); dispose = startManagedChatRequests(); syncManagedChatRequests(owner, area); await idle();
  assert.equal(panel(first.requestId).querySelector('script'), null); assert.match(panel(first.requestId).querySelector('pre')!.textContent!, /<script>text only/);
  assert.deepEqual([...panel(first.requestId).querySelectorAll('button')].map(node => node.textContent), ['Allow once', 'Deny']);
  clickText(panel(first.requestId), 'Allow once'); await until(() => records.get(owner.id)![0]!.state === 'answered'); await idle(); assert.equal(panel(second.requestId).querySelector('form')!.hidden, false);
  clickText(panel(second.requestId), 'Deny'); await until(() => records.get(owner.id)![1]!.state === 'answered'); await idle();
  assert.deepEqual(posts.map(item => [item.requestId, item.body.answer.decision]), [[first.requestId, 'allow_once'], [second.requestId, 'deny']]);
});

test('answered-before-open and expired callbacks render history without live controls; reconnect refreshes unchanged summaries', async () => {
  const owner = chat('reconnect-child'), first = request(owner.id, 'old-answer'), expired = request(owner.id, 'expired');
  records.set(owner.id, [{ ...first, state: 'answered', settledAt: 2, answerCommandId: 'answer' }, { ...expired, state: 'expired', settledAt: 2 }]);
  owner.agentRequestSummary = [{ requestId: first.requestId, kind: 'question' }, { requestId: expired.requestId, kind: 'question' }];
  const area = setup([owner]); dispose = startManagedChatRequests(); syncManagedChatRequests(owner, area); await idle();
  assert.match(panel(first.requestId).textContent!, /Answer saved/); assert.match(panel(expired.requestId).textContent!, /Expired/);
  assert.equal(panel(expired.requestId).querySelector('form')!.hidden, true); assert.deepEqual(owner.agentRequestSummary, []);
  const next = request(owner.id, 'new-after-reconnect'); records.set(owner.id, [next]); window.dispatchEvent(new window.CustomEvent('minnow:managed-chat-reconnected')); await idle();
  assert.ok(panel(next.requestId)); await focusManagedChatRequest(owner.id, next.requestId);
  assert.equal(document.activeElement, panel(next.requestId).querySelector('input'));
});

test('lost answer receipt retries the same identity; a subsequent delayed pending snapshot cannot resurrect it', async () => {
  const owner = chat('retry-child'), pending = request(owner.id, 'retry-answer', 'approval'); owner.agentRequestSummary = [{ requestId: pending.requestId, kind: 'approval' }]; records.set(owner.id, [pending]);
  const area = setup([owner]); const normal = globalThis.fetch; let attempts = 0;
  globalThis.fetch = (async (url, options) => { if (String(url).endsWith('/respond') && ++attempts === 1) { await normal(url, options); throw new TypeError('Connection lost after commit'); } return normal(url, options); }) as typeof fetch;
  dispose = startManagedChatRequests(); syncManagedChatRequests(owner, area); await idle(); clickText(panel(pending.requestId), 'Allow once'); await until(() => posts.length === 2); await idle();
  assert.equal(posts.length, 2); assert.equal(posts[0]!.body.clientRequestId, posts[1]!.body.clientRequestId); assert.equal(panel(pending.requestId).querySelector('form')!.hidden, true);
  records.set(owner.id, [pending]); window.dispatchEvent(new window.CustomEvent('minnow:managed-chat-reconnected')); await idle();
  assert.match(panel(pending.requestId).textContent!, /Answer saved/); assert.deepEqual(owner.agentRequestSummary, []);
});

test('ordinary raw chat summaries display durable requests without taking ownership of history or draft', async () => {
  const owner = chat('raw-parent'); delete owner.chatCommandVersion; owner.composerDraft = 'Keep this draft'; owner.history = [{ role: 'user', content: 'Keep this transcript' }];
  const pending = request(owner.id, 'raw-approval', 'approval'); records.set(owner.id, [pending]); owner.agentRequestSummary = [{ requestId: pending.requestId, kind: 'approval' }];
  pending.presentation = { name: 'agent_send_message', argsHash: 'hash', argsPreview: '{"chat_id":"target","message":"Review this change"}' };
  const area = setup([owner]); const history = owner.history; dispose = startManagedChatRequests(); syncManagedChatRequests(owner, area); await idle();
  assert.match(panel(pending.requestId).textContent!, /agent_send_message/); assert.match(panel(pending.requestId).querySelector('pre')!.textContent!, /Review this change/);
  clickText(panel(pending.requestId), 'Deny'); await until(() => records.get(owner.id)![0]!.state === 'answered'); await idle();
  assert.equal(owner.history, history); assert.equal(owner.composerDraft, 'Keep this draft'); assert.equal(owner.chatCommandVersion, undefined); assert.equal(owner.agentExecution, undefined);
});

test('scoped Stop controls keep paused turn identity and separate agents from the combined tree', async () => {
  const parent = chat('stop-parent'), child = chat('stop-child', parent.id); parent.agentExecution = { executionId: 'paused-parent', status: 'waiting_for_input' }; child.agentExecution = { executionId: 'running-child', status: 'running' };
  const area = setup([parent, child]); dispose = startManagedChatRequests(); syncManagedChatRequests(parent, area); await idle();
  clickText(area, 'Stop turn'); await idle(); clickText(area, 'Stop agents'); await idle(); clickText(area, 'Stop conversation and agents'); await idle();
  assert.deepEqual(posts.map(item => [item.body.scope, item.body.executionId]), [['turn', 'paused-parent'], ['agents', undefined], ['tree', undefined]]);
});

test('ancestor attention prioritizes input, failure and unread before working without wait spinners', () => {
  const parent = chat('attention-parent'), child = chat('attention-child', parent.id), sibling = chat('attention-sibling', parent.id), grandchild = chat('attention-grandchild', child.id);
  const ctx: ChatItemDotContext = { activeChatId: parent.id, streamingChatIds: new Set([child.id]), streamPhaseByChatId: new Map(), inputPendingChatId: null };
  child.agentExecution = { executionId: 'waiting', status: 'waiting_for_host' }; sibling.agentExecution = { executionId: 'working', status: 'running' }; grandchild.agentRequestSummary = [{ requestId: 'nested-question', kind: 'question' }];
  assert.equal(resolveChatItemDotState(child, ctx), 'idle');
  let states = resolveAgentAncestorDotStates([parent, child, sibling, grandchild], ctx); assert.equal(states.get(parent.id), 'needs-input'); assert.equal(states.get(child.id), 'needs-input');
  grandchild.agentRequestSummary = []; grandchild.turnError = true; states = resolveAgentAncestorDotStates([parent, child, sibling, grandchild], ctx); assert.equal(states.get(parent.id), 'error');
  grandchild.turnError = false; grandchild.unread = true; states = resolveAgentAncestorDotStates([parent, child, sibling, grandchild], ctx); assert.equal(states.get(parent.id), 'unread');
});

test('paged old requests remain reachable and preserve form focus and selections on a same-chat repaint', async () => {
  const owner = chat('paged-child'), pending = Array.from({ length: 40 }, (_, index) => request(owner.id, `paged-${String(index).padStart(3, '0')}`));
  records.set(owner.id, pending); owner.agentRequestSummary = pending.map(item => ({ requestId: item.requestId, kind: item.kind }));
  const area = setup([owner]), normal = globalThis.fetch;
  globalThis.fetch = (async (url, options) => {
    if (options?.method === 'POST') return normal(url, options);
    const parsed = new URL(String(url), 'http://localhost'), cursor = parsed.searchParams.get('pending_cursor');
    const remaining = pending.filter(item => !cursor || item.requestId > cursor), rows = remaining.slice(0, 32);
    return Response.json({ requests: rows, pendingCount: 40, nextCursor: remaining.length > 32 ? rows.at(-1)!.requestId : null, truncated: remaining.length > 32 });
  }) as typeof fetch;
  dispose = startManagedChatRequests(); syncManagedChatRequests(owner, area); await idle();
  assert.equal(area.querySelectorAll('.managed-chat-request').length, 32); assert.match(area.textContent!, /40 pending/);
  const first = panel(pending[0]!.requestId), choice = first.querySelector<HTMLInputElement>('input[value="a"]')!; choice.click(); choice.focus();
  const restore = captureAgentConversationFocus(area, owner.id); area.replaceChildren(); syncManagedChatRequests(owner, area); restore();
  assert.equal(document.activeElement, choice); assert.equal(choice.checked, true);
  await focusManagedChatRequest(owner.id, pending.at(-1)!.requestId);
  assert.equal(area.querySelectorAll('.managed-chat-request').length, 8); assert.equal(document.activeElement, panel(pending.at(-1)!.requestId).querySelector('input'));
  clickText(area, 'Previous requests'); await idle(); assert.equal(panel(pending[0]!.requestId), first); assert.equal(choice.checked, true);
});

test('multi-select and Other answers use the shared question contract without touching the composer', async () => {
  const owner = chat('multi-child'), pending = request(owner.id, 'multi-request');
  pending.presentation = { question: { questions: [{ id: 'multi', prompt: 'Choose all that apply', allow_multiple: true, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }] } };
  records.set(owner.id, [pending]); owner.agentRequestSummary = [{ requestId: pending.requestId, kind: 'question' }];
  const area = setup([owner]); dispose = startManagedChatRequests(); syncManagedChatRequests(owner, area); await idle();
  const row = panel(pending.requestId), send = [...row.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Send answer')!;
  assert.equal(send.disabled, true); row.querySelector<HTMLInputElement>('input[value="a"]')!.click(); row.querySelector<HTMLInputElement>('input[value="b"]')!.click();
  assert.equal(row.querySelectorAll('input:checked').length, 2); row.querySelector<HTMLInputElement>('input[value="__other__"]')!.click();
  assert.equal(row.querySelectorAll('input:checked').length, 1); assert.equal(send.disabled, true);
  const text = row.querySelector('textarea')!; text.value = 'A separate answer'; text.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(send.disabled, false); send.click(); await until(() => posts.length === 1); await idle();
  assert.deepEqual(posts[0]!.body.answer.answers, [{ questionId: 'multi', selectedIds: ['__other__'], otherText: 'A separate answer' }]);
  assert.equal((document.getElementById('msgInput') as HTMLTextAreaElement).value, '');
});

test('answer failures retain the selection and a retry reuses its receipt identity', async () => {
  const owner = chat('failure-child'), pending = request(owner.id, 'failure-request', 'approval'); records.set(owner.id, [pending]); owner.agentRequestSummary = [{ requestId: pending.requestId, kind: 'approval' }];
  const area = setup([owner]), normal = globalThis.fetch; let reject = true; const attempted: string[] = [];
  globalThis.fetch = (async (url, options) => { if (String(url).endsWith('/respond')) { attempted.push(JSON.parse(String(options?.body)).clientRequestId); if (reject) return Response.json({ error: { message: 'Answer could not be saved' } }, { status: 503 }); } return normal(url, options); }) as typeof fetch;
  dispose = startManagedChatRequests(); syncManagedChatRequests(owner, area); await idle(); clickText(panel(pending.requestId), 'Allow once');
  await until(() => attempted.length === 1); await idle(); assert.match(panel(pending.requestId).textContent!, /Answer could not be saved/); assert.equal(panel(pending.requestId).querySelector('form')!.hidden, false);
  reject = false; clickText(panel(pending.requestId), 'Allow once'); await until(() => posts.length === 1); await idle();
  assert.equal(attempted[0], attempted[1]); assert.match(panel(pending.requestId).textContent!, /Answer saved/);
});

test('unmount and deletion abort detail hydration and release controller subscriptions', async () => {
  const owner = chat('cleanup-child'); const area = setup([owner]); let signal: AbortSignal | undefined, fetches = 0;
  globalThis.fetch = (async (_url, options) => { fetches++; signal = options?.signal ?? undefined; return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })); }) as typeof fetch;
  dispose = startManagedChatRequests(); syncManagedChatRequests(owner, area); await idle(); assert.equal(fetches, 1);
  window.dispatchEvent(new window.CustomEvent('minnow:managed-chat-deleted', { detail: { chatId: owner.id } })); assert.equal(signal?.aborted, true); assert.equal(area.querySelector('.managed-chat-requests'), null);
  dispose(); dispose = undefined; notifyManagedChatMetadata(owner.id); window.dispatchEvent(new window.CustomEvent('minnow:managed-chat-reconnected')); await idle(); assert.equal(fetches, 1);
});

test('a new request summary cancels stale detail hydration so every newly pending request is shown', async () => {
  const owner = chat('race-child'), first = request(owner.id, 'race-one'), second = request(owner.id, 'race-two');
  owner.agentRequestSummary = [{ requestId: first.requestId, kind: 'question' }]; records.set(owner.id, [first]);
  const area = setup([owner]), normal = globalThis.fetch; let old: ((response: Response) => void) | undefined, calls = 0;
  globalThis.fetch = (async (url, options) => { if (++calls === 1) return new Promise(resolve => { old = resolve; }); return normal(url, options); }) as typeof fetch;
  dispose = startManagedChatRequests(); syncManagedChatRequests(owner, area); await idle();
  records.set(owner.id, [first, second]); owner.agentRequestSummary.push({ requestId: second.requestId, kind: 'question' }); notifyManagedChatMetadata(owner.id); await idle();
  old!(Response.json({ requests: [first], pendingCount: 1, nextCursor: null, truncated: false })); await idle();
  assert.ok(panel(first.requestId)); assert.ok(panel(second.requestId)); assert.equal(owner.agentRequestSummary.length, 2);
});

test('collapsed ancestor and manual group dots reflect a hidden child request without creating a spinner', () => {
  const parent = chat('collapsed-parent'), child = chat('hidden-child', parent.id); parent.groupId = 'manual-group'; child.agentRequestSummary = [{ requestId: 'hidden-request', kind: 'approval' }];
  setup([parent, child]); const list = document.createElement('div'); list.id = 'chatList';
  list.innerHTML = '<div class="chat-group-header" data-group-id="manual-group"></div><div class="chat-item-row" data-chat-id="collapsed-parent"><span class="chat-item-dot"></span></div>';
  document.body.append(list); syncChatItemDotsInDom();
  const row = list.querySelector<HTMLElement>('.chat-item-row')!; assert.equal(row.dataset.dotState, 'needs-input'); assert.equal(row.hasAttribute('aria-busy'), false);
  assert.equal(list.querySelector<HTMLElement>('.chat-group-header')!.dataset.dotState, 'needs-input'); assert.equal(list.querySelector('.chat-item-dot__spinner'), null);
});

test('native saved requests remain inspect-only and never create a live response control', () => {
  const owner = chat('native-request', 'parent'); owner.agentConversation!.origin = 'native'; owner.agentRequests = [request(owner.id, 'native-question')]; owner.agentRequestSummary = [{ requestId: 'native-question', kind: 'question' }];
  const area = setup([owner]); dispose = startManagedChatRequests(); syncManagedChatRequests(owner, area);
  const row = panel('native-question'); assert.equal(row.querySelector('form')!.hidden, true); assert.match(row.textContent!, /original host/); assert.equal(posts.length, 0);
});

test('request hydration and saved answers remain server projections during a later forced dirty-verifier flush', async () => {
  const owner = chat('shadow-child'), pending = request(owner.id, 'shadow-approval', 'approval'); owner.agentRequestSummary = [{ requestId: pending.requestId, kind: 'approval' }]; records.set(owner.id, [pending]);
  owner.history = [{ role: 'user', content: 'Preserve canonical history' }]; owner.composerDraft = 'Preserve draft';
  const area = setup([owner]), normal = globalThis.fetch, writes: string[] = [], warnings: string[] = [], originalWarn = console.warn;
  setStorageModeForTests('server'); setDirtyTrackingVerifierForcedForTests(true); captureDirtyTrackingShadowForTests();
  globalThis.fetch = (async (url, options) => { if (String(url).startsWith('/api/config/sessions') && options?.method) { writes.push(String(url)); return Response.json({ ok: true, revision: 1 }); } return normal(url, options); }) as typeof fetch;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    dispose = startManagedChatRequests(); syncManagedChatRequests(owner, area); await idle();
    saveSessionsNow(); await waitForSessionSaveForTests(); assert.deepEqual(writes, []);
    captureDirtyTrackingShadowForTests(); clickText(panel(pending.requestId), 'Allow once'); await until(() => posts.length === 1); await idle();
    saveSessionsNow(); await waitForSessionSaveForTests();
    assert.deepEqual(writes, []); assert.equal(warnings.some(value => value.includes('without touchChat')), false);
    assert.deepEqual(getSessionDirtyTrackingForTests().dirtyChatIds, []); assert.equal(owner.history[0]!.content, 'Preserve canonical history'); assert.equal(owner.composerDraft, 'Preserve draft');
  } finally { console.warn = originalWarn; }
});
