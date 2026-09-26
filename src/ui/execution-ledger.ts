import '../styles/execution-ledger.css';

import { projectExecutionLedger, type ExecutionLedgerTurn } from '../chat/execution-ledger';
import { formatWorkDuration } from '../chat/transcript-turns';
import { undoBlockMessage, undoLastAgentTurn, UNDO_STATUS } from '../chat/undo-turn';
import { ensureChatHistoryLoaded, getActiveChat, sessionState } from '../state/sessions';
import type { Chat } from '../types';
import { iconHtml } from './icon';
import { notifyCodeStageViewChanged, stripMainColumnOverlayClasses } from './main-column-overlay';
import { reviewTurnChanges } from './chat-turn-review';
import { renderSidebar } from './sidebar';
import { setStatus } from './status';
import { buildToolRow } from './tool-call-presentation';

const ROOT_ID = 'executionLedgerRoot';
const AREA_CLASS = 'chat-area--execution-ledger';
const MAIN_CLASS = 'main-column--execution-ledger';

let returnChatId: string | null = null;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function formatTimestamp(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(value);
}

function statusLabel(turn: ExecutionLedgerTurn): string {
  switch (turn.status) {
    case 'running': return 'In progress';
    case 'completed': return 'Completed';
    case 'stopped': return turn.stopReason ? `Stopped · ${turn.stopReason}` : 'Stopped';
    case 'failed': return 'Failed';
    case 'superseded': return 'Superseded';
    case 'recorded': return 'Transcript only';
  }
}

function renderActionList(turn: ExecutionLedgerTurn): HTMLElement | null {
  if (!turn.actions.length) return null;
  const details = el('details', 'execution-ledger__details');
  details.open = turn.status === 'failed' || turn.status === 'running';
  const failed = turn.actions.filter((action) => action.status === 'failed').length;
  const commands = turn.actions.filter((action) => action.isCommand).length;
  const summary = el('summary', 'execution-ledger__details-summary');
  summary.textContent = `${turn.actions.length} action${turn.actions.length === 1 ? '' : 's'}`;
  if (commands) summary.append(el('span', 'execution-ledger__summary-meta', ` · ${commands} command${commands === 1 ? '' : 's'}`));
  if (failed) summary.append(el('span', 'execution-ledger__summary-failed', ` · ${failed} failed`));

  const list = el('ol', 'execution-ledger__actions');
  for (const action of turn.actions) {
    const phase = action.status === 'pending'
      ? 'running'
      : action.status === 'failed' ? 'failed' : 'done';
    const row = buildToolRow(action.toolName, action.args, phase, action.result);
    const item = el('li', 'execution-ledger__action');
    item.dataset.status = action.status;
    const marker = el('span', 'execution-ledger__action-marker');
    marker.setAttribute('aria-hidden', 'true');
    const text = el('span', 'execution-ledger__action-text');
    text.append(el('strong', 'execution-ledger__action-name', row.action));
    if (row.target) {
      const target = el('span', `execution-ledger__action-target execution-ledger__action-target--${row.targetKind ?? 'text'}`, row.target);
      text.append(target);
    }
    const outcome = row.outcome ?? (action.status === 'pending' ? 'pending' : action.status);
    const outcomeNode = el('span', 'execution-ledger__action-outcome', outcome);
    if (action.status === 'failed') outcomeNode.classList.add('is-danger');
    item.append(marker, text, outcomeNode);
    list.append(item);
  }
  details.append(summary, list);
  return details;
}

function renderFileChanges(chat: Chat, turn: ExecutionLedgerTurn): HTMLElement | null {
  if (!turn.files.length) return null;
  const section = el('section', 'execution-ledger__section');
  const head = el('div', 'execution-ledger__section-head');
  head.append(el('h3', 'execution-ledger__section-title', `Changed files (${turn.files.length})`));
  const review = el('button', 'execution-ledger__text-btn', 'Review diff');
  review.type = 'button';
  review.addEventListener('click', () => {
    void reviewTurnChanges(chat, turn.fork, turn.end);
  });
  head.append(review);
  const list = el('ul', 'execution-ledger__files');
  for (const file of turn.files) {
    const item = el('li', 'execution-ledger__file');
    item.append(el('code', 'execution-ledger__file-path', file.path));
    const known = file.countsKnown !== false;
    item.append(el('span', 'execution-ledger__file-stats', known ? `+${file.additions} −${file.deletions}` : 'changed'));
    list.append(item);
  }
  section.append(head, list);
  return section;
}

function renderAgentRuns(turn: ExecutionLedgerTurn): HTMLElement | null {
  if (!turn.agents.length) return null;
  const section = el('section', 'execution-ledger__section');
  section.append(el('h3', 'execution-ledger__section-title', `Agents (${turn.agents.length})`));
  const list = el('ul', 'execution-ledger__agents');
  for (const run of turn.agents) {
    const item = el('li', 'execution-ledger__agent');
    const text = el('span', 'execution-ledger__agent-text');
    text.append(el('strong', '', run.type || 'Sub-agent'));
    text.append(el('span', '', run.task));
    const status = el('span', 'execution-ledger__agent-status', run.status);
    if (run.status === 'failed') status.classList.add('is-danger');
    item.append(text, status);
    list.append(item);
  }
  section.append(list);
  return section;
}

