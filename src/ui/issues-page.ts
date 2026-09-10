import { formatIssueAge } from '../issues/age';
import { showToast } from './toast';
import '../styles/issues.css';

import { notifyAskQuestionDisplayContextChanged } from '../chat/ask-question-display';
import { canExpandIssueWithAgent } from '../chat/issues/expand-task';
import { canExpandIssueDraft } from '../chat/issues/expand-issue-guards';
import {
  canInvestigateIssue,
  canRunIssueWorkflow,
  ISSUE_BACKGROUND_CHAT_MODES,
  ISSUE_FOREGROUND_CHAT_MODES,
  runIssueBackgroundChat,
  runIssueForegroundChat,
} from '../chat/issues/pipeline';
import type { ChatRunTargetChoice } from '../state/chat-worktree';
import {
  lastIssueMenuOrigin,
  promptIssueChatRunTarget,
  rememberIssueMenuAnchor,
} from './issues-chat-run-target';
import type {
  IssueBackgroundChatMode,
  IssueForegroundChatMode,
} from '../chat/issues/workflow-seeds';
import { getMode } from '../chat/modes/registry';
import { createAppIcon } from '../os/icons';
import { iconHtml } from './icon';
import { bindIssueDropTarget } from './issue-drop-target';
import { setIssueDragData, endIssueDrag, getActiveIssueDragIds } from '../issues/issue-drag';
import { subIssueMenuItems } from './issues-sub-issues';
import { createIssueEditor, type IssueEditorHandle } from './issue-editor';
import { collectInlineRefs } from '../issues/markdown-inline';
import { taskProgress } from '../issues/markdown-blocks';
import {
  createIssueStatusChip,
  createIssueTypeChip,
  resolveIssueStatusIcon,
} from '../issues/type-icons';
import { getForegroundAppId, getOsView } from '../os/instances';
import { isOsAppHash, isOsShellEnabled } from '../os/page-bridge';
import { navigateToDesktop } from '../os/router';
import {
  boardStatuses,
  isClosedStatus,
  sortedPriorities,
  sortedStatuses,
  sortedTypes,
} from '../issues/taxonomy';
import { subscribeIssuesTaxonomyChanges } from '../state/issues-taxonomy-events';
import { getIssuesTaxonomySync } from '../state/issues-taxonomy-store';
import { subscribeIssuesGithubMode } from '../state/issues-github';
import { subscribeIssuesChanges } from '../state/issues-events';
import {
  acceptTriageIssue,
  addIssue,
  appendIssueLinks,
  addIssueProject,
  assignIssueToMe,
  collectIssues,
  collectIssueLabelSuggestions,
  countOpenIssues,
  declineTriageIssue,
  ensureIssueViews,
  findIssueById,
  isIssuesStoreLoaded,
  listIssueProjects,
  listIssueViews,
  queueIssueAgent,
  quickCaptureIssue,
  updateIssue,
  type CollectIssuesOptions,
} from '../state/issues-store';
import { sessionState } from '../state/sessions';
import { getWorkspacePath } from '../state/workspace';
import type {
  IssueCard,
  IssuePriority,
  IssueSavedView,
  IssueStatus,
  IssueType,
} from '../types';
import { isTypingTarget } from './a11y/typing-target';
import { appPrompt, isAppDialogOpen } from './app-dialog';
import { confirmAndDeleteIssues as confirmIssueDeletion } from './issues-delete';
import { registerCommandSource } from './command-registry';
import { deferUntilContextMenuClosed, isContextMenuOpen } from './context-menu';
import { ensureIssuesChrome } from './issues-chrome';
import {
  closeIssuesFileDrawer,
  initIssuesFileDrawer,
  isIssuesFileDrawerOpen,
  subscribeIssuesFileDrawer,
  toggleIssuesFileDrawer,
} from './issues-file-drawer';
import { buildIssuesCommands } from './issues-commands';
import {
  BUILTIN_VIEW_TRIAGE,
  LOCAL_ASSIGNEE_ID,
  SESSION_VIEW_ALL,
  isIssuesGroupBy,
  parseViewFilters,
} from '../issues/saved-views';
import {
  ISSUES_GROUP_BY_OPTIONS,
  buildGroupedIssueRows,
  sortIssuesInGroup,
  type IssuesGroupBy,
} from '../issues/grouping';
import { isUnreviewedTriageIssue } from '../issues/triage';
import { ranksAfterReorder } from '../issues/rank';
import { subIssueRollup } from '../issues/hierarchy';
import {
  closeIssueDetail,
  expandIssueFromUi,
  getSelectedIssueId,
  isIssueExpanding,
  isIssuesDetailEditing,
  openIssueDetail,
  refreshIssueDetailIfOpen,
} from './issues-detail';
import { collapseIssueDetailSheet } from './issues-detail-layout';
import {
  closeIssueExpandOverlay,
  createIssueExpandButton,
  isIssueDraftExpanding,
  isIssueExpandOverlayOpen,
  startIssueExpandFromUi,
} from './issues-expand-controls';
import {
  closeIssuesLabelsSuggestionsMenu,
  createIssuesLabelsField,
  isIssuesLabelsFieldFocused,
} from './issues-labels-field';
import {
  createIssueLabelsDisplay,
  deferUntilIssueLabelPopoverClosed,
  isIssuesLabelPopoverFocused,
} from './issues-label-chip';
import {
  ariaSortValue,
  cycleIssuesListSort,
  DEFAULT_ISSUES_LIST_SORT,
  sortIssuesForList,
  type IssuesListSort,
  type IssuesSortKey,
} from './issues-list-sort';
import { stripMainColumnOverlayClasses } from './main-column-overlay';
import {
  closeIssuesContextMenu,
  openIssuesContextMenu,
  type IssuesContextMenuItem,
} from './issues-context-menu';
import {
  hasGithubSyncConflict,
  runIssuesGithubSyncAll,
  subscribeGithubSyncConflicts,
  syncIssuesGithubSyncAllButton,
} from './issues-github-section';
import {
  ensureNewIssueWorkspaceField,
  getNewIssueWorkspacePath,
  refreshNewIssueWorkspaceField,
} from './issues-new-workspace-field';
import {
  ensureNewIssuePropertyFields,
  syncNewIssuePropertyFields,
} from './issues-new-property-field';

const CHAT_AREA_ISSUES_CLASS = 'chat-area--issues';
const MAIN_COLUMN_ISSUES_CLASS = 'main-column--issues';
const ISSUES_EMBEDDED_CLASS = 'issues-page--embedded';
const EMBED_BACK_BTN_ID = 'btnIssuesEmbedBack';

type IssuesViewMode = 'list' | 'board';

const ISSUES_SORT_KEYS = new Set<IssuesSortKey>([
  'id',
  'type',
  'title',
  'status',
  'priority',
  'labels',
  'created',
]);

/** Human labels for sort aria-label (avoid reading indicator glyphs from the button). */
const ISSUES_SORT_LABELS: Record<IssuesSortKey, string> = {
  id: 'ID',
  type: 'Type',
  title: 'Title',
  status: 'Status',
  priority: 'Priority',
  labels: 'Labels',
  created: 'Created',
};

type IssuesUiFilters = {
  scope: 'current_workspace' | 'all';
  type: IssueType | 'all';
  status: IssueStatus | 'all';
  priority: IssuePriority | 'all';
  projectId: string | 'all';
  hideDone: boolean;
  search: string;
};

// ── Filters ──────────────────────────────────────────────────────────────────

/** Board and menu status options from the live taxonomy catalog. */
function getBoardStatusOptions(): Array<{ id: IssueStatus; label: string }> {
  return boardStatuses(getIssuesTaxonomySync()).map((s) => ({ id: s.id, label: s.label }));
}

/** All statuses for bulk status change menus. */
function getAllStatusOptions(): Array<{ id: IssueStatus; label: string; iconClass: string }> {
  return sortedStatuses(getIssuesTaxonomySync()).map((s) => ({
    id: s.id,
    label: s.label,
    iconClass: resolveIssueStatusIcon(s.id, s),
  }));
}

/** Sync new-issue form options from taxonomy (preserves current value when possible). */
function syncIssuesFilterSelects(): void {
  syncNewIssuePropertyFields();
}

const DEFAULT_FILTERS: IssuesUiFilters = {
  scope: 'current_workspace',
  type: 'all',
  status: 'all',
  priority: 'all',
  projectId: 'all',
  hideDone: true,
  search: '',
};

let initialized = false;
let viewMode: IssuesViewMode = 'list';
let filters: IssuesUiFilters = { ...DEFAULT_FILTERS };
/** Active list-column sort (session-only). Rank wins inside a group when set. */
let listSort: IssuesListSort = { ...DEFAULT_ISSUES_LIST_SORT };
let groupBy: IssuesGroupBy = 'status';
/** Session-only; not a schema key. */
let activeViewId = SESSION_VIEW_ALL;
let issuesUnsub: (() => void) | null = null;
let taxonomyUnsub: (() => void) | null = null;
let githubModeUnsub: (() => void) | null = null;
let githubConflictUnsub: (() => void) | null = null;
let pendingIssueId: string | undefined;
const selectedIssueIds = new Set<string>();
let lastSelectionAnchorId: string | undefined;
/** Keyboard cursor, distinct from peek (`getSelectedIssueId`) and multi-select. */
let focusedIssueId: string | undefined;
const collapsedGroups = new Set<string>();
let unregisterIssuesCommands: (() => void) | null = null;
let issuesKeyHandler: ((event: KeyboardEvent) => void) | null = null;
/** Where #issuesView lived before it was moved into the Code #chatArea embed. */
let issuesViewHome: { parent: HTMLElement; nextSibling: ChildNode | null } | null = null;
/** Chat to restore when closing the Code embed. */
let returnChatId: string | null = null;
let embedEscapeBound = false;

function getRoot(): HTMLElement | null {
  return document.getElementById('issuesView');
}

// ── Embed ────────────────────────────────────────────────────────────────────

/** True when Issues is hosted inside the Code app main column. */
export function isIssuesEmbeddedInCode(): boolean {
  const area = document.getElementById('chatArea');
  const root = getRoot();
  if (!area || !root) return false;
  return area.contains(root) && area.classList.contains(CHAT_AREA_ISSUES_CLASS);
}

/** Sidebar / Code entry should embed instead of launching the fullscreen Issues app. */
export function shouldEmbedIssuesFromCodeSidebar(): boolean {
  return isOsShellEnabled() && getOsView() === 'app' && getForegroundAppId() === 'code';
}

function getDefaultIssuesHome(): { parent: HTMLElement; nextSibling: ChildNode | null } | null {
  const parent = document.getElementById('osAppsLayer');
  if (!parent) return null;
  return { parent, nextSibling: null };
}

/** Remember the apps-layer slot so fullscreen Issues can reclaim the view. */
function rememberIssuesHome(root: HTMLElement): void {
  const area = document.getElementById('chatArea');
  if (area?.contains(root)) return;
  const parent = root.parentElement;
  if (!parent) return;
  issuesViewHome = { parent, nextSibling: root.nextSibling };
}

function removeEmbeddedBackButton(): void {
  document.getElementById(EMBED_BACK_BTN_ID)?.remove();
}

/** Inject a Back control into the Issues header while embedded in Code. */
function ensureEmbeddedBackButton(): void {
  if (document.getElementById(EMBED_BACK_BTN_ID)) return;
  const brand = document.querySelector('#issuesView .issues-header__brand');
  if (!brand) return;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = EMBED_BACK_BTN_ID;
  btn.className = 'icon-btn issues-embed-back';
  btn.setAttribute('aria-label', 'Back to chat');
  btn.title = 'Back to chat';
  btn.innerHTML =
    iconHtml('back');
  btn.addEventListener('click', () => {
    closeIssuesEmbeddedInCode();
  });
  brand.insertBefore(btn, brand.firstChild);
}

function onEmbedEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !isIssuesEmbeddedInCode()) return;
  if (document.getElementById('issuesDetailHost')) return;
  event.preventDefault();
  closeIssuesEmbeddedInCode();
}

function bindEmbedEscape(): void {
  if (embedEscapeBound) return;
  embedEscapeBound = true;
  window.addEventListener('keydown', onEmbedEscape);
}

