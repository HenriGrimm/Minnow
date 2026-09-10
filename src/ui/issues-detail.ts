import { expandGitmojiShortcodes } from '../lib/gitmoji-shortcodes.mjs';
import { setAssistantBubbleContent } from '../markdown/renderer';
import {
  appendIssueLinks,
  findIssueById,
  issueCodeRefsEqual,
  listIssues,
  scheduleSaveIssues,
  updateIssue,
} from '../state/issues-store';
import { parseIssueCodeRefPaste } from '../state/issue-code-ref-parse';
import { getWorkspacePath } from '../state/workspace';
import { getMode } from '../chat/modes/registry';
import {
  canExpandIssueWithAgent,
} from '../chat/issues/expand-task';
import {
  createIssueExpandButton,
  isIssueExpandOverlayOpen,
} from './issues-expand-controls';
import {
  canInvestigateIssue,
  canRunIssueWorkflow,
  issueActivityChip,
  issueActivityTarget,
  openIssueActivity,
  runIssueBackgroundChat,
  runIssueExpandWithAgent,
  runIssueForegroundChat,
  runIssueSendToBoard,
  openIssuePlanInEditor,
  ISSUE_BACKGROUND_CHAT_MODES,
  ISSUE_FOREGROUND_CHAT_MODES,
} from '../chat/issues/pipeline';
import type { IssueBackgroundChatMode, IssueForegroundChatMode } from '../chat/issues/workflow-seeds';
import { createIssuesWorkflowDropdown, closeIssuesWorkflowMenu } from './issues-workflow-menu';
import { promptIssueChatRunTarget } from './issues-chat-run-target';
import type { ChatRunTargetChoice } from '../state/chat-worktree';
import {
  createBranchFromIssue,
  createPrFromIssue,
  detectGhAvailable,
  linkCommitToIssue,
  linkGitHubUrlToIssue,
  listIssueCommits,
  openExternalGitUrl,
  openIssueCommitInGitUi,
  resolveGitLinkOpenUrl,
  resolveIssuePrNumber,
} from '../chat/issues/git-actions';
import { listPrReviewsForIssue, subscribePrReviews } from '../state/pr-review-store';
import {
  applyPrReviewToIssue,
  mergeReviewedPr,
  sendPrReviewToBuilder,
} from '../chat/review/review-actions';
import { startPrReview } from '../chat/review/run-pr-review';
import { renderPrReviewPanel } from './pr-review-panel';
import { switchChat } from './sidebar';
import { createCodeRefLinkButton } from './code-ref-link';
import { createIssueEditor, type IssueEditorHandle } from './issue-editor';
import {
  isIssueCommentComposerFocused,
  issueCommentCount,
  renderIssueComments,
} from './issues-comments-section';
import { collectInlineRefs } from '../issues/markdown-inline';
import { codeRefsExcludingPlan, inferIssuePlanPath } from '../issues/plan-attach';
import { renderIssueAttachments } from './issues-attachments-section';
import { bindIssueDropTarget } from './issue-drop-target';
import {
  canIssueReceiveSubIssues,
  subIssueAddMenuItems,
  subIssueMenuItems,
  unparentIssueFromParent,
} from './issues-sub-issues';
import { listChildIssues } from '../issues/hierarchy';
import {
  fillIssueChatsSection,
  issueChatsMenuItems,
  issueChatsSummary,
} from './issues-chats-section';
import {
  bindGithubSyncButton,
  buildGithubIssueChip,
  clearGithubConflictHost,
  githubSyncEnabled,
  registerGithubConflictHost,
} from './issues-github-section';
import { gitLinkDuplicatesGithubIssue } from '../issues/github-sync-plan';
import { githubSyncCaption } from '../issues/github-sync-status';
import { createIssuesLabelsField, isIssuesLabelsFieldFocused } from './issues-labels-field';
import { confirmAndDeleteIssues } from './issues-delete';
import { executeTool } from '../tools/client';
import {
  createIssuePriorityChip,
  createIssueStatusChip,
  createIssueTypeChip,
  resolveIssuePriorityIcon,
  resolveIssueStatusIcon,
  resolveIssueTypeIcon,
} from '../issues/type-icons';
import {
  sortedPriorities,
  sortedStatuses,
  sortedTypes,
} from '../issues/taxonomy';
import { getIssuesTaxonomySync } from '../state/issues-taxonomy-store';
import { isLocalServerAvailable } from '../tools/config';
import { createIcon } from './icon';
import {
  createDetailIconButton,
  createDetailRow,
  createDetailTextButton,
  type DetailRowSummaryPart,
} from './issues-detail-section';
import {
  ensureIssuesPeekLayout,
  isIssueDetailSheetExpanded,
  refreshIssuesPeekLayoutChrome,
  resetIssueDetailSheetOnClose,
  setIssueDetailSheetExpanded,
} from './issues-detail-layout';
import { openIssuesContextMenu, type IssuesContextMenuItem } from './issues-context-menu';
import type {
  IssueCard,
  IssueCodeRef,
  IssueGitLink,
  IssueIssueRef,
  IssuePriority,
  IssueStatus,
  IssueType,
} from '../types';

/** Issue ids currently expanding via issue-writer. */
const expandingIds = new Set<string>();

/** Issue ids with a workflow action in flight (Investigate / Plan / …). */
const workflowBusyIds = new Set<string>();

/** Issue ids with a Git action in flight (branch / PR / link). */
const gitBusyIds = new Set<string>();

/** Last Git error per issue (survives detail re-render). */
const gitErrorByIssueId = new Map<string, string>();

/**
 * Cached `gh` probe. The git menu is built synchronously when it opens, so it
 * reads this instead of awaiting; the first render primes it and repaints.
 */
let ghAvailable: boolean | null = null;

function ghAvailableSync(): boolean {
  return ghAvailable !== false;
}

function primeGhAvailable(): void {
  if (ghAvailable !== null || !isLocalServerAvailable()) return;
  void detectGhAvailable().then((ok) => {
    if (ghAvailable === ok) return;
    ghAvailable = ok;
  });
}

let selectedIssueId: string | undefined;
let detailHost: HTMLElement | null = null;
/** Live peek editor; flushed before remount so innerHTML cannot drop the body. */
let detailEditor: IssueEditorHandle | null = null;
/** Guards flush → store emit → refresh from rebuilding the panel mid-paint. */
let paintingDetail = false;

subscribePrReviews(() => {
  if (selectedIssueId) refreshIssueDetailIfOpen();
});

// ── Host ─────────────────────────────────────────────────────────────────────

function showIssuesToast(message: string, kind: 'success' | 'error' = 'success'): void {
  void import('./toast').then((m) => m.showToast(message, kind));
}

function ensureDetailHost(): HTMLElement | null {
  const body = document.querySelector('#issuesView .issues-body');
  if (!body) return null;
  let host = document.getElementById('issuesDetailHost');
  if (!host) {
    host = document.createElement('aside');
    host.id = 'issuesDetailHost';
    host.className = 'issues-detail-host';
    host.setAttribute('aria-label', 'Issue detail');
    body.appendChild(host);
  }
  detailHost = host;
  ensureIssuesPeekLayout(host);
  return host;
}

/** Currently open detail issue id (if any). */
export function getSelectedIssueId(): string | undefined {
  return selectedIssueId;
}

/** True when focus is inside peek chrome that a remount would wipe. */
export function isIssuesDetailEditing(): boolean {
  if (isIssueExpandOverlayOpen()) return true;
  const active = document.activeElement;
  if (!active || typeof (active as { closest?: unknown }).closest !== 'function') {
    return false;
  }
  if (isIssuesLabelsFieldFocused()) return true;
  if (isIssueCommentComposerFocused()) return true;
  const el = active as HTMLElement;
  return Boolean(
    el.closest('.issues-detail__title') ||
      el.closest('.issues-detail__desc-wrap') ||
      el.closest('.mn-editor') ||
      el.closest('.issues-detail__add-code') ||
      el.closest('.issues-expand-form'),
  );
}

