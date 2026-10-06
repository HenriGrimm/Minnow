import '../styles/issues-sidebar.css';
import { sidebarIssues, sidebarWorkspaceKey, splitQuickIssue, type SidebarIssueFilter } from '../issues/sidebar-model';
import { resolveIssueStatusIcon } from '../issues/type-icons';
import { addIssue, findIssueById, isIssuesStoreLoaded, isIssuesStoreRecovering, listIssues, loadIssuesFromStorage, saveIssuesNow, type AddIssueInput } from '../state/issues-store';
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
import { setAssistantBubbleContent } from '../markdown/renderer';
import { displayIssueAttachmentSrc } from '../state/issue-attachments-api';
import { showToast } from './toast';
import type { IssueCard } from '../types';

interface SidebarState {
  draft: AddIssueInput;
  filter: SidebarIssueFilter;
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
    value = { draft, filter: 'open', query: '', scrollTop: 0, pendingId };
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
  state().scrollTop = list.scrollTop;
  state().selectedId = id;
  render();
  detail.querySelector<HTMLButtonElement>('button')?.focus();
}

function renderDetail(issue: IssueCard): void {
  const toolbar = document.createElement('div');
  toolbar.className = 'issues-sidebar__detail-toolbar';
  toolbar.append(button('‹ Back', () => {
    const id = state().selectedId;
    state().selectedId = undefined;
    render();
    list.scrollTop = state().scrollTop;
    const row = [...list.querySelectorAll<HTMLButtonElement>('[data-issue-id]')].find((node) => node.dataset.issueId === id);
    row?.focus();
  }), button('Edit in Issues', () => { void editIssue(issue.id); }));
  const more = button('⋯', () => { void showMenu(issue.id, more); });
  more.setAttribute('aria-label', `Actions for ${issue.id}`);
  toolbar.append(more);
  const meta = document.createElement('p');
  meta.className = 'issues-sidebar__meta';
  const taxonomy = getIssuesTaxonomySync();
  meta.textContent = `${issue.id} · ${taxonomy.statuses.find((entry) => entry.id === issue.status)?.label ?? issue.status}`;
  const title = document.createElement('h2');
  title.textContent = issue.title;
  const properties = document.createElement('p');
  properties.className = 'issues-sidebar__meta';
  properties.textContent = [
    taxonomy.types.find((entry) => entry.id === issue.type)?.label ?? issue.type,
    taxonomy.priorities.find((entry) => entry.id === issue.priority)?.label ?? issue.priority,
    ...issue.labels,
  ].join(' · ');
  const body = document.createElement('div');
  body.className = 'issues-sidebar__description';
  setAssistantBubbleContent(body, issue.description || 'No description yet.');
  body.querySelectorAll<HTMLImageElement>('img').forEach((image) => {
    image.src = displayIssueAttachmentSrc(image.getAttribute('src') ?? '');
  });
  detail.replaceChildren(toolbar, meta, title, properties, body);
}

function render(): void {
  if (!root || !isIssuesStoreLoaded()) return;
  if (deferUntilContextMenuClosed(render)) return;
  const value = state();
  const selected = value.selectedId ? findIssueById(value.selectedId) : undefined;
  if (value.selectedId && !selected) value.selectedId = undefined;
  const showDetail = Boolean(selected);
  root.querySelector<HTMLElement>('.issues-sidebar__list-view')!.hidden = showDetail;
  detail.hidden = !showDetail;
  if (selected) {
    const focused = detail.contains(document.activeElement) ? (document.activeElement as HTMLElement).textContent : null;
    renderDetail(selected);
    if (focused) [...detail.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === focused)?.focus();
    return;
  }
  const taxonomy = getIssuesTaxonomySync();
  const issues = sidebarIssues(listIssues(), getWorkspacePath(), taxonomy, value.filter, value.query);
  count.textContent = String(issues.length);
  const scroll = list.scrollTop;
  const active = document.activeElement as HTMLElement | null;
  const focusId = list.contains(active) ? active?.closest<HTMLElement>('[data-issue-id]')?.dataset.issueId : undefined;
  const rows = issues.map((issue) => {
    const row = document.createElement('div');
    row.className = 'issues-sidebar__row';
    const view = button('', () => viewIssue(issue.id), 'issues-sidebar__issue');
    view.dataset.issueId = issue.id;
    const status = taxonomy.statuses.find((entry) => entry.id === issue.status);
    const icon = document.createElement('i');
    icon.className = `fi ${resolveIssueStatusIcon(issue.status, status)} icon-svg`;
    icon.setAttribute('aria-hidden', 'true');
    const content = document.createElement('span');
    const title = document.createElement('span');
    title.className = 'issues-sidebar__title';
    title.textContent = issue.title;
    title.title = issue.title;
    const meta = document.createElement('span');
    meta.className = 'issues-sidebar__meta';
    meta.textContent = `${issue.id} · ${status?.label ?? issue.status}`;
    content.append(title, meta);
    view.append(icon, content);
    bindMenu(view, issue.id);
    const more = button('⋯', () => { void showMenu(issue.id, more); }, 'issues-sidebar__more');
    more.setAttribute('aria-label', `Actions for ${issue.id}`);
    row.append(view, more);
    return row;
  });
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'issues-sidebar__empty';
    empty.textContent = value.query ? 'No matching issues.' : value.filter === 'closed' ? 'No closed issues in this workspace.' : value.filter === 'all' ? 'No issues yet. Capture one above.' : 'No open issues. Capture one above.';
    list.replaceChildren(empty);
  } else list.replaceChildren(...rows);
  list.scrollTop = scroll;
  if (focusId) [...list.querySelectorAll<HTMLButtonElement>('[data-issue-id]')].find((node) => node.dataset.issueId === focusId)?.focus();
}

