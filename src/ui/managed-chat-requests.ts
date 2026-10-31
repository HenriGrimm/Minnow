import type { Chat } from '../types';
import type { ChatRequest } from '../../server/chats/contracts';
import { readManagedChatRequestPage, respondManagedChatRequest, sendManagedChatAction } from '../chat/managed-chat-client';
import { acknowledgeChatViewed } from '../notifications/acknowledge';
import { getManagedChatView, subscribeManagedChatMetadata, subscribeManagedChatView } from '../chat/managed-chat-view';
import { applySharedChatAttention, findChatById, getActiveChat, sessionState } from '../state/sessions';
import { hasUnsettledAgentWork, projectChatRelationships } from '../state/chat-relationships';
import { subscribeWorkspace } from '../state/workspace';
import { subscribeAskQuestionDisplayContext, isAskQuestionDomVisible } from '../chat/ask-question-display';
import { getActiveChatMountElement } from './chat-mount';
import { ASK_QUESTION_OTHER_ID, validateAskQuestionArgs } from '../tools/ask-question-types';
import { areAllDraftsValid, buildAnswerEntries, type AskQuestionAnswerDraft } from './question-cards-state';
import { syncChatItemDotsInDom } from './chat-item-dot';

interface RequestPanel { request: ChatRequest; element: HTMLElement; form: HTMLFormElement; status: HTMLElement; busy: boolean; stale: boolean; error?: string; }
interface ChatRequestsView { chatId: string; host: HTMLElement; list: HTMLElement; notice: HTMLElement; pager: HTMLElement; panels: Map<string, RequestPanel>; loaded: boolean; summaryKey: string; loading?: AbortController; cursor?: string; previous: (string | undefined)[]; nextCursor: string | null; pendingCount: number; }
const views = new Map<string, ChatRequestsView>();
const activeStates = new Set(['accepted', 'queued', 'running', 'loading_model', 'waiting', 'waiting_for_host', 'waiting_for_model', 'waiting_for_capacity', 'waiting_for_agents', 'waiting_for_input', 'waiting_for_question', 'waiting_for_approval', 'stopping']);
let subscriptions: (() => void)[] | undefined;

function button(text: string, action: () => void): HTMLButtonElement {
  const node = document.createElement('button'); node.type = 'button'; node.textContent = text; node.addEventListener('click', action); return node;
}
function statusText(request: ChatRequest): string {
  return request.state === 'answered' ? 'Answer saved' : request.state === 'expired' ? 'Expired — this request can no longer be answered. The agent must ask again.' : request.state === 'cancelled' ? 'Cancelled' : request.kind === 'approval' ? 'Waiting for your approval' : 'Waiting for your answer';
}
function paintPanel(panel: RequestPanel): void {
  const live = panel.request.state === 'pending' && !panel.stale && panel.form.dataset.inspectOnly !== 'true';
  const hadFocus = panel.form.contains(document.activeElement);
  panel.element.dataset.state = panel.request.state;
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
    panel.busy = false; paintPanel(panel); syncChatItemDotsInDom();
  } catch (error) {
    panel.busy = false; paintPanel(panel);
    panel.error = error instanceof Error ? error.message : 'The answer could not be saved. Retry this request.'; paintPanel(panel);
    // A different surface may already have answered, or the original callback expired.
    await refreshView(view, true);
  }
}

