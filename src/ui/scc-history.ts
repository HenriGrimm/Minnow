import { gitShow, type GitFileEntry } from '../state/git-api';
import { renderGitGraph, type GitGraphOptions } from './git-graph';
import { showGitGraphCommitContextMenu } from './git-graph-context-menu';
import { countPatchLineStats, splitPatchIntoFiles } from './git-patch-files';
import { parseUnifiedPatchToDiffLines } from './git-patch-parse';
import { renderUnifiedPromptDiff } from './prompt-diff-unified';
import { splitCommitOutput } from './scc-commit-output';
import { gitUiCtx, showGitUiFailure } from './git-ui-op';
import { showToast } from './toast';
import {
  chip,
  diffStat,
  el,
  emptyState,
  errorStrip,
  pathLabel,
  skeletonRows,
  type SccContext,
  type SccView,
} from './scc-shared';

interface CommitFile {
  path: string;
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
  root.append(graphCol, detailCol);

  let graphHandle: ReturnType<typeof renderGitGraph> | null = null;
  let selectedSha: string | null = null;
  let openFilePath: string | null = null;
  let destroyed = false;

  const graphOptions: GitGraphOptions = {
    onSelectCommit: (sha) => void selectCommit(sha),
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
    detailCol.replaceChildren(
      emptyState({
        icon: 'gitCommit',
        title: 'Pick a commit',
        body: 'Its message, refs, and every file it touched show here.',
      }),
    );
  }

  async function selectCommit(sha: string): Promise<void> {
    if (selectedSha === sha) {
      selectedSha = null;
      graphOptions.selectedSha = null;
      void graphHandle?.refresh();
      renderPlaceholder();
      return;
    }

    selectedSha = sha;
    openFilePath = null;
    graphOptions.selectedSha = sha;
    void graphHandle?.refresh();

    detailCol.replaceChildren(skeletonRows(6));

    const result = await gitShow({ sha, cwd: ctx.getCwd() });
    if (destroyed || selectedSha !== sha) return;

    if (!result.ok) {
      detailCol.replaceChildren(
        errorStrip(result.error ?? 'Could not load the commit', () => void selectCommit(sha)),
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

    const wrap = el('div', 'scc-commit-detail');

    const head = el('div', 'scc-commit-detail__head');
    const subject = el('h2', 'scc-commit-detail__subject', header.subject || '(no message)');
    const meta = el('div', 'scc-commit-detail__meta');
    meta.append(chip(sha.slice(0, 7), 'sha'));
    if (header.author) meta.appendChild(el('span', 'scc-commit-detail__author', header.author));
    if (header.date) meta.appendChild(el('span', 'scc-commit-detail__date', header.date));
    head.append(subject, meta);
    wrap.appendChild(head);

    if (header.body) {
      wrap.appendChild(el('pre', 'scc-commit-detail__body', header.body));
    }

    const filesHead = el('div', 'scc-commit-detail__files-head');
    filesHead.append(
      el('span', 'scc-commit-detail__files-title', 'Files'),
      el('span', 'scc-commit-detail__files-count', String(files.length)),
    );
    wrap.appendChild(filesHead);

    if (files.length === 0) {
      wrap.appendChild(
        emptyState({ title: 'No file changes', body: 'This commit is empty or a merge with no conflicts.' }),
      );
      detailCol.replaceChildren(wrap);
      return;
    }

    const list = el('div', 'scc-commit-detail__files');
    for (const file of files) {
      list.appendChild(buildFileRow(file));
    }
    wrap.appendChild(list);
    detailCol.replaceChildren(wrap);
  }

  function buildFileRow(file: CommitFile): HTMLElement {
    const wrap = el('div', 'scc-commit-file');

    const row = el('button', 'scc-commit-file__row');
    row.type = 'button';
    row.setAttribute('aria-expanded', String(openFilePath === file.path));
    row.append(pathLabel(file.path), diffStat(file.additions, file.deletions));

    const body = el('div', 'scc-commit-file__diff');
    body.hidden = openFilePath !== file.path;
    if (openFilePath === file.path) paintDiff(body, file);

    row.addEventListener('click', () => {
      const open = !body.hidden;
      openFilePath = open ? null : file.path;
      body.hidden = open;
      row.setAttribute('aria-expanded', String(!open));
      if (!open && !body.firstChild) paintDiff(body, file);
    });

    wrap.append(row, body);
    return wrap;
  }

  function paintDiff(host: HTMLElement, file: CommitFile): void {
    const lines = parseUnifiedPatchToDiffLines(file.patch);
    if (lines.length === 0) {
      host.replaceChildren(el('p', 'scc-commit-file__binary', 'Binary or mode-only change'));
      return;
    }
    const mount = el('div', 'scc-diff');
    host.replaceChildren(mount);
    renderUnifiedPromptDiff(mount, lines, { lineNumbers: true });
  }

  async function refresh(): Promise<void> {
    if (destroyed) return;
    if (!graphHandle) {
      graphOptions.cwd = ctx.getCwd();
      graphHandle = renderGitGraph(graphMount, graphOptions);
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
