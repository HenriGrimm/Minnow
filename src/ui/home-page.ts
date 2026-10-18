import { captureLaunchModel, launchModelLabel } from '../models/launch-selection';
import '../styles/home.css';
import '../styles/issues.css';
import { getForegroundAppId, subscribeInstances } from '../os/instances';
import { launchApp, navigateToCodeOrchestrate } from '../os/router';
import { getWorkspaceLabel, getWorkspacePath, loadWorkspaceFromServer } from '../state/workspace';
import { ensureSessionsReady, sessionState } from '../state/sessions';
import { collectIssues, addIssue, updateIssue, loadIssuesFromStorage, refreshIssuesFromStorage, isIssuesStoreLoaded, requireIssueStatusForRole, appendIssueLinks, saveIssuesNow, updateIssueAgentRun, getIssueLabelSwatch } from '../state/issues-store';
import { subscribeIssuesChanges } from '../state/issues-events';
import { getIssuesTaxonomySync } from '../state/issues-taxonomy-store';
import { subscribeIssuesTaxonomyChanges } from '../state/issues-taxonomy-events';
import { createIssueTypeChip, createIssueTypeIconElement, resolveIssueStatusIcon } from '../issues/type-icons';
import { createIssueLabelsDisplay, deferUntilIssueLabelPopoverClosed, closeIssueLabelPopovers } from './issues-label-chip';
import { workspacePathsEqual } from '../lib/normalize-workspace-path';
import { decodeModelSelectKey } from '../lib/model-select-key';
import { gitBranches } from '../state/git-api';
import { listRecentViewerFiles } from '../state/recent-viewer-files';
import { readDefaultModelBinding } from './default-model';
import { listMainTurnActivity, subscribeMainTurnActivity } from '../chat/main-turn-activity';
import { listChatsAwaitingAnswers } from '../tools/ask-question-queue';
import { createIcon } from './icon';
import { openContextMenu, closeContextMenu, deferUntilContextMenuClosed, type MenuItem } from './context-menu';
import { showToast } from './toast';
import { el, button, age } from '../home/dom';
import { FLOW_COLUMNS, flowColumn, groupIssues, batchIssues, blockers, issueChat, type GroupMode, type DraftTask } from '../home/flow-model';
import { initHomeFlow, sendHomeIssues, addToHomeChat, homeAgentSlots, subscribeHomeFlow, pumpHomeQueue, drainHomeMerges, reconcileHomeFlow, retryHomeIssue } from '../home/flow-actions';
import { mountIssueDock } from '../home/flow-dock';
import { notifyAskQuestionDisplayContextChanged } from '../chat/ask-question-display';
import { planHomeGoal } from '../home/plan-goal';
import { createHomeStatus } from '../home/status-chip';
import { createHomeIssueStatus } from '../home/issue-status';
import type { IssueCard } from '../types';

let initialized = false, generation = 0, mountedWorkspace = '';
let timer: ReturnType<typeof setTimeout> | undefined, liveTimer: ReturnType<typeof setInterval> | undefined;
let planAbort: AbortController | undefined;
let dockCleanup: (() => void) | undefined, dockUpdate: (() => void) | undefined;
let dockKey = '', dockOpen = false, dockMaximized = false, focusedId = '';
let dockHeight = 62;
try { dockHeight = Math.max(30, Math.min(90, Number(localStorage.getItem('minnow.home.dockHeight')) || 62)); } catch {}
let selected = new Set<string>(), startNow = new Set<string>(), lastSelected = '';
let groupMode: GroupMode = 'files', sendMode: 'build' | 'plan' = 'build', sendModel = '';
let doneExpanded = false, sending = false, loaded = false;
let goalText = '', plannedGoal = '', draftTasks: DraftTask[] = [];
let boardSignature = '';
let baseBranch = '';
let page: HTMLElement, boardHost: HTMLElement, selectionHost: HTMLElement, dockHost: HTMLElement, tabsHost: HTMLElement, errorHost: HTMLElement;
let goalForm: HTMLFormElement;

