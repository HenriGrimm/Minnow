import { gitShow, type GitFileEntry } from '../state/git-api';
import { createGitHistoryMap, type GitHistoryMapOptions, type GitHistoryMapHandle } from './git-history-map/page';
import { showGitGraphCommitContextMenu } from './git-graph-context-menu';
import { countPatchLineStats, splitPatchIntoFiles } from './git-patch-files';
import { getGitCommitDiffWordWrap, setGitCommitDiffWordWrap } from './git-commit-diff-prefs';
import { renderSideBySidePatchDiff, setSideBySidePatchDiffWordWrap } from './side-by-side-patch-diff';
import { splitCommitOutput } from './scc-commit-output';
import { gitUiCtx, showGitUiFailure } from './git-ui-op';
import { createIcon } from './icon';
import {
  chip,
  detailHead,
  diffStat,
  el,
  emptyState,
  errorStrip,
  button,
  pageBar,
  pathParts,
  relativeTime,
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
  /** Name-status letter: A, M, D, R… */
  status: string;
}

export function createHistoryView(ctx: SccContext): SccView {
  const root = el('div', 'scc-history');
  root.dataset.view = 'map';
  const bar = pageBar('History');

  const graphCol = el('div', 'scc-history__graph-col');
  const graphMount = el('div', 'scc-history__graph');
  graphCol.appendChild(graphMount);

  const detailCol = el('div', 'scc-history__detail-col');
  detailCol.setAttribute('aria-label', 'Commit review');
  detailCol.setAttribute('role', 'region');
  root.append(bar.root, graphCol, detailCol);

  let graphHandle: GitHistoryMapHandle | null = null;
  let selectedSha: string | null = null;
  let destroyed = false;
  let detailRequest = 0;
  let cwd = ctx.getCwd();

  const graphOptions: GitHistoryMapOptions = {
    controlsHost: bar.controls,
    onViewChange: (view) => { root.dataset.view = view; },
    onStatus: (text) => { bar.count.textContent = text; },
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
        onOpenWorktree: ctx.openWorktree,
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
    wrap.setAttribute('aria-label', `Commit ${sha.slice(0, 7)}`);

    const closeReview = () => {
      selectedSha = null;
      detailRequest++;
      graphHandle?.setSelection(null);
      renderPlaceholder();
    };
    const totals = files.reduce((sum, file) => ({ add: sum.add + file.additions, del: sum.del + file.deletions }), { add: 0, del: 0 });

    // Who and when, read like a sentence: "abc1234 · Henri Grimm · 2h ago".
    const eyebrow: HTMLElement[] = [chip(sha.slice(0, 7), 'sha')];
    const author = parseAuthor(header.author);
    if (author.name) {
      const who = el('span', 'scc-commit-detail__author', author.name);
      if (author.email) who.title = author.email;
      eyebrow.push(who);
    }
    if (header.date) {
      const when = el('time', 'scc-commit-detail__date', commitAge(header.date));
      when.title = header.date;
      eyebrow.push(when);
    }
    const filesFact = el('span', 'scc-commit-detail__files', `${files.length} ${files.length === 1 ? 'file' : 'files'} changed`);
    const head = detailHead({
      eyebrow,
      title: header.subject || '(no message)',
      titleClass: 'scc-commit-detail__subject',
      facts: files.length ? [filesFact, diffStat(totals.add, totals.del)] : [filesFact],
      onBack: closeReview,
      backLabel: 'History',
    });
    head.root.appendChild(button({ icon: 'close', variant: 'ghost', title: 'Close commit review', className: 'scc-commit-detail__close', onClick: closeReview }));
    wrap.appendChild(head.root);

    if (header.body) {
      const message = el('details', 'scc-commit-detail__message');
      message.append(el('summary', '', 'Full message'), el('pre', 'scc-commit-detail__body', header.body));
      head.root.appendChild(message);
    }

    if (files.length === 0) {
      wrap.appendChild(
        emptyState({ title: 'No file changes', body: 'This commit is empty or a merge with no conflicts.' }),
      );
      detailCol.replaceChildren(wrap);
      return;
    }

    // Changed files beside the diff: a vertical list scales to 200 files; a tab strip does not.
    const review = el('div', 'scc-commit-detail__review');
    const fileList = el('div', 'scc-commit-files');
    fileList.setAttribute('role', 'tablist');
    fileList.setAttribute('aria-label', 'Changed files');
    fileList.setAttribute('aria-orientation', 'vertical');

    const pane = el('div', 'scc-commit-detail__pane');
    const toolbar = el('div', 'scc-commit-detail__toolbar');
    const currentPath = el('span', 'scc-commit-detail__path');
    const wrapButton = button({ label: 'Wrap lines', variant: 'ghost', title: 'Toggle word wrap in commit diff', onClick: () => {
      const enabled = !getGitCommitDiffWordWrap();
      setGitCommitDiffWordWrap(enabled);
      wrapButton.setAttribute('aria-pressed', String(enabled));
      const mount = wrap.querySelector<HTMLElement>('.git-commit-diff__diff-mount');
      if (mount) setSideBySidePatchDiffWordWrap(mount, enabled);
    } });
    wrapButton.setAttribute('aria-pressed', String(getGitCommitDiffWordWrap()));
    toolbar.append(currentPath, wrapButton);

    const body = el('div', 'git-commit-diff__body');
    body.setAttribute('role', 'tabpanel');
    body.id = `scc-history-review-${sha.slice(0, 12)}`;
    body.tabIndex = 0;
    pane.append(toolbar, body);
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
      currentPath.replaceChildren(pathLabelWithRename(file));
      body.replaceChildren();
      const labels = el('div', 'git-commit-diff__column-labels');
      labels.append(el('span', 'git-commit-diff__column-label', 'Before'), el('span', 'git-commit-diff__column-label', 'After'));
      if (file.binary || !/^@@/m.test(file.patch)) {
        body.append(el('p', 'git-commit-diff__binary', file.binary
          ? 'Binary file changed (no text diff).' : 'Rename or mode-only change (no text diff).'));
      } else {
        const mount = el('div', 'git-commit-diff__diff-mount');
        body.append(labels, mount);
        renderSideBySidePatchDiff(mount, file.patch, { wordWrap: getGitCommitDiffWordWrap() });
      }
      if (focus) {
        tabButtons[index].focus();
        tabButtons[index].scrollIntoView({ block: 'nearest' });
      }
    }

    files.forEach((file, index) => {
      const { dir, name } = pathParts(file.path);
      const tab = el('button', 'scc-commit-file git-commit-diff__file-tab');
      tab.type = 'button';
      tab.id = `${body.id}-file-${index}`;
      tab.title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', body.id);
      const status = fileStatus(file);
      const badge = el('span', `scc-commit-file__status scc-commit-file__status--${status.key}`, status.letter);
      badge.title = status.label;
      const label = el('span', 'scc-commit-file__label');
      label.append(el('span', 'scc-commit-file__name git-commit-diff__file-tab-name', name));
      if (dir) label.append(el('span', 'scc-commit-file__dir', dir.replace(/\/$/, '')));
      tab.append(badge, label, diffStat(file.additions, file.deletions));
      tab.addEventListener('click', () => selectFile(index));
      tab.addEventListener('keydown', (event) => {
        let next: number;
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % files.length;
        else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index + files.length - 1) % files.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = files.length - 1;
        else return;
        event.preventDefault();
        selectFile(next, true);
      });
      tabButtons.push(tab);
      fileList.append(tab);
    });

    review.append(fileList, pane);
    review.classList.toggle('is-single', files.length === 1);
    wrap.append(review);
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
      status: '',
    });
  }

  for (const entry of nameStatus) {
    const known = byPath.get(entry.path);
    if (known) known.status = entry.status ?? '';
    else {
      byPath.set(entry.path, {
        path: entry.path,
        patch: '',
        additions: 0,
        deletions: 0,
        binary: true,
        status: entry.status ?? '',
      });
    }
  }

  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

