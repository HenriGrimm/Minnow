import { createIssueChatActivity } from './issues-chat-activity';
import { createIssueExpansionActivity } from './issues-background-activity';
import '../styles/issues.css';
import '../styles/issues-sidebar.css';
import { sidebarIssues, sidebarWorkspaceKey, splitQuickIssue, type SidebarIssueFilter, type SidebarIssueProperties } from '../issues/sidebar-model';
import { createIssueTypeChip, createIssueStatusChip, createIssuePriorityChip } from '../issues/type-icons';
import { sortedStatuses, sortedTypes, sortedPriorities } from '../issues/taxonomy';
import { createIssuesLabelsField, isIssuesLabelsFieldFocused } from './issues-labels-field';
import { deferUntilIssueLabelPopoverClosed } from './issues-label-chip';
import { createIcon } from './icon';
import type { createIssueDetailController } from './issues-detail';
import { addIssue, findIssueById, isIssuesStoreLoaded, isIssuesStoreRecovering, listIssues, listIssueProjects, loadIssuesFromStorage, saveIssuesNow, updateIssue, type AddIssueInput } from '../state/issues-store';
import { getIssuesTaxonomySync, loadIssuesTaxonomyFromStorage } from '../state/issues-taxonomy-store';
import { subscribeIssuesChanges } from '../state/issues-events';
import { subscribeIssuesTaxonomyChanges } from '../state/issues-taxonomy-events';
import { getWorkspacePath } from '../state/workspace';
import { patchFilePanelState } from '../state/file-panel';
import { applyFileSidebarVisuals, isMobileLayout, openMobileFileSidebar } from './file-layout';
import { isIssuesSidebarActive, setIssuesSidebarActive } from './file-sidebar-view';
import { closeGitSidePanel } from './git-panel';
import { openIssuesContextMenu } from './issues-context-menu';
import { rememberIssueMenuAnchor } from './issues-chat-run-target';
import { deferUntilContextMenuClosed } from './context-menu';
import { showToast } from './toast';

interface SidebarState {
  draft: AddIssueInput;
  filter: SidebarIssueFilter;
  properties: SidebarIssueProperties;
  query: string;
  selectedId?: string;
  scrollTop: number;
  pendingId?: string;
}

const states = new Map<string, SidebarState>();
const STORAGE_KEY = 'minnow.issues.sidebarDrafts';
let currentWorkspace = '';
let root: HTMLElement | null = null;
let input: HTMLTextAreaElement;
let createButton: HTMLButtonElement;
let expandButton: HTMLButtonElement;
let list: HTMLElement;
let detail: HTMLElement;
let detailController: ReturnType<typeof createIssueDetailController> | null = null;
let mountedDetailId: string | undefined;
let feedback: HTMLElement;
let count: HTMLElement;
let busy = false;
let loading: Promise<void> | null = null;
let subscribed = false;

function state(): SidebarState {
  let value = states.get(currentWorkspace);
  if (!value) {
    let draft: AddIssueInput = { title: '' };
    let pendingId: string | undefined;
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')[currentWorkspace];
      if (typeof stored?.pendingId === 'string') pendingId = stored.pendingId;
      if (stored && typeof stored.title === 'string') draft = {
        title: stored.title,
        description: typeof stored.description === 'string' ? stored.description : '',
        type: typeof stored.type === 'string' ? stored.type : undefined,
        priority: typeof stored.priority === 'string' ? stored.priority : undefined,
        labels: Array.isArray(stored.labels) ? stored.labels.filter((label: unknown) => typeof label === 'string') : [],
      };
    } catch {}
    value = { draft, filter: 'open', properties: {}, query: '', scrollTop: 0, pendingId };
    states.set(currentWorkspace, value);
  }
  return value;
}

function saveDraft(): void {
  try {
    const drafts = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    if (state().draft.title.trim() || state().draft.description?.trim()) drafts[currentWorkspace] = { ...state().draft, pendingId: state().pendingId };
    else delete drafts[currentWorkspace];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
  } catch {}
}

