import { gitLog, type GitCommitEntry, type GitLogResult } from '../state/git-api';
import { renderGitGraphRows, setGitGraphRowSelected, type GitGraphOptions } from './git-graph';

const PAGE_SIZE = 100;

export function createGitHistoryBrowser(host: HTMLElement, options: GitGraphOptions) {
  const root = document.createElement('div');
  root.className = 'git-graph git-history-browser';
  const toolbar = document.createElement('div');
  toolbar.className = 'git-history-browser__toolbar';
  const branchLabel = document.createElement('label');
  branchLabel.textContent = 'History branch';
  const branch = document.createElement('select');
  branch.className = 'git-history-browser__branch';
  branchLabel.append(branch);
  toolbar.append(branchLabel);

  const scroll = document.createElement('div');
  scroll.className = 'git-history-browser__scroll';
  const notice = document.createElement('p');
  notice.className = 'git-panel-empty';
  const list = document.createElement('div');
  list.className = 'git-graph__list';
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', 'Commits');
  scroll.append(notice, list);

  const footer = document.createElement('div');
  footer.className = 'git-history-browser__footer';
  const status = document.createElement('span');
  status.setAttribute('role', 'status');
  const more = document.createElement('button');
  more.type = 'button';
  more.textContent = 'Load older commits';
  more.addEventListener('click', () => void read(nextSkip));
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = 'Retry';
  retry.addEventListener('click', () => void read(retryOffset));
  footer.append(status, more, retry);
  root.append(toolbar, scroll, footer);
  host.replaceChildren(root);

  let disposed = false;
  let request: AbortController | null = null;
  let branches: string[] = [];
  let commits: GitCommitEntry[] = [];
  let historyKey: string | null = null;
  let nextSkip: number | null = null;
  let selectedSha = options.selectedSha ?? null;
  let focused: HTMLElement | null = null;
  let error = '';
  let retryOffset: number | null = null;

  function updateBranches(next: string[]): void {
    const value = branch.value;
    branches = next;
    const all = document.createElement('option');
    all.value = '';
    all.textContent = 'All refs';
    const head = document.createElement('option');
    head.value = 'HEAD';
    head.textContent = 'Current checkout (HEAD)';
    const local = document.createElement('optgroup');
    local.label = 'Local branches';
    const remote = document.createElement('optgroup');
    remote.label = 'Remote branches';
    for (const ref of next) {
      const option = document.createElement('option');
      option.value = ref;
      option.textContent = ref.replace(/^refs\/(heads|remotes)\//, '');
      (ref.startsWith('refs/heads/') ? local : remote).append(option);
    }
    branch.replaceChildren(all, head);
    if (local.childElementCount) branch.append(local);
    if (remote.childElementCount) branch.append(remote);
    branch.value = value === 'HEAD' || next.includes(value) ? value : '';
  }

  function updateStatus(loadingOlder = false): void {
    const busy = request !== null;
    list.setAttribute('aria-busy', String(busy));
    notice.textContent = !commits.length && !error ? (busy ? 'Loading history…' : 'No commits yet') : '';
    notice.hidden = !notice.textContent;
    const text = busy && (!commits.length || loadingOlder || error) ? 'Loading history…' : error || (commits.length
      ? `${commits.length} commit${commits.length === 1 ? '' : 's'}${nextSkip !== null ? ' loaded' : ''}` : '');
    if (status.textContent !== text) status.textContent = text;
    more.hidden = nextSkip === null || Boolean(error);
    more.setAttribute('aria-disabled', String(busy));
    retry.hidden = !error;
    retry.textContent = retryOffset === null && commits.length ? 'Refresh history' : 'Retry';
    retry.setAttribute('aria-disabled', String(busy));
  }

  function focusRow(row: HTMLElement): void {
    if (focused) focused.tabIndex = -1;
    row.tabIndex = 0;
    focused = row;
  }

  list.addEventListener('focusin', (event) => {
    if (event.target instanceof HTMLElement && event.target.dataset.sha) focusRow(event.target);
  });
  list.addEventListener('keydown', (event) => {
    if (!focused) return;
    const target = {
      ArrowUp: focused.previousElementSibling, ArrowDown: focused.nextElementSibling,
      Home: list.firstElementChild, End: list.lastElementChild,
    }[event.key];
    if (!(target instanceof HTMLElement)) return;
    event.preventDefault();
    focusRow(target);
    target.focus();
  });

  function paintRows(): void {
    const hadFocus = list.contains(document.activeElement);
    const focusedSha = focused?.dataset.sha;
    const scrollTop = scroll.scrollTop;
    const anchor = scrollTop > 0 ? [...list.children].find((row) => {
      const element = row as HTMLElement;
      return element.offsetTop + element.offsetHeight > scrollTop;
    }) as HTMLElement | undefined : undefined;
    const offset = anchor ? scrollTop - anchor.offsetTop : 0;
    renderGitGraphRows(list, commits, { ...options, selectedSha });
    const newAnchor = anchor && list.querySelector<HTMLElement>(`[data-sha="${anchor.dataset.sha}"]`);
    scroll.scrollTop = newAnchor ? newAnchor.offsetTop + offset : scrollTop;
    const row = (focusedSha && list.querySelector<HTMLElement>(`[data-sha="${focusedSha}"]`)) || list.firstElementChild;
    focused = null;
    if (row instanceof HTMLElement) {
      focusRow(row);
      if (hadFocus) row.focus({ preventScroll: true });
    }
  }

  async function read(offset: number | null): Promise<void> {
    if (request || disposed) return;
    const controller = new AbortController();
    request = controller;
    const append = offset !== null;
    updateStatus(append);
    const ref = branch.value || undefined;
    const loaded = append ? [...commits] : [];
    const target = append ? loaded.length + PAGE_SIZE : Math.max(PAGE_SIZE, commits.length);
    let snapshotKey = append ? historyKey : null;
    let skip = offset ?? 0;
    let result: GitLogResult;
    let nextBranches: string[] | undefined;
    do {
      result = await gitLog({ cwd: options.cwd, count: PAGE_SIZE, skip, fullRefs: true, ref,
        historyKey: snapshotKey, ifHistoryKey: skip === 0 ? historyKey : null }, controller.signal);
      if (controller.signal.aborted) return;
      if (!result.ok || result.historyUnchanged) break;
      nextBranches ??= result.historyBranches;
      loaded.push(...(result.commits ?? []));
      snapshotKey = result.historyKey ?? null;
      if (!result.hasMore || result.nextSkip == null || result.nextSkip <= skip) break;
      skip = result.nextSkip;
    } while (loaded.length < target);

    request = null;
    error = result.ok ? '' : result.error || 'Could not load history';
    retryOffset = result.historyChanged ? null : offset;
    const action = document.activeElement;
    if (result.ok && !result.historyUnchanged) {
      if (nextBranches && JSON.stringify(nextBranches) !== JSON.stringify(branches)) updateBranches(nextBranches);
      const previousLength = commits.length;
      commits = loaded;
      historyKey = snapshotKey;
      nextSkip = result.hasMore ? result.nextSkip ?? null : null;
      paintRows();
      if (append && nextSkip === null && (action === more || action === retry)) {
        const row = list.children[previousLength];
        if (row instanceof HTMLElement) row.focus();
      }
    }
    updateStatus();
    if (result.ok && document.activeElement === retry) (more.hidden ? branch : more).focus();
  }

  branch.addEventListener('change', () => {
    request?.abort();
    request = null;
    commits = [];
    historyKey = nextSkip = retryOffset = null;
    error = '';
    focused = null;
    list.replaceChildren();
    scroll.scrollTop = 0;
    void read(null);
  });
  updateBranches([]);
  updateStatus();

  return {
    refresh: () => read(null),
    setSelection(sha: string | null) {
      selectedSha = sha;
      for (const row of list.querySelectorAll<HTMLElement>('[data-sha]')) {
        setGitGraphRowSelected(row, sha !== null && row.dataset.sha === sha);
      }
    },
    destroy() {
      disposed = true;
      request?.abort();
      root.remove();
    },
  };
}