function makePanel(view: ChatRequestsView, request: ChatRequest): RequestPanel {
  const element = document.createElement('section'); element.className = 'managed-chat-request'; element.dataset.requestId = request.requestId; element.dataset.chatId = request.chatId;
  const title = document.createElement('h3'); title.tabIndex = -1; title.textContent = request.kind === 'approval' ? request.title : 'Question from agent';
  const status = document.createElement('p'); status.className = 'managed-chat-request__status'; status.tabIndex = -1; status.setAttribute('role', 'status');
  const form = document.createElement('form'); form.className = 'managed-chat-request__form';
  const panel: RequestPanel = { request, element, form, status, busy: false, stale: false };
  element.append(title, status, form);
  if (request.kind === 'approval') {
    const workspace = document.createElement('p'); workspace.className = 'managed-chat-request__scope';
    const toolName = request.presentation.toolName ?? request.presentation.name;
    workspace.textContent = `${typeof toolName === 'string' ? `Tool: ${toolName}. ` : ''}${typeof request.presentation.workspaceRoot === 'string' ? `Workspace: ${request.presentation.workspaceRoot}` : 'Applies to this tool call only.'}`;
    const details = document.createElement('details'), summary = document.createElement('summary'), args = document.createElement('pre');
    summary.textContent = 'Review tool arguments'; args.textContent = typeof request.presentation.argsPreview === 'string' ? request.presentation.argsPreview : JSON.stringify(request.presentation.arguments ?? {}, null, 2); details.append(summary, args);
    const actions = document.createElement('div'); actions.className = 'managed-chat-request__actions';
    actions.append(button('Allow once', () => void submit(view, panel, { decision: 'allow_once' })), button('Deny', () => void submit(view, panel, { decision: 'deny' })));
    form.append(workspace, details, actions);
  } else {
    const parsed = validateAskQuestionArgs(request.presentation.question);
    if (!parsed.ok) {
      const diagnostic = document.createElement('p'); diagnostic.textContent = 'This saved question has an unsupported format. Skip it so the agent can ask again.';
      form.append(diagnostic, button('Skip question', () => void submit(view, panel, { status: 'cancelled', answers: [] })));
    } else {
      if (parsed.args.title) title.textContent = parsed.args.title;
      const drafts = new Map<string, AskQuestionAnswerDraft>();
      const send = document.createElement('button'); send.type = 'submit'; send.textContent = 'Send answer';
      const validate = () => { const ready = areAllDraftsValid(parsed.args.questions, drafts); send.dataset.unavailable = String(!ready); send.disabled = panel.busy || !ready; };
      for (const question of parsed.args.questions) {
        const field = document.createElement('fieldset'), legend = document.createElement('legend'); legend.textContent = question.prompt; field.append(legend);
        const draft: AskQuestionAnswerDraft = { selectedIds: [], otherText: '' }; drafts.set(question.id, draft);
        const otherText = document.createElement('textarea'); otherText.rows = 2; otherText.maxLength = 120_000; otherText.placeholder = 'Your answer'; otherText.setAttribute('aria-label', `Other answer: ${question.prompt}`); otherText.hidden = true;
        const choices: HTMLInputElement[] = [];
        for (const option of [...question.options, { id: ASK_QUESTION_OTHER_ID, label: 'Other' }]) {
          const label = document.createElement('label'); label.className = 'managed-chat-request__option';
          const input = document.createElement('input'); input.type = question.allow_multiple ? 'checkbox' : 'radio'; input.name = `${request.requestId}:${question.id}`; input.value = option.id;
          const text = document.createElement('span'); text.textContent = option.label;
          if ('description' in option && option.description) { const description = document.createElement('small'); description.textContent = option.description; text.append(description); }
          choices.push(input); label.append(input, text); field.append(label);
          input.addEventListener('change', () => {
            if (!question.allow_multiple || option.id === ASK_QUESTION_OTHER_ID) draft.selectedIds = input.checked ? [option.id] : [];
            else { draft.selectedIds = draft.selectedIds.filter(id => id !== ASK_QUESTION_OTHER_ID && id !== option.id); if (input.checked) draft.selectedIds.push(option.id); }
            for (const choice of choices) choice.checked = draft.selectedIds.includes(choice.value);
            otherText.hidden = !draft.selectedIds.includes(ASK_QUESTION_OTHER_ID); validate();
          });
        }
        otherText.addEventListener('input', () => { draft.otherText = otherText.value; validate(); }); field.append(otherText); form.append(field);
      }
      const actions = document.createElement('div'); actions.className = 'managed-chat-request__actions'; actions.append(send, button('Skip question', () => void submit(view, panel, { status: 'cancelled', answers: [] }))); form.append(actions);
      form.addEventListener('submit', event => { event.preventDefault(); if (areAllDraftsValid(parsed.args.questions, drafts)) void submit(view, panel, { status: 'answered', answers: buildAnswerEntries(parsed.args.questions, drafts) }); }); validate();
    }
  }
  form.addEventListener('submit', event => event.preventDefault()); paintPanel(panel); return panel;
}