function issues(): IssueCard[] { return isIssuesStoreLoaded() ? collectIssues({ workspacePath: mountedWorkspace, scope: 'current_workspace', hideDone: false }) : []; }
function current(version: number, workspace: string): boolean { return version === generation && workspacePathsEqual(getWorkspacePath(), workspace) && getForegroundAppId() === 'home'; }
function report(error: unknown): void { showToast(error instanceof Error ? error.message : String(error), 'error'); }
function binding(): { modelId: string; providerId?: string } { return sendModel ? decodeModelSelectKey(sendModel) ?? { modelId: sendModel } : readDefaultModelBinding(); }
function modelLabel(): string { return launchModelLabel(sendModel); }
function selectable(issue: IssueCard): boolean { return !issue.agent?.home && !issue.agent?.chatId && ['triage', 'ready'].includes(flowColumn(issue, getIssuesTaxonomySync()) ?? ''); }
function toggleSelection(issue: IssueCard, shift = false): void {
  if (!selectable(issue)) return;
  const add = !selected.has(issue.id);
  const peers = issues().filter(i => selectable(i) && flowColumn(i, getIssuesTaxonomySync()) === flowColumn(issue, getIssuesTaxonomySync()));
  const previous = peers.findIndex(i => i.id === lastSelected), next = peers.findIndex(i => i.id === issue.id);
  for (const pick of shift && previous >= 0 ? peers.slice(Math.min(previous, next), Math.max(previous, next) + 1) : [issue]) { if (add) selected.add(pick.id); else selected.delete(pick.id); }
  lastSelected = issue.id; renderSelection(); renderBoard();
}
function selectedGroups(): IssueCard[][] { return groupIssues(issues().filter(i => selected.has(i.id)), groupMode); }
function held(group: IssueCard[]): boolean { return group.every(i => !startNow.has(i.id)) && group.some(i => blockers(i, issues(), getIssuesTaxonomySync()).length); }
function counts(): { ready: number; held: number; queued: number } {
  const groups = selectedGroups(), ready = groups.filter(g => !held(g)).length;
  const free = Math.max(0, homeAgentSlots() - new Set(listMainTurnActivity().map(t => t.chatId)).size);
  return { ready: Math.min(free, ready), held: groups.length - ready, queued: Math.max(0, ready - free) };
}
function openIssue(issue: IssueCard): void {
  if (selected.size && selectable(issue)) { toggleSelection(issue); return; }
  focusedId = issue.id; dockOpen = true; renderBoard(); renderDock();
}

function renderSelection(): void {
  if (!selectionHost) return;
  selectionHost.hidden = !selected.size; selectionHost.replaceChildren(); if (!selected.size) return;
  const total = counts();
  const count = el('strong', `${selected.size} selected`, 'home-selected-count'); count.prepend(createIcon('send'));
  const segments = el('div', '', 'home-segments'); segments.setAttribute('aria-label', 'Group selected issues');
  for (const [value, label, icon] of [['files', 'By files', 'sparkles'], ['each', 'Each', 'grid'], ['one', 'One chat', 'comment']] as const) {
    const pick = button(label, () => { groupMode = value; renderSelection(); renderBoard(); }, false, icon); pick.setAttribute('aria-pressed', String(groupMode === value)); segments.append(pick);
  }
  const summary = el('span', `${total.ready + total.queued} new chats${total.held ? ` · ${total.held} held` : ''}${total.queued ? ` · ${total.queued} queued` : ''}`, 'home-send-summary home-muted');
  const actions = el('div', '', 'home-send-actions');
  const options = button(`${modelLabel()} · ${sendMode === 'build' ? 'Build' : 'Plan first'}`, () => openSendOptions(options), false, 'settings'); options.append(createIcon('chevronDown')); options.classList.add('home-options-button');
  const label = total.ready ? `Start ${total.ready} chat${total.ready === 1 ? '' : 's'}` : total.queued ? `Queue ${total.queued} chat${total.queued === 1 ? '' : 's'}` : `Hold ${total.held} chat${total.held === 1 ? '' : 's'}`;
  const send = button(`${label}${total.ready && total.queued ? ` · queue ${total.queued}` : ''}${(total.ready || total.queued) && total.held ? ` · hold ${total.held}` : ''}`, () => void sendSelection(), true); send.disabled = sending || !baseBranch;
  actions.append(button('Clear', () => { selected.clear(); startNow.clear(); renderSelection(); renderBoard(); }), options, send); selectionHost.append(count, segments, summary, actions);
}
function openSendOptions(anchor: HTMLElement): void {
  const items: MenuItem[] = [{ id: 'model', label: `Model: ${modelLabel()}`, onSelect: () => { void import('./launch-model-picker').then(({ openLaunchModelPicker }) => openLaunchModelPicker(anchor, sendModel, (value) => { sendModel = value; renderSelection(); })); } },
    { kind: 'separator' }, { kind: 'heading', label: 'Mode' }, ...(['build', 'plan'] as const).map(mode => ({ id: mode, label: mode === 'build' ? 'Build' : 'Plan first', hint: mode === 'plan' ? 'Approve before it edits' : undefined, checked: mode === sendMode, onSelect: () => { sendMode = mode; renderSelection(); } })),
  ];
  const chats = (sessionState?.chats ?? []).filter(c => c.worktreeRoot && workspacePathsEqual(c.workspacePath, mountedWorkspace) && listMainTurnActivity().some(t => t.chatId === c.id));
  if (chats.length) items.push({ kind: 'separator' }, { kind: 'heading', label: 'Or add to a running chat' }, ...chats.map(chat => ({ id: `chat-${chat.id}`, label: chat.name, hint: `${chat.gitBranch || 'Worktree'} · working`, onSelect: () => { void addToHomeChat(issues().filter(i => selected.has(i.id)), chat).then(ids => { for (const id of ids) selected.delete(id); showToast(`${ids.length} issues added${selected.size ? ` · ${selected.size} blocked or unavailable issues kept selected` : ''}`, 'success'); renderSelection(); renderBoard(); }).catch(report); } })));
  openContextMenu({ anchor, label: 'Send options', items });
}
async function sendSelection(single?: IssueCard, mode = sendMode, instructions = ''): Promise<void> {
  if (sending) return;
  if (single?.agent?.home) { await retryHomeIssue(single).catch(report); return; }
  if (!baseBranch) { report(new Error('A local main or master branch is required to start isolated work. Open Source Control to set one up.')); return; }
  const groups = single ? [[single]] : selectedGroups(); if (!groups.length) return;
  sending = true; renderSelection(); const version = generation, workspace = mountedWorkspace;
  try {
    const selectedBinding = await captureLaunchModel(sendModel);
    const ids: string[] = [];
    for (const group of groups) ids.push(...await sendHomeIssues([group], { ...selectedBinding, mode, baseBranch, instructions, startNow: group.some(i => startNow.has(i.id)) }));
    if (!current(version, workspace)) return;
    for (const id of ids) selected.delete(id);
    if (ids[0]) { focusedId = ids[0]; dockOpen = true; }
    sendModel = '';
    showToast(`${ids.length} issue${ids.length === 1 ? '' : 's'} sent to agent chats`, 'success');
  } catch (error) { if (current(version, workspace)) report(error); }
  finally { sending = false; if (current(version, workspace)) { renderSelection(); renderBoard(); renderDock(); } }
}

