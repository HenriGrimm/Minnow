import type { Chat } from '../types';
import { randomUUID } from '../lib/random-id';
import { isPairedDevice } from '../api/session-token';
import type { ChatRequest } from '../../server/chats/contracts';
import { readInterruptedExecution, retireInterruptedExecution, readManagedChatRequestPage, respondManagedChatRequest } from '../chat/managed-chat-client';
import { acknowledgeChatViewed } from '../notifications/acknowledge';
import { getManagedChatView, subscribeManagedChatMetadata, subscribeManagedChatView } from '../chat/managed-chat-view';
import { applySharedChatAttention, findChatById, getActiveChat, sessionState } from '../state/sessions';
import { hasUnsettledAgentWork, projectChatRelationships } from '../state/chat-relationships';
import { subscribeWorkspace } from '../state/workspace';
import { subscribeAskQuestionDisplayContext, isAskQuestionDomVisible } from '../chat/ask-question-display';
import { findToolWrapInDom } from '../tools/tool-wrap-dom';
import { validateAskQuestionArgs } from '../tools/ask-question-types';
import { getActiveChatMountElement } from './chat-mount';
import { focusAskQuestionModalForChat, isAskQuestionModalOpenForChat, showQuestionCardsModal, syncAskQuestionModalOnDisplayContextChange } from './question-cards-modal';
import { syncChatItemDotsInDom } from './chat-item-dot';
import { markPreviewOccluder, unmarkPreviewOccluder } from './preview-occlusion';

interface RequestPanel { request: ChatRequest; element: HTMLElement; form: HTMLFormElement; status: HTMLElement; busy: boolean; stale: boolean; error?: string; }
interface ChatRequestsView { chatId: string; host: HTMLElement; mount?: HTMLElement; list: HTMLElement; notice: HTMLElement; pager: HTMLElement; panels: Map<string, RequestPanel>; pageIds: Set<string>; loaded: boolean; summaryKey: string; loading?: AbortController; cursor?: string; previous: (string | undefined)[]; nextCursor: string | null; pendingCount: number; question?: { panel: RequestPanel; controller: AbortController }; focusedRequestId?: string; }
const views = new Map<string, ChatRequestsView>();
const mountOwners = new WeakMap<HTMLElement, string>();
let subscriptions: (() => void)[] | undefined;

interface PresentedAction { detail: string; reasons: string[]; risk: 'low' | 'elevated' | 'high'; grant: { key: string; label: string } | null }
/** The server sends the classifier's view of the call; tolerate older requests without it. */
function readPresentedAction(raw: unknown): PresentedAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const grant = row.grant && typeof row.grant === 'object' ? row.grant as Record<string, unknown> : null;
  return {
    detail: typeof row.detail === 'string' ? row.detail : '',
    reasons: Array.isArray(row.reasons) ? row.reasons.filter((r): r is string => typeof r === 'string' && r.length > 0).slice(0, 6) : [],
    risk: row.risk === 'low' || row.risk === 'high' ? row.risk : 'elevated',
    grant: grant && typeof grant.key === 'string' && typeof grant.label === 'string' ? { key: grant.key, label: grant.label } : null,
  };
}

function button(text: string, action: () => void): HTMLButtonElement {
  const node = document.createElement('button'); node.type = 'button'; node.textContent = text; node.addEventListener('click', action); return node;
}
function statusText(request: ChatRequest): string {
  return request.state === 'answered' ? 'Answer saved' : request.state === 'expired' ? 'Expired — this request can no longer be answered. The agent must ask again.' : request.state === 'cancelled' ? 'Cancelled' : request.kind === 'approval' ? 'Waiting for your approval' : 'Waiting for your answer';
}
function paintPanel(panel: RequestPanel): void {
  const live = panel.request.kind === 'approval' && panel.request.state === 'pending' && !panel.stale && panel.form.dataset.inspectOnly !== 'true';
  const hadFocus = panel.form.contains(document.activeElement);
  panel.element.dataset.state = panel.request.state;
  if (panel.request.state !== 'pending') panel.element.remove();
  panel.form.hidden = !live;
  for (const control of panel.form.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement>('input,button,textarea')) {
    control.disabled = panel.busy || control.dataset.unavailable === 'true';
  }
  const status = panel.form.dataset.inspectOnly === 'true' ? 'Continue this request in its original host.' : panel.stale ? 'Checking request status…' : panel.busy ? 'Saving your answer…' : panel.error && panel.request.state === 'pending' ? panel.error : statusText(panel.request);
  if (panel.status.textContent !== status) panel.status.textContent = status;
  panel.element.setAttribute('aria-busy', panel.busy ? 'true' : 'false');
  if (!live && hadFocus) panel.status.focus({ preventScroll: true });
}