/** Whether an expand run is in flight for this issue. */
export function isIssueExpanding(issueId: string): boolean {
  return expandingIds.has(issueId);
}

function syncDetailLayoutClass(open: boolean): void {
  const root = document.getElementById('issuesView');
  root?.classList.toggle('has-detail', open);
  root?.querySelector('.issues-shell')?.classList.toggle('is-detail', open);
}

/** Flush and drop the peek editor while its DOM is still mounted. */
function teardownDetailEditor(): void {
  const editor = detailEditor;
  detailEditor = null;
  editor?.destroy();
}

/** Close the detail panel and clear selection. */
export function closeIssueDetail(): void {
  const id = selectedIssueId;
  teardownDetailEditor();
  if (id) {
    void import('../state/issues-github-auto').then((mod) => {
      mod.flushIssueGithubAutoSync(id);
    });
    clearGithubConflictHost(id);
  }
  selectedIssueId = undefined;
  const host = detailHost ?? document.getElementById('issuesDetailHost');
  if (host) {
    host.classList.remove('is-open');
    host.querySelector('.issues-detail')?.remove();
  }
  resetIssueDetailSheetOnClose();
  refreshIssuesPeekLayoutChrome();
  syncDetailLayoutClass(false);
}

/** Delete the open issue after confirmation. */
async function deleteIssueFromDetail(issueId: string): Promise<void> {
  const { deletedIds } = await confirmAndDeleteIssues([issueId]);
  if (!deletedIds.includes(issueId)) return;
  closeIssueDetail();
  void import('./issues-page').then((m) => {
    m.setIssuesRouteHash('#/app/issues');
    m.renderIssuesPanel();
  });
}

/** Open (or refresh) the detail slide-over for an issue id. */
export function openIssueDetail(issueId: string): void {
  const issue = findIssueById(issueId);
  if (!issue) {
    closeIssueDetail();
    return;
  }
  selectedIssueId = issue.id;
  const host = ensureDetailHost();
  if (!host) return;
  syncDetailLayoutClass(true);
  host.classList.add('is-open');
  renderIssueDetail(host, issue);
  refreshIssuesPeekLayoutChrome();
}

/** Re-render detail if the selected issue is still open. */
export function refreshIssueDetailIfOpen(): void {
  closeIssuesWorkflowMenu();
  if (!selectedIssueId) return;
  openIssueDetail(selectedIssueId);
}

// ── Refs ─────────────────────────────────────────────────────────────────────

/** Capture a short snippet for a code ref via read_file_range when possible. */
async function captureSnippetForRef(ref: IssueCodeRef): Promise<string | undefined> {
  if (ref.snippet?.trim()) return ref.snippet;
  if (ref.startLine == null) return undefined;
  const start = ref.startLine;
  const end = ref.endLine ?? start;
  try {
    const raw = (
      await executeTool('read_file_range', {
        path: ref.path,
        start_line: start,
        end_line: Math.min(end, start + 40),
      })
    ).content;
    if (typeof raw !== 'string' || raw.startsWith('Error:')) return undefined;
    const body = raw
      .split('\n')
      .map((line) => line.replace(/^\s*\d+:\s?/, ''))
      .join('\n')
      .trim();
    return body.slice(0, 2000) || undefined;
  } catch {
    return undefined;
  }
}

async function addCodeRefFromPaste(issueId: string, paste: string): Promise<void> {
  const parsed = parseIssueCodeRefPaste(paste);
  if (parsed.ok === false) {
    void import('./toast').then((m) => m.showToast(parsed.error, 'error'));
    return;
  }
  const snippet = await captureSnippetForRef(parsed.ref);
  const ref: IssueCodeRef = snippet ? { ...parsed.ref, snippet } : parsed.ref;
  appendIssueLinks(issueId, { codeRefs: [ref] });
  scheduleSaveIssues();
  refreshIssueDetailIfOpen();
}

function removeCodeRefFromIssue(issueId: string, ref: IssueCodeRef): void {
  const issue = findIssueById(issueId);
  if (!issue?.codeRefs?.length) return;
  const next = issue.codeRefs.filter((entry) => !issueCodeRefsEqual(entry, ref));
  if (next.length === issue.codeRefs.length) return;
  updateIssue(issueId, { codeRefs: next });
  scheduleSaveIssues();
  refreshIssueDetailIfOpen();
}

/** Unlink a plan markdown path from the issue (does not delete the file). */
function removePlanFromIssue(issueId: string, planPath: string): void {
  const issue = findIssueById(issueId);
  if (!issue) return;
  const hadExplicitPlan = Boolean(issue.planPath?.trim());
  const nextCodeRefs = codeRefsExcludingPlan(issue.codeRefs ?? [], planPath);
  const codeRefsChanged = nextCodeRefs.length !== (issue.codeRefs?.length ?? 0);
  if (!hadExplicitPlan && !codeRefsChanged) return;
  const patch: Parameters<typeof updateIssue>[1] = {};
  if (hadExplicitPlan) patch.planPath = '';
  if (codeRefsChanged) patch.codeRefs = nextCodeRefs;
  updateIssue(issueId, patch);
  scheduleSaveIssues();
  refreshIssueDetailIfOpen();
}

// ── Chrome ───────────────────────────────────────────────────────────────────

function formatTs(ts: number): string {
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

/**
 * Headless section for the two blocks that carry no label: the description
 * (it is the page) and the meta footer (it is a caption). Everything else
 * uses the rail vocabulary in `issues-detail-section.ts`.
 */
function section(variant: 'document' | 'meta'): { section: HTMLElement; body: HTMLElement } {
  const sectionEl = document.createElement('section');
  sectionEl.className = `issues-detail__section issues-detail__section--${variant}`;
  const body = document.createElement('div');
  body.className = 'issues-detail__section-body';
  sectionEl.appendChild(body);
  return { section: sectionEl, body };
}

/** Icon button used for Close and the more menu — 28px visual, 44px on coarse pointers. */
function detailIconButton(
  label: string,
  iconName: 'close' | 'more' | 'expand',
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'issues-detail__icon-btn';
  btn.setAttribute('aria-label', label);
  btn.appendChild(createIcon(iconName, { size: 16 }));
  return btn;
}

/** Make a list-style chip a keyboard-openable property control. */
function bindPropertyChip(
  chip: HTMLElement,
  ariaLabel: string,
  open: (anchor: HTMLElement) => void,
): void {
  chip.classList.add('issues-detail__prop');
  chip.setAttribute('role', 'button');
  chip.setAttribute('tabindex', '0');
  chip.setAttribute('aria-haspopup', 'menu');
  chip.setAttribute('aria-label', ariaLabel);
  chip.appendChild(
    createIcon('chevronDown', { size: 10, className: 'issues-detail__prop-chevron' }),
  );
  const show = (): void => open(chip);
  chip.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    show();
  });
  chip.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    show();
  });
}

function openDetailPropertyMenu(
  anchor: HTMLElement,
  label: string,
  items: Array<{ id: string; label: string; iconClass?: string }>,
  onPick: (id: string) => void,
): void {
  openIssuesContextMenu({
    anchor,
    restoreFocus: anchor,
    label,
    items: items.map((item) => ({
      id: item.id,
      label: item.label,
      iconClass: item.iconClass,
      onSelect: () => onPick(item.id),
    })),
  });
}