function card(group: IssueCard[], groupIndex: Map<string, number>): HTMLElement {
  const issue = group[0], taxonomy = getIssuesTaxonomySync(), home = issue.agent?.home, chat = issueChat(issue, sessionState?.chats ?? []);
  const node = el('article', '', 'home-flow-card'); node.tabIndex = 0; node.dataset.issueId = issue.id; node.setAttribute('aria-label', `${group.map(i => i.id).join(', ')}: ${issue.title}`);
  node.classList.toggle('is-selected', selected.has(issue.id)); node.classList.toggle('is-focused', dockOpen && group.some(i => i.id === focusedId));
  const top = el('div', '', 'home-card-top');
  if (selectable(issue)) { const check = el('input'); check.type = 'checkbox'; check.checked = selected.has(issue.id); check.setAttribute('aria-label', `Select ${issue.id}`); check.onclick = event => { event.stopPropagation(); toggleSelection(issue, event.shiftKey); }; top.append(check); }
  const type = createIssueTypeChip(issue.type, taxonomy.types.find(t => t.id === issue.type), { className: 'home-card-type' });
  type.setAttribute('role', 'img'); type.setAttribute('aria-label', type.title); top.append(type);
  top.append(el('span', group.map(i => i.id).join(' + '), 'home-mono home-card-id'));
  if (['urgent', 'high'].includes(issue.priority)) top.append(el('span', taxonomy.priorities.find(p => p.id === issue.priority)?.label || issue.priority, `home-priority home-priority--${issue.priority}`));
  node.append(top, el('h3', chat && group.length > 1 ? chat.name : issue.title));
  if (group.length === 1) node.append(createHomeIssueStatus(issue));
  const labels = createIssueLabelsDisplay([...new Set(group.flatMap(item => item.labels))]);
  if (labels) { labels.classList.add('home-card-labels'); node.append(labels); }
  if (group.length > 1) { const members = el('div', '', 'home-batch-members'); for (const member of group) { const row = el('div'); row.append(el('span', member.id, 'home-mono'), el('span', member.title), createHomeIssueStatus(member)); members.append(row); } node.append(members); }
  if (selected.has(issue.id)) {
    const index = groupIndex.get(issue.id) ?? 0, selectedGroup = selectedGroups()[index], isHeld = selectedGroup && held(selectedGroup);
    const tag = el('div', '', 'home-group-tag'); tag.dataset.group = String(index % 5); tag.classList.toggle('is-held', Boolean(isHeld));
    tag.append(el('span', '', 'home-group-dot'), el('span', `${isHeld ? 'Held · ' : ''}${groupMode === 'one' ? 'One chat' : groupMode === 'each' ? issue.title : issue.codeRefs?.[0]?.path.split(/[\\/]/).at(-1) || 'Separate chat'}`));
    if (isHeld) { const now = button('Start from main', () => { for (const member of selectedGroup) startNow.add(member.id); renderSelection(); renderBoard(); }); now.title = 'Start without waiting for the blocker’s changes'; tag.append(now); } node.append(tag);
  }
  const waits = blockers(issue, issues(), taxonomy);
  if (waits.length && home?.state !== 'done') { const blocked = el('p', `${home?.state === 'held' ? 'Held · sends when' : 'Waits on'} ${waits.map(i => i.id).join(', ')}${home?.state === 'held' ? ' merges' : ''}`, 'home-blocked'); blocked.prepend(createIcon('link')); node.append(blocked); }
  if (home?.state === 'held') node.append(button('Start from main now', () => { for (const item of group) updateIssueAgentRun(item.id, { home: { ...item.agent!.home!, state: 'waitslot', startNow: true } }); void pumpHomeQueue(); }));
  if (chat || issue.agent) {
    const agent = el('div', '', 'home-card-agent'), line = el('div', '', 'home-inline'), asking = chat && listChatsAwaitingAnswers().includes(chat.id);
    const chip = createHomeStatus(home?.state, asking ? 'awaiting_input' : issue.agent?.phase);
    line.append(chip, el('time', age(issue.agent?.updatedAt || issue.updatedAt), 'home-mono home-muted'));
    const activity = listMainTurnActivity().find(t => t.chatId === chat?.id);
    const update = activity ? activity.currentTool ? `Running ${activity.currentTool}` : activity.phase.replaceAll('_', ' ') : issue.agent?.error || issue.agent?.step || (home?.state === 'ready' ? home.mode === 'plan' ? 'Plan ready. Approve it before building.' : 'Agent finished. Review the conversation and checks.' : home?.state === 'waitslot' ? 'Starts when an agent slot is available.' : home?.state === 'paused' ? 'Chat and worktree are kept.' : '');
    agent.append(line); if (update) agent.append(el('p', update, 'home-agent-update'));
    const meta = el('div', '', 'home-card-meta home-mono'); meta.append(createIcon('fileTree'), el('span', issue.agent?.branch || chat?.gitBranch || 'Preparing worktree', 'home-worktree-label'), el('span', `· ${chat?.modelId || home?.modelId || 'Default model'}`, 'home-model-label')); agent.append(meta); node.append(agent);
  }
  if (flowColumn(issue, taxonomy) === 'triage') node.append(button('Accept to Ready', () => { updateIssue(issue.id, { status: requireIssueStatusForRole('todo'), triagedAt: Date.now() }); }, false, 'sparkles'));
  node.onclick = event => { if ((event.target as HTMLElement).closest('button, input')) return; if (event.shiftKey && selectable(issue)) toggleSelection(issue, true); else openIssue(issue); };
  node.onkeydown = event => { if (event.target !== node) return; if (event.key === 'Enter') { event.preventDefault(); openIssue(issue); } else if (event.key === ' ' && selectable(issue)) { event.preventDefault(); toggleSelection(issue, event.shiftKey); } }; return node;
}
function renderDrafts(host: HTMLElement): void {
  if (!draftTasks.length) return;
  const drafts = el('div', '', 'home-draft-tasks'); drafts.append(el('h3', `Planned from “${plannedGoal}”`));
  for (const task of draftTasks) { const row = el('div', '', 'home-draft-task'); row.append(el('strong', task.title), el('p', task.description, 'home-muted')); drafts.append(row); }
  const add = (select: boolean) => {
    for (const task of draftTasks) { const issue = addIssue({ title: task.title, description: task.description, workspacePath: mountedWorkspace, status: requireIssueStatusForRole('todo'), source: 'user' }); for (const path of task.files) appendIssueLinks(issue.id, { codeRefs: [{ path }] }); if (select) selected.add(issue.id); }
    draftTasks = []; renderSelection(); renderBoard(); void saveIssuesNow().catch(report);
  };
  const actions = el('div', '', 'home-draft-actions'); actions.append(button('Add to Ready', () => add(false), true), button('Add and select', () => add(true)), button('Discard', () => { draftTasks = []; renderBoard(); })); drafts.append(actions); host.append(drafts);
}
function renderBoard(): void {
  if (!boardHost || deferUntilIssueLabelPopoverClosed(renderBoard) || deferUntilContextMenuClosed(renderBoard)) return;
  const all = issues(), taxonomy = getIssuesTaxonomySync();
  for (const id of selected) if (!all.some(i => i.id === id && selectable(i))) selected.delete(id);
  const swatches = [...new Set(all.flatMap(issue => issue.labels))].map(name => [name, getIssueLabelSwatch(name)]);
  const next = JSON.stringify([all, taxonomy, swatches, [...selected], [...startNow], groupMode, doneExpanded, focusedId, dockOpen, draftTasks, loaded, listMainTurnActivity().map(t => [t.chatId, t.phase, t.currentTool]), listChatsAwaitingAnswers()]);
  if (next === boardSignature) return; boardSignature = next;
  const empty = loaded && !all.length;
  page.classList.toggle('home-page--empty', empty);
  boardHost.classList.toggle('home-flow-board--empty', empty);
  if (empty) {
    let state = boardHost.querySelector<HTMLElement>('.home-empty-state');
    if (!state) {
      state = el('section', '', 'home-empty-state'); state.setAttribute('aria-labelledby', 'home-empty-heading');
      const heading = el('h2', 'What’s next for this project?'); heading.id = 'home-empty-heading';
      state.append(heading, el('p', 'Describe a goal to break it into tasks, or add an issue yourself.', 'home-empty-description'), goalForm);
      const code = button('Continue building in Code', () => launchApp('code'), false, 'chevronRight'); code.classList.add('home-empty-code');
      state.append(code, el('div', '', 'home-empty-drafts')); boardHost.replaceChildren(state);
    }
    const drafts = state.querySelector<HTMLElement>('.home-empty-drafts')!; drafts.replaceChildren(); renderDrafts(drafts);
    return;
  }
  // Keep the same form and draft when the first issue brings back the flow.
  if (goalForm.parentElement !== page.querySelector('.home-header')) page.querySelector('.home-header-actions')!.before(goalForm);
  const active = document.activeElement as HTMLElement | null;
  const restoreId = boardHost.contains(active) ? active?.closest<HTMLElement>('[data-issue-id]')?.dataset.issueId : undefined;
  const scrolls = [...boardHost.querySelectorAll('.home-column-cards')].map(n => n.scrollTop); boardHost.replaceChildren();
  const groupIndex = new Map<string, number>(); selectedGroups().forEach((g, index) => g.forEach(i => groupIndex.set(i.id, index)));
  for (const [id, label] of FLOW_COLUMNS) {
    const column = el('section', '', 'home-flow-column'); column.dataset.column = id; column.setAttribute('aria-label', label);
    const list = all.filter(i => flowColumn(i, taxonomy) === id);
    const role = ({ triage: 'triage', ready: 'todo', progress: 'in_progress', review: 'review', done: 'done' } as const)[id];
    const status = taxonomy.statuses.find(item => item.role === role);
    const header = el('div', '', 'home-column-heading'); header.append(createIssueTypeIconElement(resolveIssueStatusIcon(role, status)), el('h2', label), el('span', String(list.length), 'home-mono'));
    if (id === 'triage' || id === 'ready') { const picks = list.filter(selectable), clear = picks.length > 0 && picks.every(i => selected.has(i.id)); if (picks.length) header.append(button(clear ? 'Clear' : 'Select all', () => { for (const pick of picks) { if (clear) selected.delete(pick.id); else selected.add(pick.id); } renderSelection(); renderBoard(); })); }
    const body = el('div', '', 'home-column-cards'); body.tabIndex = 0; body.setAttribute('role', 'group'); body.setAttribute('aria-label', `${label} issues`);
    if (id === 'triage') renderDrafts(body);
    if (!loaded) for (let n = 0; n < 2; n++) body.append(el('div', '', 'home-card-skeleton'));
    else if (id === 'done') {
      const collapse = button(`Done today · ${list.filter(i => new Date(i.updatedAt).toDateString() === new Date().toDateString()).length}`, () => { doneExpanded = !doneExpanded; renderBoard(); }, false, 'check'); collapse.append(createIcon(doneExpanded ? 'chevronUp' : 'chevronDown')); collapse.setAttribute('aria-expanded', String(doneExpanded)); collapse.classList.add('home-done-toggle'); body.append(collapse);
      if (doneExpanded) for (const group of batchIssues(list)) body.append(card(group, groupIndex));
    } else { for (const group of batchIssues(list)) body.append(card(group, groupIndex)); if (!list.length && !(id === 'triage' && draftTasks.length)) body.append(el('p', id === 'triage' ? 'Capture an issue or plan a goal above.' : id === 'ready' ? 'Accepted issues are ready to send to agents.' : id === 'progress' ? 'Agent chats appear here when you start work.' : 'Completed agent work appears here for review.', 'home-column-empty')); }
    if (id === 'review') { const queued = list.filter(i => ['mergequeued', 'merging'].includes(i.agent?.home?.state || '')); if (queued.length) { const queue = el('div', '', 'home-merge-queue'); queue.append(el('h3', `Merge queue → ${baseBranch || 'main'}`)); for (const group of batchIssues(queued)) queue.append(el('p', `${group[0].id} · ${group[0].agent?.home?.state === 'merging' ? 'checking and merging' : 'waiting'}`, 'home-mono')); body.append(queue); } }
    column.append(header, body); boardHost.append(column);
  }
  [...boardHost.querySelectorAll('.home-column-cards')].forEach((n, index) => { n.scrollTop = scrolls[index] || 0; });
  if (restoreId) [...boardHost.querySelectorAll<HTMLElement>('[data-issue-id]')].find(n => n.dataset.issueId === restoreId)?.focus({ preventScroll: true });
}