function draftText(draft: AddIssueInput): string {
  return [draft.title, draft.description].filter(Boolean).join('\n');
}

function syncCapture(): void {
  const disabled = busy || !isIssuesStoreLoaded() || isIssuesStoreRecovering() || !input.value.trim();
  input.disabled = busy || Boolean(state().pendingId);
  createButton.disabled = disabled;
  expandButton.disabled = disabled || Boolean(state().pendingId);
  createButton.textContent = busy ? 'Creating…' : state().pendingId ? 'Retry save' : 'Create';
}

function button(text: string, onClick: () => void, className = 'issues-sidebar__button'): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = text;
  node.addEventListener('click', onClick);
  return node;
}

async function editIssue(id: string): Promise<void> {
  detailController?.closeIssueDetail();
  mountedDetailId = undefined;
  window.location.hash = `#/app/issues/${encodeURIComponent(id)}`;
}

async function showMenu(id: string, anchor: HTMLElement, point?: { x: number; y: number }): Promise<void> {
  const { buildIssueRowMenuItems } = await import('./issues-page');
  const issue = findIssueById(id);
  if (!issue || !anchor.isConnected) return;
  const rect = anchor.getBoundingClientRect();
  rememberIssueMenuAnchor(point?.x ?? rect.left, point?.y ?? rect.bottom, anchor);
  const items = await buildIssueRowMenuItems(issue, [id], {
    view: () => viewIssue(id), edit: () => { void editIssue(id); },
  });
  if (!anchor.isConnected || !isIssuesSidebarActive()) return;
  openIssuesContextMenu({
    anchor: point ? undefined : anchor, clientX: point?.x, clientY: point?.y,
    restoreFocus: anchor,
    items,
  });
}

function bindMenu(node: HTMLElement, id: string): void {
  node.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    void showMenu(id, node, { x: event.clientX, y: event.clientY });
  });
  node.addEventListener('keydown', (event) => {
    if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
      event.preventDefault();
      event.stopPropagation();
      void showMenu(id, node);
    }
  });
}

function viewIssue(id: string): void {
  if (!state().selectedId) state().scrollTop = list.scrollTop;
  state().selectedId = id;
  render();
  detail.querySelector<HTMLButtonElement>('button')?.focus();
}

function backToList(): void {
  const id = state().selectedId;
  state().selectedId = undefined;
  detailController?.closeIssueDetail();
  mountedDetailId = undefined;
  render();
  list.scrollTop = state().scrollTop;
  const row = [...list.querySelectorAll<HTMLButtonElement>('[data-issue-id]')].find((node) => node.dataset.issueId === id);
  row?.focus();
}

function filterOptions() {
  const taxonomy = getIssuesTaxonomySync();
  return [
    { key: 'type', label: 'Type', items: sortedTypes(taxonomy) },
    { key: 'status', label: 'Status', items: sortedStatuses(taxonomy) },
    { key: 'priority', label: 'Priority', items: sortedPriorities(taxonomy) },
    { key: 'projectId', label: 'Project', items: [
      { id: null, label: 'No project' },
      ...listIssueProjects().map((project) => ({ id: project.id, label: project.name })),
    ] },
  ] as const;
}

function openFilterMenu(anchor: HTMLElement): void {
  const value = state();
  openIssuesContextMenu({
    anchor, restoreFocus: anchor, label: 'Filters',
    items: filterOptions().map(({ key, label, items }) => ({
      id: key, label,
      submenu: () => items.map((item) => ({
        id: item.id ?? 'no-project', label: item.label,
        onSelect: () => {
          value.properties = { ...value.properties, [key]: item.id };
          render();
        },
      })),
    })),
  });
}