function unbindEmbedEscape(): void {
  if (!embedEscapeBound) return;
  embedEscapeBound = false;
  window.removeEventListener('keydown', onEmbedEscape);
}

/** Move #issuesView back to the OS apps layer (or its remembered home). */
export function restoreIssuesViewIfMounted(): void {
  const root = getRoot();
  if (!root) {
    issuesViewHome = null;
    return;
  }

  const appsLayer = document.getElementById('osAppsLayer');
  if (appsLayer?.contains(root) && !document.getElementById('chatArea')?.contains(root)) {
    root.classList.remove(ISSUES_EMBEDDED_CLASS);
    removeEmbeddedBackButton();
    issuesViewHome = null;
    return;
  }

  const home = issuesViewHome ?? getDefaultIssuesHome();
  if (!home) return;

  const { parent, nextSibling } = home;
  if (nextSibling && nextSibling.parentNode === parent) {
    parent.insertBefore(root, nextSibling);
  } else {
    parent.appendChild(root);
  }
  root.classList.remove(ISSUES_EMBEDDED_CLASS);
  removeEmbeddedBackButton();
  issuesViewHome = null;
}

/** Restore Issues out of #chatArea before the transcript repaints. */
export function teardownIssuesEmbedBeforeChatPaint(): boolean {
  const area = document.getElementById('chatArea');
  const root = getRoot();
  const inChat = Boolean(area && root && area.contains(root));
  const hadEmbed = isIssuesEmbeddedInCode() || inChat || Boolean(issuesViewHome);

  if (inChat) {
    restoreIssuesViewIfMounted();
  } else {
    issuesViewHome = null;
    root?.classList.remove(ISSUES_EMBEDDED_CLASS);
    removeEmbeddedBackButton();
  }

  stripMainColumnOverlayClasses();
  returnChatId = null;
  unbindEmbedEscape();
  return hadEmbed;
}

async function closeCompetingMainColumnViews(): Promise<void> {
  const { closeOtherCodeStageViews } = await import('./main-column-overlay');
  await closeOtherCodeStageViews('issues');
}

/** Mount Issues inside the Code app #chatArea (does not change the OS foreground app). */
export async function openIssuesEmbeddedInCode(options?: { issueId?: string }): Promise<void> {
  const root = getRoot();
  const area = document.getElementById('chatArea');
  if (!root || !area) return;

  if (isIssuesEmbeddedInCode()) {
    await openIssues({ issueId: options?.issueId, embedded: true });
    return;
  }

  await closeCompetingMainColumnViews();

  returnChatId = sessionState?.activeId ?? null;

  rememberIssuesHome(root);
  area.replaceChildren();
  area.appendChild(root);
  stripMainColumnOverlayClasses();
  area.classList.add(CHAT_AREA_ISSUES_CLASS);
  document.getElementById('mainColumn')?.classList.add(MAIN_COLUMN_ISSUES_CLASS);
  root.classList.add(ISSUES_EMBEDDED_CLASS);

  bindEmbedEscape();
  await openIssues({ issueId: options?.issueId, embedded: true });
  ensureEmbeddedBackButton();
  notifyAskQuestionDisplayContextChanged();
}

/** Tear down the Code embed and optionally restore the prior chat. */
export function closeIssuesEmbeddedInCode(options?: { restoreChat?: boolean }): void {
  if (!isIssuesEmbeddedInCode() && !issuesViewHome) return;

  const savedReturnChatId = returnChatId;
  const root = getRoot();
  root?.classList.remove('is-open');
  pendingIssueId = undefined;
  closeIssueDetail();
  clearIssueSelection();
  unbindIssuesCommands();
  setNewFormOpen(false);

  teardownIssuesEmbedBeforeChatPaint();

  if (options?.restoreChat === false) {
    notifyAskQuestionDisplayContextChanged();
    return;
  }

  const targetId =
    savedReturnChatId && sessionState?.chats.some((c) => c.id === savedReturnChatId)
      ? savedReturnChatId
      : sessionState?.activeId;
  const chat = targetId ? sessionState?.chats.find((c) => c.id === targetId) : undefined;
  const area = document.getElementById('chatArea');
  if (chat) {
    void import('./messages').then((m) => m.renderChatFromHistory(chat));
  } else if (area) {
    area.replaceChildren();
  }
  notifyAskQuestionDisplayContextChanged();
}

/** Toggle Issues embed from the Code sidebar footer button. */
export function toggleIssuesFromSidebar(): void {
  if (isIssuesEmbeddedInCode()) {
    closeIssuesEmbeddedInCode();
    return;
  }
  void openIssuesEmbeddedInCode();
}

// ── Collect ──────────────────────────────────────────────────────────────────

function getMount(): HTMLElement | null {
  return document.getElementById('issuesPanelMount');
}

function mountHeaderIcon(): void {
  const slot = document.getElementById('issuesPageIcon');
  if (!slot || slot.childElementCount > 0) return;
  slot.appendChild(createAppIcon('issues'));
}

function collectOptions(): CollectIssuesOptions {
  const view = activeView();
  const viewFilters = parseViewFilters(view?.filters);
  const type = viewFilters.type ?? filters.type;
  const status = viewFilters.status ?? filters.status;
  const priority = viewFilters.priority ?? filters.priority;
  const options: CollectIssuesOptions = {
    scope: filters.scope,
    workspacePath: getWorkspacePath(),
    type: type === 'all' ? 'all' : (type as IssueType),
    status: status === 'all' ? 'all' : (status as IssueStatus),
    priority: priority === 'all' ? 'all' : (priority as IssuePriority),
    hideDone: filters.hideDone,
    search: filters.search,
  };
  if (viewFilters.unreviewed) options.unreviewed = true;
  if (viewFilters.hasAgent) options.hasAgent = true;
  if (viewFilters.mine) options.mine = true;
  const projectId = viewFilters.projectId !== undefined ? viewFilters.projectId : filters.projectId;
  if (projectId && projectId !== 'all') options.projectId = projectId;
  else if (projectId === null) options.projectId = null;
  if (viewFilters.assigneeId !== undefined) options.assigneeId = viewFilters.assigneeId;
  return options;
}

function asElement(value: EventTarget | null): Element | null {
  if (!value || typeof value !== 'object') return null;
  return typeof (value as { closest?: unknown }).closest === 'function'
    ? (value as Element)
    : null;
}

function controlValue(id: string): string {
  const node = document.getElementById(id);
  if (!node || !('value' in node)) return '';
  const value = (node as { value: unknown }).value;
  return typeof value === 'string' ? value : '';
}

function setControlValue(id: string, value: string): void {
  const node = document.getElementById(id);
  if (node && 'value' in node) (node as { value: string }).value = value;
}

function activeView(): IssueSavedView | undefined {
  if (activeViewId === SESSION_VIEW_ALL) return undefined;
  return listIssueViews().find((view) => view.id === activeViewId);
}

function visibleIssueOrder(): IssueCard[] {
  if (viewMode === 'board') {
    const issues = collectIssues(collectOptions());
    const taxonomy = getIssuesTaxonomySync();
    const columns = filters.hideDone
      ? getBoardStatusOptions().filter((col) => !isClosedStatus(taxonomy, col.id))
      : getBoardStatusOptions();
    return buildBoardOrderedIssues(sortColumnIssues(issues), columns);
  }
  const grouped = currentGroupedRows();
  const ordered: IssueCard[] = [];
  for (const group of grouped) {
    if (collapsedGroups.has(group.id)) continue;
    for (const row of group.rows) {
      ordered.push(row.issue);
      ordered.push(...row.children);
    }
  }
  return ordered;
}

function sortColumnIssues(issues: IssueCard[]): IssueCard[] {
  const taxonomy = getIssuesTaxonomySync();
  const byStatus = new Map<string, IssueCard[]>();
  for (const issue of issues) {
    const bucket = byStatus.get(issue.status) ?? [];
    bucket.push(issue);
    byStatus.set(issue.status, bucket);
  }
  const out: IssueCard[] = [];
  for (const bucket of byStatus.values()) {
    out.push(...sortIssuesInGroup(bucket, listSort, taxonomy));
  }
  return out;
}

function currentGroupedRows() {
  const issues = collectIssues(collectOptions());
  return buildGroupedIssueRows(issues, groupBy, listSort, {
    taxonomy: getIssuesTaxonomySync(),
    projects: listIssueProjects({ includeArchived: true }),
    allIssues: collectIssues({
      scope: filters.scope,
      workspacePath: getWorkspacePath(),
      hideDone: false,
    }),
  });
}

// ── Selection ────────────────────────────────────────────────────────────────

/** Build a type badge for list rows. */
function createTypeChip(type: IssueType): HTMLElement {
  const taxonomy = getIssuesTaxonomySync();
  const item = taxonomy.types.find((t) => t.id === type);
  return createIssueTypeChip(type, item);
}

/** Build a status pill for list rows. */
function createStatusChip(status: IssueStatus): HTMLElement {
  const taxonomy = getIssuesTaxonomySync();
  const item = taxonomy.statuses.find((s) => s.id === status);
  return createIssueStatusChip(status, item);
}

/** Build a priority label for list rows. */
function createPriorityChip(priority: IssuePriority): HTMLElement {
  const taxonomy = getIssuesTaxonomySync();
  const item = taxonomy.priorities.find((p) => p.id === priority);
  const chip = document.createElement('span');
  chip.className = `issues-priority-chip issues-priority-chip--${priority}`;
  chip.textContent = item?.label ?? (priority === 'none' ? '—' : priority);
  if (item?.color) chip.style.setProperty('--issues-chip-color', item.color);
  chip.classList.toggle('is-unknown', !item);
  return chip;
}

function syncListHeadVisibility(): void {
  const head = document.getElementById('issuesListHead');
  if (!head) return;
  head.hidden = viewMode !== 'list';
}

/** Reflect active sort on list column headers (aria-sort + indicator class). */
function syncListHeadSortUi(): void {
  const head = document.getElementById('issuesListHead');
  if (!head) return;
  head.querySelectorAll<HTMLButtonElement>('.issues-list-head__sort[data-sort-key]').forEach((btn) => {
    const key = btn.dataset.sortKey;
    if (!key || !isIssuesSortKey(key)) return;
    const aria = ariaSortValue(listSort, key);
    btn.setAttribute('aria-sort', aria);
    btn.classList.toggle('is-active', aria !== 'none');
    const dirLabel =
      aria === 'ascending' ? 'ascending' : aria === 'descending' ? 'descending' : 'unsorted';
    btn.setAttribute('aria-label', `Sort by ${ISSUES_SORT_LABELS[key]}, ${dirLabel}`);
  });
}

function isIssuesSortKey(value: string): value is IssuesSortKey {
  return ISSUES_SORT_KEYS.has(value as IssuesSortKey);
}

/** Apply filters, then list-column sort (list view only). */
function collectVisibleIssues(): IssueCard[] {
  const issues = collectIssues(collectOptions());
  if (viewMode !== 'list') return issues;
  return sortIssuesForList(issues, listSort, getIssuesTaxonomySync());
}

/** Drop selection entries that are no longer visible under current filters. */
function pruneIssueSelection(visibleIds: Set<string>): void {
  for (const id of selectedIssueIds) {
    if (!visibleIds.has(id)) selectedIssueIds.delete(id);
  }
}

function syncSelectionBar(_visibleCount: number): void {
  const bar = document.getElementById('issuesSelectionBar');
  const countEl = document.getElementById('issuesSelectionCount');
  const selectedCount = selectedIssueIds.size;
  if (bar) bar.hidden = selectedCount === 0;
  if (countEl) {
    countEl.textContent =
      selectedCount === 1 ? '1 issue selected' : `${selectedCount} issues selected`;
  }
}

function setIssueChecked(issueId: string, checked: boolean): void {
  if (checked) selectedIssueIds.add(issueId);
  else selectedIssueIds.delete(issueId);
}

function clearIssueSelection(): void {
  selectedIssueIds.clear();
  lastSelectionAnchorId = undefined;
}

type IssueSelectionInput = {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  /** When set (context menu), use this checked state instead of toggling. */
  checked?: boolean;
};