function renderDock(): void {
  if (!dockHost) return;
  const issue = issues().find(i => i.id === focusedId), chat = issue && issueChat(issue, sessionState?.chats ?? []);
  page.classList.toggle('home-page--dock-open', dockOpen);
  page.classList.toggle('home-page--dock-maximized', dockOpen && dockMaximized);
  page.style.setProperty('--home-dock-height', `${dockHeight}%`);
  dockHost.hidden = !dockOpen;
  tabsHost.hidden = dockOpen;
  if (!dockOpen) {
    const label = issue ? `${issue.id} · ${issue.title}` : 'Select an issue to open its workspace';
    let expand = tabsHost.querySelector<HTMLButtonElement>('button');
    if (!expand) { expand = button(label, () => { if (focusedId) { dockOpen = true; renderDock(); renderBoard(); notifyAskQuestionDisplayContextChanged(); } }, false, 'chevronUp'); tabsHost.append(expand); }
    expand.querySelector('span')!.textContent = label; expand.disabled = !issue; expand.setAttribute('aria-expanded', 'false');
    return;
  }
  const key = `${generation}:${focusedId}:${chat?.id || ''}`;
  if (key === dockKey) { dockUpdate?.(); return; }
  dockKey = key; dockCleanup?.(); dockCleanup = undefined; dockUpdate = undefined; dockHost.replaceChildren();
  if (!issue) { dockHost.append(el('p', 'Select an issue to see its context and agent conversation.', 'home-dock-empty')); return; }
  const dock = mountIssueDock(dockHost, {
    issue, issues: issues(), currentIssues: issues, workspace: mountedWorkspace, modelLabel: modelLabel(),
    start: (i, mode, instructions) => { void sendSelection(i, mode, instructions); },
    select: i => { selected.add(i.id); renderSelection(); renderBoard(); },
    addToChat: (i, chat) => { void addToHomeChat([i], chat).then(() => { renderBoard(); renderDock(); }).catch(report); },
    collapse: () => { dockOpen = false; renderDock(); renderBoard(); notifyAskQuestionDisplayContextChanged(); },
    close: () => {
      const id = focusedId; dockOpen = false; focusedId = ''; dockMaximized = false;
      dockCleanup?.(); dockCleanup = undefined; dockUpdate = undefined; dockKey = ''; dockHost.replaceChildren();
      renderDock(); renderBoard(); document.querySelector<HTMLElement>(`[data-issue-id="${CSS.escape(id)}"]`)?.focus();
    },
    maximize: () => { dockMaximized = !dockMaximized; renderDock(); }, isMaximized: () => dockMaximized,
  });
  dockCleanup = dock.dispose; dockUpdate = dock.update;
}
function mountDockResize(handle: HTMLElement): void {
  const clamp = (value: number) => Math.max(30, Math.min(90, value));
  const apply = (value: number) => { dockHeight = clamp(value); page.style.setProperty('--home-dock-height', `${dockHeight}%`); handle.setAttribute('aria-valuenow', String(Math.round(dockHeight))); };
  const save = () => { try { localStorage.setItem('minnow.home.dockHeight', String(dockHeight)); } catch {} };
  handle.onkeydown = event => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); apply(event.key === 'Home' ? 30 : event.key === 'End' ? 90 : dockHeight + (event.key === 'ArrowUp' ? 5 : -5)); save();
  };
  handle.onpointerdown = event => {
    if (!dockOpen || dockMaximized || event.button !== 0) return;
    event.preventDefault(); handle.setPointerCapture(event.pointerId);
    const rect = page.getBoundingClientRect();
    handle.onpointermove = next => { apply((rect.bottom - next.clientY) / rect.height * 100); };
    const end = () => { handle.onpointermove = null; handle.onpointerup = null; handle.onpointercancel = null; save(); };
    handle.onpointerup = end; handle.onpointercancel = end;
  };
}
async function refresh(): Promise<void> {
  clearTimeout(timer); if (getForegroundAppId() !== 'home' || document.hidden) return;
  if (!workspacePathsEqual(getWorkspacePath(), mountedWorkspace)) { await openHome(); return; }
  const version = generation, workspace = mountedWorkspace;
  try {
    await ensureSessionsReady(); if (!isIssuesStoreLoaded()) await loadIssuesFromStorage(); else await refreshIssuesFromStorage();
    if (!current(version, workspace)) return; loaded = true; errorHost.hidden = true; reconcileHomeFlow(); renderBoard(); renderSelection(); renderDock(); void pumpHomeQueue(); void drainHomeMerges();
  } catch { if (current(version, workspace)) showRefreshError(loaded ? 'Showing the last update. Could not refresh.' : 'Could not load project issues.'); }
  const result = await gitBranches(workspace);
  if (!current(version, workspace)) return;
  if (result.ok) { const local = result.local ?? []; baseBranch = local.includes('main') ? 'main' : local.includes('master') ? 'master' : ''; }
  else showRefreshError('Showing the last update. Could not refresh project branches.');
  renderSelection(); timer = setTimeout(() => void refresh(), 10000);
}
function showRefreshError(message: string): void { errorHost.hidden = false; errorHost.replaceChildren(el('span', message), button('Retry', () => void refresh())); }