function createDetailStatusChip(status: IssueStatus): HTMLElement {
  const taxonomy = getIssuesTaxonomySync();
  const item = taxonomy.statuses.find((entry) => entry.id === status);
  return createIssueStatusChip(status, item);
}

function createDetailPriorityChip(priority: IssuePriority): HTMLElement {
  const taxonomy = getIssuesTaxonomySync();
  const item = taxonomy.priorities.find((entry) => entry.id === priority);
  return createIssuePriorityChip(priority, item);
}

/** Input + submit used by code links and git paste rows. */
function buildAddRow(
  input: HTMLInputElement,
  button: HTMLButtonElement,
  extraClass?: string,
): HTMLElement {
  const addRow = document.createElement('div');
  addRow.className = extraClass
    ? `issues-detail__add-code ${extraClass}`
    : 'issues-detail__add-code';
  addRow.append(input, button);
  return addRow;
}

// ── Description ──────────────────────────────────────────────────────────────

/** Description: the WYSIWYG editor over canonical markdown. */
function buildDescriptionSection(issue: IssueCard): HTMLElement {
  const descSection = section('document');
  const host = document.createElement('div');
  host.className = 'issues-detail__desc-wrap';

  let lastCommitted = findIssueById(issue.id)?.description ?? issue.description;

  detailEditor = createIssueEditor(host, {
    value: lastCommitted,
    issueId: issue.id,
    placeholder: 'Describe the problem. / for blocks, # for issues, @ for files.',
    onChange: (markdown) => {
      if (markdown === lastCommitted) return;
      lastCommitted = markdown;
      updateIssue(issue.id, { description: markdown });
      syncDescriptionRefs(issue.id, markdown);
      scheduleSaveIssues();
    },
  });

  descSection.body.appendChild(host);
  return descSection.section;
}

/** Turn `#KEY-12` and `@path:12-34` in the body into real links. */
function syncDescriptionRefs(issueId: string, markdown: string): void {
  const refs = collectInlineRefs(markdown);
  if (refs.issueIds.length === 0 && refs.codeRefs.length === 0) return;

  appendIssueLinks(issueId, {
    issueRefs: refs.issueIds
      .filter((id) => id !== issueId && findIssueById(id))
      .map((id) => ({ issueId: id, kind: 'related' as const, addedAt: Date.now() })),
    codeRefs: refs.codeRefs,
  });
}

/** Build the detail panel DOM for one issue. */
function renderIssueDetail(host: HTMLElement, issue: IssueCard): void {
  if (paintingDetail) return;
  paintingDetail = true;
  try {
    teardownDetailEditor();
    host.querySelector('.issues-detail')?.remove();

  const panel = document.createElement('div');
  panel.className = 'issues-detail';
  panel.dataset.issueId = issue.id;

  const sticky = document.createElement('div');
  sticky.className = 'issues-detail__sticky';

  const header = document.createElement('header');
  header.className = 'issues-detail__header';

  // The id is the thing people paste into a commit or a chat; make it one click.
  const idEl = document.createElement('button');
  idEl.type = 'button';
  idEl.className = 'issues-detail__id';
  idEl.textContent = issue.id;
  idEl.title = `Copy ${issue.id}`;
  idEl.setAttribute('aria-label', `Copy issue id ${issue.id}`);
  idEl.appendChild(createIcon('copy', { size: 11, className: 'issues-detail__id-copy' }));
  idEl.addEventListener('click', () => {
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) return;
    void clipboard.writeText(issue.id).then(
      () => showIssuesToast(`Copied ${issue.id}`, 'success'),
      () => showIssuesToast('Could not copy the issue id', 'error'),
    );
  });

  const headerActions = document.createElement('div');
  headerActions.className = 'issues-detail__header-actions';

  const moreBtn = detailIconButton('Issue actions', 'more');
  moreBtn.classList.add('issues-detail__more');
  moreBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    openIssuesContextMenu({
      anchor: moreBtn,
      restoreFocus: moreBtn,
      label: 'Issue actions',
      items: [
        ...subIssueMenuItems(issue),
        {
          id: 'delete',
          label: 'Delete issue',
          danger: true,
          separatorBefore: true,
          onSelect: () => {
            void deleteIssueFromDetail(issue.id);
          },
        },
      ],
    });
  });

  // Docked vs overlay: this control grows the same peek, it does not close it.
  const layoutBtn = detailIconButton('Open issue in a larger sheet', 'expand');
  layoutBtn.classList.add('issues-detail__layout-expand');
  layoutBtn.setAttribute('aria-pressed', isIssueDetailSheetExpanded() ? 'true' : 'false');
  layoutBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    setIssueDetailSheetExpanded(!isIssueDetailSheetExpanded());
  });

  const closeBtn = detailIconButton('Close issue detail', 'close');
  closeBtn.classList.add('issues-detail__close');
  closeBtn.addEventListener('click', () => {
    closeIssueDetail();
    void import('./issues-page').then((m) => m.setIssuesRouteHash('#/app/issues'));
  });

  headerActions.append(createIssueExpandButton(issue, 'peek'), moreBtn, layoutBtn, closeBtn);
  header.append(idEl, headerActions);
  sticky.appendChild(header);

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'issues-detail__title';
  titleInput.value = issue.title;
  titleInput.setAttribute('aria-label', 'Issue title');
  titleInput.addEventListener('change', () => {
    const next = titleInput.value.trim();
    if (next && next !== issue.title) updateIssue(issue.id, { title: next });
  });
  sticky.appendChild(titleInput);

  const props = document.createElement('div');
  props.className = 'issues-detail__props';
  const taxonomy = getIssuesTaxonomySync();

  const typeChip = createIssueTypeChip(
    issue.type,
    taxonomy.types.find((entry) => entry.id === issue.type),
    { labeled: true },
  );
  bindPropertyChip(typeChip, `Type: ${typeChip.title || issue.type}`, (anchor) => {
    openDetailPropertyMenu(
      anchor,
      'Type',
      sortedTypes(taxonomy).map((entry) => ({
        id: entry.id,
        label: entry.label,
        iconClass: resolveIssueTypeIcon(entry.id, entry),
      })),
      (id) => updateIssue(issue.id, { type: id as IssueType }),
    );
  });

  const statusChip = createDetailStatusChip(issue.status);
  bindPropertyChip(statusChip, `Status: ${statusChip.title || issue.status}`, (anchor) => {
    openDetailPropertyMenu(
      anchor,
      'Status',
      sortedStatuses(taxonomy).map((entry) => ({
        id: entry.id,
        label: entry.label,
        iconClass: resolveIssueStatusIcon(entry.id, entry),
      })),
      (id) => updateIssue(issue.id, { status: id as IssueStatus }),
    );
  });

  const priorityChip = createDetailPriorityChip(issue.priority);
  bindPropertyChip(
    priorityChip,
    `Priority: ${priorityChip.textContent || issue.priority}`,
    (anchor) => {
      openDetailPropertyMenu(
        anchor,
        'Priority',
        sortedPriorities(taxonomy).map((entry) => ({
          id: entry.id,
          label: entry.label,
          iconClass: resolveIssuePriorityIcon(entry.id, entry),
        })),
        (id) => updateIssue(issue.id, { priority: id as IssuePriority }),
      );
    },
  );

  props.append(typeChip, statusChip, priorityChip);
  sticky.appendChild(props);

  const labelsField = createIssuesLabelsField({
    issueId: issue.id,
    labels: issue.labels,
    severity: issue.severity,
    variant: 'detail',
    onChange: (labels) => {
      updateIssue(issue.id, { labels });
    },
    onBlur: () => refreshIssueDetailIfOpen(),
  });
  sticky.appendChild(labelsField);

  sticky.appendChild(buildWorkflowToolbar(issue));
  panel.appendChild(sticky);

  const scroll = document.createElement('div');
  scroll.className = 'issues-detail__scroll';

  // Three zones, in this DOM order so the docked column reads document →
  // links → conversation. The expanded sheet re-places them with grid areas:
  // the rail becomes a right sidebar and the document keeps a readable measure.
  const doc = document.createElement('div');
  doc.className = 'issues-detail__doc';

  const parentLine = buildParentLine(issue);
  if (parentLine) doc.appendChild(parentLine);
  doc.appendChild(buildDescriptionSection(issue));

  const rail = document.createElement('div');
  rail.className = 'issues-detail__rail';

  const planPath = inferIssuePlanPath(issue);
  if (planPath) rail.appendChild(buildPlanSection(issue, planPath));
  rail.appendChild(buildCodeLinksSection(issue, planPath));
  rail.appendChild(buildAttachmentsSection(issue));
  rail.appendChild(buildGitSection(issue));

  const reviewSection = buildIssueReviewSection(issue);
  if (reviewSection) rail.appendChild(reviewSection);

  const subIssues = buildSubIssuesSection(issue);
  if (subIssues) rail.appendChild(subIssues);

  const related = buildRelatedIssuesSection(issue);
  if (related) rail.appendChild(related);

  rail.appendChild(buildChatsSection(issue));

  const talk = document.createElement('div');
  talk.className = 'issues-detail__talk';
  talk.appendChild(buildCommentsSection(issue));
  talk.appendChild(buildActivityFooter(issue));

  scroll.append(doc, rail, talk);

  panel.appendChild(scroll);
  bindIssueDropTarget(panel, issue.id, () => refreshIssueDetailIfOpen());
  host.appendChild(panel);
  } finally {
    paintingDetail = false;
  }
}