/** Apply multiselect from modifier-click or context menu on a row/card. */
function handleIssueSelection(
  issue: IssueCard,
  orderedIssues: IssueCard[],
  index: number,
  input: IssueSelectionInput,
): void {
  const modifier = input.ctrlKey || input.metaKey;
  const explicitChecked = input.checked;

  if (
    input.shiftKey &&
    lastSelectionAnchorId &&
    lastSelectionAnchorId !== issue.id
  ) {
    const anchorIndex = orderedIssues.findIndex((row) => row.id === lastSelectionAnchorId);
    if (anchorIndex >= 0) {
      const checked = explicitChecked ?? true;
      const start = Math.min(anchorIndex, index);
      const end = Math.max(anchorIndex, index);
      for (let i = start; i <= end; i += 1) {
        setIssueChecked(orderedIssues[i].id, checked);
      }
      return;
    }
  }

  if (modifier || explicitChecked !== undefined || input.shiftKey) {
    if (explicitChecked !== undefined) {
      setIssueChecked(issue.id, explicitChecked);
    } else if (modifier) {
      setIssueChecked(issue.id, !selectedIssueIds.has(issue.id));
    } else {
      setIssueChecked(issue.id, true);
    }
    lastSelectionAnchorId = issue.id;
  }
}

function isIssueMultiSelectClick(event: MouseEvent): boolean {
  return event.shiftKey || event.ctrlKey || event.metaKey;
}

/** Board visual order: left-to-right columns, top-to-bottom within each column. */
function buildBoardOrderedIssues(
  issues: IssueCard[],
  columns: Array<{ id: IssueStatus; label: string }>,
): IssueCard[] {
  const ordered: IssueCard[] = [];
  for (const col of columns) {
    for (const issue of issues.filter((row) => row.status === col.id)) {
      ordered.push(issue);
    }
  }
  return ordered;
}

function onIssueItemClick(
  event: MouseEvent,
  issue: IssueCard,
  orderedIssues: IssueCard[],
  index: number,
): void {
  const target = asElement(event.target);
  if (target?.closest('button')) return;
  if (!isIssueMultiSelectClick(event)) {
    focusedIssueId = issue.id;
    navigateToIssueDetail(issue.id);
    return;
  }
  event.preventDefault();
  focusedIssueId = issue.id;
  handleIssueSelection(issue, orderedIssues, index, {
    shiftKey: event.shiftKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
  });
  renderIssuesPanel();
}

/** Issue ids targeted by a row/card action (selection group or single row). */
function resolveIssueActionTargetIds(issueId: string): string[] {
  if (selectedIssueIds.has(issueId) && selectedIssueIds.size > 1) {
    return [...selectedIssueIds];
  }
  return [issueId];
}

// ── Menus ────────────────────────────────────────────────────────────────────

async function copyTextToClipboard(text: string): Promise<void> {
  if (!text.trim()) return;
  try {
    await navigator.clipboard.writeText(text);
    const { showToast } = await import('./toast');
    showToast('Copied to clipboard');
  } catch {
    const { showToast } = await import('./toast');
    showToast('Could not copy to clipboard', 'error');
  }
}

const FOREGROUND_CHAT_HINTS: Record<IssueForegroundChatMode, string> = {
  general: 'Triage and discuss with full tool access',
  build: 'Implement or iterate on a fix',
  plan: 'Interactive planning chat in Code',
  debug: 'Reproduce and narrow root cause',
};

const BACKGROUND_CHAT_HINTS: Record<IssueBackgroundChatMode, string> = {
  debug: 'Debugger sub-agent investigates unattended',
  plan: 'Planner writes documentation/plans/issues/<id>.md',
};

/** Issue ids with a workflow action in flight from the list context menu. */
const workflowBusyIds = new Set<string>();

async function runIssueWorkflowFromMenu(
  issueId: string,
  action: 'foreground' | 'background',
  modeId: IssueForegroundChatMode | IssueBackgroundChatMode,
  runTarget: ChatRunTargetChoice,
): Promise<void> {
  if (workflowBusyIds.has(issueId)) return;
  workflowBusyIds.add(issueId);
  const { showToast } = await import('./toast');
  try {
    if (action === 'foreground') {
      const result = await runIssueForegroundChat(
        issueId,
        modeId as IssueForegroundChatMode,
        runTarget,
      );
      if (!result.ok) {
        showToast(result.error || 'Send to chat failed', 'error');
        return;
      }
      if (modeId === 'plan') {
        showToast(
          result.planPath ? `Plan chat · ${result.planPath}` : 'Plan chat opened',
          'success',
        );
      } else {
        showToast(`${getMode(modeId as IssueForegroundChatMode).label} chat opened`, 'success');
      }
      return;
    }
    const bgMode = modeId as IssueBackgroundChatMode;
    const result = await runIssueBackgroundChat(issueId, bgMode, runTarget);
    if (!result.ok) {
      showToast(result.error || 'Send to background failed', 'error');
      return;
    }
    if (bgMode === 'debug') {
      showToast('Investigation started', 'success');
    } else {
      showToast(result.planPath ? `Plan: ${result.planPath}` : 'Plan ready', 'success');
    }
  } finally {
    workflowBusyIds.delete(issueId);
    renderIssuesPanel();
    refreshIssueDetailIfOpen();
  }
}

function buildForegroundChatSubmenuItems(issue: IssueCard): IssuesContextMenuItem[] {
  const workflowOk = canRunIssueWorkflow(issue);
  const busy = workflowBusyIds.has(issue.id);
  return ISSUE_FOREGROUND_CHAT_MODES.map((modeId) => ({
    id: modeId,
    label: getMode(modeId).label,
    hint: FOREGROUND_CHAT_HINTS[modeId],
    disabled: !workflowOk || busy,
    onSelect: () => {
      const origin = lastIssueMenuOrigin();
      promptIssueChatRunTarget({
        issueId: issue.id,
        anchor: origin.anchor,
        clientX: origin.clientX,
        clientY: origin.clientY,
        onPick: (choice) =>
          void runIssueWorkflowFromMenu(issue.id, 'foreground', modeId, choice),
      });
    },
  }));
}

function buildBackgroundChatSubmenuItems(issue: IssueCard): IssuesContextMenuItem[] {
  const workflowOk = canRunIssueWorkflow(issue);
  const busy = workflowBusyIds.has(issue.id);
  return ISSUE_BACKGROUND_CHAT_MODES.map((modeId) => ({
    id: modeId,
    label: getMode(modeId).label,
    hint: BACKGROUND_CHAT_HINTS[modeId],
    disabled:
      !workflowOk ||
      busy ||
      (modeId === 'debug' && !canInvestigateIssue(issue)),
    onSelect: () => {
      const origin = lastIssueMenuOrigin();
      promptIssueChatRunTarget({
        issueId: issue.id,
        anchor: origin.anchor,
        clientX: origin.clientX,
        clientY: origin.clientY,
        onPick: (choice) =>
          void runIssueWorkflowFromMenu(issue.id, 'background', modeId, choice),
      });
    },
  }));
}

/** Build context menu items for a list row or board card. */
function buildIssueRowMenuItems(
  issue: IssueCard,
  targetIds: string[],
): IssuesContextMenuItem[] {
  const singleTarget = targetIds.length === 1;
  const isChecked = selectedIssueIds.has(issue.id);
  const workflowOk = canRunIssueWorkflow(issue);
  const workflowBusy = workflowBusyIds.has(issue.id);
  const items: IssuesContextMenuItem[] = [
    {
      id: 'open',
      label: 'Open',
      disabled: !singleTarget,
      onSelect: () => navigateToIssueDetail(issue.id),
    },
    {
      id: 'copy-id',
      label: singleTarget ? 'Copy ID' : `Copy ${targetIds.length} IDs`,
      onSelect: () => void copyTextToClipboard(targetIds.join(', ')),
    },
    {
      id: 'select',
      label: isChecked ? 'Deselect' : 'Select',
      onSelect: () => {
        setIssueChecked(issue.id, !isChecked);
        renderIssuesPanel();
      },
    },
  ];

  if (singleTarget && canExpandIssueDraft(issue)) {
    items.push({
      id: 'expand',
      label: isIssueDraftExpanding(issue.id) ? 'Expanding…' : 'Expand',
      hint: 'Fill title and description from this card',
      onSelect: () => void startIssueExpandFromUi(issue.id),
    });
  }

  if (singleTarget && canExpandIssueWithAgent(issue)) {
    items.push({
      id: 'expand-agent',
      label: isIssueExpanding(issue.id) ? 'Expanding with agent…' : 'Expand with agent',
      hint: 'Research the workspace and write the card',
      disabled: isIssueExpanding(issue.id),
      onSelect: () => void expandIssueFromUi(issue.id).then(() => renderIssuesPanel()),
    });
  }

  if (singleTarget) {
    const subItems = subIssueMenuItems(issue);
    if (subItems.length > 0) {
      subItems[0] = { ...subItems[0], separatorBefore: true };
      items.push(...subItems);
    }
  }

  if (singleTarget) {
    items.push({
      id: 'send-to-chat',
      label: 'Send to chat',
      separatorBefore: true,
      disabled: !workflowOk || workflowBusy,
      submenu: () => buildForegroundChatSubmenuItems(issue),
    });
    items.push({
      id: 'send-to-background',
      label: 'Send to background',
      disabled: !workflowOk || workflowBusy,
      submenu: () => buildBackgroundChatSubmenuItems(issue),
    });
  }

  items.push({
    id: 'change-status',
    label: singleTarget ? 'Change status' : `Change status (${targetIds.length})`,
    separatorBefore: true,
    submenu: () =>
      getAllStatusOptions().map((status) => ({
        id: status.id,
        label: status.label,
        iconClass: status.iconClass,
        onSelect: () => {
          for (const id of targetIds) {
            updateIssue(id, { status: status.id });
          }
          renderIssuesPanel();
        },
      })),
  });

  items.push({
    id: 'delete',
    label: singleTarget ? 'Delete' : `Delete ${targetIds.length} issues`,
    danger: true,
    separatorBefore: true,
    onSelect: () => void confirmAndDeleteIssues(targetIds),
  });

  return items;
}

/** Open the row/card context menu at viewport coordinates. */
function openIssueRowMenu(
  issue: IssueCard,
  clientX: number,
  clientY: number,
  restoreFocus: HTMLElement,
): void {
  rememberIssueMenuAnchor(clientX, clientY, restoreFocus);
  const targetIds = resolveIssueActionTargetIds(issue.id);
  openIssuesContextMenu({
    clientX,
    clientY,
    restoreFocus,
    items: buildIssueRowMenuItems(issue, targetIds),
  });
}

function bindIssueRowContextMenu(
  row: HTMLElement,
  issue: IssueCard,
): void {
  row.addEventListener('contextmenu', (event) => {
    const target = event.target as Element | null;
    if (
      target?.closest(
        '.issues-label-chip, .issues-labels-field__more, .issues-labels-field__add, .issues-labels-popover',
      )
    ) {
      return;
    }
    event.preventDefault();
    openIssueRowMenu(issue, event.clientX, event.clientY, row);
  });
  row.addEventListener('keydown', (event) => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      const rect = row.getBoundingClientRect();
      openIssueRowMenu(issue, rect.left + 8, rect.bottom + 4, row);
    }
  });
}