async function submit(view: ChatRequestsView, panel: RequestPanel, answer: unknown): Promise<void> {
  if (panel.busy || panel.stale || panel.request.state !== 'pending') return;
  panel.busy = true; panel.error = undefined; paintPanel(panel);
  try {
    const saved = await respondManagedChatRequest(view.chatId, panel.request.requestId, answer);
    panel.request = saved; panel.stale = false;
    const chat = findChatById(view.chatId);
    if (chat) {
      applySharedChatAttention(view.chatId, { agentRequests: [...(chat.agentRequests ?? []).filter(item => item.requestId !== saved.requestId), saved],
        agentRequestSummary: (chat.agentRequestSummary ?? []).filter(item => item.requestId !== saved.requestId) });
    }
    panel.busy = false; paintPanel(panel); syncChatItemDotsInDom(); syncQuestionPopup(view); syncHostVisibility(view);
  } catch (error) {
    panel.busy = false; paintPanel(panel);
    panel.error = error instanceof Error ? error.message : 'The answer could not be saved. Retry this request.'; paintPanel(panel);
    // A different surface may already have answered, or the original callback expired.
    await refreshView(view, true);
  }
}

function makePanel(view: ChatRequestsView, request: ChatRequest): RequestPanel {
  const element = document.createElement('section'); element.className = 'managed-chat-request'; element.dataset.requestId = request.requestId; element.dataset.chatId = request.chatId;
  const title = document.createElement('h3'); title.tabIndex = -1; title.textContent = request.title;
  const status = document.createElement('p'); status.className = 'managed-chat-request__status'; status.tabIndex = -1; status.setAttribute('role', 'status');
  const form = document.createElement('form'); form.className = 'managed-chat-request__form';
  const panel: RequestPanel = { request, element, form, status, busy: false, stale: false };
  element.append(title, status);
  if (request.kind === 'approval') {
    element.append(form);
    element.classList.add('managed-chat-request--approval');
    const action = readPresentedAction(request.presentation.action);
    if (action) element.dataset.risk = action.risk;
    const toolName = request.presentation.toolName ?? request.presentation.name;
    if (action?.detail) {
      const detail = document.createElement('pre'); detail.className = 'managed-chat-request__detail'; detail.textContent = action.detail;
      form.append(detail);
    }
    if (action?.reasons.length) {
      const chips = document.createElement('div'); chips.className = 'managed-chat-request__chips';
      for (const reason of action.reasons) { const chip = document.createElement('span'); chip.textContent = reason; chips.append(chip); }
      form.append(chips);
    }
    const workspace = document.createElement('p'); workspace.className = 'managed-chat-request__scope';
    workspace.textContent = `${typeof toolName === 'string' ? `Tool: ${toolName}. ` : ''}${typeof request.presentation.workspaceRoot === 'string' ? `Project: ${request.presentation.workspaceRoot}` : 'Applies to this tool call only.'}`;
    const details = document.createElement('details'), summary = document.createElement('summary'), args = document.createElement('pre');
    summary.textContent = 'Details'; args.textContent = typeof request.presentation.argsPreview === 'string' ? request.presentation.argsPreview : JSON.stringify(request.presentation.arguments ?? {}, null, 2); details.append(summary, workspace, args);
    const feedback = document.createElement('input'); feedback.type = 'text'; feedback.className = 'managed-chat-request__feedback';
    feedback.placeholder = 'Or tell Minnow what to do instead…'; feedback.setAttribute('aria-label', 'Deny with a note for the agent');
    const deny = () => { const note = feedback.value.trim(); void submit(view, panel, note ? { decision: 'deny', feedback: note } : { decision: 'deny' }); };
    feedback.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); deny(); } });
    const actions = document.createElement('div'); actions.className = 'managed-chat-request__actions';
    const graphite = Boolean(view.mount?.closest('#workspaceSplit')?.querySelector('#graphiteThreadHeader:not([hidden])'));
    const allow = button(graphite ? 'Allow once' : 'Allow', () => void submit(view, panel, { decision: 'allow_once' })); allow.classList.add('managed-chat-request__primary');
    actions.append(allow);
    if (action?.grant && action.risk !== 'high') {
      actions.append(button(`Allow ${action.grant.label} for this chat`, () => void submit(view, panel, { decision: 'allow_chat' })));
    }
    actions.append(button('Deny', deny));
    form.append(details, actions, feedback);
  }
  form.addEventListener('submit', event => event.preventDefault()); paintPanel(panel); return panel;
}