// ── Links ────────────────────────────────────────────────────────────────────

function buildCodeAddRow(issueId: string, onAdded: () => void): HTMLElement {
  const pasteInput = document.createElement('input');
  pasteInput.type = 'text';
  pasteInput.className = 'issues-search';
  pasteInput.placeholder = 'path/to/file.ts:12-34';
  pasteInput.setAttribute('aria-label', 'Paste code link');
  const addBtn = createDetailTextButton({
    label: 'Add',
    icon: 'plus',
    onClick: () => submitPaste(),
  });
  const submitPaste = (): void => {
    const value = pasteInput.value.trim();
    if (!value) return;
    void addCodeRefFromPaste(issueId, value).then(() => {
      pasteInput.value = '';
      onAdded();
    });
  };
  pasteInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    submitPaste();
  });
  return buildAddRow(pasteInput, addBtn);
}

/** Trailing remove control shared by code, sub-issue, and chat rows. */
function buildRowRemove(label: string, onRemove: () => void): HTMLButtonElement {
  return createDetailIconButton({
    label,
    icon: 'close',
    danger: true,
    onClick: onRemove,
    className: 'issues-detail__row-remove',
  });
}

/** Last path segment — enough to recognise a file without eating the row. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** "one thing" reads as the thing; "many things" reads as a count. */
function countSummary(items: readonly string[], plural: string): DetailRowSummaryPart[] {
  if (items.length === 0) return [];
  if (items.length === 1) return [{ text: items[0]!, mono: true }];
  return [{ text: `${items.length} ${plural}` }];
}

function buildCodeLinksSection(issue: IssueCard, planPath: string | undefined): HTMLElement {
  const refs = codeRefsExcludingPlan(issue.codeRefs ?? [], planPath);
  let addRow: HTMLElement | null = null;

  const sec = createDetailRow({
    key: 'code',
    icon: 'appCode',
    label: 'Code',
    summary: countSummary(refs.map((ref) => baseName(ref.path)), 'files'),
    expandable: refs.length > 0,
    addLabel: 'Add code link',
    onAdd: () => {
      sec.expand();
      if (!addRow) {
        addRow = buildCodeAddRow(issue.id, () => refreshIssueDetailIfOpen());
        sec.body.appendChild(addRow);
      }
      addRow.hidden = false;
      sec.body.hidden = false;
      addRow.querySelector('input')?.focus();
    },
  });

  if (refs.length > 0) {
    const list = document.createElement('div');
    list.className = 'issues-detail__code-list';
    for (const ref of refs) {
      const row = document.createElement('div');
      row.className = 'issues-detail__code-row';

      const main = document.createElement('div');
      main.className = 'issues-detail__code-row-main';
      main.appendChild(
        createCodeRefLinkButton({
          workspacePath: ref.path,
          startLine: ref.startLine ?? 1,
          endLine: ref.endLine ?? ref.startLine ?? 1,
        }),
      );
      if (ref.snippet?.trim()) {
        const snip = document.createElement('pre');
        snip.className = 'issues-detail__snippet';
        snip.textContent = ref.snippet.slice(0, 500);
        main.appendChild(snip);
      }
      row.appendChild(main);
      row.appendChild(
        buildRowRemove(`Remove link to ${ref.path}`, () => removeCodeRefFromIssue(issue.id, ref)),
      );
      list.appendChild(row);
    }
    sec.body.insertBefore(list, sec.body.firstChild);
  }

  return sec.section;
}

/** Attachments: the picker lives in the body, its control on the row. */
function buildAttachmentsSection(issue: IssueCard): HTMLElement {
  const attachments = issue.attachments ?? [];
  let openPicker = (): void => {};

  const sec = createDetailRow({
    key: 'attachments',
    icon: 'attach',
    label: 'Attachments',
    summary: countSummary(attachments.map((file) => file.name), 'files'),
    expandable: attachments.length > 0,
    addLabel: 'Attach files',
    onAdd: () => {
      sec.expand();
      openPicker();
    },
  });

  openPicker = renderIssueAttachments(sec.body, issue, () => refreshIssueDetailIfOpen()).openPicker;
  return sec.section;
}

function buildPlanSection(issue: IssueCard, planPath: string): HTMLElement {
  const workflowOk = canRunIssueWorkflow(issue);
  const workflowBusy = workflowBusyIds.has(issue.id) || expandingIds.has(issue.id);

  const sec = createDetailRow({
    key: 'plan',
    icon: 'modePlan',
    label: 'Plan',
    summary: [{ text: baseName(planPath), mono: true }],
    addLabel: 'Plan actions',
    addIcon: 'more',
    onAdd: (anchor) => {
      openIssuesContextMenu({
        anchor,
        restoreFocus: anchor,
        label: 'Plan actions',
        items: [
          {
            id: 'open-plan',
            label: 'Open plan',
            hint: planPath,
            iconClass: 'fi-rr-arrow-up-right-from-square',
            onSelect: () => {
              void openIssuePlanInEditor(planPath, issue.workspacePath);
            },
          },
          {
            id: 'plan-to-board',
            label: 'Send to board',
            hint: workflowOk ? 'Launch an Orchestrate board from this plan' : 'Issue is closed',
            disabled: !workflowOk || workflowBusy,
            iconClass: 'fi-rr-layout-fluid',
            onSelect: () => {
              void runWorkflowAction(issue.id, 'board');
            },
          },
          {
            id: 'plan-unlink',
            label: 'Unlink plan',
            hint: 'The file stays on disk',
            danger: true,
            separatorBefore: true,
            onSelect: () => removePlanFromIssue(issue.id, planPath),
          },
        ],
      });
    },
  });

  // The row itself opens the plan; the menu carries everything else.
  sec.row.addEventListener('click', () => {
    void openIssuePlanInEditor(planPath, issue.workspacePath);
  });
  sec.row.title = `Open ${planPath}`;
  return sec.section;
}