async function confirmAndDeleteIssues(issueIds: string[]): Promise<void> {
  const ids = [...new Set(issueIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return;
  const { deletedIds } = await confirmIssueDeletion(ids);
  if (deletedIds.length === 0) return;
  const openId = getSelectedIssueId();
  for (const id of deletedIds) selectedIssueIds.delete(id);
  if (openId && deletedIds.includes(openId)) {
    closeIssueDetail();
    setIssuesRouteHash('#/app/issues');
  }
  renderIssuesPanel();
}

/** Delete one issue from list/detail actions. */
export async function deleteIssueFromUi(issueId: string): Promise<void> {
  await confirmAndDeleteIssues([issueId]);
}

function menuItemsFromPairs(
  pairs: Array<{ id: string; label: string; swatch?: string; iconClass?: string }>,
  onPick: (id: string) => void,
): IssuesContextMenuItem[] {
  return pairs.map((pair) => ({
    id: pair.id,
    label: pair.label,
    iconClass: pair.iconClass,
    onSelect: () => onPick(pair.id),
  }));
}

function openPropertyMenu(
  anchor: Element,
  label: string,
  items: IssuesContextMenuItem[],
): void {
  const restore =
    'focus' in anchor && typeof (anchor as { focus?: unknown }).focus === 'function'
      ? (anchor as unknown as HTMLElement)
      : undefined;
  openIssuesContextMenu({
    anchor: restore,
    restoreFocus: restore,
    label,
    items,
  });
}

function applyPatchToTargets(issueId: string, patch: Parameters<typeof updateIssue>[1]): void {
  for (const id of resolveIssueActionTargetIds(issueId)) {
    try {
      updateIssue(id, patch);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not update issue';
      void import('./toast').then((m) => m.showToast(message, 'error'));
    }
  }
  renderIssuesPanel();
}

function openStatusMenu(anchor: Element, issue: IssueCard): void {
  openPropertyMenu(
    anchor,
    'Status',
    menuItemsFromPairs(getAllStatusOptions(), (id) =>
      applyPatchToTargets(issue.id, { status: id }),
    ),
  );
}

function openPriorityMenu(anchor: Element, issue: IssueCard): void {
  openPropertyMenu(
    anchor,
    'Priority',
    menuItemsFromPairs(
      sortedPriorities(getIssuesTaxonomySync()).map((p) => ({ id: p.id, label: p.label })),
      (id) => applyPatchToTargets(issue.id, { priority: id }),
    ),
  );
}

function openAssigneeMenu(anchor: Element, issue: IssueCard): void {
  openPropertyMenu(anchor, 'Assignee', [
    {
      id: 'me',
      label: 'Me',
      onSelect: () => {
        for (const id of resolveIssueActionTargetIds(issue.id)) assignIssueToMe(id);
        renderIssuesPanel();
      },
    },
    {
      id: 'unassign',
      label: 'Unassigned',
      onSelect: () => applyPatchToTargets(issue.id, { assignee: null }),
    },
  ]);
}

function openProjectMenu(anchor: Element, issue: IssueCard): void {
  const projects = listIssueProjects();
  const items: IssuesContextMenuItem[] = [
    {
      id: 'none',
      label: 'No project',
      onSelect: () => applyPatchToTargets(issue.id, { projectId: null }),
    },
    ...projects.map((project) => ({
      id: project.id,
      label: project.name,
      onSelect: () => applyPatchToTargets(issue.id, { projectId: project.id }),
    })),
    {
      id: 'new',
      label: 'New project…',
      separatorBefore: true,
      onSelect: () => void promptNewProject(issue.id),
    },
  ];
  openPropertyMenu(anchor, 'Project', items);
}

function openLabelsMenu(anchor: Element, issue: IssueCard): void {
  const suggestions = collectIssueLabelSuggestions(issue.id);
  const items: IssuesContextMenuItem[] = suggestions.map((label) => ({
    id: `label-${label}`,
    label,
    onSelect: () => {
      const has = issue.labels.some((entry) => entry.toLowerCase() === label.toLowerCase());
      const next = has
        ? issue.labels.filter((entry) => entry.toLowerCase() !== label.toLowerCase())
        : [...issue.labels, label];
      applyPatchToTargets(issue.id, { labels: next });
    },
  }));
  if (items.length === 0) {
    items.push({
      id: 'empty',
      label: 'No workspace labels yet — edit the labels cell',
      disabled: true,
    });
  }
  openPropertyMenu(anchor, 'Labels', items);
}

async function promptNewProject(issueId?: string): Promise<void> {
  const name = await appPrompt('Project name', '', { title: 'New project' });
  if (!name?.trim()) return;
  const project = addIssueProject(name.trim());
  if (issueId) applyPatchToTargets(issueId, { projectId: project.id });
  else renderIssuesPanel();
}

function bindCellMenu(cell: HTMLElement, open: (anchor: Element) => void): void {
  cell.tabIndex = 0;
  cell.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    open(cell);
  });
  cell.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    open(cell);
  });
}

// ── Rows ─────────────────────────────────────────────────────────────────────

function assigneeLabel(issue: IssueCard): string {
  if (!issue.assignee) return '—';
  if (issue.assignee.id === LOCAL_ASSIGNEE_ID) return issue.assignee.label?.trim() || 'Me';
  return issue.assignee.label?.trim() || issue.assignee.id;
}

function agentLabel(issue: IssueCard): string {
  if (!issue.agent) return '';
  if (issue.agent.phase === 'queued') return 'Queued';
  return issue.agent.phase.replace(/_/g, ' ');
}

function linkCounts(issue: IssueCard): string {
  const attachments = issue.attachments?.length ?? 0;
  const links =
    (issue.gitLinks?.length ?? 0) + (issue.codeRefs?.length ?? 0) + (issue.issueRefs?.length ?? 0);
  return `${attachments}/${links}`;
}

function paintRowState(row: HTMLElement, issue: IssueCard): void {
  const isMultiSelected = selectedIssueIds.has(issue.id);
  row.classList.toggle('is-checked', isMultiSelected);
  row.classList.toggle('is-selected', getSelectedIssueId() === issue.id);
  row.classList.toggle('is-focused', focusedIssueId === issue.id);
  row.setAttribute('aria-selected', isMultiSelected || focusedIssueId === issue.id ? 'true' : 'false');
}

function buildIssueRow(
  issue: IssueCard,
  orderedIssues: IssueCard[],
  index: number,
  options?: { depth?: 0 | 1; rollup?: { done: number; total: number } | null },
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'issues-row';
  row.setAttribute('role', 'listitem');
  row.dataset.issueId = issue.id;
  if (options?.depth === 1) row.classList.add('is-child');
  paintRowState(row, issue);

  const id = document.createElement('span');
  id.className = 'issues-row__id';
  id.textContent = issue.id;

  const type = createTypeChip(issue.type);

  const title = document.createElement('span');
  title.className = 'issues-row__title';
  title.textContent = issue.title;
  title.title = issue.title;

  // Comments are the only way an agent reports back in prose; without a mark on
  // the row there is nothing to tell the user a reply is waiting inside.
  const commentCount = issue.comments?.length ?? 0;
  if (commentCount > 0) {
    const badge = document.createElement('span');
    badge.className = 'issues-row__comments';
    badge.textContent = String(commentCount);
    badge.title = commentCount === 1 ? '1 comment' : `${commentCount} comments`;
    if (issue.comments?.some((comment) => comment.authorKind === 'agent')) {
      badge.classList.add('is-agent');
    }
    title.appendChild(document.createTextNode(' '));
    title.appendChild(badge);
  }

  if (hasGithubSyncConflict(issue.id)) {
    const conflictBadge = document.createElement('span');
    conflictBadge.className = 'issues-row__github-conflict';
    conflictBadge.textContent = 'Conflict';
    conflictBadge.title = 'GitHub sync conflict — open to resolve';
    title.appendChild(document.createTextNode(' '));
    title.appendChild(conflictBadge);
    row.classList.add('has-github-conflict');
  }

  const status = createStatusChip(issue.status);
  status.className = `${status.className} issues-row__status`;
  bindCellMenu(status, (anchor) => openStatusMenu(anchor, issue));

  const priority = createPriorityChip(issue.priority);
  priority.className = `${priority.className} issues-row__priority`;
  bindCellMenu(priority, (anchor) => openPriorityMenu(anchor, issue));

  const assignee = document.createElement('button');
  assignee.type = 'button';
  assignee.className = 'issues-row__assignee';
  assignee.textContent = assigneeLabel(issue);
  bindCellMenu(assignee, (anchor) => openAssigneeMenu(anchor, issue));

  const project = document.createElement('button');
  project.type = 'button';
  project.className = 'issues-row__project';
  const projectName = issue.projectId
    ? (listIssueProjects({ includeArchived: true }).find((row) => row.id === issue.projectId)?.name
      ?? issue.projectId)
    : '—';
  project.textContent = projectName;
  bindCellMenu(project, (anchor) => openProjectMenu(anchor, issue));

  const agent = document.createElement('span');
  agent.className = 'issues-row__agent';
  const agentText = agentLabel(issue);
  if (agentText) {
    agent.textContent = issue.agent?.step ?? agentText;
    agent.title = issue.agent?.error ?? agentText;
    const phase = issue.agent?.phase;
    if (phase === 'running') agent.classList.add('is-running');
    else if (phase === 'awaiting_input') agent.classList.add('is-waiting');
    else if (phase === 'failed') agent.classList.add('is-failed');
    else if (phase === 'review') agent.classList.add('is-review');
    else agent.classList.add('is-queued');

    if (phase === 'awaiting_input' || phase === 'failed') {
      agent.setAttribute('role', 'button');
      agent.tabIndex = 0;
      agent.addEventListener('click', (event) => {
        event.stopPropagation();
        void openIssueAgentChat(issue.id);
      });
    }
  } else {
    agent.textContent = '—';
  }
  row.classList.toggle('is-agent-waiting', issue.agent?.phase === 'awaiting_input');

  const rollup = document.createElement('span');
  rollup.className = 'issues-row__rollup';
  const tasks = taskProgress(issue.description);
  if (options?.rollup && options.rollup.total > 0) {
    rollup.textContent = `${options.rollup.done}/${options.rollup.total}`;
    rollup.title = 'Sub-issues done / total';
  } else if (tasks.total > 0) {
    rollup.textContent = `${tasks.done}/${tasks.total}`;
    rollup.classList.add('is-tasks');
    rollup.title = 'Checklist items done / total';
  } else {
    rollup.textContent = '—';
  }

  const counts = document.createElement('span');
  counts.className = 'issues-row__counts';
  counts.textContent = linkCounts(issue);
  counts.title = 'Attachments / links';

  const labels = createIssuesLabelsField({
    issueId: issue.id,
    labels: issue.labels,
    severity: issue.severity,
    variant: 'row',
    onChange: (nextLabels) => {
      updateIssue(issue.id, { labels: nextLabels });
    },
    onBlur: () => refreshIssueDetailIfOpen(),
  });

  const created = document.createElement('time');
  created.className = 'issues-row__created';
  created.textContent = formatIssueAge(issue.createdAt);
  if (Number.isFinite(issue.createdAt)) {
    created.dateTime = new Date(issue.createdAt).toISOString();
    created.title = `Created ${new Date(issue.createdAt).toLocaleString()}`;
  }

  // Match the list grid: labels sit after title; status sits with the trailing metadata.
  row.append(
    id,
    priority,
    type,
    title,
    labels,
    assignee,
    project,
    agent,
    rollup,
    counts,
    status,
    created,
  );
  row.addEventListener('click', (event) => {
    const target = asElement(event.target);
    if (target?.closest('button') || target?.closest('.issues-labels-field')) return;
    onIssueItemClick(event, issue, orderedIssues, index);
  });
  row.tabIndex = focusedIssueId === issue.id ? 0 : -1;
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      navigateToIssueDetail(issue.id);
    }
  });
  bindIssueRowContextMenu(row, issue);
  row.draggable = true;
  row.addEventListener('dragstart', (event) => {
    const ids =
      selectedIssueIds.has(issue.id) && selectedIssueIds.size > 1
        ? [...selectedIssueIds]
        : [issue.id];
    setIssueDragData(event.dataTransfer, ids);
    event.stopPropagation();
  });
  row.addEventListener('dragend', () => {
    endIssueDrag();
  });
  bindIssueDropTarget(row, issue.id, () => {
    renderIssuesPanel();
    void import('./issues-detail').then((m) => m.refreshIssueDetailIfOpen());
  });
  return row;
}

