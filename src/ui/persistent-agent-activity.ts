import type { SubAgentRun } from '../agents/types';
import type { PersistedSubAgentRun } from '../types';
import { findChatById } from '../state/sessions';
import { agentChatStatusLabel, chatLink } from '../state/chat-relationships';
import { createIcon } from './icon';
import { legacyOutcomeFromSummary } from '../agents/sub-agent-structured-outcome';
import { formatWorkDuration } from '../chat/transcript-turns';
import { agentMarkStateFromLabel, agentModelId, createAgentMark, createAgentModelChip, syncAgentMark, syncAgentMarkStack, syncAgentModelChip, type AgentMarkState } from './agent-model-mark';
import { subAgentLiveStatusLine } from './sub-agent-live-status';
import { getPerFileChangeSummary, getPerFileChangeSummaryForMessages } from '../usage/code-change-ledger';

type ActivityRun = SubAgentRun | PersistedSubAgentRun;
interface Entry { run: ActivityRun; row: HTMLElement; key: string; chatId: string; state?: AgentMarkState }
const entries = new Map<string, Entry>();
const disclosure = new Map<string, boolean>();
const groups = new Map<string, HTMLDetailsElement>();
const resultsOpen = new Map<string, boolean>();
let batchDepth = 0;
const pendingMounts = new Map<HTMLElement, string>();
export function batchPersistentAgentActivity(update: () => void): void {
  batchDepth++;
  try { update(); } finally {
    if (--batchDepth === 0) { for (const [area, chatId] of pendingMounts) reconcile(area, chatId); pendingMounts.clear(); }
  }
}

export function persistentAgentActivityOwner(run: ActivityRun, fallbackChatId?: string): string | null {
  if (!run.childChatId) return null;
  if (run.completionPolicy?.kind === 'local_only') return null;
  return run.completionPolicy?.kind === 'wake_delegator' ? run.completionPolicy.recipientChatId :
    findChatById(run.childChatId)?.agentConversation?.parentChatId ?? ('parentChatId' in run ? run.parentChatId : fallbackChatId ?? null);
}

export function clearPersistentAgentActivity(): void { entries.clear(); groups.clear(); stopClock(); }

function stateLabel(run: ActivityRun): string {
  if (run.status === 'completed') return 'Complete';
  if (run.status === 'failed') return 'Failed';
  if (run.status === 'cancelled') return 'Stopped';
  if (run.phase === 'recovery_required') return 'Needs recovery';
  if ((run as SubAgentRun).startError) return 'Waiting for retry';
  const child = run.childChatId ? findChatById(run.childChatId) : undefined;
  if (run.commandId && child?.agentPendingCommand?.commandId === run.commandId && child.agentPendingCommand.errorCode === 'capability_unavailable') return 'Waiting for host';
  if (child?.agentExecution && run.executionId === child.agentExecution.executionId) return agentChatStatusLabel(child);
  return run.status === 'queued' ? 'Queued for agent slot' : 'Working';
}

/** The model name for the chip, and the semantic options that trail it. */
function modelParts(run: ActivityRun): { model: string; options: string[] } {
  const requested = run.modelId ?? '';
  const actual = run.resolvedModel;
  const model = run.providerId === 'minnow-router' ? `Pool ${requested}${actual?.id && (actual.id !== requested || actual.providerId !== run.providerId) ? ` → ${actual.id}` : ''}` : requested || actual?.id || 'Model selection pending';
  const options = run.modelOptions;
  return { model, options: [options?.reasoningEffort ? `effort ${options.reasoningEffort}` : '', options?.thinkingMode && options.thinkingMode !== 'inherit' ? `thinking ${options.thinkingMode}` : '',
    typeof options?.thinkingBudgetTokens === 'number' ? `${options.thinkingBudgetTokens} thinking tokens` : ''].filter(Boolean) };
}