/**
 * Comments + activity: the only place an agent's reply is readable.
 *
 * This is a zone, not a property row — it owns a composer, so it keeps a real
 * heading and stays open.
 */
function buildCommentsSection(issue: IssueCard): HTMLElement {
  const count = issueCommentCount(issue);
  const sectionEl = document.createElement('section');
  sectionEl.className = 'issues-detail__section issues-detail__section--comments';
  sectionEl.dataset.section = 'comments';

  const head = document.createElement('div');
  head.className = 'issues-detail__zone-head';
  head.appendChild(createIcon('comment', { size: 14, className: 'issues-detail__row-icon' }));
  const title = document.createElement('h3');
  title.className = 'issues-detail__section-title';
  title.textContent = count > 0 ? 'Comments' : 'Activity';
  head.appendChild(title);
  if (count > 0) {
    const countEl = document.createElement('span');
    countEl.className = 'issues-detail__row-value';
    const part = document.createElement('span');
    part.className = 'issues-detail__row-value-part is-mono';
    part.textContent = String(count);
    countEl.appendChild(part);
    head.appendChild(countEl);
  }
  sectionEl.appendChild(head);

  const body = document.createElement('div');
  body.className = 'issues-detail__section-body';
  renderIssueComments(body, issue, () => refreshIssueDetailIfOpen());
  sectionEl.appendChild(body);
  return sectionEl;
}

function buildActivityFooter(issue: IssueCard): HTMLElement {
  const activitySection = section('meta');
  const ws = issue.workspacePath || getWorkspacePath();

  const metaLine = (
    icon: Parameters<typeof createIcon>[0],
    text: string,
    title?: string,
  ): HTMLElement => {
    const row = document.createElement('p');
    row.className = 'issues-detail__meta-line';
    row.appendChild(createIcon(icon, { size: 12 }));
    const value = document.createElement('span');
    value.textContent = text;
    row.appendChild(value);
    if (title) row.title = title;
    return row;
  };

  activitySection.body.appendChild(
    metaLine('clock', `Created ${formatTs(issue.createdAt)} \u00b7 Updated ${formatTs(issue.updatedAt)}`),
  );
  if (ws) activitySection.body.appendChild(metaLine('folder', ws, ws));

  const chatBits: string[] = [];
  if (issue.investigateRunId) chatBits.push(`run ${issue.investigateRunId.slice(0, 8)}\u2026`);
  if (issue.planRunId) chatBits.push(`plan ${issue.planRunId.slice(0, 8)}\u2026`);
  if (chatBits.length) {
    activitySection.body.appendChild(metaLine('appAgentActivity', chatBits.join(' \u00b7 ')));
  }

  if (issue.notes?.trim()) {
    const notes = document.createElement('div');
    notes.className = 'issues-detail__notes';
    notes.textContent = issue.notes;
    activitySection.body.appendChild(notes);
  }
  return activitySection.section;
}

/** Shared review panel when this issue has a persisted PR review. */
function buildIssueReviewSection(issue: IssueCard): HTMLElement | null {
  const records = listPrReviewsForIssue(issue.id);
  if (!records.length) return null;
  const record = [...records].sort((a, b) => b.startedAt - a.startedAt)[0]!;
  const reviewSection = createDetailRow({
    key: 'review',
    icon: 'pullRequest',
    label: 'Review',
    summary: [
      { text: `#${record.number}`, mono: true },
      {
        text:
          record.status === 'running' ? 'Running' : record.status === 'failed' ? 'Failed' : 'Done',
        tone:
          record.status === 'running'
            ? 'accent'
            : record.status === 'failed'
              ? 'danger'
              : 'success',
      },
    ],
    expandable: true,
  });
  renderPrReviewPanel(reviewSection.body, record, {
    showUpdateIssue: true,
    onMerge: () => {
      void mergeReviewedPr(record, issue.workspacePath || getWorkspacePath()).then((outcome) => {
        if (outcome.cancelled) return;
        if (!outcome.ok) {
          showIssuesToast(outcome.error ?? 'Could not merge the pull request', 'error');
          return;
        }
        showIssuesToast(`Merged #${record.number}`, 'success');
      });
    },
    onFix: () => {
      void sendPrReviewToBuilder(record);
    },
    onUpdateIssue: () => {
      if (applyPrReviewToIssue(record, issue.id)) {
        showIssuesToast('Issue updated with the review', 'success');
        refreshIssueDetailIfOpen();
      }
    },
    onOpenChat: () => {
      if (record.chatId) void switchChat(record.chatId);
    },
    onRetry: () => {
      void runGitAction(issue.id, 'review');
    },
  });
  return reviewSection.section;
}

// ── Git ──────────────────────────────────────────────────────────────────────

/**
 * Git as one row.
 *
 * The old block put Create branch / Create PR / Review PR on screen as three
 * filled buttons, which made the least important actions the heaviest thing
 * in the panel. They are all "git, for this issue", so they belong in one
 * menu; the row itself carries the state that actually matters — the linked
 * GitHub issue and whether it needs pushing.
 */