function renderList(mount: HTMLElement, _issues: IssueCard[]): void {
  const grouped = currentGroupedRows();
  const ordered = visibleIssueOrder();
  const list = document.createElement('div');
  list.className = 'issues-list';
  list.setAttribute('role', 'list');

  for (const group of grouped) {
    const section = document.createElement('section');
    section.className = 'issues-group';
    section.dataset.groupId = group.id;

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'issues-group__head';
    head.setAttribute('aria-expanded', collapsedGroups.has(group.id) ? 'false' : 'true');
    const label = document.createElement('span');
    label.className = 'issues-group__label';
    label.textContent = group.label;
    const count = document.createElement('span');
    count.className = 'issues-group__count';
    const visibleCount = group.rows.reduce((n, row) => n + 1 + row.children.length, 0);
    count.textContent = String(visibleCount);
    head.append(label, count);
    head.addEventListener('click', () => {
      if (collapsedGroups.has(group.id)) collapsedGroups.delete(group.id);
      else collapsedGroups.add(group.id);
      renderIssuesPanel();
    });
    section.appendChild(head);

    if (!collapsedGroups.has(group.id)) {
      const body = document.createElement('div');
      body.className = 'issues-group__body';
      for (const nested of group.rows) {
        const index = ordered.findIndex((row) => row.id === nested.issue.id);
        body.appendChild(
          buildIssueRow(nested.issue, ordered, index, {
            depth: 0,
            rollup: nested.rollup,
          }),
        );
        for (const child of nested.children) {
          const childIndex = ordered.findIndex((row) => row.id === child.id);
          body.appendChild(buildIssueRow(child, ordered, childIndex, { depth: 1 }));
        }
      }
      section.appendChild(body);
    }

    list.appendChild(section);
  }

  mount.appendChild(list);
}

/** Write ranks for a keyboard reorder (Alt+↑/↓). Pointer drag no longer ranks. */
function persistRanksAfterReorder(
  orderedIds: string[],
  movingIds: string[],
  insertIndex: number,
): void {
  const existing = new Map(
    [...orderedIds, ...movingIds].map((id) => [id, findIssueById(id)?.rank]),
  );
  const nextRanks = ranksAfterReorder(orderedIds, existing, movingIds, insertIndex);
  const seen = new Set<string>();
  for (const id of [...orderedIds, ...movingIds]) {
    if (seen.has(id)) continue;
    seen.add(id);
    const rank = nextRanks.get(id);
    if (!rank) continue;
    const isMover = movingIds.includes(id);
    if (isMover) {
      updateIssue(id, { rank });
      continue;
    }
    if (rank !== findIssueById(id)?.rank) updateIssue(id, { rank });
  }
}

// ── Board ────────────────────────────────────────────────────────────────────

/** Rows, cards and peek accept capture, files, and issue-on-issue parent drops. */
function bindIssueCaptureDrop(el: HTMLElement, issueId: string): void {
  bindIssueDropTarget(el, issueId, () => {
    renderIssuesPanel();
    void import('./issues-detail').then((m) => m.refreshIssueDetailIfOpen());
  });
}

function bindCardDrag(card: HTMLElement, issueId: string): void {
  card.draggable = true;
  card.addEventListener('dragstart', (event) => {
    const ids =
      selectedIssueIds.has(issueId) && selectedIssueIds.size > 1
        ? [...selectedIssueIds]
        : [issueId];
    setIssueDragData(event.dataTransfer, ids);
    event.stopPropagation();
  });
  card.addEventListener('dragend', () => {
    endIssueDrag();
  });
  bindIssueCaptureDrop(card, issueId);
}

function bindColumnDrop(columnEl: HTMLElement, status: IssueStatus): void {
  columnEl.addEventListener('dragover', (event) => {
    const ids = getActiveIssueDragIds();
    if (ids.length === 0) return;
    const overCard = asElement(event.target)?.closest('.issues-card');
    if (overCard) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    columnEl.classList.add('is-drag-over');
  });
  columnEl.addEventListener('dragleave', (event) => {
    const related = asElement(event.relatedTarget as EventTarget | null);
    if (related && columnEl.contains(related)) return;
    columnEl.classList.remove('is-drag-over');
  });
  columnEl.addEventListener('drop', (event) => {
    const ids = getActiveIssueDragIds();
    if (ids.length === 0) return;
    const overCard = asElement(event.target)?.closest('.issues-card');
    if (overCard) return;
    event.preventDefault();
    columnEl.classList.remove('is-drag-over');
    for (const id of ids) {
      updateIssue(id, { status });
    }
    renderIssuesPanel();
  });
}

function renderBoard(mount: HTMLElement, issues: IssueCard[]): void {
  const kanban = document.createElement('div');
  kanban.className = 'issues-kanban';
  kanban.setAttribute('role', 'region');
  kanban.setAttribute('aria-label', 'Issue board');

  const taxonomy = getIssuesTaxonomySync();
  const hideDone = filters.hideDone;
  const columns = hideDone
    ? getBoardStatusOptions().filter((c) => !isClosedStatus(taxonomy, c.id))
    : getBoardStatusOptions();
  const sorted = sortColumnIssues(issues);
  const boardOrderedIssues = buildBoardOrderedIssues(sorted, columns);

  for (const col of columns) {
    const columnEl = document.createElement('section');
    columnEl.className = 'issues-column';
    columnEl.dataset.status = col.id;

    const head = document.createElement('h3');
    head.className = 'issues-column__head';
    const count = issues.filter((i) => i.status === col.id).length;
    head.textContent = `${col.label} (${count})`;
    columnEl.appendChild(head);

    const list = document.createElement('div');
    list.className = 'issues-column__list';

    for (const issue of sortIssuesInGroup(
      issues.filter((i) => i.status === col.id),
      listSort,
      taxonomy,
    )) {
      const boardIndex = boardOrderedIssues.findIndex((row) => row.id === issue.id);
      const card = document.createElement('article');
      card.className = 'issues-card';
      card.dataset.issueId = issue.id;
      paintRowState(card, issue);

      const cardHead = document.createElement('div');
      cardHead.className = 'issues-card__head';
      const id = document.createElement('div');
      id.className = 'issues-card__id';
      id.textContent = issue.id;
      if (canExpandIssueDraft(issue)) {
        cardHead.append(id, createIssueExpandButton(issue, 'board'));
      } else {
        cardHead.append(id);
      }

      const title = document.createElement('h4');
      title.className = 'issues-card__title';
      title.textContent = issue.title;

      const meta = document.createElement('div');
      meta.className = 'issues-card__meta';
      const assigneeBit = document.createElement('span');
      assigneeBit.textContent = assigneeLabel(issue);
      meta.appendChild(assigneeBit);
      const agentText = agentLabel(issue);
      if (agentText) {
        const chip = document.createElement('span');
        chip.className = 'issues-card__agent';
        chip.classList.add(issue.agent?.phase === 'running' ? 'is-running' : 'is-queued');
        chip.textContent = agentText;
        meta.appendChild(chip);
      }
      const labelsDisplay = createIssueLabelsDisplay(issue.labels);
      if (labelsDisplay) meta.appendChild(labelsDisplay);
      const rollup = subIssueRollup(issue.id, collectIssues({ hideDone: false, scope: 'all' }), taxonomy);
      if (rollup.total > 0) {
        const rollupBit = document.createElement('span');
        rollupBit.textContent = `${rollup.done}/${rollup.total}`;
        meta.appendChild(rollupBit);
      }

      card.append(cardHead, title, meta);
      card.addEventListener('click', (event) => {
        onIssueItemClick(event, issue, boardOrderedIssues, boardIndex);
      });
      bindIssueRowContextMenu(card, issue);
      bindCardDrag(card, issue.id);
      list.appendChild(card);
    }

    columnEl.appendChild(list);
    bindColumnDrop(columnEl, col.id);
    kanban.appendChild(columnEl);
  }

  mount.appendChild(kanban);
}

// ── Views ────────────────────────────────────────────────────────────────────

/** Rebuild list or board from current filters. */
export function renderIssuesPanel(): void {
  if (deferUntilContextMenuClosed(renderIssuesPanel)) return;
  if (deferUntilIssueLabelPopoverClosed(renderIssuesPanel)) return;
  const root = getRoot();
  if (root) ensureIssuesChrome(root);
  const mount = getMount();
  const summaryEl = document.getElementById('issuesSummary');
  if (!mount || !isIssuesStoreLoaded()) return;

  ensureIssueViews();
  const issues = collectVisibleIssues();
  const visibleIds = new Set(issues.map((issue) => issue.id));
  pruneIssueSelection(visibleIds);
  if (focusedIssueId && !visibleIds.has(focusedIssueId)) focusedIssueId = orderedFirstId(issues);
  closeIssuesContextMenu();
  mount.innerHTML = '';

  renderViewTabs();
  renderFilterChips();

  const empty = document.createElement('p');
  empty.className = 'issues-empty';
  empty.classList.toggle('issues-empty--triage', activeViewId === BUILTIN_VIEW_TRIAGE);
  empty.textContent = emptyStateCopy(issues.length);
  empty.classList.toggle('hidden', issues.length > 0);
  mount.appendChild(empty);

  if (issues.length === 0) {
  } else if (viewMode === 'list') {
    renderList(mount, issues);
  } else {
    renderBoard(mount, issues);
  }

  if (summaryEl) {
    const openAll = countOpenIssues({ scope: 'all' });
    const triageCount = collectIssues({
      scope: filters.scope,
      workspacePath: getWorkspacePath(),
      hideDone: false,
      unreviewed: true,
    }).length;
    summaryEl.textContent = `${issues.length} shown · ${openAll} open`;
    if (triageCount > 0) {
      summaryEl.textContent += ` · ${triageCount} to triage`;
    }
  }

  syncListHeadVisibility();
  syncListHeadSortUi();
  syncSelectionBar(issues.length);
  syncGroupByButton();

  if (pendingIssueId) {
    const id = pendingIssueId;
    pendingIssueId = undefined;
    focusedIssueId = id;
    openIssueDetail(id);
  } else if (getSelectedIssueId() && !isIssuesDetailEditing()) {
    refreshIssueDetailIfOpen();
  }
}

function orderedFirstId(issues: IssueCard[]): string | undefined {
  return visibleIssueOrder()[0]?.id ?? issues[0]?.id;
}

function emptyStateCopy(matchCount: number): string {
  if (activeViewId === BUILTIN_VIEW_TRIAGE && matchCount === 0) {
    return 'Crashes, agents, and GitHub land here — Y accept, N/Backspace decline, C to file.';
  }
  return 'Issues come from you, agents, crashes, and GitHub. File one with Quick capture or New issue (C).';
}

function renderViewTabs(): void {
  const host = document.getElementById('issuesViewTabs');
  if (!host) return;
  host.replaceChildren();
  const views: Array<{ id: string; name: string; count?: number }> = [
    { id: SESSION_VIEW_ALL, name: 'All' },
    ...listIssueViews().map((view) => ({
      id: view.id,
      name: view.name,
      count:
        view.id === BUILTIN_VIEW_TRIAGE
          ? collectIssues({
              scope: filters.scope,
              workspacePath: getWorkspacePath(),
              hideDone: false,
              unreviewed: true,
            }).length
          : undefined,
    })),
  ];
  for (const view of views) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'issues-view-tab';
    tab.setAttribute('role', 'tab');
    tab.dataset.viewId = view.id;
    tab.setAttribute('aria-selected', activeViewId === view.id ? 'true' : 'false');
    tab.classList.toggle('is-active', activeViewId === view.id);
    tab.textContent = view.count != null && view.count > 0 ? `${view.name} ${view.count}` : view.name;
    tab.addEventListener('click', () => setActiveView(view.id));
    host.appendChild(tab);
  }
}

function renderFilterChips(): void {
  const host = document.getElementById('issuesChipBar');
  if (!host) return;
  host.replaceChildren();
  const addChip = (
    id: string,
    label: string,
    onRemove?: () => void,
  ): void => {
    const chip = document.createElement(onRemove ? 'button' : 'span');
    chip.className = 'issues-filter-chip';
    if (onRemove) {
      chip.setAttribute('type', 'button');
      chip.addEventListener('click', onRemove);
    }
    chip.textContent = onRemove ? `${label} ×` : label;
    chip.dataset.chipId = id;
    host.appendChild(chip);
  };

  if (filters.type !== 'all') {
    addChip('type', `Type: ${filters.type}`, () => {
      filters = { ...filters, type: 'all' };
      renderIssuesPanel();
    });
  }
  if (filters.status !== 'all') {
    addChip('status', `Status: ${filters.status}`, () => {
      filters = { ...filters, status: 'all' };
      renderIssuesPanel();
    });
  }
  if (filters.priority !== 'all') {
    addChip('priority', `Priority: ${filters.priority}`, () => {
      filters = { ...filters, priority: 'all' };
      renderIssuesPanel();
    });
  }
  if (filters.projectId !== 'all') {
    const project = listIssueProjects({ includeArchived: true }).find((row) => row.id === filters.projectId);
    addChip('project', `Project: ${project?.name ?? filters.projectId}`, () => {
      filters = { ...filters, projectId: 'all' };
      renderIssuesPanel();
    });
  }

  const hideChip = document.createElement('button');
  hideChip.type = 'button';
  hideChip.className = 'issues-filter-chip';
  hideChip.classList.toggle('is-on', filters.hideDone);
  hideChip.textContent = filters.hideDone ? 'Hide done' : 'Show done';
  hideChip.addEventListener('click', () => {
    filters = { ...filters, hideDone: !filters.hideDone };
    renderIssuesPanel();
  });
  host.appendChild(hideChip);

  const addFilter = document.createElement('button');
  addFilter.type = 'button';
  addFilter.className = 'issues-filter-chip issues-filter-chip--add';
  addFilter.textContent = 'Filter';
  addFilter.addEventListener('click', () => openAddFilterMenu(addFilter));
  host.appendChild(addFilter);
}