/** Durable questions use the same per-chat composer strip as renderer questions. */
function syncQuestionPopup(view: ChatRequestsView): void {
  if (views.get(view.chatId) !== view) return;
  const native = findChatById(view.chatId)?.agentConversation?.origin === 'native';
  const eligible = (panel: RequestPanel) => !native && panel.request.kind === 'question' && panel.request.state === 'pending' && !panel.stale;
  if (view.question) {
    if (!eligible(view.question.panel) || (view.focusedRequestId && view.focusedRequestId !== view.question.panel.request.requestId)) view.question.controller.abort();
    return;
  }
  if (!isAskQuestionDomVisible(view.chatId) || isAskQuestionModalOpenForChat(view.chatId)) return;
  const panel = view.focusedRequestId ? view.panels.get(view.focusedRequestId) : [...view.panels.values()].find(eligible);
  if (!panel || !eligible(panel)) { view.focusedRequestId = undefined; return; }
  const parsed = validateAskQuestionArgs(panel.request.presentation.question);
  const controller = new AbortController();
  const question = { panel, controller }; view.question = question;
  void showQuestionCardsModal(parsed.ok ? parsed.args : {
    title: 'Question unavailable',
    unavailable: 'This saved question could not be opened. Ask the agent to send it again.',
  }, {}, {
    chatId: view.chatId,
    signal: controller.signal,
    notify: false,
    async onSubmit(answer) {
      await submit(view, panel, answer);
      if (panel.request.state === 'pending' && !controller.signal.aborted) throw new Error(panel.error ?? 'The answer could not be saved. Try again.');
    },
  }).finally(() => {
    if (view.question !== question) return;
    view.question = undefined;
    if (view.focusedRequestId === panel.request.requestId) view.focusedRequestId = undefined;
    syncQuestionPopup(view);
  });
}

function applyRequests(view: ChatRequestsView, requests: readonly ChatRequest[]): void {
  const active = view.host.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  const selected = [...requests.filter(item => item.state === 'pending'), ...requests.filter(item => item.state !== 'pending').slice(-8)];
  const ids = new Set(selected.map(item => item.requestId));
  view.pageIds = ids;
  for (const [id, panel] of view.panels) if (!ids.has(id)) panel.element.remove();
  const approvals: HTMLElement[] = [];
  for (const request of selected) {
    let panel = view.panels.get(request.requestId);
    if (!panel) { panel = makePanel(view, request); view.panels.set(request.requestId, panel); }
    // A delayed GET cannot resurrect a request whose answer was acknowledged.
    if (panel.request.state === 'pending' || request.state !== 'pending') panel.request = request;
    panel.stale = false; panel.form.dataset.inspectOnly = String(findChatById(view.chatId)?.agentConversation?.origin === 'native');
    paintPanel(panel);
    if (panel.request.kind === 'approval' && panel.request.state === 'pending') approvals.push(panel.element);
  }
  approvals.forEach((element, index) => {
    const at = view.list.children.item(index);
    if (at !== element) view.list.insertBefore(element, at);
  });
  view.loaded = true; view.notice.replaceChildren(); view.notice.hidden = true;
  while (view.panels.size > 80) { const old = [...view.panels.entries()].find(([id, panel]) => !ids.has(id) && !panel.busy); if (!old) break; view.panels.delete(old[0]); }
  syncHostVisibility(view);
  syncQuestionPopup(view);
  if (active?.isConnected && document.activeElement === document.body) active.focus({ preventScroll: true });
}