function renderFilterChips(): void {
  const host = root!.querySelector<HTMLElement>('[data-filter-chips]')!;
  const restoreFocus = host.contains(document.activeElement);
  const value = state();
  const chips: HTMLButtonElement[] = [];
  for (const { key, label, items } of filterOptions()) {
    const selected = value.properties[key];
    if (selected === undefined) continue;
    const name = items.find((item) => item.id === selected)?.label
      ?? (key === 'projectId' ? listIssueProjects({ includeArchived: true }).find((project) => project.id === selected)?.name : undefined)
      ?? selected;
    const chip = button(`${label}: ${name} ×`, () => {
      delete value.properties[key];
      render();
    }, 'issues-filter-chip');
    chip.dataset.chipId = key;
    chip.setAttribute('aria-label', `Remove ${label.toLowerCase()} filter: ${name}`);
    chips.push(chip);
  }
  host.replaceChildren(...chips);
  host.hidden = chips.length === 0;
  if (restoreFocus) root!.querySelector<HTMLButtonElement>('[data-add-filter]')!.focus();
}

function render(): void {
  if (!root || !isIssuesStoreLoaded()) return;
  if (deferUntilContextMenuClosed(render) || deferUntilIssueLabelPopoverClosed(render)) return;
  const value = state();
  const selected = value.selectedId ? findIssueById(value.selectedId) : undefined;
  if (value.selectedId && !selected) value.selectedId = undefined;
  const showDetail = Boolean(selected);
  root.querySelector<HTMLElement>('.issues-sidebar__list-view')!.hidden = showDetail;
  detail.hidden = !showDetail;
  if (selected) {
    if (mountedDetailId !== selected.id || !detailController?.isIssuesDetailEditing()) {
      detailController?.openIssueDetail(selected.id);
      mountedDetailId = selected.id;
    }
    return;
  }
  if (mountedDetailId) {
    detailController?.closeIssueDetail();
    mountedDetailId = undefined;
  }
  if (isIssuesLabelsFieldFocused()) return;
  const taxonomy = getIssuesTaxonomySync();
  renderFilterChips();
  const issues = sidebarIssues(listIssues(), getWorkspacePath(), taxonomy, value.filter, value.query, value.properties);
  count.textContent = `${issues.length} ${issues.length === 1 ? 'issue' : 'issues'}`;
  const scroll = list.scrollTop;
  const active = document.activeElement as HTMLElement | null;
  const focusId = list.contains(active) ? active?.closest<HTMLElement>('[data-issue-id]')?.dataset.issueId : undefined;
  const rows = issues.map((issue) => {
    const row = document.createElement('div');
    row.className = 'issues-sidebar__row';
    const view = button('', () => viewIssue(issue.id), 'issues-sidebar__issue');
    view.dataset.issueId = issue.id;
    const status = taxonomy.statuses.find((entry) => entry.id === issue.status);
    const icon = createIssueTypeChip(issue.type, taxonomy.types.find((entry) => entry.id === issue.type));
    const content = document.createElement('span');
    content.className = 'issues-sidebar__content';
    const title = document.createElement('span');
    title.className = 'issues-sidebar__title';
    title.textContent = issue.title;
    title.title = issue.title;
    title.prepend(createIssueExpansionActivity(issue.id, issue.workspacePath), createIssueChatActivity(issue));
    const meta = document.createElement('span');
    meta.className = 'issues-sidebar__meta';
    const id = document.createElement('span');
    id.className = 'issues-sidebar__id';
    id.textContent = issue.id;
    meta.append(id, createIssueStatusChip(issue.status, status), createIssuePriorityChip(issue.priority, taxonomy.priorities.find((entry) => entry.id === issue.priority)));
    content.append(title, meta);
    view.append(icon, content);
    bindMenu(view, issue.id);
    const more = button('', () => { void showMenu(issue.id, more); }, 'issues-sidebar__more');
    more.appendChild(createIcon('more', { size: 16 }));
    more.setAttribute('aria-label', `Actions for ${issue.id}`);
    const labels = createIssuesLabelsField({
      issueId: issue.id, labels: issue.labels, severity: issue.severity, variant: 'row',
      onChange: (labels) => { updateIssue(issue.id, { labels }); },
      onBlur: render,
    });
    row.append(view, more, labels);
    row.dataset.status = issue.status;
    return row;
  });
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'issues-sidebar__empty';
    empty.textContent = value.query.trim() || Object.keys(value.properties).length ? 'No matching issues. Remove a filter or change your search.' : value.filter === 'closed' ? 'No closed issues in this workspace.' : value.filter === 'all' ? 'No issues yet. Capture one above.' : 'No open issues. Capture one above.';
    list.replaceChildren(empty);
  } else {
    const groups: HTMLElement[] = [];
    const statuses = [...new Set([...sortedStatuses(taxonomy).map((entry) => entry.id), ...issues.map((issue) => issue.status)])];
    for (const statusId of statuses) {
      const members = rows.filter((row) => row.dataset.status === statusId);
      if (!members.length) continue;
      const heading = document.createElement('h3');
      heading.className = 'issues-sidebar__group';
      heading.textContent = taxonomy.statuses.find((entry) => entry.id === statusId)?.label ?? statusId;
      const total = document.createElement('span');
      total.textContent = String(members.length);
      heading.appendChild(total);
      groups.push(heading, ...members);
    }
    list.replaceChildren(...groups);
  }
  list.scrollTop = scroll;
  if (focusId) [...list.querySelectorAll<HTMLButtonElement>('[data-issue-id]')].find((node) => node.dataset.issueId === focusId)?.focus();
}