function openAddFilterMenu(anchor: HTMLElement): void {
  const taxonomy = getIssuesTaxonomySync();
  openIssuesContextMenu({
    anchor,
    restoreFocus: anchor,
    label: 'Filters',
    items: [
      {
        id: 'type',
        label: 'Type',
        submenu: () =>
          sortedTypes(taxonomy).map((item) => ({
            id: item.id,
            label: item.label,
            onSelect: () => {
              filters = { ...filters, type: item.id };
              renderIssuesPanel();
            },
          })),
      },
      {
        id: 'status',
        label: 'Status',
        submenu: () =>
          sortedStatuses(taxonomy).map((item) => ({
            id: item.id,
            label: item.label,
            onSelect: () => {
              filters = { ...filters, status: item.id };
              renderIssuesPanel();
            },
          })),
      },
      {
        id: 'priority',
        label: 'Priority',
        submenu: () =>
          sortedPriorities(taxonomy).map((item) => ({
            id: item.id,
            label: item.label,
            onSelect: () => {
              filters = { ...filters, priority: item.id };
              renderIssuesPanel();
            },
          })),
      },
      {
        id: 'project',
        label: 'Project',
        submenu: () => [
          ...listIssueProjects().map((project) => ({
            id: project.id,
            label: project.name,
            onSelect: () => {
              filters = { ...filters, projectId: project.id };
              renderIssuesPanel();
            },
          })),
          {
            id: 'new-project',
            label: 'New project…',
            separatorBefore: true,
            onSelect: () => void promptNewProject(),
          },
        ],
      },
    ],
  });
}

function setActiveView(viewId: string): void {
  activeViewId = viewId;
  const view = activeView();
  if (view?.groupBy && isIssuesGroupBy(view.groupBy)) groupBy = view.groupBy;
  const viewFilters = parseViewFilters(view?.filters);
  if (typeof viewFilters.hideDone === 'boolean') filters = { ...filters, hideDone: viewFilters.hideDone };
  renderIssuesPanel();
}

function syncGroupByButton(): void {
  const btn = document.getElementById('btnIssuesGroupBy');
  if (!btn) return;
  const label = ISSUES_GROUP_BY_OPTIONS.find((option) => option.id === groupBy)?.label ?? 'Status';
  btn.textContent = `Group: ${label}`;
}

function setViewMode(mode: IssuesViewMode): void {
  viewMode = mode;
  syncControlsFromState();
  renderIssuesPanel();
}

function setGroupBy(next: IssuesGroupBy): void {
  groupBy = next;
  renderIssuesPanel();
}

/** Sync the Issues deep-link hash — skipped while embedded in Code so the OS router does not foreground the fullscreen Issues app. */
export function setIssuesRouteHash(next: string): void {
  if (isIssuesEmbeddedInCode()) return;
  if (window.location.hash !== next) window.location.hash = next;
}

/** Navigate hash + open detail for an issue. */
function navigateToIssueDetail(issueId: string): void {
  focusedIssueId = issueId;
  pendingIssueId = issueId;
  openIssueDetail(issueId);
  setIssuesRouteHash(`#/app/issues/${issueId}`);
  document.querySelectorAll('.issues-row.is-selected, .issues-card.is-selected').forEach((el) => {
    el.classList.remove('is-selected');
  });
  document
    .querySelector(`.issues-row[data-issue-id="${CSS.escape(issueId)}"], .issues-card[data-issue-id="${CSS.escape(issueId)}"]`)
    ?.classList.add('is-selected');
}

function syncControlsFromState(): void {
  setControlValue('issuesScope', filters.scope);
  setControlValue('issuesSearch', filters.search);
  document.getElementById('issuesViewList')?.classList.toggle('is-active', viewMode === 'list');
  document.getElementById('issuesViewBoard')?.classList.toggle('is-active', viewMode === 'board');
  document
    .getElementById('issuesViewList')
    ?.setAttribute('aria-pressed', viewMode === 'list' ? 'true' : 'false');
  document
    .getElementById('issuesViewBoard')
    ?.setAttribute('aria-pressed', viewMode === 'board' ? 'true' : 'false');
  syncIssuesGithubSyncAllButton();
}

function readFiltersFromControls(): void {
  const scope = controlValue('issuesScope');
  filters = {
    ...filters,
    scope: scope === 'all' ? 'all' : 'current_workspace',
    search: controlValue('issuesSearch'),
  };
}

function issuesGithubSyncScope(): { scope: 'all' | 'current_workspace'; workspacePath: string } {
  readFiltersFromControls();
  return {
    scope: filters.scope,
    workspacePath: getWorkspacePath(),
  };
}

function onFiltersChanged(): void {
  readFiltersFromControls();
  if (isNewFormOpen()) {
    void refreshNewIssueWorkspaceField(filters.scope);
  }
  renderIssuesPanel();
}

function ensureSubscriptions(): void {
  if (!issuesUnsub) {
    issuesUnsub = subscribeIssuesChanges(() => {
      if (isIssuesPageOpen()) renderIssuesPanel();
    });
  }
  if (!taxonomyUnsub) {
    taxonomyUnsub = subscribeIssuesTaxonomyChanges(() => {
      syncIssuesFilterSelects();
      if (isIssuesPageOpen()) renderIssuesPanel();
    });
  }
  if (!githubModeUnsub) {
    githubModeUnsub = subscribeIssuesGithubMode(() => {
      syncIssuesGithubSyncAllButton();
    });
  }
  if (!githubConflictUnsub) {
    githubConflictUnsub = subscribeGithubSyncConflicts(() => {
      if (isIssuesPageOpen()) renderIssuesPanel();
    });
  }
}

// ── New issue ────────────────────────────────────────────────────────────────

function isNewFormOpen(): boolean {
  return document.getElementById('issuesNewForm')?.classList.contains('is-open') ?? false;
}

let newFormOutsideHandler: ((e: PointerEvent) => void) | null = null;
let newFormEscapeHandler: ((e: KeyboardEvent) => void) | null = null;
let newFormSessionAbort: AbortController | null = null;

function detachNewFormListeners(): void {
  newFormSessionAbort?.abort();
  newFormSessionAbort = null;
  newFormOutsideHandler = null;
  newFormEscapeHandler = null;
}