function renderPrompt(turn: ExecutionLedgerTurn): HTMLElement {
  const text = turn.prompt || 'Prompt unavailable';
  const quote = (): HTMLElement => {
    const prompt = el('blockquote', 'execution-ledger__prompt');
    if (turn.issue) {
      prompt.append(el('span', 'execution-ledger__prompt-kicker', `${turn.issue.id} · ${turn.issue.title}`));
    }
    prompt.append(el('p', '', text));
    return prompt;
  };

  if (text.length <= 360 && text.split(/\r?\n/).length <= 6) return quote();

  const details = el('details', 'execution-ledger__prompt-details');
  const firstLine = text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? text.trim();
  const preview = firstLine.length > 180 ? `${firstLine.slice(0, 179)}…` : firstLine;
  const summary = el('summary', 'execution-ledger__prompt-summary');
  if (turn.issue) summary.append(el('span', 'execution-ledger__prompt-kicker', `${turn.issue.id} · ${turn.issue.title}`));
  summary.append(el('span', '', preview || 'View prompt'));
  details.append(summary, quote());
  return details;
}

async function undoFromLedger(chat: Chat): Promise<void> {
  const result = await undoLastAgentTurn(chat.id);
  if (!result.ok) {
    if (result.error === 'cancelled') {
      setStatus('ok', UNDO_STATUS.cancelled);
      return;
    }
    const message = result.error === 'streaming'
      ? undoBlockMessage('streaming')
      : UNDO_STATUS.failed;
    setStatus(result.error === 'streaming' ? 'spin' : 'err', message);
    return;
  }

  teardownExecutionLedgerBeforeChatPaint();
  const updated = getActiveChat();
  const messages = await import('./messages');
  messages.renderChatFromHistory(updated);
  messages.renderStatsForChat(updated);
  renderSidebar();
  void import('./composer-undo').then((module) => module.syncComposerUndoFromActiveChat());
  (document.getElementById('msgInput') as HTMLTextAreaElement | null)?.focus();
  setStatus('ok', result.filesRestored ? UNDO_STATUS.successFiles : UNDO_STATUS.successChat);
}

function renderTurn(chat: Chat, turn: ExecutionLedgerTurn): HTMLElement {
  const article = el('article', 'execution-ledger__turn');
  article.dataset.status = turn.status;

  const rail = el('div', 'execution-ledger__rail');
  const dot = el('span', 'execution-ledger__dot');
  dot.setAttribute('aria-hidden', 'true');
  rail.append(dot);

  const content = el('div', 'execution-ledger__turn-content');
  const head = el('header', 'execution-ledger__turn-head');
  const headingWrap = el('div', 'execution-ledger__turn-heading');
  const heading = el('h2', 'execution-ledger__turn-title', `Turn ${turn.number}`);
  const mode = el('span', 'execution-ledger__mode', turn.modeLabel);
  if (turn.modeSource === 'chat') mode.title = 'Current chat mode; this older turn did not store a frozen mode';
  headingWrap.append(heading, mode);
  const status = el('span', 'execution-ledger__status', statusLabel(turn));
  status.dataset.status = turn.status;
  head.append(headingWrap, status);

  const meta = el('div', 'execution-ledger__meta');
  if (turn.createdAt != null) meta.append(el('span', '', formatTimestamp(turn.createdAt)));
  if (turn.durationMs != null) meta.append(el('span', '', formatWorkDuration(turn.durationMs)));
  if (turn.workAgentId) meta.append(el('span', '', `Agent: ${turn.workAgentId}`));
  if (turn.modelId) meta.append(el('span', '', `Model: ${turn.modelId}`));
  if (turn.planPath) meta.append(el('code', '', turn.planPath));

  content.append(head);
  if (meta.childElementCount) content.append(meta);
  content.append(renderPrompt(turn));

  const commandActions = turn.actions.filter((action) => action.isCommand);
  if (commandActions.length) {
    const failed = commandActions.filter((action) => action.status === 'failed').length;
    const pending = commandActions.filter((action) => action.status === 'pending').length;
    const passed = commandActions.length - failed - pending;
    const verification = el('p', 'execution-ledger__verification');
    verification.append(el('strong', '', 'Commands & verification'));
    const parts: string[] = [];
    if (passed) parts.push(`${passed} succeeded`);
    if (failed) parts.push(`${failed} failed`);
    if (pending) parts.push(`${pending} pending`);
    verification.append(document.createTextNode(` · ${parts.join(' · ')}`));
    content.append(verification);
  }

  const actionList = renderActionList(turn);
  if (actionList) content.append(actionList);
  const agents = renderAgentRuns(turn);
  if (agents) content.append(agents);
  const files = renderFileChanges(chat, turn);
  if (files) content.append(files);

  if (turn.errorMessage) {
    content.append(el('p', 'execution-ledger__error', turn.errorMessage));
  } else if (turn.completion) {
    const completion = el('p', 'execution-ledger__completion');
    completion.append(el('strong', '', 'Outcome'));
    completion.append(document.createTextNode(` · ${turn.completion}`));
    content.append(completion);
  }

  if (turn.canUndo) {
    const actions = el('div', 'execution-ledger__turn-actions');
    const undo = el('button', 'execution-ledger__undo', 'Undo this turn');
    undo.type = 'button';
    undo.title = 'Rewind this reply and restore files when a safe snapshot is available';
    undo.addEventListener('click', () => void undoFromLedger(chat));
    actions.append(undo, el('span', 'execution-ledger__undo-note', 'Latest safe checkpoint'));
    content.append(actions);
  }

  article.append(rail, content);
  return article;
}