function buildGitSection(issue: IssueCard): HTMLElement {
  const canSync = githubSyncEnabled();
  const github = issue.github;
  // Same-number GH chips are the GitHub row; keep other git links (PRs, other issues).
  const gitLinks = (issue.gitLinks ?? []).filter((link) => !gitLinkDuplicatesGithubIssue(link, issue));
  const showPush = canSync && !github;
  const busy = gitBusyIds.has(issue.id);
  const reviewing = listPrReviewsForIssue(issue.id).some((row) => row.status === 'running');
  const onGithubChanged = (): void => refreshIssueDetailIfOpen();
  const storedErr = gitErrorByIssueId.get(issue.id);

  const summary: DetailRowSummaryPart[] = [];
  if (github) {
    summary.push({ text: `#${github.number}`, mono: true });
    const caption = githubSyncCaption(issue);
    if (caption) {
      summary.push({ text: caption, tone: caption === 'Needs push' ? 'warning' : undefined });
    }
  }
  if (gitLinks.length > 0) {
    summary.push({ text: gitLinks.length === 1 ? '1 link' : `${gitLinks.length} links` });
  }
  if (storedErr) summary.push({ text: 'Failed', tone: 'danger' });

  const sec = createDetailRow({
    key: 'git',
    icon: 'gitBranch',
    label: 'Git',
    summary,
    expandable: summary.length > 0,
    addLabel: 'Git actions',
    addIcon: 'more',
    onAdd: (anchor) => {
      openIssuesContextMenu({
        anchor,
        restoreFocus: anchor,
        label: 'Git actions',
        items: gitMenuItems(issue, {
          busy,
          reviewing,
          showPush,
          canSync,
          conflictHost,
          onGithubChanged,
          onLink: () => {
            sec.expand();
            linkFields.hidden = false;
            shaInput.focus();
          },
        }),
      });
    },
  });
  const body = sec.body;

  const conflictHost = document.createElement('div');
  conflictHost.className = 'issues-detail__git-conflict';

  if (storedErr) {
    const errEl = document.createElement('p');
    errEl.className = 'issues-detail__git-error';
    errEl.setAttribute('role', 'alert');
    errEl.appendChild(createIcon('statusFail', { size: 13 }));
    const errText = document.createElement('span');
    errText.textContent = storedErr;
    errEl.appendChild(errText);
    body.appendChild(errEl);
  }

  if (github || gitLinks.length > 0) {
    const chipList = document.createElement('ul');
    chipList.className = 'issues-detail__git-list';
    if (github) {
      chipList.appendChild(
        buildGithubIssueChip(issue, { canSync, conflictHost, onChanged: onGithubChanged }),
      );
    }
    for (const link of gitLinks) {
      chipList.appendChild(buildGitLinkRow(link));
    }
    body.appendChild(chipList);
  }
  body.appendChild(conflictHost);
  registerGithubConflictHost(issue.id, conflictHost, onGithubChanged);

  const commitsHost = document.createElement('div');
  commitsHost.className = 'issues-detail__git-commits';
  commitsHost.hidden = true;
  body.appendChild(commitsHost);

  const shaInput = document.createElement('input');
  shaInput.type = 'text';
  shaInput.className = 'issues-search';
  shaInput.placeholder = 'Commit sha…';
  shaInput.setAttribute('aria-label', 'Commit sha');
  const submitSha = (): void => {
    const value = shaInput.value;
    shaInput.value = '';
    void runGitAction(issue.id, 'link-commit', value);
  };
  const shaBtn = createDetailTextButton({
    label: 'Link commit',
    icon: 'gitCommit',
    disabled: busy,
    onClick: () => submitSha(),
  });
  shaInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitSha();
    }
  });

  const urlInput = document.createElement('input');
  urlInput.type = 'url';
  urlInput.className = 'issues-search';
  urlInput.placeholder = 'GitHub issue or PR URL…';
  urlInput.setAttribute('aria-label', 'GitHub issue or PR URL');
  const submitUrl = (): void => {
    const value = urlInput.value;
    urlInput.value = '';
    void runGitAction(issue.id, 'link-url', value);
  };
  const urlBtn = createDetailTextButton({
    label: 'Link URL',
    icon: 'link',
    disabled: busy,
    onClick: () => submitUrl(),
  });
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitUrl();
    }
  });

  const linkFields = document.createElement('div');
  linkFields.id = `issues-git-link-fields-${issue.id}`;
  linkFields.className = 'issues-detail__git-link-fields';
  linkFields.hidden = true;
  linkFields.append(buildAddRow(shaInput, shaBtn), buildAddRow(urlInput, urlBtn));
  body.appendChild(linkFields);

  if (!isLocalServerAvailable()) return sec.section;
  primeGhAvailable();

  void (async () => {
    const listed = await listIssueCommits(issue);
    if (selectedIssueId !== issue.id) return;
    commitsHost.replaceChildren();
    if (!listed.ok || listed.commits.length === 0) {
      commitsHost.hidden = true;
      return;
    }
    commitsHost.hidden = false;
    const ul = document.createElement('ul');
    ul.className = 'issues-detail__git-list';
    for (const c of listed.commits) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'issues-detail__git-commit-btn';
      btn.title = 'Open in git panel';
      btn.appendChild(createIcon('gitCommit', { size: 12 }));
      const shaSpan = document.createElement('span');
      shaSpan.className = 'issues-detail__git-sha';
      shaSpan.textContent = c.sha.slice(0, 7);
      const subSpan = document.createElement('span');
      subSpan.className = 'issues-detail__git-subject';
      subSpan.textContent = expandGitmojiShortcodes(c.subject);
      btn.append(shaSpan, subSpan);
      btn.addEventListener('click', () => {
        void openIssueCommitInGitUi(c.sha, expandGitmojiShortcodes(c.subject));
      });
      li.appendChild(btn);
      ul.appendChild(li);
    }
    commitsHost.appendChild(ul);
  })();

  return sec.section;
}

interface GitMenuContext {
  busy: boolean;
  reviewing: boolean;
  showPush: boolean;
  canSync: boolean;
  conflictHost: HTMLElement;
  onGithubChanged: () => void;
  onLink: () => void;
}

/** Everything git can do to this issue, in one menu. */
function gitMenuItems(issue: IssueCard, ctx: GitMenuContext): IssuesContextMenuItem[] {
  const items: IssuesContextMenuItem[] = [
    {
      id: 'git-branch',
      label: 'Create branch',
      hint: 'issue/<id>-<slug>, checked out',
      disabled: ctx.busy,
      iconClass: 'fi-sr-code-branch',
      onSelect: () => {
        void runGitAction(issue.id, 'branch');
      },
    },
    {
      id: 'git-pr',
      label: 'Create pull request',
      hint: ghAvailableSync() ? 'Opens a PR with gh from the issue branch' : 'Needs the gh CLI',
      disabled: ctx.busy || !ghAvailableSync(),
      iconClass: 'fi-rr-code-pull-request',
      onSelect: () => {
        void runGitAction(issue.id, 'pr');
      },
    },
    {
      id: 'git-review',
      label: ctx.reviewing ? 'Reviewing…' : 'Review pull request',
      hint: 'Review the linked PR in its own chat',
      disabled: ctx.busy || ctx.reviewing || !ghAvailableSync(),
      iconClass: 'fi-rr-search',
      onSelect: () => {
        void runGitAction(issue.id, 'review');
      },
    },
    {
      id: 'git-link',
      label: 'Link a commit or URL',
      separatorBefore: true,
      iconClass: 'fi-rr-link-alt',
      onSelect: () => ctx.onLink(),
    },
  ];

  if (ctx.showPush) {
    items.push({
      id: 'git-push',
      label: 'Push to GitHub',
      hint: 'Create this issue on GitHub',
      disabled: ctx.busy,
      iconClass: 'fi-rr-cloud-upload',
      onSelect: () => {
        void pushIssueToGithub(issue, ctx.conflictHost, ctx.onGithubChanged);
      },
    });
  }
  return items;
}

/** Push without a live button: the menu item is the trigger. */
async function pushIssueToGithub(
  issue: IssueCard,
  conflictHost: HTMLElement,
  onChanged: () => void,
): Promise<void> {
  const proxy = document.createElement('button');
  proxy.type = 'button';
  bindGithubSyncButton(proxy, issue, {
    idleLabel: 'Push to GitHub',
    conflictHost,
    onChanged,
  });
  proxy.click();
}

const ISSUE_RELATION_LABELS: Record<IssueIssueRef['kind'], string> = {
  related: 'Related',
  blocks: 'Blocks',
  'blocked-by': 'Blocked by',
  'duplicate-of': 'Duplicate of',
  parent: 'Parent',
  'sub-issue': 'Sub-issue',
};

/** Parent chip at the top of a child peek. */
function buildParentLine(issue: IssueCard): HTMLElement | null {
  const parentId = issue.parentId?.trim();
  if (!parentId) return null;
  const parent = findIssueById(parentId);
  const titleBit = parent?.title?.trim() ? ` · ${parent.title.trim()}` : '';

  const wrap = document.createElement('div');
  wrap.className = 'issues-detail__parent-line';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'issues-detail__parent-line-btn';
  btn.textContent = `Parent · ${parentId}${titleBit}`;
  btn.title = `Open ${parentId}`;
  btn.addEventListener('click', () => {
    openIssueDetail(parentId);
    void import('./issues-page').then((m) => m.setIssuesRouteHash(`#/app/issues/${parentId}`));
  });
  wrap.appendChild(btn);
  return wrap;
}

/** Parent peek: children rows plus a + menu. Hidden on children (one level). */
function buildSubIssuesSection(issue: IssueCard): HTMLElement | null {
  const receive = canIssueReceiveSubIssues(issue.id);
  if (!receive.ok) return null;

  const children = listChildIssues(issue.id, listIssues());
  const done = children.filter((child) => child.status === 'done' || child.status === 'canceled');
  const summary: DetailRowSummaryPart[] =
    children.length === 0
      ? []
      : [
          { text: `${done.length}/${children.length}`, mono: true },
          ...(done.length === children.length
            ? [{ text: 'done', tone: 'success' as const }]
            : []),
        ];

  const sec = createDetailRow({
    key: 'sub-issues',
    icon: 'subIssues',
    label: 'Sub-issues',
    summary,
    expandable: children.length > 0,
    addLabel: 'Add a sub-issue',
    onAdd: (anchor) => {
      sec.expand();
      openIssuesContextMenu({
        anchor,
        restoreFocus: anchor,
        label: 'Add a sub-issue',
        items: subIssueAddMenuItems(issue.id),
      });
    },
  });

  if (children.length > 0) {
    const list = document.createElement('ul');
    list.className = 'issues-detail__sub-issues-list';
    for (const child of children) {
      list.appendChild(buildSubIssueRow(child));
    }
    sec.body.appendChild(list);
  }
  return sec.section;
}