async function refreshView(view: ChatRequestsView, force = false): Promise<void> {
  if (view.loading && !view.loading.signal.aborted && !force) return;
  view.loading?.abort(); const controller = new AbortController(); view.loading = controller;
  try {
    const page = await readManagedChatRequestPage(view.chatId, { cursor: view.cursor, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) });
    if (controller.signal.aborted || views.get(view.chatId) !== view) return;
    view.nextCursor = page.nextCursor; view.pendingCount = page.pendingCount;
    applyRequests(view, page.requests); syncPager(view);
    const chat = findChatById(view.chatId);
    if (chat) {
      const requests = [...view.panels.values()].map(panel => panel.request);
      const settled = new Set(requests.filter(request => request.state !== 'pending').map(request => request.requestId));
      const summary = new Map((chat.agentRequestSummary ?? []).filter(request => !settled.has(request.requestId)).map(request => [request.requestId, request]));
      for (const request of requests) if (request.state === 'pending') summary.set(request.requestId, { requestId: request.requestId, kind: request.kind });
      applySharedChatAttention(view.chatId, { agentRequests: requests, agentRequestSummary: [...summary.values()] });
      view.summaryKey = JSON.stringify(chat.agentRequestSummary); syncChatItemDotsInDom();
      syncHostVisibility(view);
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    view.notice.hidden = false; view.notice.replaceChildren(document.createTextNode(error instanceof Error ? error.message : 'Could not load requests.'), button('Retry', () => void refreshView(view, true)));
    syncHostVisibility(view);
  } finally { if (view.loading === controller) view.loading = undefined; }
}

function getView(chatId: string): ChatRequestsView {
  const prior = views.get(chatId); if (prior) return prior;
  const host = document.createElement('section'); host.className = 'managed-chat-requests'; host.dataset.chatId = chatId; host.setAttribute('aria-label', 'Conversation requests and controls');
  const notice = document.createElement('p'); notice.className = 'managed-chat-requests__notice'; notice.hidden = true; notice.tabIndex = -1; notice.setAttribute('role', 'status');
  const list = document.createElement('div'); list.className = 'managed-chat-requests__list'; host.append(notice, list);
  const pager = document.createElement('nav'); pager.className = 'managed-chat-requests__pager'; pager.hidden = true; pager.setAttribute('aria-label', 'Pending request pages'); host.append(pager);
  const view: ChatRequestsView = { chatId, host, list, notice, pager, panels: new Map(), pageIds: new Set(), loaded: false, summaryKey: '', previous: [], nextCursor: null, pendingCount: 0 }; views.set(chatId, view);
  while (views.size > 16) { const old = [...views.values()].find(item => item.chatId !== getActiveChat().id && !item.host.isConnected && !item.question); if (!old) break; old.loading?.abort(); views.delete(old.chatId); }
  return view;
}