async function createIssue(expandInBackground = false): Promise<void> {
  if (busy || !state().draft.title.trim()) return;
  busy = true;
  feedback.textContent = '';
  syncCapture();
  try {
    if (!isIssuesStoreLoaded() || isIssuesStoreRecovering()) throw new Error('Issues are still loading');
    if (state().pendingId && !findIssueById(state().pendingId!)) state().pendingId = undefined;
    if (!state().pendingId) state().pendingId = addIssue({ ...state().draft, workspacePath: getWorkspacePath(), source: 'user' }).id;
    saveDraft();
    await saveIssuesNow();
    const id = state().pendingId!;
    state().pendingId = undefined;
    state().draft = { title: '' };
    saveDraft();
    input.value = '';
    feedback.textContent = expandInBackground ? `Created ${id}. Expanding in the background.` : `Created ${id}`;
    render();
    if (expandInBackground) {
      void import('./issues-expand').then((m) => m.expandCreatedIssueInBackground(id)).catch((error) => {
        showToast(error instanceof Error ? error.message : `Could not expand ${id}`, 'error');
      });
    }
  } catch {
    feedback.textContent = 'Could not save this issue. Retry save to keep it without creating a duplicate.';
  } finally {
    busy = false;
    syncCapture();
    input.focus();
  }
}