function buildLedgerDom(chat: Chat): HTMLElement {
  const ledger = projectExecutionLedger(chat);
  const root = el('div', 'execution-ledger');
  root.id = ROOT_ID;

  const header = el('header', 'execution-ledger__header');
  const back = el('button', 'icon-btn execution-ledger__back');
  back.type = 'button';
  back.setAttribute('aria-label', 'Back to chat');
  back.title = 'Back to chat';
  back.innerHTML = iconHtml('back');
  back.addEventListener('click', closeExecutionLedger);
  const heading = el('div', 'execution-ledger__header-text');
  heading.append(el('p', 'execution-ledger__eyebrow', 'Current task'));
  heading.append(el('h1', 'execution-ledger__title', 'Execution ledger'));
  heading.append(el('p', 'execution-ledger__lede', ledger.title));
  header.append(back, heading);

  const body = el('div', 'execution-ledger__body');
  if (ledger.references.length) {
    const refs = el('dl', 'execution-ledger__refs');
    for (const ref of ledger.references) {
      refs.append(el('dt', '', ref.label), el('dd', '', ref.value));
    }
    body.append(refs);
  }

  if (!ledger.turns.length) {
    const empty = el('div', 'execution-ledger__empty');
    empty.append(el('h2', '', 'No execution history yet'));
    empty.append(el('p', '', 'Send a message in this task. Prompts, tool actions, changes, and outcomes will appear here from the saved transcript.'));
    body.append(empty);
  } else {
    const timeline = el('div', 'execution-ledger__timeline');
    for (const turn of ledger.turns) timeline.append(renderTurn(chat, turn));
    body.append(timeline);
  }

  const limits = el('details', 'execution-ledger__limits');
  limits.append(el('summary', '', 'About this record'));
  const list = el('ul');
  for (const item of ledger.unavailable) list.append(el('li', '', item));
  limits.append(list);
  body.append(limits);
  root.append(header, body);
  return root;
}

function syncButton(): void {
  const button = document.getElementById('btnExecutionLedger');
  if (!button) return;
  const open = isExecutionLedgerOpen();
  button.setAttribute('aria-pressed', open ? 'true' : 'false');
  button.setAttribute('aria-expanded', open ? 'true' : 'false');
}

export function isExecutionLedgerOpen(): boolean {
  return Boolean(document.getElementById(ROOT_ID));
}

export async function openExecutionLedger(): Promise<void> {
  const chatId = sessionState?.activeId;
  if (!chatId) return;
  await ensureChatHistoryLoaded(chatId);
  const chat = sessionState?.chats.find((item) => item.id === chatId);
  const area = document.getElementById('chatArea');
  if (!chat || !area) return;

  const { closeOtherCodeStageViews } = await import('./main-column-overlay');
  await closeOtherCodeStageViews('ledger');
  returnChatId = chat.id;
  area.replaceChildren(buildLedgerDom(chat));
  stripMainColumnOverlayClasses();
  area.classList.add(AREA_CLASS);
  document.getElementById('mainColumn')?.classList.add(MAIN_CLASS);
  syncButton();
  notifyCodeStageViewChanged();
}

export function teardownExecutionLedgerBeforeChatPaint(): boolean {
  const hadLedger = isExecutionLedgerOpen();
  if (!hadLedger) return false;
  document.getElementById(ROOT_ID)?.remove();
  document.getElementById('chatArea')?.classList.remove(AREA_CLASS);
  document.getElementById('mainColumn')?.classList.remove(MAIN_CLASS);
  returnChatId = null;
  syncButton();
  return true;
}

export function closeExecutionLedger(): void {
  if (!isExecutionLedgerOpen()) return;
  const targetId = returnChatId && sessionState?.chats.some((chat) => chat.id === returnChatId)
    ? returnChatId
    : sessionState?.activeId;
  teardownExecutionLedgerBeforeChatPaint();
  const chat = targetId ? sessionState?.chats.find((item) => item.id === targetId) : undefined;
  if (chat) void import('./messages').then((module) => module.renderChatFromHistory(chat));
  notifyCodeStageViewChanged();
}