function syncPager(view: ChatRequestsView): void {
  view.pager.replaceChildren();
  const turnPage = (cursor: string | undefined) => { view.cursor = cursor; void refreshView(view, true).then(() => view.list.querySelector<HTMLElement>('h3')?.focus({ preventScroll: true })); };
  if (view.previous.length) view.pager.append(button('Previous requests', () => turnPage(view.previous.pop())));
  if (view.nextCursor) { const cursor = view.nextCursor; view.pager.append(button('More pending requests', () => { view.previous.push(view.cursor); turnPage(cursor); })); }
  if (view.previous.length || view.nextCursor) { const count = document.createElement('span'); count.textContent = `${view.pendingCount} pending in this conversation`; view.pager.append(count); }
  view.pager.hidden = !view.pager.children.length;
  syncHostVisibility(view);
}

function descendants(chat: Chat): Chat[] {
  const graph = projectChatRelationships(sessionState?.chats ?? [chat]), result: Chat[] = [], queue = [...(graph.children.get(chat.id) ?? [])];
  for (let index = 0; index < queue.length; index++) { const child = queue[index]!; result.push(child); queue.push(...(graph.children.get(child.id) ?? [])); }
  return result;
}
function recoveryControls(chatId: string, executionId: string, needsConfirmation: boolean): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'managed-chat-recovery';
  const info = document.createElement('p');
  info.setAttribute('role', 'status');
  panel.append(info);
  if (!needsConfirmation) {
    info.textContent = 'Waiting for interrupted work to stop…';
    return panel;
  }
  const paired = isPairedDevice();
  const guidance = paired
    ? 'Confirm the interrupted work has stopped on the host computer to continue.'
    : 'If the interrupted work has stopped, you can keep any changes and continue this chat.';
  info.textContent = guidance;
  if (paired) return panel;
  const requestId = randomUUID();
  let review: Awaited<ReturnType<typeof readInterruptedExecution>> | undefined;
  const continueButton = button('Confirm stopped', async () => {
    continueButton.disabled = true;
    info.textContent = 'Getting this chat ready…';
    try {
      review ??= await readInterruptedExecution(chatId);
      if (!panel.isConnected || review.executionId !== executionId) {
        continueButton.disabled = false;
        info.textContent = guidance;
        return;
      }
      await retireInterruptedExecution(chatId, review, requestId);
      continueButton.remove();
      info.textContent = 'You can continue this chat.';
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Refresh')) review = undefined;
      continueButton.disabled = false;
      info.textContent = error instanceof Error ? error.message : 'Could not continue this chat. Try again.';
    }
  });
  panel.append(continueButton);
  return panel;
}
function syncControls(chat: Chat, view: ChatRequestsView): void {
  const attention = descendants(chat).filter(child => child.agentRequestSummary?.length);
  let controls = view.host.querySelector<HTMLElement>(':scope > .managed-chat-scopes');
  const execution = chat.agentExecution;
  const key = JSON.stringify([execution?.executionId, execution?.status, execution?.needsManualRecovery, attention.map(item => [item.id, item.agentRequestSummary])]);
  if (controls?.dataset.key === key) return;
  if (!controls) { controls = document.createElement('div'); controls.className = 'managed-chat-scopes'; view.host.prepend(controls); }
  controls.dataset.key = key; controls.replaceChildren();
  if (attention.length) {
    const first = attention[0]!, requestId = first.agentRequestSummary![0]!.requestId;
    controls.append(button(`${attention.length} agent${attention.length === 1 ? '' : 's'} need${attention.length === 1 ? 's' : ''} your attention`, () => void import('../os/chat-launch').then(async module => { await module.launchCodeWithChat(first.id); await focusManagedChatRequest(first.id, requestId); })));
  }
  if (execution?.status === 'recovery_required') controls.append(recoveryControls(chat.id, execution.executionId, execution.needsManualRecovery === true));
  controls.hidden = !controls.children.length;
}

function composerApprovalSlot(mount: HTMLElement): HTMLElement | null {
  const shared = mount.closest('.shared-chat-host');
  if (shared) return shared.querySelector('#toolApprovalHost');
  if (mount.id === 'chatArea') return mount.closest('#mainColumn')?.querySelector('#toolApprovalHost') ?? null;
  if (mount.id === 'chatAppMessageCol') return mount.closest('#chatView')?.querySelector('#chatAppToolApprovalHost') ?? null;
  return null;
}