function attachNewFormSessionListeners(form: HTMLElement, backdrop: HTMLElement | null): void {
  detachNewFormListeners();
  const abort = new AbortController();
  newFormSessionAbort = abort;
  const { signal } = abort;
  const anchor = document.getElementById('btnIssuesNew');

  form.addEventListener(
    'click',
    (event) => {
      const target = event.target as Element | null;
      if (!target?.closest('#btnIssuesNewCancel')) return;
      event.preventDefault();
      event.stopPropagation();
      setNewFormOpen(false);
    },
    { signal },
  );

  backdrop?.addEventListener(
    'click',
    () => {
      setNewFormOpen(false);
    },
    { signal },
  );

  newFormOutsideHandler = (event) => {
    const liveForm = document.getElementById('issuesNewForm');
    if (!liveForm?.classList.contains('is-open')) return;
    const target = event.target as Node | null;
    if (liveForm.contains(target) || anchor?.contains(target ?? null)) return;
    if (isIssuesLabelsFieldFocused()) return;
    if (isContextMenuOpen()) return;
    setNewFormOpen(false);
  };
  document.addEventListener('pointerdown', newFormOutsideHandler, { capture: true, signal });

  newFormEscapeHandler = (event) => {
    if (event.key !== 'Escape') return;
    if (isIssuesLabelPopoverFocused()) {
      closeIssuesLabelsSuggestionsMenu();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (isContextMenuOpen()) {
      closeIssuesContextMenu();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setNewFormOpen(false);
  };
  document.addEventListener('keydown', newFormEscapeHandler, { capture: true, signal });
}

function setNewIssuePanelOpen(open: boolean, form: HTMLElement, backdrop: HTMLElement | null): void {
  form.classList.toggle('is-open', open);
  backdrop?.classList.toggle('is-open', open);
  form.style.left = '';
  form.style.top = '';
  form.style.visibility = '';
}

let newIssueDescriptionEditor: IssueEditorHandle | null = null;
/** Invalidates submit operations waiting on an upload after cancel/reopen. */
let newIssueFormRevision = 0;

const NEW_ISSUE_LABELS_ID = '__new__';
let newIssueLabels: string[] = [];
let newIssueLabelsField: HTMLElement | null = null;

/** Insert the labels host when an older new-issue form predates the field. */
function ensureNewIssueLabelsHost(form: HTMLElement): void {
  if (document.getElementById('issuesNewLabelsHost')) return;

  const grid = form.querySelector('.issues-new-form__grid');
  const desc = form.querySelector('.issues-new-form__desc');
  if (!grid || !desc) return;

  const labels = document.createElement('div');
  labels.className = 'issues-new-form__labels';

  const fieldLabel = document.createElement('span');
  fieldLabel.className = 'issues-new-form__field-label';
  fieldLabel.textContent = 'Labels';

  const host = document.createElement('div');
  host.id = 'issuesNewLabelsHost';
  host.className = 'issues-new-form__labels-host';

  labels.append(fieldLabel, host);
  grid.insertBefore(labels, desc);
}

function ensureNewIssueLabelsField(): void {
  const form = document.getElementById('issuesNewForm');
  if (!form) return;
  ensureNewIssueLabelsHost(form);

  const host = document.getElementById('issuesNewLabelsHost');
  if (!host) return;
  if (newIssueLabelsField && host.contains(newIssueLabelsField)) return;

  newIssueLabelsField?.remove();
  newIssueLabels = [];
  newIssueLabelsField = createIssuesLabelsField({
    issueId: NEW_ISSUE_LABELS_ID,
    labels: [],
    variant: 'form',
    onChange: (labels) => {
      newIssueLabels = labels;
    },
  });
  host.replaceChildren(newIssueLabelsField);
}

function resetNewIssueLabels(): void {
  newIssueLabels = [];
  newIssueLabelsField?.remove();
  newIssueLabelsField = null;
  document.getElementById('issuesNewLabelsHost')?.replaceChildren();
}

function getNewIssueDescriptionHost(): HTMLElement | null {
  let host = document.getElementById('issuesNewDescriptionHost');
  if (host) {
    unwrapNewIssueDescriptionLabel(host);
    return host;
  }

  const legacy = document.getElementById('issuesNewDescription');
  if (!(legacy instanceof HTMLTextAreaElement)) return null;

  const migrated = document.createElement('div');
  migrated.id = 'issuesNewDescriptionHost';
  migrated.className = 'issues-detail__desc-wrap is-editing';
  legacy.replaceWith(migrated);
  unwrapNewIssueDescriptionLabel(migrated);
  return migrated;
}

/** `<label>` around the editor steals focus to the toolbar's first button. */
function unwrapNewIssueDescriptionLabel(host: HTMLElement): void {
  const label = host.closest('label.issues-new-form__desc');
  if (!label?.parentElement) return;

  const field = document.createElement('div');
  field.className = 'issues-new-form__desc';
  const fieldLabel = document.createElement('span');
  fieldLabel.className = 'issues-new-form__field-label';
  fieldLabel.textContent = 'Description';
  field.append(fieldLabel, host);
  label.replaceWith(field);
}

function ensureNewIssueDescriptionEditor(): void {
  const host = getNewIssueDescriptionHost();
  if (!host) return;
  if (newIssueDescriptionEditor && host.contains(newIssueDescriptionEditor.root)) return;
  newIssueDescriptionEditor?.destroy();
  host.replaceChildren();

  newIssueDescriptionEditor = createIssueEditor(host, {
    value: '',
    placeholder: 'Describe the problem. / for blocks, # for issues, @ for files.',
    onChange: () => {
    },
  });
}

function getNewIssueDescription(): string {
  // Flush so Create reads the live DOM, not the empty parse from mount.
  return newIssueDescriptionEditor?.flush().trim() ?? '';
}

function resetNewIssueDescription(): void {
  newIssueDescriptionEditor?.setValue('');
}

function syncNewIssueDescriptionRefs(issueId: string, markdown: string): void {
  const refs = collectInlineRefs(markdown);
  if (refs.issueIds.length === 0 && refs.codeRefs.length === 0) return;

  appendIssueLinks(issueId, {
    issueRefs: refs.issueIds
      .filter((id) => id !== issueId && findIssueById(id))
      .map((id) => ({ issueId: id, kind: 'related' as const, addedAt: Date.now() })),
    codeRefs: refs.codeRefs,
  });
}

let newIssueExpandAbort: AbortController | null = null;

function readNewIssueExpandSource() {
  return {
    id: '__new__',
    title: controlValue('issuesNewTitle'),
    description: getNewIssueDescription(),
    type: controlValue('issuesNewType') || 'task',
    priority: controlValue('issuesNewPriority') || 'none',
    labels: [...newIssueLabels],
  };
}

function cancelNewIssueExpand(): void {
  newIssueExpandAbort?.abort();
  newIssueExpandAbort = null;
  const button = document.getElementById('issuesNewExpand');
  if (button) {
    button.textContent = 'Expand';
    button.setAttribute('aria-busy', 'false');
  }
}

function ensureNewIssueExpandButton(form: HTMLElement): void {
  if (form.querySelector('#issuesNewExpand')) return;
  const actions = form.querySelector('.issues-new-form__actions');
  if (!actions) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'issuesNewExpand';
  button.className = 'issues-btn';
  button.textContent = 'Expand';
  button.title = 'Suggest title, description, type, labels, and priority from this draft';
  button.addEventListener('click', () => void expandNewIssueForm());
  actions.prepend(button);
}

async function expandNewIssueForm(): Promise<void> {
  if (newIssueExpandAbort) {
    cancelNewIssueExpand();
    return;
  }
  const source = readNewIssueExpandSource();
  if (!canExpandIssueDraft(source)) {
    showToast('Add a title or description to expand');
    return;
  }
  const controller = new AbortController();
  newIssueExpandAbort = controller;
  const button = document.getElementById('issuesNewExpand');
  if (button) {
    button.textContent = 'Cancel expansion';
    button.setAttribute('aria-busy', 'true');
  }
  try {
    await newIssueDescriptionEditor?.waitForImages();
    if (controller.signal.aborted) return;
    Object.assign(source, readNewIssueExpandSource());
    const { expandUnsavedIssueDraft } = await import('./issues-expand');
    const draft = await expandUnsavedIssueDraft(source, controller.signal);
    if (!draft || controller.signal.aborted || !isNewFormOpen()) return;
    if (JSON.stringify(source) !== JSON.stringify(readNewIssueExpandSource())) {
      showToast('Draft changed while expanding. Expand again to include your edits.');
      return;
    }
    setControlValue('issuesNewTitle', draft.title);
    newIssueDescriptionEditor?.setValue(draft.description);
    setControlValue('issuesNewType', draft.type ?? source.type);
    setControlValue('issuesNewPriority', draft.priority ?? source.priority);
    syncNewIssuePropertyFields();
    newIssueLabels = draft.labels ?? source.labels;
    newIssueLabelsField?.remove();
    newIssueLabelsField = createIssuesLabelsField({
      issueId: NEW_ISSUE_LABELS_ID,
      labels: newIssueLabels,
      variant: 'form',
      onChange: (labels) => { newIssueLabels = labels; },
    });
    document.getElementById('issuesNewLabelsHost')?.replaceChildren(newIssueLabelsField);
    showToast('Draft expanded. Review it before creating the issue.', 'success');
  } catch (error) {
    if (!controller.signal.aborted) {
      showToast(error instanceof Error ? error.message : 'Could not expand the draft', 'error');
    }
  } finally {
    if (newIssueExpandAbort === controller) cancelNewIssueExpand();
  }
}

let newIssueFormBindingsDone = false;

/** The new-issue form lives on document.body; bind its controls outside #issuesView. */
function bindNewIssueFormControls(): void {
  if (newIssueFormBindingsDone) return;
  const form = document.getElementById('issuesNewForm');
  if (!form) return;

  ensureNewIssueWorkspaceField(form);
  ensureNewIssuePropertyFields(form);
  ensureNewIssueDescriptionEditor();
  ensureNewIssueLabelsField();
  syncNewIssuePropertyFields();

  ensureNewIssueExpandButton(form);
  form.addEventListener('submit', submitNewIssue);
  newIssueFormBindingsDone = true;
}

function setNewFormOpen(open: boolean): void {
  bindNewIssueFormControls();

  const form = document.getElementById('issuesNewForm');
  const backdrop = document.getElementById('issuesNewFormBackdrop');
  const anchor = document.getElementById('btnIssuesNew');
  if (!form) return;

  if (!open) {
    newIssueFormRevision++;
    cancelNewIssueExpand();
    setNewIssuePanelOpen(false, form, backdrop);
    anchor?.setAttribute('aria-expanded', 'false');
    resetNewIssueDescription();
    resetNewIssueLabels();
    detachNewFormListeners();
    return;
  }

  ensureNewIssueDescriptionEditor();
  ensureNewIssueLabelsField();
  syncNewIssuePropertyFields();
  void refreshNewIssueWorkspaceField(filters.scope);
  setNewIssuePanelOpen(true, form, backdrop);
  anchor?.setAttribute('aria-expanded', 'true');

  attachNewFormSessionListeners(form, backdrop);

  const title = document.getElementById('issuesNewTitle');
  if (title && 'focus' in title && typeof (title as { focus?: unknown }).focus === 'function') {
    (title as { focus: () => void }).focus();
  }
}

async function submitNewIssue(event: Event): Promise<void> {
  event.preventDefault();
  const editor = newIssueDescriptionEditor;
  const revision = newIssueFormRevision;
  await editor?.waitForImages();
  if (revision !== newIssueFormRevision || !isNewFormOpen() || editor !== newIssueDescriptionEditor) return;
  const title = controlValue('issuesNewTitle').trim();
  if (!title) return;
  const description = getNewIssueDescription();
  const issue = addIssue({
    title,
    description,
    type: (controlValue('issuesNewType') as IssueType) || 'task',
    priority: (controlValue('issuesNewPriority') as IssuePriority) || 'none',
    labels: newIssueLabels,
    workspacePath: getNewIssueWorkspacePath(filters.scope),
  });
  editor?.attachImagesToIssue(issue.id);
  syncNewIssueDescriptionRefs(issue.id, description);
  setControlValue('issuesNewTitle', '');
  resetNewIssueDescription();
  resetNewIssueLabels();
  setNewFormOpen(false);
  renderIssuesPanel();
}

function onQuickCaptureKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const title = controlValue('issuesQuickCapture').trim();
  if (!title) return;
  quickCaptureIssue(title, getWorkspacePath());
  setControlValue('issuesQuickCapture', '');
  renderIssuesPanel();
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

function focusedIssue(): IssueCard | undefined {
  const id = focusedIssueId ?? visibleIssueOrder()[0]?.id;
  return id ? findIssueById(id) : undefined;
}

function moveFocus(delta: number): void {
  const ordered = visibleIssueOrder();
  if (ordered.length === 0) return;
  const current = focusedIssueId ? ordered.findIndex((issue) => issue.id === focusedIssueId) : -1;
  const nextIndex = current < 0 ? 0 : Math.max(0, Math.min(ordered.length - 1, current + delta));
  focusedIssueId = ordered[nextIndex].id;
  renderIssuesPanel();
  const row = document.querySelector(
    `.issues-row[data-issue-id="${CSS.escape(focusedIssueId)}"], .issues-card[data-issue-id="${CSS.escape(focusedIssueId)}"]`,
  );
  if (row && 'focus' in row && typeof (row as { focus?: unknown }).focus === 'function') {
    (row as { focus: (opts?: { preventScroll?: boolean }) => void }).focus({ preventScroll: true });
  }
  row?.scrollIntoView({ block: 'nearest' });
}

function moveRank(delta: -1 | 1): void {
  const issue = focusedIssue();
  if (!issue) return;
  const ids = rankPeerIds(issue);
  const from = ids.indexOf(issue.id);
  if (from < 0) return;
  const to = Math.max(0, Math.min(ids.length - 1, from + delta));
  if (to === from) return;
  persistRanksAfterReorder(ids, [issue.id], to);
  renderIssuesPanel();
}

/** Rank peers: same board column, or the same list group (including nested children). */
function rankPeerIds(issue: IssueCard): string[] {
  if (viewMode === 'board') {
    return visibleIssueOrder()
      .filter((row) => row.status === issue.status)
      .map((row) => row.id);
  }
  for (const group of currentGroupedRows()) {
    const ids: string[] = [];
    for (const row of group.rows) {
      ids.push(row.issue.id, ...row.children.map((child) => child.id));
    }
    if (ids.includes(issue.id)) return ids;
  }
  return visibleIssueOrder().map((row) => row.id);
}

function moveBoardColumn(delta: -1 | 1): void {
  const issue = focusedIssue();
  if (!issue) return;
  const columns = getBoardStatusOptions();
  const index = columns.findIndex((col) => col.id === issue.status);
  if (index < 0) return;
  const next = columns[index + delta];
  if (!next) return;
  updateIssue(issue.id, { status: next.id });
  renderIssuesPanel();
}

function openMenuForFocused(
  opener: (anchor: Element, issue: IssueCard) => void,
): void {
  const issue = focusedIssue();
  if (!issue) return;
  const row = document.querySelector(
    `.issues-row[data-issue-id="${CSS.escape(issue.id)}"], .issues-card[data-issue-id="${CSS.escape(issue.id)}"]`,
  );
  if (!row) return;
  opener(row, issue);
}

function acceptFocusedTriage(): void {
  const issue = focusedIssue();
  if (!issue || !isUnreviewedTriageIssue(issue)) return;
  acceptTriageIssue(issue.id);
  renderIssuesPanel();
}

function declineFocusedTriage(): void {
  const issue = focusedIssue();
  if (!issue || !isUnreviewedTriageIssue(issue)) return;
  declineTriageIssue(issue.id);
  renderIssuesPanel();
}

/** `A` on the focused issue: the whole dispatch loop in one keystroke. */
function dispatchFocusedAgent(): void {
  const issue = focusedIssue();
  if (!issue) return;

  if (issue.agent?.phase === 'awaiting_input') {
    void openIssueAgentChat(issue.id);
    return;
  }

  queueIssueAgent(issue.id);
  renderIssuesPanel();

  void import('../chat/issues/agent-dispatch').then(async (m) => {
    const result = await m.dispatchIssueToAgent(issue.id);
    if (!result.ok && result.error) {
      void import('./toast').then((t) => t.showToast(result.error!, 'error'));
    }
    renderIssuesPanel();
  });
}

/** Answer an agent's question from the row. */
async function openIssueAgentChat(issueId: string): Promise<void> {
  const issue = findIssueById(issueId);
  const chatId = issue?.agent?.chatId ?? issue?.boardChatId;
  if (!chatId) return;
  const { launchApp } = await import('../os/router');
  launchApp('code', { codeSection: 'chat', workspacePath: issue?.workspacePath });
  const { switchChat } = await import('./sidebar');
  switchChat(chatId);
}

/** Issues keyboard map (suppressed by isTypingTarget): j/k or arrows — move selection Enter — peek; Escape — restore expanded peek, then close peek / clear multi-select s status, p priority, u assignee, l labels, g project A — assign an agent (plan, board, worktree, PR); answer it when it is waiting Y — accept triage (backlog + triagedAt) N or Backspace — decline triage when the focused card is unreviewed C — new issue E — expand focused issue (sparkles rewrite) Alt+↑/↓ — rank within the group/column Shift+←/→ — move board column (status) / */
function onIssuesKeydown(event: KeyboardEvent): void {
  if (!isIssuesPageOpen()) return;
  if (event.defaultPrevented || event.ctrlKey || event.metaKey) return;
  if (isTypingTarget(event.target)) return;
  if (isContextMenuOpen() || isAppDialogOpen()) return;
  if (isIssueExpandOverlayOpen()) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeIssueExpandOverlay();
    }
    return;
  }
  if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    event.preventDefault();
    moveRank(event.key === 'ArrowUp' ? -1 : 1);
    return;
  }
  if (event.altKey) return;
  if (event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.preventDefault();
    moveBoardColumn(event.key === 'ArrowLeft' ? -1 : 1);
    return;
  }
  if (event.key === 'j' || event.key === 'ArrowDown') {
    event.preventDefault();
    moveFocus(1);
    return;
  }
  if (event.key === 'k' || event.key === 'ArrowUp') {
    event.preventDefault();
    moveFocus(-1);
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    const issue = focusedIssue();
    if (issue) navigateToIssueDetail(issue.id);
    return;
  }
  if (event.key === 'Escape') {
    if (isNewFormOpen()) {
      event.preventDefault();
      setNewFormOpen(false);
      return;
    }
    if (collapseIssueDetailSheet()) {
      event.preventDefault();
      return;
    }
    if (getSelectedIssueId()) {
      closeIssueDetail();
      setIssuesRouteHash('#/app/issues');
      renderIssuesPanel();
      return;
    }
    if (selectedIssueIds.size > 0) {
      clearIssueSelection();
      renderIssuesPanel();
    }
    return;
  }
  if (event.key === 's') {
    event.preventDefault();
    const issue = focusedIssue();
    if (issue) openMenuForFocused(openStatusMenu);
    return;
  }
  if (event.key === 'p') {
    event.preventDefault();
    openMenuForFocused(openPriorityMenu);
    return;
  }
  if (event.key === 'u') {
    event.preventDefault();
    openMenuForFocused(openAssigneeMenu);
    return;
  }
  if (event.key === 'l') {
    event.preventDefault();
    openMenuForFocused(openLabelsMenu);
    return;
  }
  if (event.key === 'g') {
    event.preventDefault();
    openMenuForFocused(openProjectMenu);
    return;
  }
  if (event.key === 'A' || (event.key === 'a' && event.shiftKey)) {
    event.preventDefault();
    dispatchFocusedAgent();
    return;
  }
  if (event.key === 'Y' || event.key === 'y') {
    event.preventDefault();
    acceptFocusedTriage();
    return;
  }
  if (event.key === 'n' || event.key === 'N' || event.key === 'Backspace') {
    const issue = focusedIssue();
    if (issue && isUnreviewedTriageIssue(issue)) {
      event.preventDefault();
      declineFocusedTriage();
      return;
    }
    if (event.key === 'Backspace') return;
  }
  if (event.key === 'c' || event.key === 'C') {
    event.preventDefault();
    setNewFormOpen(true);
    return;
  }
  if (event.key === 'e' || event.key === 'E') {
    event.preventDefault();
    const issue = focusedIssue();
    if (issue) void startIssueExpandFromUi(issue.id);
    return;
  }
}