function mount(): void {
  const host = document.getElementById('issuesSidebarRoot');
  if (!host || root === host && host.childElementCount) return;
  detailController?.dispose();
  detailController = null;
  mountedDetailId = undefined;
  root = host;
  root.innerHTML = `<div class="issues-sidebar__list-view">
    <form class="issues-sidebar__capture">
      <label for="issuesSidebarDraft">New issue</label>
      <textarea id="issuesSidebarDraft" rows="3" placeholder="Describe the issue…" aria-describedby="issuesSidebarFeedback"></textarea>
      <div class="issues-sidebar__actions"><button type="button" data-expand>Expand</button><button type="submit" data-create>Create</button></div>
      <p id="issuesSidebarFeedback" class="issues-sidebar__feedback" role="status" aria-live="polite"></p>
    </form>
    <div class="issues-sidebar__filters"><select aria-label="Filter issues"><option value="open">Open</option><option value="all">All</option><option value="closed">Closed</option></select><button type="button" data-add-filter class="issues-filter-chip issues-filter-chip--add" aria-haspopup="menu">Filter</button><span data-count class="issues-sidebar__meta" role="status"></span>
      <div data-filter-chips class="issues-sidebar__filter-chips" aria-label="Active issue filters" hidden></div>
      <input type="search" placeholder="Search issues…" aria-label="Search issues by title or ID">
    </div>
    <div class="issues-sidebar__list" aria-label="Issues"></div>
    <button type="button" class="issues-sidebar__all">View all issues →</button>
  </div><div class="issues-sidebar__detail" hidden>
    <div class="issues-sidebar__detail-toolbar"></div>
    <div class="issues-sidebar__detail-host" aria-label="Issue detail"></div>
  </div>`;
  input = root.querySelector('textarea')!;
  createButton = root.querySelector('[data-create]')!;
  expandButton = root.querySelector('[data-expand]')!;
  expandButton.title = 'Create the issue and expand it in the background';
  list = root.querySelector('.issues-sidebar__list')!;
  detail = root.querySelector('.issues-sidebar__detail')!;
  const toolbar = detail.querySelector('.issues-sidebar__detail-toolbar')!;
  toolbar.append(button('‹ Back', backToList), button('Open in Issues', () => {
    const id = state().selectedId;
    if (id) void editIssue(id);
  }));
  detail.addEventListener('focusout', () => {
    setTimeout(() => { if (isIssuesSidebarActive() && state().selectedId) render(); }, 0);
  });
  feedback = root.querySelector('.issues-sidebar__feedback')!;
  count = root.querySelector('[data-count]')!;
  const addFilter = root.querySelector<HTMLButtonElement>('[data-add-filter]')!;
  addFilter.addEventListener('click', () => openFilterMenu(addFilter));
  root.querySelector('form')!.addEventListener('submit', (event) => { event.preventDefault(); void createIssue(); });
  expandButton.addEventListener('click', () => { void createIssue(true); });
  input.addEventListener('input', () => {
    state().draft = { ...state().draft, ...splitQuickIssue(input.value) };
    saveDraft();
    syncCapture();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault();
      void createIssue();
    }
  });
  root.querySelector('select')!.addEventListener('change', (event) => {
    state().filter = (event.target as HTMLSelectElement).value as SidebarIssueFilter;
    render();
  });
  root.querySelector('input')!.addEventListener('input', (event) => {
    state().query = (event.target as HTMLInputElement).value;
    render();
  });
  root.querySelector('.issues-sidebar__all')!.addEventListener('click', () => {
    void import('../os/router').then((m) => m.launchApp('issues'));
  });
  if (!subscribed) {
    subscribed = true;
    const refresh = () => { if (isIssuesSidebarActive()) render(); };
    subscribeIssuesChanges(refresh);
    subscribeIssuesTaxonomyChanges(refresh);
  }
}

export async function openIssuesSidebar(): Promise<void> {
  closeGitSidePanel();
  setIssuesSidebarActive(true);
  patchFilePanelState({ fileSidebarCollapsed: false });
  if (isMobileLayout()) openMobileFileSidebar();
  applyFileSidebarVisuals();
  const workspace = sidebarWorkspaceKey(getWorkspacePath());
  if (workspace !== currentWorkspace) {
    detailController?.closeIssueDetail();
    mountedDetailId = undefined;
  }
  currentWorkspace = workspace;
  mount();
  if (!root) return;
  if (!detailController) {
    const { createIssueDetailController } = await import('./issues-detail');
    detailController ??= createIssueDetailController({
      host: detail.querySelector<HTMLElement>('.issues-sidebar__detail-host')!,
      onClose: backToList,
      onNavigate: viewIssue,
    });
  }
  input.value = draftText(state().draft);
  root.querySelector('select')!.value = state().filter;
  root.querySelector('input')!.value = state().query;
  syncCapture();
  if (!isIssuesStoreLoaded() || isIssuesStoreRecovering()) {
    feedback.textContent = 'Loading issues…';
    createButton.disabled = expandButton.disabled = true;
    loading ??= (async () => {
      await loadIssuesTaxonomyFromStorage();
      await loadIssuesFromStorage();
      if (isIssuesStoreRecovering()) throw new Error('Could not load issues');
    })().finally(() => { loading = null; });
    try { await loading; }
    catch {
      feedback.textContent = 'Could not load issues. Select Issues again to retry.';
      return;
    }
    feedback.textContent = '';
    syncCapture();
  }
  render();
}