async function createIssue(): Promise<void> {
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
    const id = state().pendingId;
    state().pendingId = undefined;
    state().draft = { title: '' };
    saveDraft();
    input.value = '';
    feedback.textContent = `Created ${id}`;
    render();
  } catch {
    feedback.textContent = 'Could not save this issue. Retry save to keep it without creating a duplicate.';
  } finally {
    busy = false;
    syncCapture();
    input.focus();
  }
}

async function expandDraft(): Promise<void> {
  const { openQuickIssueForm } = await import('./issues-page');
  const value = state();
  const workspace = currentWorkspace;
  openQuickIssueForm({ items: [], workspacePath: getWorkspacePath() }, input, {
    draft: value.draft,
    onClose: (draft) => {
      value.draft = draft;
      if (currentWorkspace === workspace) {
        input.value = draftText(draft);
        saveDraft();
        syncCapture();
      }
    },
    onCreate: (issue) => {
      value.draft = { title: '' };
      if (currentWorkspace === workspace) {
        input.value = '';
        saveDraft();
        syncCapture();
        feedback.textContent = `Created ${issue.id}`;
      }
    },
  });
}

function mount(): void {
  const host = document.getElementById('issuesSidebarRoot');
  if (!host || root === host && host.childElementCount) return;
  root = host;
  root.innerHTML = `<div class="issues-sidebar__list-view">
    <form class="issues-sidebar__capture">
      <label for="issuesSidebarDraft">New issue</label>
      <textarea id="issuesSidebarDraft" rows="3" placeholder="Describe the issue…" aria-describedby="issuesSidebarFeedback"></textarea>
      <div class="issues-sidebar__actions"><button type="button" data-expand>Expand</button><button type="submit" data-create>Create</button></div>
      <p id="issuesSidebarFeedback" class="issues-sidebar__feedback" role="status" aria-live="polite"></p>
    </form>
    <div class="issues-sidebar__filters"><select aria-label="Filter issues"><option value="open">Open</option><option value="all">All</option><option value="closed">Closed</option></select><span data-count class="issues-sidebar__meta"></span>
      <input type="search" placeholder="Search issues…" aria-label="Search issues by title or ID">
    </div>
    <div class="issues-sidebar__list" aria-label="Issues"></div>
    <button type="button" class="issues-sidebar__all">View all issues →</button>
  </div><div class="issues-sidebar__detail" hidden></div>`;
  input = root.querySelector('textarea')!;
  createButton = root.querySelector('[data-create]')!;
  expandButton = root.querySelector('[data-expand]')!;
  list = root.querySelector('.issues-sidebar__list')!;
  detail = root.querySelector('.issues-sidebar__detail')!;
  feedback = root.querySelector('.issues-sidebar__feedback')!;
  count = root.querySelector('[data-count]')!;
  root.querySelector('form')!.addEventListener('submit', (event) => { event.preventDefault(); void createIssue(); });
  expandButton.addEventListener('click', () => { void expandDraft().catch(() => showToast('Could not open the issue form', 'error')); });
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
    void import('./issues-page').then((m) => m.openIssuesEmbeddedInCode());
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
  currentWorkspace = sidebarWorkspaceKey(getWorkspacePath());
  mount();
  if (!root) return;
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