function applyRequests(view: ChatRequestsView, requests: readonly ChatRequest[]): void {
  const active = view.host.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  const selected = [...requests.filter(item => item.state === 'pending'), ...requests.filter(item => item.state !== 'pending').slice(-8)];
  const ids = new Set(selected.map(item => item.requestId));
  for (const [id, panel] of view.panels) if (!ids.has(id)) panel.element.remove();
  let next = view.list.firstElementChild;
  for (const request of selected) {
    let panel = view.panels.get(request.requestId);
    if (!panel) { panel = makePanel(view, request); view.panels.set(request.requestId, panel); }
    // A delayed GET cannot resurrect a request whose answer was acknowledged.
    if (panel.request.state === 'pending' || request.state !== 'pending') panel.request = request;
    panel.stale = false; panel.form.dataset.inspectOnly = String(findChatById(view.chatId)?.agentConversation?.origin === 'native');
    paintPanel(panel);
    if (next !== panel.element) view.list.insertBefore(panel.element, next);
    next = panel.element.nextElementSibling;
  }
  view.loaded = true; view.notice.replaceChildren(); view.notice.hidden = true;
  while (view.panels.size > 80) { const old = [...view.panels.entries()].find(([id, panel]) => !ids.has(id) && !panel.busy); if (!old) break; view.panels.delete(old[0]); }
  syncHostVisibility(view);
  if (active?.isConnected && document.activeElement === document.body) active.focus({ preventScroll: true });
}

async function refreshView(view: ChatRequestsView, force = false): Promise<void> {
  if (view.loading && !force) return;
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
  const notice = document.createElement('p'); notice.className = 'managed-chat-requests__notice'; notice.hidden = true; notice.setAttribute('role', 'status');
  const list = document.createElement('div'); list.className = 'managed-chat-requests__list'; host.append(notice, list);
  const pager = document.createElement('nav'); pager.className = 'managed-chat-requests__pager'; pager.setAttribute('aria-label', 'Pending request pages'); host.append(pager);
  const view: ChatRequestsView = { chatId, host, list, notice, pager, panels: new Map(), loaded: false, summaryKey: '', previous: [], nextCursor: null, pendingCount: 0 }; views.set(chatId, view);
  while (views.size > 16) { const old = [...views.values()].find(item => item.chatId !== getActiveChat().id && !item.host.isConnected); if (!old) break; old.loading?.abort(); views.delete(old.chatId); }
  return view;
}

function syncPager(view: ChatRequestsView): void {
  view.pager.replaceChildren();
  const turnPage = (cursor: string | undefined) => { view.cursor = cursor; void refreshView(view, true).then(() => view.list.querySelector<HTMLElement>('h3')?.focus({ preventScroll: true })); };
  if (view.previous.length) view.pager.append(button('Previous requests', () => turnPage(view.previous.pop())));
  if (view.nextCursor) { const cursor = view.nextCursor; view.pager.append(button('More pending requests', () => { view.previous.push(view.cursor); turnPage(cursor); })); }
  if (view.previous.length || view.nextCursor) { const count = document.createElement('span'); count.textContent = `${view.pendingCount} pending in this conversation`; view.pager.append(count); }
  view.pager.hidden = !view.pager.children.length;
}

