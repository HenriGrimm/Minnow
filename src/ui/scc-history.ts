import { gitShow, type GitFileEntry } from '../state/git-api';
import { createGitHistoryMap, type GitHistoryMapOptions, type GitHistoryMapHandle } from './git-history-map/page';
import { showGitGraphCommitContextMenu } from './git-graph-context-menu';
import { countPatchLineStats, splitPatchIntoFiles } from './git-patch-files';
import { getGitCommitDiffWordWrap, setGitCommitDiffWordWrap } from './git-commit-diff-prefs';
import { renderSideBySidePatchDiff, setSideBySidePatchDiffWordWrap } from './side-by-side-patch-diff';
import { splitCommitOutput } from './scc-commit-output';
import { gitUiCtx, showGitUiFailure } from './git-ui-op';
import {
  chip,
  diffStat,
  el,
  emptyState,
  errorStrip,
  button,
  skeletonRows,
  type SccContext,
  type SccView,
} from './scc-shared';

interface CommitFile {
  path: string;
  oldPath?: string;
  patch: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

export function createHistoryView(ctx: SccContext): SccView {
  const root = el('div', 'scc-history');

  const graphCol = el('div', 'scc-history__graph-col');
  const graphMount = el('div', 'scc-history__graph');
  graphCol.appendChild(graphMount);

  const detailCol = el('div', 'scc-history__detail-col');
  detailCol.setAttribute('aria-label', 'Commit review');
  detailCol.setAttribute('role', 'region');
  root.append(graphCol, detailCol);

  let graphHandle: GitHistoryMapHandle | null = null;
  let selectedSha: string | null = null;
  let destroyed = false;
  let detailRequest = 0;
  let cwd = ctx.getCwd();

  const graphOptions: GitHistoryMapOptions = {
    onSelectCommit: (sha) => void selectCommit(sha),
    onSelectionRemoved: () => {
      selectedSha = null;
      detailRequest++;
      renderPlaceholder();
    },
    onContextMenu: (visual, event) => {
      void showGitGraphCommitContextMenu(visual, event, {
        cwd: ctx.getCwd(),
        onOpenChanges: (sha) => void selectCommit(sha),
        onRefresh: () => ctx.refreshAll(),
        getCurrentBranch: () => ctx.getBranch(),
        onConflict: (message) =>
          showGitUiFailure(message, { chatKind: 'merge', ctx: gitUiCtx(ctx.getCwd(), ctx.getBranch()) }),
      });
    },
  };

  renderPlaceholder();

  function renderPlaceholder(): void {
    detailCol.hidden = true;
    root.classList.remove('has-review');
    detailCol.replaceChildren(
      emptyState({
        icon: 'gitCommit',
        title: 'Pick a commit',
        body: 'Review its changed files below the map.',
      }),
    );
  }

  async function selectCommit(sha: string, retry = false): Promise<void> {
    if (destroyed) return;
    const request = ++detailRequest;
    if (selectedSha === sha && !retry) {
      selectedSha = null;
      graphHandle?.setSelection(null);
      renderPlaceholder();
      return;
    }

    selectedSha = sha;
    graphHandle?.setSelection(sha);
    detailCol.hidden = false;
    root.classList.add('has-review');

    detailCol.replaceChildren(skeletonRows(6));

    const requestCwd = ctx.getCwd();
    const result = await gitShow({ sha, cwd: requestCwd });
    if (destroyed || selectedSha !== sha || request !== detailRequest || requestCwd !== ctx.getCwd()) return;

    if (!result.ok) {
      detailCol.replaceChildren(
        errorStrip(result.error ?? 'Could not load the commit', () => void selectCommit(sha, true)),
      );
      return;
    }

    renderDetail(sha, result.stdout ?? '', result.patch ?? '', result.files ?? []);
  }

  function renderDetail(
    sha: string,
    stdout: string,
    patch: string,
    nameStatus: GitFileEntry[],
  ): void {
    const header = splitCommitOutput(stdout);
    const files = collectFiles(patch || header.patch, nameStatus);
    const wrap = el('div', 'scc-commit-detail git-commit-diff');

    const head = el('div', 'scc-commit-detail__head git-commit-diff__meta');
    const text = el('div', 'git-commit-diff__meta-text');
    const subject = el('h2', 'scc-commit-detail__subject', header.subject || '(no message)');
    const meta = el('div', 'scc-commit-detail__meta');
    meta.append(chip(sha.slice(0, 7), 'sha'));
    if (header.author) meta.appendChild(el('span', 'scc-commit-detail__author', header.author));
    if (header.date) meta.appendChild(el('span', 'scc-commit-detail__date', header.date));
    meta.append(el('span', '', `${files.length} files changed`));
    text.append(subject, meta);
    const actions = el('div', 'git-commit-diff__meta-actions');
    const wrapButton = button({ label: 'Wrap', title: 'Toggle word wrap in commit diff', onClick: () => {
      const enabled = !getGitCommitDiffWordWrap();
      setGitCommitDiffWordWrap(enabled);
      wrapButton.setAttribute('aria-pressed', String(enabled));
      const mount = wrap.querySelector<HTMLElement>('.git-commit-diff__diff-mount');
      if (mount) setSideBySidePatchDiffWordWrap(mount, enabled);
    } });
    wrapButton.setAttribute('aria-pressed', String(getGitCommitDiffWordWrap()));
    actions.append(wrapButton, button({ icon: 'close', title: 'Close commit review', onClick: () => {
      selectedSha = null;
      detailRequest++;
      graphHandle?.setSelection(null);
      renderPlaceholder();
    } }));
    head.append(text, actions);
    wrap.appendChild(head);

    if (header.body) {
      const message = el('details', 'scc-commit-detail__message');
      message.append(el('summary', '', 'Commit message'), el('pre', 'scc-commit-detail__body', header.body));
      text.append(message);
    }

    if (files.length === 0) {
      wrap.appendChild(
        emptyState({ title: 'No file changes', body: 'This commit is empty or a merge with no conflicts.' }),
      );
      detailCol.replaceChildren(wrap);
      return;
    }

    const tabs = el('div', 'git-commit-diff__file-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Changed files');
    const body = el('div', 'git-commit-diff__body');
    body.setAttribute('role', 'tabpanel');
    body.id = `scc-history-review-${sha.slice(0, 12)}`;
    body.tabIndex = 0;
    const tabButtons: HTMLButtonElement[] = [];

    function selectFile(index: number, focus = false): void {
      const file = files[index];
      tabButtons.forEach((tab, i) => {
        tab.classList.toggle('is-active', index === i);
        tab.setAttribute('aria-selected', String(index === i));
        tab.tabIndex = index === i ? 0 : -1;
      });
      body.setAttribute('aria-label', `${file.path}, parent and commit diff`);
      body.setAttribute('aria-labelledby', tabButtons[index].id);
      body.replaceChildren();
      const labels = el('div', 'git-commit-diff__column-labels');
      labels.append(el('span', 'git-commit-diff__column-label', `${file.oldPath ?? file.path} (parent)`),
        el('span', 'git-commit-diff__column-label', file.path));
      body.append(labels);
      if (file.binary || !/^@@/m.test(file.patch)) {
        body.append(el('p', 'git-commit-diff__binary', file.binary
          ? 'Binary file changed (no text diff).' : 'Rename or mode-only change (no text diff).'));
      } else {
        const mount = el('div', 'git-commit-diff__diff-mount');
        body.append(mount);
        renderSideBySidePatchDiff(mount, file.patch, { wordWrap: getGitCommitDiffWordWrap() });
      }
      if (focus) tabButtons[index].focus();
    }

    files.forEach((file, index) => {
      const tab = el('button', 'git-commit-diff__file-tab');
      tab.type = 'button';
      tab.id = `${body.id}-file-${index}`;
      tab.title = file.path;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', body.id);
      tab.append(el('span', 'git-commit-diff__file-tab-name', file.path.split('/').pop() ?? file.path),
        diffStat(file.additions, file.deletions));
      tab.addEventListener('click', () => selectFile(index));
      tab.addEventListener('keydown', (event) => {
        let next: number;
        if (event.key === 'ArrowRight') next = (index + 1) % files.length;
        else if (event.key === 'ArrowLeft') next = (index + files.length - 1) % files.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = files.length - 1;
        else return;
        event.preventDefault();
        selectFile(next, true);
      });
      tabButtons.push(tab);
      tabs.append(tab);
    });
    wrap.append(tabs, body);
    detailCol.replaceChildren(wrap);
    selectFile(0);
  }

  async function refresh(): Promise<void> {
    if (destroyed) return;
    if (cwd !== ctx.getCwd()) {
      cwd = ctx.getCwd();
      detailRequest++;
      selectedSha = null;
      renderPlaceholder();
    }
    if (!graphHandle) {
      graphOptions.cwd = ctx.getCwd();
      graphHandle = createGitHistoryMap(graphMount, graphOptions);
    }
    graphOptions.cwd = ctx.getCwd();
    await graphHandle.refresh();
  }

  void refresh();

  return {
    root,
    refresh,
    destroy: () => {
      destroyed = true;
      detailRequest++;
      graphHandle?.destroy();
      graphHandle = null;
      root.remove();
    },
  };
}

/** Pair per-file patches with name-status entries, keeping files with no hunks. */
function collectFiles(patch: string, nameStatus: GitFileEntry[]): CommitFile[] {
  const byPath = new Map<string, CommitFile>();

  for (const entry of splitPatchIntoFiles(patch)) {
    const { additions, deletions } = countPatchLineStats(entry.patch);
    byPath.set(entry.path, {
      path: entry.path,
      oldPath: entry.oldPath,
      patch: entry.patch,
      additions,
      deletions,
      binary: entry.binary,
    });
  }

  for (const entry of nameStatus) {
    if (!byPath.has(entry.path)) {
      byPath.set(entry.path, {
        path: entry.path,
        patch: '',
        additions: 0,
        deletions: 0,
        binary: true,
      });
    }
  }

  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}