function openBulkMenu(
  kind: 'status' | 'priority' | 'assignee' | 'labels' | 'project',
  anchor: Element,
): void {
  const firstId = [...selectedIssueIds][0];
  const issue = firstId ? findIssueById(firstId) : undefined;
  if (!issue) return;
  if (kind === 'status') openStatusMenu(anchor, issue);
  else if (kind === 'priority') openPriorityMenu(anchor, issue);
  else if (kind === 'assignee') openAssigneeMenu(anchor, issue);
  else if (kind === 'labels') openLabelsMenu(anchor, issue);
  else openProjectMenu(anchor, issue);
}

function bindIssuesCommands(): void {
  unregisterIssuesCommands?.();
  unregisterIssuesCommands = registerCommandSource(
    'issues',
    () =>
      buildIssuesCommands({
        isOpen: () => isIssuesPageOpen(),
        newIssue: () => setNewFormOpen(true),
        setViewMode,
        setGroupBy,
        setActiveView,
        goToFocused: () => {
          const issue = focusedIssue();
          if (issue) navigateToIssueDetail(issue.id);
        },
        expandFocused: () => {
          const issue = focusedIssue();
          if (issue) void startIssueExpandFromUi(issue.id);
        },
        acceptTriage: acceptFocusedTriage,
        declineTriage: declineFocusedTriage,
        queueAgent: dispatchFocusedAgent,
        listUserViews: () =>
          listIssueViews()
            .filter((view) => !view.builtIn)
            .map((view) => ({ id: view.id, name: view.name })),
      }),
    { order: 20 },
  );
}

function unbindIssuesCommands(): void {
  unregisterIssuesCommands?.();
  unregisterIssuesCommands = null;
}

let staticBindingsDone = false;

function bindStaticControls(): void {
  const root = getRoot();
  if (!root || staticBindingsDone) return;
  staticBindingsDone = true;

  root.addEventListener('change', (event) => {
    const target = asElement(event.target);
    if (target?.id === 'issuesScope') onFiltersChanged();
  });
  root.addEventListener('input', (event) => {
    const target = asElement(event.target);
    if (target?.id === 'issuesSearch') onFiltersChanged();
  });
  root.addEventListener('click', (event) => {
    const target = asElement(event.target);
    if (!target) return;
    if (target.closest('#issuesViewList')) {
      setViewMode('list');
      return;
    }
    if (target.closest('#issuesViewBoard')) {
      setViewMode('board');
      return;
    }
    if (target.closest('#btnIssuesNew')) {
      setNewFormOpen(!isNewFormOpen());
      return;
    }
    if (target.closest('#btnIssuesFiles')) {
      toggleIssuesFileDrawer();
      return;
    }
    if (target.closest('#btnIssuesSyncAll')) {
      void runIssuesGithubSyncAll(issuesGithubSyncScope());
      return;
    }
    if (target.closest('#btnIssuesGroupBy')) {
      const btn = document.getElementById('btnIssuesGroupBy');
      if (!btn) return;
      openIssuesContextMenu({
        anchor: btn,
        restoreFocus: btn,
        label: 'Group by',
        items: ISSUES_GROUP_BY_OPTIONS.map((option) => ({
          id: option.id,
          label: option.label,
          onSelect: () => setGroupBy(option.id),
        })),
      });
      return;
    }
    if (target.closest('#btnIssuesDeleteSelected')) {
      void confirmAndDeleteIssues([...selectedIssueIds]);
      return;
    }
    if (target.closest('#btnIssuesClearSelection')) {
      clearIssueSelection();
      renderIssuesPanel();
      return;
    }
    if (target.closest('#btnIssuesBulkStatus')) {
      openBulkMenu('status', target.closest('#btnIssuesBulkStatus') ?? target);
      return;
    }
    if (target.closest('#btnIssuesBulkPriority')) {
      openBulkMenu('priority', target.closest('#btnIssuesBulkPriority') ?? target);
      return;
    }
    if (target.closest('#btnIssuesBulkAssignee')) {
      openBulkMenu('assignee', target.closest('#btnIssuesBulkAssignee') ?? target);
      return;
    }
    if (target.closest('#btnIssuesBulkLabels')) {
      openBulkMenu('labels', target.closest('#btnIssuesBulkLabels') ?? target);
      return;
    }
    if (target.closest('#btnIssuesBulkProject')) {
      openBulkMenu('project', target.closest('#btnIssuesBulkProject') ?? target);
      return;
    }
    const sortBtn = target.closest('.issues-list-head__sort[data-sort-key]');
    if (sortBtn) {
      const key = sortBtn.getAttribute('data-sort-key');
      if (!key || !isIssuesSortKey(key)) return;
      listSort = cycleIssuesListSort(listSort, key);
      renderIssuesPanel();
    }
  });
  bindNewIssueFormControls();
  document.getElementById('issuesQuickCapture')?.addEventListener('keydown', onQuickCaptureKeydown);

  if (!issuesKeyHandler) {
    issuesKeyHandler = onIssuesKeydown;
    document.addEventListener('keydown', issuesKeyHandler);
  }
}

/** Context-aware Issues entry point. */
export function openIssuesFromSidebar(): void {
  if (shouldEmbedIssuesFromCodeSidebar()) {
    toggleIssuesFromSidebar();
    return;
  }
  if (isOsShellEnabled()) {
    void import('../os/router').then((m) => m.launchApp('issues'));
    return;
  }
  void openIssues();
}

function syncIssuesFilesButton(): void {
  const btn = document.getElementById('btnIssuesFiles');
  if (!btn) return;
  const open = isIssuesFileDrawerOpen();
  btn.classList.toggle('is-active', open);
  btn.setAttribute('aria-pressed', open ? 'true' : 'false');
}

/** Wire listeners; safe to call on every boot. */
export function initIssuesPage(): void {
  if (initialized) return;
  initialized = true;
  const root = getRoot();
  if (root) ensureIssuesChrome(root);
  mountHeaderIcon();
  bindStaticControls();
  initIssuesFileDrawer();
  subscribeIssuesFileDrawer(syncIssuesFilesButton);
  ensureSubscriptions();
  window.addEventListener('hashchange', onHashChange);
  const hash = window.location.hash;
  if (hash === '#/app/issues' || hash.startsWith('#/app/issues/')) {
    void openIssues();
  }
}

export async function openIssues(options?: {
  issueId?: string;
  /** When true, skip OS hash navigation (Code #chatArea embed). */
  embedded?: boolean;
}): Promise<void> {
  const root = getRoot();
  if (!root) return;

  if (!options?.embedded && isIssuesEmbeddedInCode()) {
    teardownIssuesEmbedBeforeChatPaint();
  }

  pendingIssueId = options?.issueId;
  ensureIssuesChrome(root);
  root.classList.add('is-open');
  mountHeaderIcon();
  bindStaticControls();
  bindIssuesCommands();
  ensureSubscriptions();
  if (!isIssuesStoreLoaded()) {
    const { loadIssuesTaxonomyFromStorage } = await import('../state/issues-taxonomy-store');
    await loadIssuesTaxonomyFromStorage();
    const { loadIssuesFromStorage } = await import('../state/issues-store');
    await loadIssuesFromStorage();
  }
  ensureIssueViews();
  syncIssuesFilterSelects();
  syncControlsFromState();
  try {
    renderIssuesPanel();
  } catch {
  }

  if (!options?.embedded && !isOsShellEnabled()) {
    const next = options?.issueId ? `#/app/issues/${options.issueId}` : '#/app/issues';
    if (window.location.hash !== next) window.location.hash = next;
  }
}

export function closeIssues(options?: { skipNavigate?: boolean }): void {
  if (isIssuesEmbeddedInCode()) {
    closeIssuesEmbeddedInCode({ restoreChat: !options?.skipNavigate });
    return;
  }

  const root = getRoot();
  if (!root) return;
  closeIssuesFileDrawer();
  root.classList.remove('is-open');
  pendingIssueId = undefined;
  closeIssueDetail();
  clearIssueSelection();
  unbindIssuesCommands();
  setNewFormOpen(false);
  if (!isOsShellEnabled()) {
    if (!options?.skipNavigate && window.location.hash.startsWith('#/app/issues')) {
      window.location.hash = '#/';
    }
  } else if (!options?.skipNavigate) {
    navigateToDesktop();
  }
}

export function isIssuesPageOpen(): boolean {
  return getRoot()?.classList.contains('is-open') ?? false;
}

/** Consume deep-link issue id prepared by the router (Phase 2 opens detail). */
export function consumePendingIssueId(): string | undefined {
  const id = pendingIssueId;
  pendingIssueId = undefined;
  return id;
}

function onHashChange(): void {
  const hash = window.location.hash;
  if (isIssuesEmbeddedInCode()) return;
  if (hash === '#/app/issues' || hash.startsWith('#/app/issues/')) {
    const match = hash.match(/^#\/app\/issues\/([\w-]+)/);
    void openIssues({ issueId: match?.[1] });
    return;
  }
  if (isOsShellEnabled() && isOsAppHash(hash)) return;
  if (isIssuesPageOpen()) {
    closeIssues({ skipNavigate: true });
  }
}

