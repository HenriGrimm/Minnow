import { createGitChangeSelection } from './git-change-selection';
import { createCommitGenerationStatus } from './commit-generation-status';
import { gitStatusRenderKey } from './git-status-render-key';
import { getWorkspacePath } from '../state/workspace';
import { pushWithPublishPrompt } from './git-publish-push';
import { appChoice, appConfirm } from './app-dialog';
import { openContextMenu } from './context-menu';
import {
  gitCommit,
  gitDiff,
  gitDiscard,
  gitStage,
  gitStageAll,
  gitStatus,
  gitUnstage,
  type GitFileEntry,
  type GitOpResult,
} from '../state/git-api';
import { fetchGitChangeReview, fetchGitChangeSummary, fetchGitCommitMessage, type GitCommitMessagePromptInput } from './git-commit-message-client';
import { parseUnifiedPatchToDiffLines } from './git-patch-parse';
import { renderUnifiedPromptDiff } from './prompt-diff-unified';
import { renderSideBySidePatchDiff } from './side-by-side-patch-diff';
import { paintGraphiteFileDiff } from './graphite-file-diff';
import { gitUiCtx, inferGitUiLabel, runGitUiOp, showGitUiFailure } from './git-ui-op';
import { showToast } from './toast';
import { createFileTypeIconElement } from './file-type-icons';
import {
  button,
  diffStat,
  el,
  emptyState,
  errorStrip,
  listNavigator,
  pathLabel,
  skeletonRows,
  type SccContext,
  type SccView,
} from './scc-shared';

/** Which bucket a row came from — drives the stage/unstage direction. */
type Bucket = 'staged' | 'unstaged' | 'untracked';

interface Selection {
  path: string;
  bucket: Bucket;
}

// ── Status ───────────────────────────────────────────────────────────────────

const STATUS_TITLE: Record<string, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  U: 'Conflicted',
  '?': 'Untracked',
};

function statusLetter(status: string): string {
  if (status === '?') return '?';
  const first = status.trim().slice(0, 1).toUpperCase();
  return first || 'M';
}

// ── Changes view ─────────────────────────────────────────────────────────────