/** One child row: open the card, or unparent it. */
function buildSubIssueRow(child: IssueCard): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'issues-detail__sub-issue';

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'issues-detail__sub-issue-open';
  openBtn.title = `Open ${child.id}`;

  const taxonomy = getIssuesTaxonomySync();
  openBtn.appendChild(
    createIssueTypeChip(
      child.type,
      taxonomy.types.find((entry) => entry.id === child.type),
    ),
  );

  const idEl = document.createElement('span');
  idEl.className = 'issues-detail__sub-issue-id';
  idEl.textContent = child.id;

  const titleEl = document.createElement('span');
  titleEl.className = 'issues-detail__sub-issue-title';
  titleEl.textContent = child.title.trim() || 'Untitled';

  const statusChip = createDetailStatusChip(child.status);
  statusChip.classList.add('issues-detail__sub-issue-status');

  openBtn.append(idEl, titleEl, statusChip);
  openBtn.addEventListener('click', () => {
    openIssueDetail(child.id);
    void import('./issues-page').then((m) => m.setIssuesRouteHash(`#/app/issues/${child.id}`));
  });

  li.append(
    openBtn,
    buildRowRemove(`Remove ${child.id} from parent`, () => unparentIssueFromParent(child.id)),
  );
  return li;
}

/** Linked sessions and boards, with a + menu for new or existing chats. */
function buildChatsSection(issue: IssueCard): HTMLElement {
  const stats = issueChatsSummary(issue);
  const summary: DetailRowSummaryPart[] =
    stats.total === 0
      ? []
      : [
          { text: String(stats.total), mono: true },
          ...(stats.running > 0
            ? [{ text: `${stats.running} running`, tone: 'accent' as const }]
            : []),
        ];

  const sec = createDetailRow({
    key: 'chats',
    icon: 'appChat',
    label: 'Chats',
    summary,
    expandable: stats.total > 0,
    addLabel: 'Add a chat',
    onAdd: (anchor) => {
      sec.expand();
      openIssuesContextMenu({
        anchor,
        restoreFocus: anchor,
        label: 'Add a chat',
        items: issueChatsMenuItems(issue),
      });
    },
  });
  fillIssueChatsSection(issue, sec.body);
  return sec.section;
}

/** Related issue chips with deep links to other cards. */
function buildRelatedIssuesSection(issue: IssueCard): HTMLElement | null {
  const refs = issue.issueRefs ?? [];
  if (refs.length === 0) return null;

  const sec = createDetailRow({
    key: 'related',
    icon: 'link',
    label: 'Related',
    summary: [{ text: String(refs.length), mono: true }],
    expandable: true,
  });
  const list = document.createElement('ul');
  list.className = 'issues-detail__related-list';
  for (const ref of refs) {
    list.appendChild(buildRelatedIssueChip(ref));
  }
  sec.body.appendChild(list);
  return sec.section;
}

/** One clickable related-issue chip. */
function buildRelatedIssueChip(ref: IssueIssueRef): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'issues-detail__related-chip';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'issues-detail__related-chip-btn';
  const target = findIssueById(ref.issueId);
  const kindLabel = ISSUE_RELATION_LABELS[ref.kind] ?? ref.kind;

  const kindEl = document.createElement('span');
  kindEl.className = 'issues-detail__related-kind';
  kindEl.textContent = kindLabel;

  const idEl = document.createElement('span');
  idEl.className = 'issues-detail__related-id';
  idEl.textContent = ref.issueId;

  btn.append(kindEl, idEl);
  const title = target?.title?.trim();
  if (title) {
    const titleEl = document.createElement('span');
    titleEl.className = 'issues-detail__related-title';
    titleEl.textContent = title;
    btn.appendChild(titleEl);
  }
  btn.title = `Open ${ref.issueId}`;
  btn.addEventListener('click', () => {
    openIssueDetail(ref.issueId);
    void import('./issues-page').then((m) => m.setIssuesRouteHash(`#/app/issues/${ref.issueId}`));
  });
  li.appendChild(btn);
  return li;
}

/** One git link chip row with optional Open on GitHub. */
function buildGitLinkRow(link: IssueGitLink): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'issues-detail__git-chip';

  const label = document.createElement('span');
  label.className = 'issues-detail__git-chip-label';
  const kindLabel =
    link.kind === 'github-issue' ? 'GH issue' : link.kind === 'pr' ? 'PR' : link.kind;
  label.textContent = link.title?.trim() || `${kindLabel}: ${link.ref}`;
  li.appendChild(label);

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'issues-btn issues-detail__git-open';
  openBtn.textContent = link.kind === 'commit' ? 'Open' : 'Open on GitHub';
  openBtn.addEventListener('click', () => {
    void (async () => {
      if (link.kind === 'commit') {
        await openIssueCommitInGitUi(link.ref, link.title);
        return;
      }
      const url = await resolveGitLinkOpenUrl(link);
      if (!url) {
        showIssuesToast('No web URL for this link', 'error');
        return;
      }
      openExternalGitUrl(url);
    })();
  });
  li.appendChild(openBtn);
  return li;
}

type GitUiAction = 'branch' | 'pr' | 'review' | 'link-commit' | 'link-url';

/** Persist error or toast success from a Git action result. */
function applyGitActionResult(
  issueId: string,
  result: { ok: boolean; message?: string; error?: string },
  fallbackOk: string,
): void {
  if (result.ok === false) {
    gitErrorByIssueId.set(issueId, result.error || 'Git action failed');
    return;
  }
  showIssuesToast(result.message || fallbackOk, 'success');
}

async function runGitAction(
  issueId: string,
  action: GitUiAction,
  input?: string,
): Promise<void> {
  if (gitBusyIds.has(issueId)) return;
  const issue = findIssueById(issueId);
  if (!issue) {
    gitErrorByIssueId.set(issueId, 'Issue not found');
    refreshIssueDetailIfOpen();
    return;
  }
  gitBusyIds.add(issueId);
  gitErrorByIssueId.delete(issueId);
  refreshIssueDetailIfOpen();
  try {
    if (action === 'branch') {
      const result = await createBranchFromIssue(issue);
      applyGitActionResult(issueId, result, 'Branch ready');
      return;
    }
    if (action === 'pr') {
      const result = await createPrFromIssue(issue);
      applyGitActionResult(issueId, result, 'PR created');
      return;
    }
    if (action === 'review') {
      const resolved = await resolveIssuePrNumber(issue);
      if (!resolved) {
        applyGitActionResult(issueId, { ok: false, error: 'No pull request to review' }, '');
        return;
      }
      const started = await startPrReview({
        cwd: issue.workspacePath || getWorkspacePath(),
        repo: resolved.repo,
        number: resolved.number,
        issueId: issue.id,
      });
      applyGitActionResult(
        issueId,
        started.ok
          ? { ok: true, message: `Reviewing #${resolved.number}` }
          : { ok: false, error: started.error },
        'Review started',
      );
      return;
    }
    if (action === 'link-commit') {
      const result = await linkCommitToIssue(issueId, input ?? '');
      applyGitActionResult(issueId, result, 'Commit linked');
      return;
    }
    const result = await linkGitHubUrlToIssue(issueId, input ?? '');
    applyGitActionResult(issueId, result, 'URL linked');
  } finally {
    gitBusyIds.delete(issueId);
    refreshIssueDetailIfOpen();
  }
}

