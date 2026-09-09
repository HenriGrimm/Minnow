import { appConfirm } from './app-dialog';
import {
  gitCommit,
  gitDiff,
  gitDiscard,
  gitPush,
  gitStage,
  gitStageAll,
  gitStatus,
  gitUnstage,
  type GitFileEntry,
  type GitOpResult,
} from '../state/git-api';
import { fetchGitCommitMessage } from './git-commit-message-client';
import { parseUnifiedPatchToDiffLines } from './git-patch-parse';
import { renderUnifiedPromptDiff } from './prompt-diff-unified';
import { gitUiCtx, inferGitUiLabel, runGitUiOp, showGitUiFailure } from './git-ui-op';
import { showToast } from './toast';
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
  let lastCounts = { staged: 0, unstaged: 0, untracked: 0 };

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
  commitActions.append(generateBtn, commitHint, commitPushBtn, commitBtn);
  commitBox.append(messageInput, commitActions);
  commitBox.addEventListener('submit', (event) => event.preventDefault());

  const stageAllBtn = button({
    label: 'Stage all',
    onClick: () =>
      void run(() => gitStageAll(ctx.getCwd()), 'Staged every change'),
  });

  const unstageAllBtn = button({
    label: 'Unstage all',
    variant: 'ghost',
    onClick: () => void unstageAll(),
  });

  const discardAllBtn = button({
    label: 'Discard all',
    variant: 'ghost',
    className: 'scc-btn--danger-hover',
    onClick: () => void discardAll(),
  });

  listToolbar.append(stageAllBtn, unstageAllBtn, discardAllBtn);

  async function refresh(): Promise<void> {
    if (destroyed) return;

    if (!listScroll.firstChild) listScroll.appendChild(skeletonRows(7));

    const status = await gitStatus(ctx.getCwd());
    if (destroyed) return;

    if (!status.ok) {
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

    renderList(staged, unstaged, untracked);
    syncCommitButtons();

    if (selection && !hasPath(selection.path, staged, unstaged, untracked)) {
      selection = null;
    }
    await renderDiff();
  }

  function hasPath(path: string, ...buckets: GitFileEntry[][]): boolean {
    return buckets.some((bucket) => bucket.some((entry) => entry.path === path));
  }

  function renderList(
    staged: GitFileEntry[],
    unstaged: GitFileEntry[],
    untracked: GitFileEntry[],
  ): void {
    const total = staged.length + unstaged.length + untracked.length;
    stageAllBtn.disabled = unstaged.length + untracked.length === 0;
    unstageAllBtn.disabled = staged.length === 0;
    discardAllBtn.disabled = unstaged.length === 0;

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
    if (staged.length) frag.appendChild(buildGroup('Staged', staged, 'staged'));
    if (unstaged.length) frag.appendChild(buildGroup('Changes', unstaged, 'unstaged'));
    if (untracked.length) frag.appendChild(buildGroup('Untracked', untracked, 'untracked'));
    listScroll.replaceChildren(frag);
  }

  function buildGroup(title: string, files: GitFileEntry[], bucket: Bucket): HTMLElement {
    const group = el('section', 'scc-filegroup');
    const head = el('div', 'scc-filegroup__head');
    head.append(
      el('span', 'scc-filegroup__title', title),
      el('span', 'scc-filegroup__count', String(files.length)),
    );
    group.appendChild(head);

    for (const entry of files) {
      group.appendChild(buildRow(entry, bucket));
    }
    return group;
  }

  function buildRow(entry: GitFileEntry, bucket: Bucket): HTMLElement {
    const row = el('div', 'scc-filerow');
    row.tabIndex = 0;
    row.dataset.path = entry.path;
    row.dataset.bucket = bucket;
    row.setAttribute('role', 'button');

    const letter = statusLetter(entry.status);
    const badge = el('span', `scc-filerow__status scc-filerow__status--${letter.toLowerCase()}`, letter);
    badge.title = STATUS_TITLE[letter] ?? 'Changed';
    badge.setAttribute('aria-label', badge.title);

    if (selection?.path === entry.path && selection.bucket === bucket) {
      row.classList.add('is-selected');
    }

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
        void discardOne(entry.path);
      },
    });

    actions.append(discardBtn, toggleBtn);
    row.append(badge, pathLabel(entry.path), actions);

    row.addEventListener('click', () => void select(entry.path, bucket));
    row.addEventListener('focus', () => void select(entry.path, bucket));
    row.addEventListener('dblclick', () => void toggleStage(entry.path, bucket));

    return row;
  }

  async function select(path: string, bucket: Bucket): Promise<void> {
    if (selection?.path === path && selection.bucket === bucket) return;
    selection = { path, bucket };
    for (const row of listScroll.querySelectorAll('.scc-filerow')) {
      row.classList.toggle(
        'is-selected',
        (row as HTMLElement).dataset.path === path &&
          (row as HTMLElement).dataset.bucket === bucket,
      );
    }
    await renderDiff();
  }

  async function renderDiff(): Promise<void> {
    if (!selection) {
      diffHead.replaceChildren();
      diffBody.replaceChildren(
        emptyState({
          icon: 'fileText',
          title: 'Select a file',
          body: 'Its diff shows here. Space stages or unstages the highlighted file.',
        }),
      );
      return;
    }

    const { path, bucket } = selection;
    const result = await gitDiff({
      path,
      cached: bucket === 'staged',
      cwd: ctx.getCwd(),
    });
    if (destroyed || selection?.path !== path) return;

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

    const mount = el('div', 'scc-diff');
    diffBody.replaceChildren(mount);
    renderUnifiedPromptDiff(mount, lines, { lineNumbers: true });
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

  async function discardOne(path: string): Promise<void> {
    const confirmed = await appConfirm(`Discard changes to ${path}?`, {
      title: 'Discard changes',
      confirmLabel: 'Discard',
      danger: true,
    });
    if (!confirmed) return;
    if (selection?.path === path) selection = null;
    await run(() => gitDiscard({ paths: [path], cwd: ctx.getCwd() }), `Discarded ${path}`);
  }

  async function discardAll(): Promise<void> {
    const status = await gitStatus(ctx.getCwd());
    const paths = (status.unstaged ?? []).map((entry) => entry.path);
    if (paths.length === 0) return;

    const confirmed = await appConfirm(
      `Discard changes to ${paths.length} file${paths.length === 1 ? '' : 's'}? This cannot be undone.`,
      { title: 'Discard all changes', confirmLabel: 'Discard all', danger: true },
    );
    if (!confirmed) return;

    selection = null;
    await run(() => gitDiscard({ paths, cwd: ctx.getCwd() }), 'Discarded working tree changes');
  }

  function syncCommitButtons(): void {
    const hasMessage = messageInput.value.trim().length > 0;
    const hasStaged = lastCounts.staged > 0;
    const hasAny = hasStaged || lastCounts.unstaged > 0 || lastCounts.untracked > 0;

    commitBtn.disabled = !hasMessage || !hasAny;
    commitPushBtn.disabled = !hasMessage || !hasAny;
    generateBtn.disabled = !hasAny;

    commitHint.textContent = !hasAny
      ? ''
      : hasStaged
        ? `${lastCounts.staged} staged`
        : 'Commits everything';
  }

  async function runCommit(andPush: boolean): Promise<void> {
    const message = messageInput.value.trim();
    if (!message || busy) return;

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
      await run(() => gitPush({ cwd: ctx.getCwd() }), 'Committed and pushed', 'Pushing…');
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
    generateAbort?.abort();
    const controller = new AbortController();
    generateAbort = controller;

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

    generateBtn.disabled = true;
    generateBtn.setAttribute('aria-busy', 'true');
    commitHint.textContent = 'Writing…';

    try {
      const result = await fetchGitCommitMessage({
        changedPaths: useStagedOnly
          ? staged.map((file) => file.path)
          : [...staged, ...unstaged, ...untracked].map((file) => file.path),
        excludedPaths: useStagedOnly ? [...unstaged, ...untracked].map((f) => f.path) : [],
        scope: useStagedOnly ? 'staged' : 'working-tree',
        patch: diff.patch,
        signal: controller.signal,
        onPartial: (text) => {
          messageInput.value = text;
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
    } finally {
      if (generateAbort === controller) generateAbort = null;
      generateBtn.removeAttribute('aria-busy');
      syncCommitButtons();
    }
  }

  const navigate = listNavigator({
    getRows: () => [...listScroll.querySelectorAll<HTMLElement>('.scc-filerow')],
  });

  function onKey(event: KeyboardEvent): boolean {
    const target = event.target;
    const inField = target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement;

    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void runCommit(false);
      return true;
    }

    if (inField) return false;

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
      if (!selection && first) first.focus();
    },
    destroy: () => {
      destroyed = true;
      generateAbort?.abort();
      generateAbort = null;
      root.remove();
    },
  };
}

// ── Focus ────────────────────────────────────────────────────────────────────

/** Focus the commit message box if the Changes view is mounted (palette action). */
export function focusCommitMessage(root: HTMLElement): void {
  root.querySelector<HTMLTextAreaElement>('.scc-commit__input')?.focus();
}