function descendants(chat: Chat): Chat[] {
  const graph = projectChatRelationships(sessionState?.chats ?? [chat]), result: Chat[] = [], queue = [...(graph.children.get(chat.id) ?? [])];
  for (let index = 0; index < queue.length; index++) { const child = queue[index]!; result.push(child); queue.push(...(graph.children.get(child.id) ?? [])); }
  return result;
}
function syncControls(chat: Chat, view: ChatRequestsView): void {
  const children = descendants(chat), attention = children.filter(child => child.agentRequestSummary?.length);
  const agents = children.filter(child => hasUnsettledAgentWork(child));
  const turn = chat.chatCommandVersion === 1 && chat.agentExecution && activeStates.has(chat.agentExecution.status) ? chat.agentExecution : null;
  const canStop = chat.agentConversation?.origin !== 'native' && chat.agentConversation?.capabilities?.canStop !== false;
  let controls = view.host.querySelector<HTMLElement>(':scope > .managed-chat-scopes');
  const key = JSON.stringify([turn?.executionId, turn?.status, agents.map(item => item.id), attention.map(item => [item.id, item.agentRequestSummary]), canStop]);
  if (controls?.dataset.key === key) return;
  const focusedAction = controls?.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.scope : undefined;
  if (!controls) { controls = document.createElement('div'); controls.className = 'managed-chat-scopes'; view.host.prepend(controls); }
  controls.dataset.key = key; controls.replaceChildren();
  const status = document.createElement('span'); status.className = 'managed-chat-scopes__status'; status.setAttribute('role', 'status'); status.tabIndex = -1;
  const stop = (label: string, scope: 'turn' | 'agents' | 'tree') => {
    const executionId = scope === 'turn' ? turn?.executionId : undefined;
    const action = button(label, () => {
      if (action.disabled) return; action.disabled = true; status.textContent = 'Stopping…';
      void sendManagedChatAction(chat.id, 'stop', { scope, ...(executionId ? { executionId } : {}) }).then(() => { status.textContent = scope === 'agents' ? 'Agent stop requested' : 'Stop requested'; }, error => { status.textContent = error instanceof Error ? error.message : 'Stop failed'; }).finally(() => { if (action.isConnected) action.disabled = false; });
    }); action.dataset.scope = scope; controls!.append(action);
  };
  if (canStop && turn && turn.status !== 'stopping') stop('Stop turn', 'turn');
  if (canStop && agents.length) { stop('Stop agents', 'agents'); stop('Stop conversation and agents', 'tree'); }
  if (attention.length) {
    const first = attention[0]!, requestId = first.agentRequestSummary![0]!.requestId;
    controls.append(button(`${attention.length} agent${attention.length === 1 ? '' : 's'} need${attention.length === 1 ? 's' : ''} your attention`, () => void import('../os/chat-launch').then(async module => { await module.launchCodeWithChat(first.id); await focusManagedChatRequest(first.id, requestId); })));
  }
  if (chat.agentExecution?.status === 'recovery_required') { const warning = document.createElement('p'); warning.textContent = 'Needs recovery. A tool may have started before execution was interrupted. It will not run again automatically.'; controls.append(warning); }
  controls.append(status);
  controls.hidden = controls.children.length === 1;
  if (focusedAction) (controls.querySelector<HTMLElement>(`[data-scope="${focusedAction}"]`) ?? status).focus({ preventScroll: true });
}

function syncHostVisibility(view: ChatRequestsView): void {
  view.host.hidden = !view.panels.size && view.notice.hidden && Boolean(view.host.querySelector<HTMLElement>('.managed-chat-scopes')?.hidden);
}

/** Mount alongside the common transcript; forms retain draft/focus across history refreshes. */
export function syncManagedChatRequests(chat: Chat, mount: HTMLElement): void {
  const needed = chat.chatCommandVersion === 1 || chat.agentRequestSummary !== undefined || Boolean(chat.agentRequests?.length) || descendants(chat).some(child => hasUnsettledAgentWork(child));
  if (!needed) { mount.querySelector(':scope > .managed-chat-requests')?.remove(); return; }
  const view = getView(chat.id); syncControls(chat, view);
  const context = mount.querySelector(':scope > .agent-chat-context');
  if (context) { if (context.nextElementSibling !== view.host) context.after(view.host); }
  else if (mount.firstElementChild !== view.host) mount.prepend(view.host);
  const summaryKey = JSON.stringify(chat.agentRequestSummary ?? []), changed = summaryKey !== view.summaryKey;
  const active = document.activeElement as HTMLElement | null;
  if (chat.agentRequests && !view.loaded) applyRequests(view, chat.agentRequests.slice(0, 40));
  if (changed && chat.agentRequestSummary !== undefined) {
    const pending = new Set(chat.agentRequestSummary.map(request => request.requestId));
    for (const panel of view.panels.values()) if (panel.request.state === 'pending' && !pending.has(panel.request.requestId)) { panel.stale = true; paintPanel(panel); }
  }
  view.summaryKey = summaryKey;
  if (changed) { view.cursor = undefined; view.previous = []; }
  if ((!view.loaded || changed) && chat.agentConversation?.origin !== 'native') void refreshView(view, changed);
  if (active && view.host.contains(active) && document.activeElement === document.body) active.focus({ preventScroll: true });
  syncHostVisibility(view);
  if (chat.agentActivityCursor && getActiveChat().id === chat.id && isAskQuestionDomVisible(chat.id) && document.visibilityState !== 'hidden' && document.hasFocus()) acknowledgeChatViewed(chat.id);
}