// ── Workflow ─────────────────────────────────────────────────────────────────

/** Build the restrained workflow toolbar for the detail panel. */
function buildWorkflowToolbar(issue: IssueCard): HTMLElement {
  const row = document.createElement('div');
  row.className = 'issues-detail__workflow';
  row.setAttribute('role', 'toolbar');
  row.setAttribute('aria-label', 'Issue workflow');

  const busy = workflowBusyIds.has(issue.id) || expandingIds.has(issue.id);
  const workflowOk = canRunIssueWorkflow(issue);
  const activity = issueActivityChip(issue);
  const activityTarget = issueActivityTarget(issue);

  const primary = document.createElement('div');
  primary.className = 'issues-detail__workflow-primary';

  if (activity) {
    const chip = document.createElement(
      activityTarget ? 'button' : 'span',
    ) as HTMLButtonElement | HTMLSpanElement;
    chip.className = 'issues-detail__activity-chip';
    if (activityTarget) {
      chip.classList.add('issues-detail__activity-chip--interactive');
      if (chip instanceof HTMLButtonElement) {
        chip.type = 'button';
        chip.title =
          activityTarget.kind === 'board_chat'
            ? 'Open board chat'
            : 'View sub-agent chat';
        chip.addEventListener('click', () => {
          void openIssueActivity(issue).then((ok) => {
            if (!ok) showIssuesToast('Could not open activity', 'error');
          });
        });
      }
    }
    chip.appendChild(
      createIcon(activityTarget ? 'statusRunning' : 'statusPending', {
        size: 11,
        className: 'issues-detail__activity-chip-icon',
      }),
    );
    const activityText = document.createElement('span');
    activityText.textContent = activity;
    chip.appendChild(activityText);
    primary.appendChild(chip);
  }

  if (canExpandIssueWithAgent(issue)) {
    const busyExpand = expandingIds.has(issue.id);
    const expandBtn = createDetailTextButton({
      label: busyExpand ? 'Expanding…' : 'Expand with agent',
      icon: 'sparkles',
      primary: true,
      disabled: busyExpand,
      title: 'Research the workspace and fill this triage note with the issue-writer agent',
      onClick: () => {
        void startExpand(issue.id);
      },
    });
    primary.appendChild(expandBtn);
  }

  row.appendChild(primary);

  const secondary = document.createElement('div');
  secondary.className = 'issues-detail__workflow-secondary';

  const foregroundHints: Record<IssueForegroundChatMode, string> = {
    general: 'Triage and discuss with full tool access',
    build: 'Implement or iterate on a fix',
    plan: 'Interactive planning chat in Code',
    debug: 'Reproduce and narrow root cause',
  };

  const foregroundItems = ISSUE_FOREGROUND_CHAT_MODES.map((modeId) => ({
    id: modeId,
    label: getMode(modeId).label,
    hint: foregroundHints[modeId],
    disabled: !workflowOk || busy,
    onSelect: (ctx?: { trigger: HTMLButtonElement }) => {
      promptIssueChatRunTarget({
        issueId: issue.id,
        anchor: ctx?.trigger,
        onPick: (choice) =>
          void runWorkflowAction(issue.id, 'foreground', modeId, choice),
      });
    },
  }));

  secondary.appendChild(
    createIssuesWorkflowDropdown({
      label: 'Send to chat',
      ariaLabel: 'Send issue to chat — choose mode',
      icon: 'appChat',
      disabled: !workflowOk || busy,
      primary: true,
      items: foregroundItems,
    }),
  );

  const backgroundHints: Record<IssueBackgroundChatMode, string> = {
    debug: 'Debugger sub-agent investigates unattended',
    plan: 'Planner writes documentation/plans/issues/<id>.md',
  };

  const backgroundItems = ISSUE_BACKGROUND_CHAT_MODES.map((modeId) => ({
    id: modeId,
    label: getMode(modeId).label,
    hint: backgroundHints[modeId],
    disabled:
      !workflowOk ||
      busy ||
      (modeId === 'debug' && !canInvestigateIssue(issue)),
    onSelect: (ctx?: { trigger: HTMLButtonElement }) => {
      promptIssueChatRunTarget({
        issueId: issue.id,
        anchor: ctx?.trigger,
        onPick: (choice) =>
          void runWorkflowAction(issue.id, 'background', modeId, choice),
      });
    },
  }));

  secondary.appendChild(
    createIssuesWorkflowDropdown({
      label: 'Send to background',
      ariaLabel: 'Send issue to background chat — choose mode',
      icon: 'appAgentActivity',
      disabled: !workflowOk || busy,
      items: backgroundItems,
    }),
  );

  row.appendChild(secondary);
  return row;
}

type WorkflowAction =
  | { kind: 'foreground'; modeId: IssueForegroundChatMode }
  | { kind: 'background'; modeId: IssueBackgroundChatMode }
  | { kind: 'board' };

async function runWorkflowAction(
  issueId: string,
  action: WorkflowAction['kind'],
  modeId?: IssueForegroundChatMode | IssueBackgroundChatMode,
  runTarget?: ChatRunTargetChoice,
): Promise<void> {
  if (workflowBusyIds.has(issueId)) return;
  workflowBusyIds.add(issueId);
  refreshIssueDetailIfOpen();
  try {
    if (action === 'foreground' && modeId) {
      const result = await runIssueForegroundChat(
        issueId,
        modeId as IssueForegroundChatMode,
        runTarget,
      );
      if (!result.ok) {
        showIssuesToast(result.error || 'Send to chat failed', 'error');
        return;
      }
      if (modeId === 'plan') {
        showIssuesToast(
          result.planPath ? `Plan chat · ${result.planPath}` : 'Plan chat opened',
          'success',
        );
      } else {
        showIssuesToast(`${getMode(modeId as IssueForegroundChatMode).label} chat opened`, 'success');
      }
      return;
    }
    if (action === 'background' && modeId) {
      const bgMode = modeId as IssueBackgroundChatMode;
      const result = await runIssueBackgroundChat(issueId, bgMode, runTarget);
      if (!result.ok) {
        showIssuesToast(result.error || 'Send to background failed', 'error');
        return;
      }
      if (bgMode === 'debug') {
        showIssuesToast('Investigation started', 'success');
      } else {
        showIssuesToast(result.planPath ? `Plan: ${result.planPath}` : 'Plan ready', 'success');
      }
      return;
    }
    const result = await runIssueSendToBoard(issueId);
    if (!result.ok) showIssuesToast(result.error || 'Send to board failed', 'error');
    else showIssuesToast('Board started', 'success');
  } finally {
    workflowBusyIds.delete(issueId);
    refreshIssueDetailIfOpen();
  }
}

async function startExpand(issueId: string): Promise<void> {
  if (expandingIds.has(issueId)) return;
  expandingIds.add(issueId);
  refreshIssueDetailIfOpen();
  try {
    const result = await runIssueExpandWithAgent(issueId);
    if (!result.ok) {
      showIssuesToast(result.error || 'Expand failed', 'error');
    } else {
      showIssuesToast('Issue expanded', 'success');
    }
  } finally {
    expandingIds.delete(issueId);
    refreshIssueDetailIfOpen();
  }
}

/** Expand with agent from list/board row actions (shared with detail). */
export async function expandIssueFromUi(issueId: string): Promise<void> {
  await startExpand(issueId);
}