function syncHostVisibility(view: ChatRequestsView): void {
  const { host, mount } = view;
  if (!mount || !mount.isConnected || mountOwners.get(mount) !== view.chatId) return;
  const scopes = view.host.querySelector<HTMLElement>('.managed-chat-scopes');
  const hasControls = scopes?.hidden === false;
  host.hidden = view.list.childElementCount === 0 && view.notice.hidden && view.pager.hidden && !hasControls;
  const slot = host.hidden ? null : composerApprovalSlot(mount);
  const active = host.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  host.classList.toggle('managed-chat-requests--docked', Boolean(slot));
  if (slot) {
    if (host.nextElementSibling !== slot) slot.before(host);
    markPreviewOccluder(host, 'panel');
  } else {
    unmarkPreviewOccluder(host);
    if (host.parentElement !== mount) mount.append(host);
  }
  if (active?.isConnected && document.activeElement === document.body) active.focus({ preventScroll: true });
}

/** Mount alongside the common transcript; forms retain draft/focus across history refreshes. */
export function syncManagedChatRequests(chat: Chat, mount: HTMLElement): void {
  mountOwners.set(mount, chat.id);
  const inline = mount.querySelector<HTMLElement>(':scope > .managed-chat-requests');
  if (inline && inline.dataset.chatId !== chat.id) inline.remove();
  const docked = composerApprovalSlot(mount)?.previousElementSibling;
  if (docked instanceof HTMLElement && docked.classList.contains('managed-chat-requests--docked') && docked.dataset.chatId !== chat.id) docked.remove();
  const needed = chat.chatCommandVersion === 1 || chat.agentRequestSummary !== undefined || Boolean(chat.agentRequests?.length) || descendants(chat).some(child => hasUnsettledAgentWork(child));
  if (!needed) { inline?.remove(); return; }
  const view = getView(chat.id); view.mount = mount; syncControls(chat, view);
  const summaryKey = JSON.stringify(chat.agentRequestSummary ?? []), changed = summaryKey !== view.summaryKey;
  const active = document.activeElement as HTMLElement | null;
  if (chat.agentRequests && !view.loaded) applyRequests(view, chat.agentRequests.slice(0, 40));
  for (const request of chat.agentRequests ?? []) {
    const panel = view.panels.get(request.requestId);
    if (panel && request.state !== 'pending') { panel.request = request; panel.stale = false; paintPanel(panel); }
  }
  if (changed && chat.agentRequestSummary !== undefined) {
    const pending = new Set(chat.agentRequestSummary.map(request => request.requestId));
    for (const panel of view.panels.values()) if (panel.request.state === 'pending' && !pending.has(panel.request.requestId)) { panel.stale = true; paintPanel(panel); }
  }
  view.summaryKey = summaryKey;
  if (changed) { view.cursor = undefined; view.previous = []; }
  if ((!view.loaded || changed) && chat.agentConversation?.origin !== 'native') void refreshView(view, changed);
  if (active && view.host.contains(active) && document.activeElement === document.body) active.focus({ preventScroll: true });
  syncQuestionPopup(view);
  syncHostVisibility(view);
  if (chat.agentActivityCursor && getActiveChat().id === chat.id && isAskQuestionDomVisible(chat.id) && document.visibilityState !== 'hidden' && document.hasFocus()) acknowledgeChatViewed(chat.id);
}

