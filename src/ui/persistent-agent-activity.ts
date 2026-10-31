import type { SubAgentRun } from '../agents/types';
import type { PersistedSubAgentRun } from '../types';
import { findChatById } from '../state/sessions';
import { agentChatStatusLabel, chatLink } from '../state/chat-relationships';
import { createIcon } from './icon';
import { legacyOutcomeFromSummary } from '../agents/sub-agent-structured-outcome';

type ActivityRun = SubAgentRun | PersistedSubAgentRun;
interface Entry { run: ActivityRun; row: HTMLElement; key: string; chatId: string }
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

export function clearPersistentAgentActivity(): void { entries.clear(); groups.clear(); }

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

function modelLabel(run: ActivityRun): string {
  const requested = run.modelId ?? '';
  const actual = run.resolvedModel;
  const label = run.providerId === 'minnow-router' ? `Pool ${requested}${actual?.id && (actual.id !== requested || actual.providerId !== run.providerId) ? ` → ${actual.id}` : ''}` : requested || actual?.id || 'Model selection pending';
  const options = run.modelOptions;
  return [label, options?.reasoningEffort ? `effort ${options.reasoningEffort}` : '', options?.thinkingMode && options.thinkingMode !== 'inherit' ? `thinking ${options.thinkingMode}` : '',
    typeof options?.thinkingBudgetTokens === 'number' ? `${options.thinkingBudgetTokens} thinking tokens` : ''].filter(Boolean).join(' · ');
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
  const status = stateLabel(run), model = modelLabel(run);
  const startError = (run as SubAgentRun).startError;
  const key = JSON.stringify([run.task, run.type, status, model, run.summary, run.error, startError?.message, startError?.consecutive]);
  if (entry.key === key) return;
  entry.key = key;
  row.dataset.status = run.status;
  row.dataset.parentToolCallId = run.parentToolCallId ?? '';
  const generating = ['Working', 'Loading model'].includes(status);
  row.classList.toggle('sub-agent-card--active', generating);
  row.setAttribute('aria-busy', String(generating));
  let link = row.querySelector<HTMLAnchorElement>(':scope > a');
  if (!link) {
    link = document.createElement('a'); link.className = 'sub-agent-card__body';
    const icon = createIcon('appAgentActivity', { size: 14 }); icon.classList.add('sub-agent-card__mark');
    const type = document.createElement('span'); type.className = 'sub-agent-card__type';
    const title = document.createElement('span'); title.className = 'sub-agent-card__task';
    const meta = document.createElement('span'); meta.className = 'sub-agent-card__meta';
    link.append(icon, type, title, meta, createIcon('chevronRight', { className: 'sub-agent-card__chevron', size: 14 }));
    link.addEventListener('click', event => { event.preventDefault(); void import('../os/chat-launch').then(module => module.launchCodeWithChat(entry.run.childChatId!)); });
    row.append(link);
  }
  link.href = chatLink(run.childChatId!);
  link.querySelector('.sub-agent-card__type')!.textContent = run.type.replace(/[-_]/g, ' ').replace(/^./, letter => letter.toUpperCase());
  link.querySelector('.sub-agent-card__task')!.textContent = run.task.trim().split('\n')[0] ?? 'Agent assignment';
  link.querySelector<HTMLElement>('.sub-agent-card__task')!.title = run.task;
  link.querySelector('.sub-agent-card__meta')!.textContent = status;
  link.setAttribute('aria-label', `${run.type} agent, ${status}. ${run.task}. Open agent chat`);
  let selection = row.querySelector<HTMLElement>(':scope > .sub-agent-card__selection');
  if (!selection) { selection = document.createElement('div'); selection.className = 'sub-agent-card__selection'; row.append(selection); }
  selection.textContent = model;
  let progress = row.querySelector<HTMLElement>(':scope > .sub-agent-card__progress');
  if (startError) {
    if (!progress) { progress = document.createElement('div'); progress.className = 'sub-agent-card__progress'; row.append(progress); }
    progress.textContent = startError.message;
  } else progress?.remove();
  const result = run.summary?.trim() || run.error?.trim() || '';
  let details = row.querySelector<HTMLDetailsElement>(':scope > .sub-agent-card__result');
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
      details.append(document.createElement('summary'), document.createElement('pre')); row.append(details);
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
      const summary = document.createElement('summary'); summary.className = 'sub-agent-group__summary'; group.append(summary);
      const body = document.createElement('div'); body.className = 'sub-agent-group__body'; body.setAttribute('role', 'group'); body.setAttribute('aria-label', 'Delegated agents'); group.append(body);
      group.addEventListener('toggle', () => { if (groups.get(key) !== group) return; disclosure.set(key, group!.open); if (disclosure.size > 512) disclosure.delete(disclosure.keys().next().value!); });
      groups.set(key, group);
    }
    const working = members.filter(entry => !['queued', 'completed', 'failed', 'cancelled'].includes(entry.run.status) && stateLabel(entry.run) === 'Working').length;
    const states = members.map(entry => stateLabel(entry.run));
    const queued = states.filter(state => state.startsWith('Queued')).length;
    const attention = states.filter(state => state.startsWith('Needs') || state === 'Failed').length;
    const waiting = states.filter(state => state.startsWith('Waiting')).length;
    group.querySelector('summary')!.textContent = [`${members.length} agents`, working ? `${working} working` : '', queued ? `${queued} queued` : '',
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