const STATUS: Record<string, { letter: string; key: string; label: string }> = {
  A: { letter: 'A', key: 'added', label: 'Added' },
  M: { letter: 'M', key: 'modified', label: 'Modified' },
  D: { letter: 'D', key: 'deleted', label: 'Deleted' },
  R: { letter: 'R', key: 'renamed', label: 'Renamed' },
  C: { letter: 'C', key: 'renamed', label: 'Copied' },
  T: { letter: 'T', key: 'modified', label: 'Type changed' },
};

/** Name-status when git gave one; otherwise inferred from the patch. */
function fileStatus(file: CommitFile): { letter: string; key: string; label: string } {
  const code = file.status.trim().charAt(0).toUpperCase();
  if (STATUS[code]) return STATUS[code];
  if (file.oldPath && file.oldPath !== file.path) return STATUS.R;
  if (/^new file mode/m.test(file.patch) || (file.deletions === 0 && /^--- \/dev\/null/m.test(file.patch))) return STATUS.A;
  if (/^deleted file mode/m.test(file.patch) || /^\+\+\+ \/dev\/null/m.test(file.patch)) return STATUS.D;
  return STATUS.M;
}

function pathLabelWithRename(file: CommitFile): HTMLElement {
  const wrap = el('span', 'scc-commit-detail__path-text');
  if (file.oldPath && file.oldPath !== file.path) {
    wrap.append(el('span', 'scc-commit-detail__path-old', file.oldPath), createIcon('chevronRight', { size: 12 }));
  }
  wrap.append(el('span', undefined, file.path));
  wrap.title = file.path;
  return wrap;
}

/** "Henri Grimm <henri@example.org>" → name and email. */
function parseAuthor(raw: string): { name: string; email: string } {
  const match = /^(.*?)\s*<([^>]+)>\s*$/.exec(raw.trim());
  return match ? { name: match[1]!, email: match[2]! } : { name: raw.trim(), email: '' };
}

/** "Mon Nov 16 19:32:52 2026 -0800" → "2h ago"; unparseable dates pass through. */
function commitAge(raw: string): string {
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return raw;
  return relativeTime(new Date(ms).toISOString());
}