/** Wall time once settled; live cards show their status instead of a ticking clock. */
function settledDuration(run: ActivityRun): string {
  if (!run.startedAt || !run.endedAt) return '';
  const ms = Date.parse(run.endedAt) - Date.parse(run.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? formatWorkDuration(ms) : '';
}

const LIVE_MARK_STATES: ReadonlySet<AgentMarkState> = new Set(['queued', 'running', 'waiting']);

/** One-shot outline pulse when a card settles while you watch; rebuilt history stays still. */
function flashSettled(row: HTMLElement, panel: HTMLElement): void {
  row.classList.add('sub-agent-card--settled');
  const done = (event: AnimationEvent): void => {
    if (event.target !== panel) return;
    row.classList.remove('sub-agent-card--settled');
    panel.removeEventListener('animationend', done);
  };
  panel.addEventListener('animationend', done);
}

/** Panel (the visible card) inside the row, so timeline step padding stays outside its border. */
function buildCard(row: HTMLElement, entry: Entry): void {
  const panel = document.createElement('div'); panel.className = 'sub-agent-card__panel';
  const link = document.createElement('a'); link.className = 'sub-agent-card__body';
  const heading = document.createElement('span'); heading.className = 'sub-agent-card__heading';
  const title = document.createElement('span'); title.className = 'sub-agent-card__task';
  const type = document.createElement('span'); type.className = 'sub-agent-card__type';
  heading.append(title, type);
  const meta = document.createElement('span'); meta.className = 'sub-agent-card__meta';
  const statusText = document.createElement('span'); statusText.className = 'sub-agent-card__status';
  const clock = document.createElement('span'); clock.className = 'sub-agent-card__clock';
  meta.append(statusText, clock);
  link.append(createAgentMark('sub-agent-card__mark'), heading, meta);
  link.addEventListener('click', event => { event.preventDefault(); void import('../os/chat-launch').then(module => module.launchCodeWithChat(entry.run.childChatId!)); });
  const selection = document.createElement('div'); selection.className = 'sub-agent-card__selection';
  const options = document.createElement('span'); options.className = 'sub-agent-card__options';
  selection.append(createAgentModelChip(), options);
  const activity = document.createElement('div'); activity.className = 'sub-agent-card__activity agent-shimmer'; activity.hidden = true;
  const files = document.createElement('div'); files.className = 'sub-agent-card__files'; files.hidden = true;
  files.setAttribute('aria-label', 'Files changed');
  panel.append(link, selection, activity, files);
  row.append(panel);
}

// ── Live clock: one shared ticker for every live card, stopped when none remain ──

let clockTimer: ReturnType<typeof setInterval> | null = null;

function liveElapsed(run: ActivityRun): string {
  const start = run.startedAt ? Date.parse(run.startedAt) : NaN;
  return Number.isFinite(start) ? formatWorkDuration(Math.max(0, Date.now() - start)) : '';
}

function tickClocks(): void {
  let live = false;
  for (const entry of entries.values()) {
    if (!entry.state || !LIVE_MARK_STATES.has(entry.state) || !entry.row.isConnected) continue;
    const clock = entry.row.querySelector<HTMLElement>('.sub-agent-card__clock');
    if (!clock) continue;
    live = true;
    clock.textContent = liveElapsed(entry.run);
  }
  if (!live) stopClock();
}

function startClock(): void {
  if (clockTimer != null || typeof setInterval !== 'function') return;
  clockTimer = setInterval(tickClocks, 1000);
  // Node test runners must not be held open by a UI clock.
  (clockTimer as { unref?: () => void }).unref?.();
}

function stopClock(): void {
  if (clockTimer != null) clearInterval(clockTimer);
  clockTimer = null;
}

// ── File chips ──

interface FileChip { path: string; additions: number; deletions: number }
const MAX_FILE_CHIPS = 3;

/**
 * Files this task changed: its own tool results first, else the child chat's
 * ledger while this task is the child's current one (later work stays out of
 * a settled card), else just the child's line totals.
 */
function runFileChanges(run: ActivityRun, live: boolean): { files: FileChip[]; totals: FileChip | null } {
  const own = Array.isArray(run.messages) ? getPerFileChangeSummaryForMessages(run.messages) : [];
  if (own.length) return { files: own.map(({ path, additions, deletions }) => ({ path, additions, deletions })), totals: null };
  const child = run.childChatId ? findChatById(run.childChatId) : undefined;
  const current = live || (Boolean(run.executionId) && child?.agentExecution?.executionId === run.executionId);
  if (!child || !current) return { files: [], totals: null };
  const ledger = getPerFileChangeSummary(child);
  if (ledger.length) return { files: ledger.map(({ path, additions, deletions }) => ({ path, additions, deletions })), totals: null };
  const totals = child.codeChangeTotals;
  return { files: [], totals: totals && (totals.additions || totals.deletions) ? { path: '', ...totals } : null };
}

function fileChip(file: FileChip): HTMLElement {
  const chip = document.createElement('span'); chip.className = 'sub-agent-card__file';
  if (file.path) {
    chip.title = file.path;
    const name = document.createElement('span'); name.className = 'sub-agent-card__file-name';
    name.textContent = file.path.split(/[\\/]/).pop() || file.path;
    chip.append(name);
  }
  if (file.additions) { const add = document.createElement('span'); add.className = 'sub-agent-card__file-add'; add.textContent = `+${file.additions}`; chip.append(add); }
  if (file.deletions) { const del = document.createElement('span'); del.className = 'sub-agent-card__file-del'; del.textContent = `−${file.deletions}`; chip.append(del); }
  return chip;
}

function syncFileChips(host: HTMLElement, changes: { files: FileChip[]; totals: FileChip | null }): void {
  const chips = changes.files.slice(0, MAX_FILE_CHIPS).map(fileChip);
  const extra = changes.files.length - chips.length;
  if (extra > 0) {
    const more = document.createElement('span'); more.className = 'sub-agent-card__file sub-agent-card__file--more';
    more.textContent = `+${extra} more`;
    more.title = changes.files.slice(MAX_FILE_CHIPS).map(file => file.path).join('\n');
    chips.push(more);
  }
  if (!chips.length && changes.totals) chips.push(fileChip(changes.totals));
  host.replaceChildren(...chips);
  host.hidden = chips.length === 0;
}

function sourceAnchor(index: Map<string, HTMLElement>, run: ActivityRun): HTMLElement | null {
  if (!run.parentToolCallId) return null;
  // Compare identity as data, rather than interpolating provider tool ids into CSS.
  const row = index.get(run.parentToolCallId);
  if (!row) return null;
  row.classList.add('tool-call-msg--delegated');
  const batch = row.closest<HTMLElement>('.tool-call-batch');
  if (batch) {
    const rows = [...batch.querySelectorAll(':scope > .tool-call-batch__body > .tool-call-msg')];
    batch.classList.toggle('tool-call-batch--delegated', rows.length > 0 && rows.every(node => node.classList.contains('tool-call-msg--delegated')));
  }
  return batch ?? row;
}

function fill(entry: Entry): void {
  const { run, row } = entry;
  const status = stateLabel(run), { model, options } = modelParts(run), modelId = agentModelId(run), duration = settledDuration(run);
  const startError = (run as SubAgentRun).startError;
  const generating = ['Working', 'Loading model'].includes(status);
  const activityText = generating ? (status === 'Loading model' ? 'Loading model…' : subAgentLiveStatusLine(run, true) || 'Working…') : '';
  const changes = runFileChanges(run, generating);
  const key = JSON.stringify([run.task, run.type, status, model, options, modelId, duration, run.startedAt, activityText, changes, run.summary, run.error, startError?.message, startError?.consecutive]);
  if (entry.key === key) return;
  entry.key = key;
  row.dataset.status = run.status;
  row.dataset.parentToolCallId = run.parentToolCallId ?? '';
  row.classList.toggle('sub-agent-card--active', generating);
  row.setAttribute('aria-busy', String(generating));
  if (!row.querySelector(':scope > .sub-agent-card__panel')) buildCard(row, entry);
  const panel = row.querySelector<HTMLElement>(':scope > .sub-agent-card__panel')!;
  const link = panel.querySelector<HTMLAnchorElement>(':scope > a')!;
  const markState = agentMarkStateFromLabel(status);
  if (entry.state && LIVE_MARK_STATES.has(entry.state) && (markState === 'done' || markState === 'failed')) flashSettled(row, panel);
  entry.state = markState;
  syncAgentMark(link.querySelector<HTMLElement>('.sub-agent-card__mark')!, modelId, markState);
  link.href = chatLink(run.childChatId!);
  link.querySelector('.sub-agent-card__type')!.textContent = run.type.replace(/[-_]/g, ' ').replace(/^./, letter => letter.toUpperCase());
  link.querySelector('.sub-agent-card__task')!.textContent = run.task.trim().split('\n')[0] ?? 'Agent assignment';
  link.querySelector<HTMLElement>('.sub-agent-card__task')!.title = run.task;
  link.querySelector('.sub-agent-card__status')!.textContent = status;
  const clock = link.querySelector<HTMLElement>('.sub-agent-card__clock')!;
  clock.textContent = LIVE_MARK_STATES.has(markState) ? liveElapsed(run) : duration;
  if (LIVE_MARK_STATES.has(markState) && clock.textContent) startClock();
  link.setAttribute('aria-label', `${run.type} agent on ${model}, ${status}. ${run.task}. Open agent chat`);
  const selection = panel.querySelector<HTMLElement>(':scope > .sub-agent-card__selection')!;
  syncAgentModelChip(selection.querySelector<HTMLElement>('.agent-model-chip')!, modelId, model);
  selection.querySelector<HTMLElement>('.sub-agent-card__options')!.textContent = options.join(' · ');
  const activity = panel.querySelector<HTMLElement>(':scope > .sub-agent-card__activity')!;
  activity.textContent = activityText;
  activity.hidden = !activityText;
  syncFileChips(panel.querySelector<HTMLElement>(':scope > .sub-agent-card__files')!, changes);
  let progress = panel.querySelector<HTMLElement>(':scope > .sub-agent-card__progress');
  if (startError) {
    if (!progress) { progress = document.createElement('div'); progress.className = 'sub-agent-card__progress'; selection.after(progress); }
    progress.textContent = startError.message;
  } else progress?.remove();
  const result = run.summary?.trim() || run.error?.trim() || '';
  let details = panel.querySelector<HTMLDetailsElement>(':scope > .sub-agent-card__result');
  if (result) {
    if (!details) {
      details = document.createElement('details'); details.className = 'sub-agent-card__result';
      details.open = resultsOpen.get(run.runId) ?? false;
      const resultDisclosure = details;
      details.addEventListener('toggle', () => {
        if (entries.get(run.runId)?.row !== row) return;
        resultsOpen.set(run.runId, resultDisclosure.open);
        if (resultsOpen.size > 512) resultsOpen.delete(resultsOpen.keys().next().value!);
      });
      details.append(document.createElement('summary'), document.createElement('pre')); panel.append(details);
    }
    const outcome = run.structuredOutcome ?? legacyOutcomeFromSummary(result);
    details.querySelector('summary')!.textContent = (outcome?.summary || result.split('\n').find(line => line.trim())!).slice(0, 180);
    details.querySelector('pre')!.textContent = result;
  } else details?.remove();
}

function placeAfter(anchor: HTMLElement | null, node: HTMLElement, area: HTMLElement): void {
  if (anchor?.parentElement) { if (anchor.nextElementSibling !== node) anchor.after(node); }
  else if (!area.contains(node)) area.append(node);
}

function reconcile(area: HTMLElement, chatId: string): void {
  const anchorsById = new Map<string, HTMLElement>();
  area.querySelectorAll<HTMLElement>('[data-tool-call-id]').forEach(row => { if (!anchorsById.has(row.dataset.toolCallId!)) anchorsById.set(row.dataset.toolCallId!, row); });
  const anchorOrder = new Map([...area.querySelectorAll<HTMLElement>('.tool-call-msg, .tool-call-batch')].map((row, i) => [row, i]));
  const buckets = new Map<string, Entry[]>();
  for (const entry of entries.values()) {
    if (entry.chatId !== chatId) continue;
    const key = `${chatId}:${entry.run.parentTurnId || entry.run.runId}`;
    const members = buckets.get(key) ?? []; members.push(entry); buckets.set(key, members);
  }
  for (const [key, members] of buckets) {
    const anchors = members.map(entry => sourceAnchor(anchorsById, entry.run)).filter((anchor): anchor is HTMLElement => Boolean(anchor));
    // DOM order, not completion order, chooses the original delegation anchor.
    const anchor = anchors.sort((a, b) => (anchorOrder.get(a) ?? Infinity) - (anchorOrder.get(b) ?? Infinity))[0] ?? null;
    if (members.length === 1) { groups.get(key)?.remove(); groups.delete(key); placeAfter(anchor, members[0]!.row, area); continue; }
    let group = groups.get(key);
    if (!group) {
      group = document.createElement('details'); group.className = 'sub-agent-group'; group.dataset.parentTurnId = members[0]!.run.parentTurnId ?? '';
      group.dataset.agentGroupKey = key;
      group.open = disclosure.get(key) ?? members.some(entry => ['queued', 'running'].includes(entry.run.status));
      const summary = document.createElement('summary'); summary.className = 'sub-agent-group__summary';
      const stack = document.createElement('span'); stack.className = 'agent-mark-stack'; stack.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span'); label.className = 'sub-agent-group__label';
      summary.append(stack, label, createIcon('chevronRight', { className: 'sub-agent-group__chevron', size: 12 })); group.append(summary);
      const body = document.createElement('div'); body.className = 'sub-agent-group__body'; body.setAttribute('role', 'group'); body.setAttribute('aria-label', 'Delegated agents'); group.append(body);
      group.addEventListener('toggle', () => { if (groups.get(key) !== group) return; disclosure.set(key, group!.open); if (disclosure.size > 512) disclosure.delete(disclosure.keys().next().value!); });
      groups.set(key, group);
    }
    const working = members.filter(entry => !['queued', 'completed', 'failed', 'cancelled'].includes(entry.run.status) && stateLabel(entry.run) === 'Working').length;
    const states = members.map(entry => stateLabel(entry.run));
    const queued = states.filter(state => state.startsWith('Queued')).length;
    const attention = states.filter(state => state.startsWith('Needs') || state === 'Failed').length;
    const waiting = states.filter(state => state.startsWith('Waiting')).length;
    group.dataset.live = String(working + queued + waiting > 0);
    syncAgentMarkStack(group.querySelector<HTMLElement>('.agent-mark-stack')!, members.map(entry => agentModelId(entry.run)));
    group.querySelector('.sub-agent-group__label')!.textContent = [`${members.length} agents`, working ? `${working} working` : '', queued ? `${queued} queued` : '',
      attention ? `${attention} need attention` : '', waiting ? `${waiting} waiting` : '', states.every(state => state === 'Complete') ? 'Complete' : ''].filter(Boolean).join(' · ');
    const body = group.querySelector<HTMLElement>('.sub-agent-group__body')!;
    let next = body.firstChild;
    for (const entry of members) { if (next !== entry.row) body.insertBefore(entry.row, next); next = entry.row.nextSibling; }
    placeAfter(anchor, group, area);
  }
}

export function upsertPersistentAgentActivity(run: ActivityRun, chatId: string, area: HTMLElement): HTMLElement | null {
  if (!run.childChatId || persistentAgentActivityOwner(run, chatId) !== chatId) return null;
  let entry = entries.get(run.runId);
  if (!entry) {
    const row = document.createElement('article'); row.className = 'sub-agent-card sub-agent-card--persistent'; row.dataset.runId = run.runId; row.dataset.childChatId = run.childChatId; row.dataset.chatId = chatId;
    entry = { run, row, key: '', chatId }; entries.set(run.runId, entry);
  }
  entry.run = run; fill(entry);
  if (batchDepth) pendingMounts.set(area, chatId); else reconcile(area, chatId);
  return entry.row;
}

export function refreshPersistentAgentActivity(chatId: string, area: HTMLElement): void {
  for (const entry of entries.values()) if (entry.chatId === chatId) fill(entry);
  reconcile(area, chatId);
}