export async function focusManagedChatRequest(chatId: string, requestId: string): Promise<void> {
  if (getActiveChat().id !== chatId) return;
  const chat = findChatById(chatId), mount = getActiveChatMountElement(); if (!chat || !mount) return;
  syncManagedChatRequests(chat, mount); const view = getView(chatId);
  if (chat.agentConversation?.origin !== 'native') {
    view.cursor = undefined; view.previous = []; await refreshView(view, true);
  }
  const seen = new Set<string>();
  while (!view.pageIds.has(requestId) && view.nextCursor && !seen.has(view.nextCursor)) {
    if (getActiveChat().id !== chatId || !view.host.isConnected) return;
    seen.add(view.nextCursor); view.previous.push(view.cursor); view.cursor = view.nextCursor; await refreshView(view, true);
  }
  if (getActiveChat().id !== chatId || !view.host.isConnected) return;
  const panel = view.pageIds.has(requestId) ? view.panels.get(requestId) : undefined;
  if (panel?.request.kind === 'question' && panel.request.state === 'pending' && !panel.stale && chat.agentConversation?.origin !== 'native') {
    view.focusedRequestId = requestId; syncQuestionPopup(view);
    await Promise.resolve();
    focusAskQuestionModalForChat(chatId);
    return;
  }
  if (!panel || !view.list.contains(panel.element)) {
    const tool = panel && findToolWrapInDom(panel.request.toolCallId, mount);
    if (tool && panel.request.state !== 'pending') {
      for (let detail = tool.closest('details'); detail && mount.contains(detail); detail = detail.parentElement?.closest('details') ?? null) detail.open = true;
      const summary = tool.querySelector<HTMLElement>('.tool-call-summary');
      summary?.scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
      summary?.focus({ preventScroll: true });
      return;
    }
    view.notice.hidden = false;
    view.notice.textContent = panel?.request.state === 'pending' && chat.agentConversation?.origin === 'native'
      ? 'Continue this request in its original host.'
      : panel && panel.request.state !== 'pending' ? statusText(panel.request) : 'This request is no longer available.';
    syncHostVisibility(view);
    view.notice.focus();
    return;
  }
  panel.element.scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
  (panel.form.hidden ? panel.status : panel.form.querySelector<HTMLElement>('input,button,textarea') ?? panel.status).focus({ preventScroll: true });
}

/** One disposable subscription set; no per-child event streams or provider callbacks. */
export function startManagedChatRequests(): () => void {
  if (subscriptions) return () => {};
  let disposed = false;
  let dismissing = false;
  const sync = () => {
    if (disposed || dismissing) return;
    syncAskQuestionModalOnDisplayContextChange();
    const id = getManagedChatView() || getActiveChat().id, chat = findChatById(id);
    if (!chat || !isAskQuestionDomVisible(id)) return;
    const mount = getActiveChatMountElement(); if (mount?.isConnected) syncManagedChatRequests(chat, mount);
    syncChatItemDotsInDom();
  };
  const reconnect = () => { sync(); const view = views.get(getManagedChatView() || getActiveChat().id); if (view?.host.isConnected) void refreshView(view, true); };
  const clear = () => { dismissing = true; try { const previous = [...views.values()]; views.clear(); for (const view of previous) { view.loading?.abort(); view.question?.controller.abort(); view.host.remove(); } } finally { dismissing = false; } };
  const deleted = (event: Event) => {
    const id = (event as CustomEvent).detail?.chatId; if (!id) return;
    dismissing = true;
    try { const view = views.get(id); views.delete(id); view?.loading?.abort(); view?.question?.controller.abort(); view?.host.remove(); }
    finally { dismissing = false; }
  };
  subscriptions = [subscribeManagedChatView(() => { for (const view of views.values()) view.loading?.abort(); queueMicrotask(sync); }), subscribeManagedChatMetadata(sync), subscribeAskQuestionDisplayContext(sync), subscribeWorkspace(clear)];
  window.addEventListener('minnow:managed-chat-reconnected', reconnect);
  window.addEventListener('minnow:managed-chat-deleted', deleted);
  window.addEventListener('focus', sync);
  document.addEventListener('visibilitychange', sync);
  sync();
  return () => { if (disposed) return; disposed = true; const current = subscriptions; subscriptions = undefined; current?.forEach(dispose => dispose()); window.removeEventListener('minnow:managed-chat-reconnected', reconnect); window.removeEventListener('minnow:managed-chat-deleted', deleted); window.removeEventListener('focus', sync); document.removeEventListener('visibilitychange', sync); clear(); };
}