export async function openHome(): Promise<void> {
  initHomePage(); generation++; clearTimeout(timer); clearInterval(liveTimer); planAbort?.abort(); dockCleanup?.(); dockCleanup = undefined; dockUpdate = undefined; dockKey = '';
  const version = generation; if (!getWorkspacePath()) await loadWorkspaceFromServer(); if (version !== generation || getForegroundAppId() !== 'home') return;
  const workspace = getWorkspacePath();
  if (!workspacePathsEqual(workspace, mountedWorkspace)) { selected = new Set(); startNow = new Set(); focusedId = ''; goalText = ''; draftTasks = []; dockOpen = false; sendModel = ''; dockMaximized = false; baseBranch = ''; }
  mountedWorkspace = workspace; boardSignature = ''; loaded = false;
  const root = document.getElementById('homeView')!; root.classList.add('is-open'); root.replaceChildren();
  page = el('div', '', 'home-page'); page.tabIndex = -1; page.setAttribute('role', 'region'); page.setAttribute('aria-label', 'Project dashboard'); page.onkeydown = event => { if (event.defaultPrevented || event.key !== 'Escape') return; if (selected.size) { selected.clear(); startNow.clear(); renderSelection(); renderBoard(); } else if (dockOpen) { dockOpen = false; renderDock(); renderBoard(); notifyAskQuestionDisplayContextChanged(); document.querySelector<HTMLElement>(`[data-issue-id="${CSS.escape(focusedId)}"]`)?.focus(); } };
  const header = el('header', '', 'home-header'), title = el('h1', getWorkspaceLabel() || 'Your project'); title.title = workspace; header.append(title);
  const goal = goalForm = el('form', '', 'home-goal-bar'), input = el('input'); input.value = goalText; input.placeholder = 'Describe a goal, paste an error, or capture an issue…'; input.setAttribute('aria-label', 'Project goal or issue'); input.oninput = () => { goalText = input.value; capture.disabled = plan.disabled = !input.value.trim() || !workspace || Boolean(planAbort); };
  const capture = button('Add issue', () => { if (!input.value.trim() || !loaded || planAbort) return; const text = input.value.trim(), issue = addIssue({ title: text.split(/\r?\n/)[0].slice(0, 240), description: text, status: requireIssueStatusForRole('triage'), workspacePath: workspace }); input.value = goalText = ''; capture.disabled = plan.disabled = true; showToast(`${issue.id} captured in Triage`, 'success'); renderBoard(); });
  const plan = button('Plan a goal', () => goal.requestSubmit(), true); capture.disabled = plan.disabled = !input.value.trim() || !workspace; goal.append(createIcon('sparkles'), input, plan, capture);
  goal.onsubmit = event => {
    event.preventDefault(); const text = input.value.trim(); if (!text || !loaded || planAbort) return;
    const abort = new AbortController(); planAbort = abort; plan.disabled = capture.disabled = true; plan.querySelector('span')!.textContent = 'Planning…';
    void planHomeGoal(text, [...new Set([...issues().flatMap(i => i.codeRefs?.map(r => r.path) ?? []), ...listRecentViewerFiles(workspace).map(f => f.path)])], abort.signal).then(tasks => { if (!current(version, workspace)) return; plannedGoal = text; draftTasks = tasks; renderBoard(); }).catch(error => { if (!abort.signal.aborted && current(version, workspace)) report(error); }).finally(() => { if (planAbort === abort) planAbort = undefined; if (current(version, workspace)) { capture.disabled = plan.disabled = !input.value.trim(); plan.querySelector('span')!.textContent = 'Plan a goal'; } });
  };
  header.append(goal); const actions = el('div', '', 'home-header-actions'); actions.append(button('New board', navigateToCodeOrchestrate), button('Open Code', () => launchApp('code'), true)); header.append(actions);
  selectionHost = el('div', '', 'home-selection-bar'); selectionHost.hidden = true; errorHost = el('div', '', 'home-refresh-error'); errorHost.hidden = true; errorHost.setAttribute('role', 'status');
  boardHost = el('div', '', 'home-flow-board'); boardHost.setAttribute('role', 'group'); boardHost.setAttribute('aria-label', 'Project issue flow');
  const dock = el('section', '', 'home-dock'); dock.setAttribute('aria-label', 'Project context');
  const resize = el('div', '', 'home-dock-resize'); resize.tabIndex = 0; resize.setAttribute('role', 'separator'); resize.setAttribute('aria-label', 'Resize issue details'); resize.setAttribute('aria-orientation', 'horizontal'); resize.setAttribute('aria-valuemin', '30'); resize.setAttribute('aria-valuemax', '90'); resize.setAttribute('aria-valuenow', String(Math.round(dockHeight))); mountDockResize(resize);
  tabsHost = el('div', '', 'home-dock-collapsed'); dockHost = el('div', '', 'home-dock-content'); dockHost.id = 'home-dock-content'; dockHost.setAttribute('role', 'region'); dock.append(resize, tabsHost, dockHost);
  page.append(header, selectionHost, errorHost, boardHost, dock); root.append(page); renderSelection(); renderBoard(); renderDock();
  if (workspace) { void refresh(); liveTimer = setInterval(() => { if (current(version, workspace) && !document.hidden) { renderBoard(); dockUpdate?.(); } }, 1000); }
  else { loaded = true; showRefreshError('Choose a workspace to capture issues and start agent work.'); errorHost.append(button('Choose project', () => { void import('../os/workspace-gate').then(m => m.openWorkspaceGate({ switch: true })); })); renderBoard(); }
}
export function initHomePage(): void {
  if (!document.getElementById('homeView')) { const root = el('main', '', 'mn-os-app-layer'); root.id = 'homeView'; root.dataset.osApp = 'home'; document.getElementById('osAppsLayer')?.append(root); }
  if (initialized) return; initialized = true; initHomeFlow();
  const update = () => { if (getForegroundAppId() === 'home' && page?.isConnected) { renderBoard(); renderSelection(); renderDock(); } };
  subscribeIssuesChanges(() => queueMicrotask(update)); subscribeIssuesTaxonomyChanges(() => queueMicrotask(update)); subscribeMainTurnActivity(update); subscribeHomeFlow(update);
  subscribeInstances(() => { if (getForegroundAppId() !== 'home') { generation++; clearTimeout(timer); clearInterval(liveTimer); planAbort?.abort(); planAbort = undefined; dockCleanup?.(); dockCleanup = undefined; dockKey = ''; closeIssueLabelPopovers(); closeContextMenu({ restoreFocus: false }); } });
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(timer); else if (getForegroundAppId() === 'home') void refresh(); });
}