export async function focusManagedChatRequest(chatId: string, requestId: string): Promise<void> {
  if (getActiveChat().id !== chatId) return;
  const chat = findChatById(chatId), mount = getActiveChatMountElement(); if (!chat || !mount) return;
  syncManagedChatRequests(chat, mount); const view = getView(chatId); view.cursor = undefined; view.previous = []; await refreshView(view, true);
  const seen = new Set<string>();
  while (view.panels.get(requestId)?.element.parentElement !== view.list && view.nextCursor && !seen.has(view.nextCursor)) {
    if (getActiveChat().id !== chatId || !view.host.isConnected) return;
    seen.add(view.nextCursor); view.previous.push(view.cursor); view.cursor = view.nextCursor; await refreshView(view, true);
  }
  if (getActiveChat().id !== chatId || !view.host.isConnected) return;
  const panel = view.panels.get(requestId); if (!panel || panel.element.parentElement !== view.list) { view.notice.hidden = false; view.notice.textContent = 'This request is no longer available.'; syncHostVisibility(view); return; }
  panel.element.scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
  (panel.form.hidden ? panel.status : panel.form.querySelector<HTMLElement>('input,button,textarea') ?? panel.status).focus({ preventScroll: true });
}

/** One disposable subscription set; no per-child event streams or provider callbacks. */
export function startManagedChatRequests(): () => void {
  if (subscriptions) return () => {};
  let disposed = false;
  const sync = () => {
    if (disposed) return;
    const id = getManagedChatView() || getActiveChat().id, chat = findChatById(id);
    if (!chat || !isAskQuestionDomVisible(id)) return;
    const mount = getActiveChatMountElement(); if (mount?.isConnected) syncManagedChatRequests(chat, mount);
    syncChatItemDotsInDom();
  };
  const reconnect = () => { sync(); const view = views.get(getManagedChatView() || getActiveChat().id); if (view?.host.isConnected) void refreshView(view, true); };
  const clear = () => { for (const view of views.values()) { view.loading?.abort(); view.host.remove(); } views.clear(); };
  const deleted = (event: Event) => {
    const id = (event as CustomEvent).detail?.chatId; if (!id) return;
    const view = views.get(id); view?.loading?.abort(); view?.host.remove(); views.delete(id);
  };
  subscriptions = [subscribeManagedChatView(() => { for (const view of views.values()) view.loading?.abort(); queueMicrotask(sync); }), subscribeManagedChatMetadata(sync), subscribeAskQuestionDisplayContext(sync), subscribeWorkspace(clear)];
  window.addEventListener('minnow:managed-chat-reconnected', reconnect);
  window.addEventListener('minnow:managed-chat-deleted', deleted);
  window.addEventListener('focus', sync);
  document.addEventListener('visibilitychange', sync);
  sync();
  return () => { if (disposed) return; disposed = true; const current = subscriptions; subscriptions = undefined; current?.forEach(dispose => dispose()); window.removeEventListener('minnow:managed-chat-reconnected', reconnect); window.removeEventListener('minnow:managed-chat-deleted', deleted); window.removeEventListener('focus', sync); document.removeEventListener('visibilitychange', sync); clear(); };
}