export function createChangesView(ctx: SccContext): SccView {
  const root = el('div', 'scc-changes');

  const listCol = el('div', 'scc-changes__list-col');
  const listToolbar = el('div', 'scc-changes__list-toolbar');
  const listHeading = el('h2', 'scc-changes__heading', 'Changes');
  const listCount = el('span');
  listCount.dataset.count = '';
  listHeading.append(listCount);
  const listScroll = el('div', 'scc-changes__list');
  const commitBox = el('form', 'scc-commit');

  const diffCol = el('div', 'scc-changes__diff-col');
  const diffHead = el('div', 'scc-changes__diff-head');
  const diffBody = el('div', 'scc-changes__diff-body');
  diffCol.append(diffHead, diffBody);

  listCol.append(listToolbar, listScroll, commitBox);
  root.append(listCol, diffCol);

  let selection: Selection | null = null;
  let busy = false;
  let destroyed = false;
  let generateAbort: AbortController | null = null;
  let reviewAbort: AbortController | null = null;
  let diffLayout: 'unified' | 'split' = 'unified';
  let showInitialDiff = true;
  let lastCounts = { staged: 0, unstaged: 0, untracked: 0 };
  let listKey: string | null = null;
  let diffKey: string | null = null;
  let refreshSequence = 0;
  let diffSequence = 0;
  let renderedCwd: string | undefined;

  const effectiveCwd = (): string => ctx.getCwd() ?? getWorkspacePath().trim();
  const changesSelection = createGitChangeSelection({
    root: listScroll,
    getCwd: effectiveCwd,
    run: (fn, message) => run(fn, message),
    onOpen: (entry) => void select(entry.path, entry.bucket === 'conflicted' ? 'unstaged' : entry.bucket),
  });

  const messageInput = el('textarea', 'scc-commit__input');
  messageInput.placeholder = 'Commit message';
  messageInput.rows = 2;
  messageInput.setAttribute('aria-label', 'Commit message');
  messageInput.addEventListener('input', syncCommitButtons);
  messageInput.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void runCommit(false);
    }
  });

  const generateBtn = button({
    icon: 'sparkles',
    title: 'Write a commit message from the diff',
    variant: 'ghost',
    onClick: () => void generateMessage(),
  });

  const commitBtn = button({
    label: 'Commit',
    variant: 'primary',
    onClick: () => void runCommit(false),
  });

  const commitPushBtn = button({
    label: 'Commit & push',
    onClick: () => void runCommit(true),
  });

  const commitHint = el('span', 'scc-commit__hint');

  const commitActions = el('div', 'scc-commit__actions');
  const reviewBtn = button({ icon: 'eye', label: 'Review', variant: 'ghost', onClick: () => void reviewChanges() });
  commitActions.append(reviewBtn, commitHint, commitBtn, commitPushBtn);
  const generationStatus = createCommitGenerationStatus();
  const messageField = el('div', 'scc-commit__field');
  messageField.append(messageInput, generateBtn);
  commitBox.append(messageField, generationStatus, commitActions);
  commitBox.addEventListener('submit', (event) => event.preventDefault());

  const stageAllBtn = button({
    label: 'Stage all',
    onClick: () =>
      void run(() => gitStageAll(ctx.getCwd()), 'Staged every change'),
  });

  const unstageAllBtn = button({
    label: 'Unstage all',
    variant: 'ghost',
    className: 'scc-changes__legacy-action',
    onClick: () => void unstageAll(),
  });

  const discardAllBtn = button({
    label: 'Discard all',
    variant: 'ghost',
    className: 'scc-btn--danger-hover scc-changes__legacy-action',
    onClick: () => void discardAll(),
  });

  const listMore = button({
    icon: 'more',
    title: 'Working tree actions',
    variant: 'ghost',
    className: 'scc-changes__graphite-action',
    onClick: () => openContextMenu({ anchor: listMore, label: 'Working tree actions', items: [
      { id: 'unstage-all', label: 'Unstage all', disabled: unstageAllBtn.disabled, onSelect: () => void unstageAll() },
      { id: 'discard-all', label: 'Discard all', danger: true, disabled: discardAllBtn.disabled, onSelect: () => void discardAll() },
    ] }),
  });
  listMore.setAttribute('aria-haspopup', 'menu');
  listToolbar.append(listHeading, stageAllBtn, unstageAllBtn, discardAllBtn, listMore);

  async function refresh(): Promise<void> {
    if (destroyed) return;
    const sequence = ++refreshSequence;
    const cwd = effectiveCwd();

    if (renderedCwd !== cwd) {
      renderedCwd = cwd;
      selection = null;
      showInitialDiff = true;
      changesSelection.clear();
      listKey = null;
      diffKey = null;
      ++diffSequence;
    }

    if (!listScroll.firstChild) listScroll.appendChild(skeletonRows(7));

    const graphite = document.documentElement.classList.contains('mn-graphite-apps');
    const status = graphite ? await gitStatus(cwd || undefined, undefined, { lineStats: true }) : await gitStatus(cwd || undefined);
    if (destroyed || sequence !== refreshSequence || cwd !== effectiveCwd()) return;

    if (!status.ok) {
      changesSelection.clear();
      listKey = null;
      listScroll.replaceChildren(errorStrip(status.error ?? 'Could not read git status', () => void refresh()));
      ctx.setBadge('changes', null);
      return;
    }

    const staged = status.staged ?? [];
    const unstaged = status.unstaged ?? [];
    const untracked = status.untracked ?? [];
    lastCounts = { staged: staged.length, unstaged: unstaged.length, untracked: untracked.length };

    const total = staged.length + unstaged.length + untracked.length;
    ctx.setBadge('changes', total > 0 ? { kind: 'count', value: total } : null);
    listCount.textContent = String(total);

    if (showInitialDiff && total && graphite) {
      showInitialDiff = false;
      if (staged[0]) selection = { path: staged[0].path, bucket: 'staged' };
      else if (unstaged[0]) selection = { path: unstaged[0].path, bucket: 'unstaged' };
      else if (untracked[0]) selection = { path: untracked[0].path, bucket: 'untracked' };
    }

    if (selection && !status[selection.bucket]?.some((entry) => entry.path === selection?.path)) {
      selection = null;
    }
    const nextListKey = gitStatusRenderKey(cwd, status);
    if (listKey !== nextListKey) {
      renderList(staged, unstaged, untracked, graphite);
      listKey = nextListKey;
    }
    syncCommitButtons();
    await renderDiff();
  }

  function renderList(
    staged: GitFileEntry[],
    unstaged: GitFileEntry[],
    untracked: GitFileEntry[],
    graphite: boolean,
  ): void {
    const total = staged.length + unstaged.length + untracked.length;
    stageAllBtn.disabled = unstaged.length + untracked.length === 0;
    unstageAllBtn.disabled = staged.length === 0;
    discardAllBtn.disabled = unstaged.length + untracked.length === 0;

    changesSelection.setEntries([
      ...staged.map((entry) => ({ path: entry.path, bucket: 'staged' as const })),
      ...unstaged.map((entry) => ({ path: entry.path, bucket: 'unstaged' as const })),
      ...untracked.map((entry) => ({ path: entry.path, bucket: 'untracked' as const })),
    ]);
    if (total === 0) {
      listScroll.replaceChildren(
        emptyState({
          icon: 'statusPass',
          title: 'Working tree clean',
          body: 'Nothing to commit. Changes appear here as you edit, and while agents work.',
        }),
      );
      return;
    }

    const frag = document.createDocumentFragment();
    if (staged.length) frag.appendChild(buildGroup('Staged', staged, 'staged', graphite));
    if (unstaged.length || (graphite && untracked.length)) {
      frag.appendChild(buildGroup('Changes', unstaged, 'unstaged', graphite, graphite ? untracked : []));
    }
    if (!graphite && untracked.length) frag.appendChild(buildGroup('Untracked', untracked, 'untracked', graphite));
    listScroll.replaceChildren(frag);
  }

  function buildGroup(title: string, files: GitFileEntry[], bucket: Bucket, graphite: boolean, extraUntracked: GitFileEntry[] = []): HTMLElement {
    const group = el('section', 'scc-filegroup');
    const head = el('div', 'scc-filegroup__head');
    head.append(
      el('span', 'scc-filegroup__title', title),
      el('span', 'scc-filegroup__count', String(files.length + extraUntracked.length)),
    );
    group.appendChild(head);

    for (const entry of files) {
      group.appendChild(buildRow(entry, bucket, graphite));
    }
    for (const entry of extraUntracked) group.appendChild(buildRow(entry, 'untracked', graphite));
    return group;
  }

  function buildRow(entry: GitFileEntry, bucket: Bucket, graphite: boolean): HTMLElement {
    const row = el('div', 'scc-filerow');
    row.tabIndex = 0;
    row.dataset.path = entry.path;
    row.dataset.bucket = bucket;
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', `${entry.path}, ${bucket}`);

    const letter = graphite && bucket === 'untracked' ? 'U' : statusLetter(entry.status);
    const badge = el('span', `scc-filerow__status scc-filerow__status--${letter.toLowerCase()}`, letter);
    badge.title = bucket === 'untracked' ? 'Untracked' : STATUS_TITLE[letter] ?? 'Changed';
    badge.setAttribute('aria-label', badge.title);

    const actions = el('div', 'scc-filerow__actions');
    const staged = bucket === 'staged';

    const toggleBtn = button({
      icon: staged ? 'clear' : 'plus',
      title: staged ? 'Unstage' : 'Stage',
      variant: 'ghost',
      onClick: (event) => {
        event.stopPropagation();
        void toggleStage(entry.path, bucket);
      },
    });

    const discardBtn = button({
      icon: 'undo',
      title: bucket === 'untracked' ? 'Delete file' : 'Discard changes',
      variant: 'ghost',
      className: 'scc-btn--danger-hover',
      onClick: (event) => {
        event.stopPropagation();
        void changesSelection.discard([{ path: entry.path, bucket }]);
      },
    });

    actions.append(discardBtn, toggleBtn);
    const path = pathLabel(entry.path);
    if (graphite) {
      const icon = createFileTypeIconElement(entry.path);
      icon.classList.add('scc-filerow__file-icon');
      path.prepend(icon);
    }
    row.append(badge, path);
    if (graphite && ((entry.additions ?? 0) > 0 || (entry.deletions ?? 0) > 0)) {
      const counts = diffStat(entry.additions ?? 0, entry.deletions ?? 0);
      counts.classList.add('scc-filerow__counts');
      row.append(counts);
    }
    row.append(actions);

    changesSelection.bindRow(row, { path: entry.path, bucket }, actions);
    row.addEventListener('dblclick', (event) => {
      if (!actions.contains(event.target as Node) && !event.shiftKey && !event.ctrlKey && !event.metaKey) void toggleStage(entry.path, bucket);
    });

    return row;
  }

  async function select(path: string, bucket: Bucket): Promise<void> {
    if (selection?.path === path && selection.bucket === bucket) return;
    selection = { path, bucket };
    await renderDiff();
  }

  async function renderDiff(): Promise<void> {
    const sequence = ++diffSequence;
    const cwd = effectiveCwd();
    for (const row of listScroll.querySelectorAll<HTMLElement>('.scc-filerow')) {
      const current = row.dataset.path === selection?.path && row.dataset.bucket === selection?.bucket;
      row.classList.toggle('is-diff-current', current);
      if (current) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
    }
    if (!selection) {
      if (diffKey === 'empty') return;
      diffKey = 'empty';
      diffHead.replaceChildren();
      diffBody.replaceChildren(
        emptyState({
          icon: 'fileText',
          title: 'Select a file',
          body: 'Its diff shows here. Shift-click for a range; Command or Control-click to select multiple changes.',
        }),
      );
      return;
    }

    const { path, bucket } = selection;
    const result = await gitDiff({
      path,
      cached: bucket === 'staged',
      cwd: cwd || undefined,
    });
    if (destroyed || sequence !== diffSequence || cwd !== effectiveCwd()
      || selection?.path !== path || selection.bucket !== bucket) return;

    const graphite = document.documentElement.classList.contains('mn-graphite-apps');
    const nextDiffKey = JSON.stringify([cwd, path, bucket, graphite, result.ok, result.patch ?? '', result.error ?? '']);
    // Status M can remain unchanged while the file is edited: fetch every time,
    // but retain the DOM (and accessible text ranges) when the patch is identical.
    if (diffKey === nextDiffKey) return;
    diffKey = nextDiffKey;

    diffHead.replaceChildren();
    const label = el('div', 'scc-changes__diff-title');
    label.append(pathLabel(path));
    diffHead.append(
      label,
      el(
        'span',
        'scc-changes__diff-scope',
        bucket === 'staged' ? 'Staged' : bucket === 'untracked' ? 'New file' : 'Working tree',
      ),
    );

    if (!result.ok) {
      diffBody.replaceChildren(errorStrip(result.error ?? 'Could not load the diff'));
      return;
    }

    const lines = parseUnifiedPatchToDiffLines(result.patch ?? '');
    if (lines.length === 0) {
      diffBody.replaceChildren(
        emptyState({
          title: bucket === 'untracked' ? 'New file, not yet tracked' : 'No textual changes',
          body:
            bucket === 'untracked'
              ? 'Stage it to see its contents as a diff.'
              : 'This file changed in mode or is binary.',
        }),
      );
      return;
    }

    const added = lines.filter((line) => line.type === 'add').length;
    const removed = lines.filter((line) => line.type === 'remove').length;
    diffHead.appendChild(diffStat(added, removed));

    const patch = result.patch ?? '';
    if (graphite) {
      const options = el('div', 'scc-changes__diff-options');
      options.setAttribute('role', 'group');
      options.setAttribute('aria-label', 'Diff layout');
      for (const [mode, label] of [['unified', 'Unified'], ['split', 'Split']] as const) {
        const control = button({ label, variant: 'ghost', onClick: () => {
          if (diffLayout === mode) return;
          diffLayout = mode;
          for (const btn of options.querySelectorAll('button')) btn.setAttribute('aria-pressed', String(btn === control));
          paintDiff();
        } });
        control.setAttribute('aria-pressed', String(diffLayout === mode));
        options.append(control);
      }
      const summarize = button({ icon: 'sparkles', label: 'Summarize', variant: 'ghost', onClick: () => {
        showDiffAnalysis('summary', { changedPaths: [path], patch, scope: bucket === 'staged' ? 'staged' : 'working-tree' });
      } });
      const actions = el('div', 'scc-changes__diff-actions');
      actions.append(options, summarize);
      diffHead.append(actions);
    }
    paintDiff();

    function paintDiff(): void {
      const mount = el('div', 'scc-diff');
      diffBody.replaceChildren(mount);
      if (graphite && diffLayout === 'split') renderSideBySidePatchDiff(mount, patch);
      else if (graphite) {
        mount.classList.add('graphite-git-patch');
        paintGraphiteFileDiff(mount, patch);
      } else renderUnifiedPromptDiff(mount, lines, { lineNumbers: true });
    }
  }

  async function reviewChanges(): Promise<void> {
    if (reviewAbort || destroyed) return;
    const cwd = effectiveCwd();
    const status = await gitStatus(cwd || undefined);
    if (destroyed || cwd !== effectiveCwd() || reviewAbort) return;
    if (!status.ok) {
      showToast(status.error ?? 'Could not read Git status.', 'error');
      return;
    }
    const staged = status.staged ?? [];
    const cached = staged.length > 0;
    const files = cached ? staged : [...status.unstaged ?? [], ...status.untracked ?? []];
    const diff = await gitDiff({ ...(cached ? { cached } : { workingTree: true }), cwd: cwd || undefined });
    if (destroyed || cwd !== effectiveCwd() || reviewAbort) return;
    if (!diff.ok || !diff.patch?.trim()) {
      showToast(diff.error ?? 'No textual changes to review.', 'error');
      return;
    }
    showDiffAnalysis('review', { changedPaths: files.map(({ path }) => path), patch: diff.patch, scope: cached ? 'staged' : 'working-tree' });
  }

  function showDiffAnalysis(purpose: 'review' | 'summary', input: GitCommitMessagePromptInput): void {
    if (reviewAbort || destroyed) return;
    const controller = new AbortController();
    reviewAbort = controller;
    const review = purpose === 'review';
    const title = review ? 'Commit review' : 'Change summary';
    const body = el('p', 'scc-changes__summary', review ? 'Reviewing changes…' : 'Summarizing changes…');
    void appChoice({ title, message: '', body, buttons: [{ id: 'close', label: 'Close' }], cancelId: 'close' })
      .finally(() => {
        controller.abort();
        if (reviewAbort === controller) reviewAbort = null;
      });
    const analyze = review ? fetchGitChangeReview : fetchGitChangeSummary;
    void analyze({
      ...input,
      signal: controller.signal,
      onPartial: (text) => { if (!controller.signal.aborted) body.textContent = text; },
    }).then(({ text, error }) => {
      if (!controller.signal.aborted) {
        body.setAttribute('role', 'status');
        body.textContent = text || error || 'The model returned an empty response.';
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        body.setAttribute('role', 'status');
        body.textContent = error instanceof Error ? error.message : 'The model request failed.';
      }
    });
  }

  async function run(
    fn: () => Promise<GitOpResult>,
    successMessage?: string,
    label?: string,
  ): Promise<boolean> {
    if (busy) return false;
    busy = true;
    try {
      const result = await runGitUiOp(fn, {
        label: label ?? inferGitUiLabel(successMessage),
        successMessage,
        ctx: gitUiCtx(ctx.getCwd(), ctx.getBranch()),
      });
      if (!result.ok) return false;
      await ctx.refreshAll();
      return true;
    } finally {
      busy = false;
    }
  }

  async function toggleStage(path: string, bucket: Bucket): Promise<void> {
    const cwd = ctx.getCwd();
    const staged = bucket === 'staged';
    if (selection?.path === path) {
      selection = { path, bucket: staged ? 'unstaged' : 'staged' };
    }
    await run(() =>
      staged ? gitUnstage({ paths: [path], cwd }) : gitStage({ paths: [path], cwd }),
    );
  }

  async function unstageAll(): Promise<void> {
    const status = await gitStatus(ctx.getCwd());
    const paths = (status.staged ?? []).map((entry) => entry.path);
    if (paths.length === 0) return;
    await run(() => gitUnstage({ paths, cwd: ctx.getCwd() }), 'Unstaged everything');
  }

  async function discardAll(): Promise<void> {
    const cwd = effectiveCwd();
    const status = await gitStatus(cwd);
    if (destroyed || cwd !== effectiveCwd() || !status.ok) return;
    const paths = [...(status.unstaged ?? []), ...(status.untracked ?? [])].map((entry) => entry.path);
    if (paths.length === 0) return;

    const confirmed = await appConfirm(
      `Discard changes to ${paths.length} file${paths.length === 1 ? '' : 's'}? This cannot be undone.`,
      { title: 'Discard all changes', confirmLabel: 'Discard all', danger: true },
    );
    if (!confirmed || destroyed || cwd !== effectiveCwd()) return;

    selection = null;
    await run(() => gitDiscard({ paths, cwd }), 'Discarded working tree changes');
  }

  function syncCommitButtons(): void {
    const hasMessage = messageInput.value.trim().length > 0;
    const hasStaged = lastCounts.staged > 0;
    const hasAny = hasStaged || lastCounts.unstaged > 0 || lastCounts.untracked > 0;

    commitBtn.disabled = !!generateAbort || !hasMessage || !hasAny;
    commitPushBtn.disabled = !!generateAbort || !hasMessage || !hasAny;
    generateBtn.disabled = !!generateAbort || !hasAny;
    reviewBtn.disabled = !hasAny;

    commitHint.textContent = !hasAny
      ? ''
      : hasStaged
        ? `${lastCounts.staged} staged`
        : 'Commits everything';
  }

  async function runCommit(andPush: boolean): Promise<void> {
    const message = messageInput.value.trim();
    if (!message || busy || generateAbort) return;

    if (lastCounts.staged === 0) {
      const staged = await runGitUiOp(() => gitStageAll(ctx.getCwd()), {
        label: 'Staging…',
        ctx: gitUiCtx(ctx.getCwd(), ctx.getBranch()),
        skipSuccessToast: true,
      });
      if (!staged.ok) return;
    }

    setCommitBusy(true, andPush ? 'Committing…' : 'Committing…');
    try {
      const committed = await run(
        () => gitCommit({ message, cwd: ctx.getCwd() }),
        andPush ? undefined : 'Committed',
        'Committing…',
      );
      if (!committed) return;

      messageInput.value = '';
      selection = null;

      if (!andPush) {
        return;
      }

      setCommitBusy(true, 'Pushing…');
      await run(() => pushWithPublishPrompt(ctx.getCwd()), 'Committed and pushed', 'Pushing…');
    } finally {
      setCommitBusy(false);
      syncCommitButtons();
    }
  }

  function setCommitBusy(active: boolean, label?: string): void {
    commitBox.classList.toggle('is-busy', active);
    messageInput.disabled = active;
    commitBtn.disabled = active;
    commitPushBtn.disabled = active;
    generateBtn.disabled = active;
    if (active && label) commitHint.textContent = label;
  }

  async function generateMessage(): Promise<void> {
    if (generateAbort || destroyed) return;
    const controller = new AbortController();
    generateAbort = controller;
    generationStatus.hidden = false;
    generateBtn.setAttribute('aria-busy', 'true');
    syncCommitButtons();

    try {
      const cwd = ctx.getCwd();
      const status = await gitStatus(cwd);
      if (!status.ok) {
        showGitUiFailure(status.error ?? 'Could not read git status', {
          chatKind: 'generic',
          ctx: gitUiCtx(cwd, ctx.getBranch()),
        });
        return;
      }

      const staged = status.staged ?? [];
      const unstaged = status.unstaged ?? [];
      const untracked = status.untracked ?? [];
      if (staged.length + unstaged.length + untracked.length === 0) {
        showToast('No changes to describe', 'error');
        return;
      }

      const useStagedOnly = staged.length > 0;
      const diff = useStagedOnly
        ? await gitDiff({ cached: true, cwd })
        : await gitDiff({ workingTree: true, cwd });

      if (!diff.ok || !diff.patch?.trim()) {
        showGitUiFailure(diff.error ?? 'Could not read the diff', {
          chatKind: 'generic',
          ctx: gitUiCtx(cwd, ctx.getBranch()),
        });
        return;
      }

      if (controller.signal.aborted || destroyed) return;
      const result = await fetchGitCommitMessage({
        changedPaths: useStagedOnly
          ? staged.map((file) => file.path)
          : [...staged, ...unstaged, ...untracked].map((file) => file.path),
        excludedPaths: useStagedOnly ? [...unstaged, ...untracked].map((f) => f.path) : [],
        scope: useStagedOnly ? 'staged' : 'working-tree',
        patch: diff.patch,
        signal: controller.signal,
        onPartial: (text) => {
          if (!controller.signal.aborted && !destroyed) messageInput.value = text;
        },
      });

      if (controller.signal.aborted || destroyed) return;
      if (result.error) {
        showToast(result.error, 'error');
        return;
      }
      if (result.text) {
        messageInput.value = result.text;
        messageInput.focus();
        messageInput.setSelectionRange(result.text.length, result.text.length);
      }
    } catch (error) {
      if (!controller.signal.aborted && !destroyed) {
        showToast(error instanceof Error ? error.message : 'Could not generate commit message', 'error');
      }
    } finally {
      generationStatus.hidden = true;
      if (generateAbort === controller) generateAbort = null;
      generateBtn.removeAttribute('aria-busy');
      syncCommitButtons();
    }
  }

  const navigate = listNavigator({
    getRows: () => [...listScroll.querySelectorAll<HTMLElement>('.scc-filerow')],
  });

  function onKey(event: KeyboardEvent): boolean {
    if (event.defaultPrevented) return true;
    const target = event.target;
    const inField = target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement;

    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void runCommit(false);
      return true;
    }

    if (inField) return false;
    if (changesSelection.onKey(event)) return true;
    if (target instanceof Element && target.closest('button, a, select')) return false;

    if (event.key === ' ' && selection) {
      event.preventDefault();
      void toggleStage(selection.path, selection.bucket);
      return true;
    }

    return navigate(event);
  }

  void refresh();

  return {
    root,
    refresh,
    onKey,
    activate: () => {
      const first = listScroll.querySelector<HTMLElement>('.scc-filerow');
      if (!selection && first) { first.click(); first.focus(); }
    },
    destroy: () => {
      destroyed = true;
      changesSelection.destroy();
      generateAbort?.abort();
      generateAbort = null;
      reviewAbort?.abort();
      reviewAbort = null;
      root.remove();
    },
  };
}

// ── Focus ────────────────────────────────────────────────────────────────────

/** Focus the commit message box if the Changes view is mounted (palette action). */
export function focusCommitMessage(root: HTMLElement): void {
  root.querySelector<HTMLTextAreaElement>('.scc-commit__input')?.focus();
}
