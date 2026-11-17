import { createIcon, type IconName } from './icon';
import { markPreviewOccluder, unmarkPreviewOccluder } from './preview-occlusion';
import type { GitCheckoutSwitchInput, GitOpResult, GitSavedCheckoutChanges } from '../state/git-api';
import { forgeRefresh, prList, type ForgeResult } from '../state/forge-api';
import { panelPathsEqual } from './panel-worktree-cwd';
import type { ParsedWorktree } from '../lib/worktree-list-parse';
import { displayWorktreeTitle } from './worktree-display';
import { displayRemoteRef, isSkippedRemoteRef, shortLocalNameFromRemote } from '../lib/git-ref-start.mjs';
import { parseGitError } from '../lib/git-error-parse';
import { actionApi } from '../state/actions-api';

const branchNameOrder = new Intl.Collator(undefined, { numeric: true });

/** Branches recently switched to or from, per checkout (memory only, newest first). */
const recentByCheckout = new Map<string, string[]>();
const RECENT_LIMIT = 5;
const recentKey = (cwd: string) => cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function rememberRecent(cwd: string, branches: (string | undefined)[]): void {
  if (!cwd) return;
  const key = recentKey(cwd);
  const next = [...branches.filter((b): b is string => Boolean(b && b !== 'HEAD')), ...(recentByCheckout.get(key) ?? [])];
  recentByCheckout.set(key, [...new Set(next)].slice(0, RECENT_LIMIT + 1));
}

/** Test helper: recent branches are module state shared by every picker. */
export function resetRecentCheckoutsForTests(): void {
  recentByCheckout.clear();
}
const checkoutTabs = [
  ['branches', 'Branches', 'Branch name…'],
  ['worktrees', 'Worktrees', 'Name or path…'],
  ['pulls', 'Pull requests', 'Number, title, or branch…'],
] as const;

export interface CheckoutPickerState {
  cwd: string;
  workspace: string;
  branch: string;
  branches: string[];
  remoteBranches?: string[];
  worktrees: ParsedWorktree[];
  savedChanges: GitSavedCheckoutChanges[];
}

interface PickerActions {
  onSwitch(input: GitCheckoutSwitchInput): Promise<GitOpResult>;
  onRestore(input: { cwd: string; sha: string; expectedBranch: string }): Promise<GitOpResult>;
}

type PickerOptions = PickerActions & (
  | { inline: true; onWorktree(path: string): Promise<void> }
  | {
      inline?: false;
      onWorktree(path: string): void;
      onNewBranch(anchor: HTMLButtonElement): void;
      onNewWorktree(anchor: HTMLButtonElement): void;
      onDeleteBranch(): void;
      onRemoveWorktree(): void;
    }
);

export function createGitCheckoutPicker(options: PickerOptions) {
  const root = document.createElement('div');
  root.className = options.inline ? 'git-checkout' : 'git-checkout git-checkout--dropdown';
  const id = options.inline ? 'threadCheckout' : 'gitCheckout';
  const trigger = button('', 'git-checkout__trigger', () => {
    if (open) {
      close();
      return;
    }
    open = true;
    pending = undefined;
    render();
    if (open) focusSearch();
  });
  trigger.id = `${id}Trigger`;
  trigger.setAttribute('aria-controls', `${id}Menu`);
  const menu = document.createElement('div');
  menu.className = 'git-checkout__menu';
  menu.id = `${id}Menu`;
  menu.setAttribute('role', 'region');
  menu.setAttribute('aria-label', 'Choose a checkout');
  const notices = document.createElement('div');
  notices.className = 'git-checkout__notices';
  notices.setAttribute('aria-live', 'polite');
  if (!options.inline) root.append(trigger);
  root.append(notices, menu);
  let state: CheckoutPickerState = { cwd: '', workspace: '', branch: '', branches: [], worktrees: [], savedChanges: [] };
  let open = Boolean(options.inline);
  let tab: (typeof checkoutTabs)[number][0] = 'branches';
  let pulls: { result?: ForgeResult } | undefined;
  let query = '';
  let busy = false;
  let checkingOutPull: number | undefined;
  let disposed = false;
  let message = '';
  /** Raw Git output behind the plain-language message. */
  let messageDetails = '';
  /** The target turned out to be checked out in another worktree. */
  let movedTo: { path: string; label: string } | undefined;
  /** A local action holds this checkout; the switch can retry once it stops. */
  let blocked: { input: GitCheckoutSwitchInput; runId?: string; label?: string } | undefined;
  let pending: GitCheckoutSwitchInput | undefined;
  let pendingComplete: (() => Promise<void>) | undefined;
  let pendingCount = 0;
  const contextKey = () => `${state.cwd}\0${state.branch}`;

  function button(text: string, className: string, action: () => void, icon?: IconName) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = className;
    if (icon) el.append(createIcon(icon, { size: 16 }));
    if (text) el.append(document.createTextNode(text));
    el.addEventListener('click', action);
    return el;
  }
  function text(value: string, className: string) {
    const el = document.createElement('span');
    el.className = className;
    el.textContent = value;
    return el;
  }
  function worktreeName(wt?: Pick<ParsedWorktree, 'path'> & Partial<Pick<ParsedWorktree, 'branch' | 'detached'>>) {
    const path = wt?.path ?? state.cwd;
    if (panelPathsEqual(path, state.workspace)) return 'Workspace';
    const branch = wt?.branch ?? (panelPathsEqual(path, state.cwd) ? state.branch : undefined);
    return displayWorktreeTitle({ path, branch, detached: wt?.detached }, { workspaceRoot: state.workspace });
  }
  /** Plain-language failure; the raw output goes behind Technical details. */
  function describeFailure(result: GitOpResult, input: GitCheckoutSwitchInput): string {
    const fallback = input.pullRequest ? 'Could not check out the pull request.' : 'Could not switch branches.';
    const raw = (result.error ?? '').trim();
    if (!raw) { messageDetails = ''; return fallback; }
    const parsed = parseGitError(raw, fallback, result.code);
    if (parsed.kind === 'generic') { messageDetails = ''; return raw; }
    messageDetails = raw;
    return `${parsed.title}. ${parsed.summary}`;
  }
  async function stopAndRetry(hold: { input: GitCheckoutSwitchInput; runId?: string }) {
    if (busy || disposed || !hold.runId) return;
    busy = true;
    render();
    const stopped = await actionApi('localRunCancel', { cwd: hold.input.cwd ?? state.cwd, id: hold.runId });
    busy = false;
    if (disposed) return;
    if (!stopped.ok) {
      blocked = undefined;
      message = stopped.error || 'Could not stop the action.';
      messageDetails = '';
      render();
      return;
    }
    await requestSwitch(hold.input);
  }
  function close() {
    if (busy) return;
    if (!options.inline) pulls = undefined;
    open = Boolean(options.inline);
    pending = undefined;
    pendingComplete = undefined;
    movedTo = undefined;
    blocked = undefined;
    query = '';
    render();
  }
  function focusSearch() {
    menu.querySelector<HTMLInputElement>('input')?.focus();
  }
  function resetSelection() {
    close();
    if (options.inline) focusSearch();
    else trigger.focus();
  }
  async function loadPullRequests(refreshForge = false) {
    if (pulls || !state.cwd) return;
    const cwd = state.cwd;
    const request: { result?: ForgeResult } = {};
    pulls = request;
    if (refreshForge) {
      await forgeRefresh(cwd);
      if (disposed || pulls !== request) return;
    }
    request.result = await prList({ cwd, state: 'open', limit: 200 });
    if (disposed || pulls !== request || !open || tab !== 'pulls') return;
    const list = menu.querySelector<HTMLElement>('.git-checkout__list');
    if (list) renderRows(list);
  }
  async function requestSwitch(input: GitCheckoutSwitchInput, onComplete = pendingComplete) {
    if (busy || disposed) return;
    const key = contextKey();
    const fromBranch = state.branch;
    busy = true;
    checkingOutPull = input.pullRequest?.number;
    message = '';
    messageDetails = '';
    movedTo = undefined;
    blocked = undefined;
    render();
    try {
      const result = await options.onSwitch(input);
      if (disposed) return;
      if (!result.ok && (result.error ?? '').trim().toLowerCase() === 'cancelled') {
        pending = undefined;
        pendingComplete = undefined;
        return;
      }
      if (result.ok) {
        rememberRecent(input.cwd ?? state.cwd, [result.branch ?? input.branch, fromBranch]);
        pending = undefined;
        pendingComplete = undefined;
        open = Boolean(options.inline);
        if (!open) pulls = undefined;
        if (input.cwd && panelPathsEqual(input.cwd, state.cwd)) await onComplete?.();
        return;
      }
      // gh can switch branches before an update fails. Keep its error visible in that checkout.
      if (contextKey() !== key && !(input.pullRequest && result.branch === state.branch &&
        input.cwd && panelPathsEqual(input.cwd, state.cwd))) return;
      if (result.needsChoice) {
        pending = { ...input, expectedBranch: result.branch };
        pendingComplete = onComplete;
        pendingCount = result.fileCount ?? 0;
        open = true;
      } else if (result.code === 'in_worktree' && result.worktreePath) {
        // Detected by tracking ref or head commit (e.g. fork PRs): route like a branch row.
        movedTo = { path: result.worktreePath, label: input.pullRequest ? `PR #${input.pullRequest.number}` : input.branch };
        pending = undefined;
        open = true;
      } else if (result.code === 'busy') {
        blocked = { input, runId: result.busyRunId, label: result.busyLabel };
        pending = undefined;
        open = true;
      } else {
        message = describeFailure(result, input);
        pending = undefined;
        open = true;
      }
    } catch (err) {
      if (!disposed && contextKey() === key) message = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
      checkingOutPull = undefined;
      if (!disposed) {
        render();
        if (pending) menu.querySelector<HTMLButtonElement>('.git-checkout__choice')?.focus();
        else if (document.activeElement === document.body) {
          if (open) focusSearch();
          else trigger.focus();
        }
      }
    }
  }
  async function selectWorktree(path: string) {
    if (!options.inline) {
      close();
      options.onWorktree(path);
      trigger.focus();
      return;
    }
    if (busy || disposed) return;
    busy = true;
    message = '';
    messageDetails = '';
    render();
    try {
      await options.onWorktree(path);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
      if (!disposed) {
        render();
        if (document.activeElement === document.body) focusSearch();
      }
    }
  }
  async function restore(saved: GitSavedCheckoutChanges) {
    if (busy) return;
    const key = contextKey();
    busy = true;
    message = '';
    messageDetails = '';
    render();
    try {
      const result = await options.onRestore({ cwd: state.cwd, expectedBranch: state.branch, sha: saved.sha });
      if (disposed || contextKey() !== key) return;
      if (!result.ok) message = result.error ?? 'Could not restore changes. Your saved stash is retained.';
    } catch (err) {
      if (!disposed && contextKey() === key) message = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
      if (!disposed) render();
    }
  }
  function renderNotices() {
    notices.replaceChildren();
    if (checkingOutPull !== undefined) {
      const status = text(`Checking out PR #${checkingOutPull}…`, 'git-checkout__detail');
      status.setAttribute('role', 'status');
      notices.append(status);
    }
    if (blocked) {
      const hold = blocked;
      const offer = document.createElement('div');
      offer.className = 'git-checkout__restore';
      offer.setAttribute('role', 'alert');
      offer.append(
        text(hold.label ? `Waiting for ${hold.label}` : 'A local action is using this checkout', 'git-checkout__title'),
        text('Git changes wait until it finishes. Stop it to switch now.', 'git-checkout__detail'),
      );
      const actions = document.createElement('div');
      actions.className = 'git-checkout__notice-actions';
      if (hold.runId) {
        const stop = button(busy ? 'Working…' : 'Stop and switch', 'git-checkout__action', () => void stopAndRetry(hold), 'close');
        stop.disabled = busy;
        actions.append(stop);
      }
      const retry = button('Try again', 'git-checkout__action', () => void requestSwitch(hold.input), 'refresh');
      retry.disabled = busy;
      actions.append(retry);
      offer.append(actions);
      notices.append(offer);
    }
    if (movedTo) {
      const target = movedTo;
      const offer = document.createElement('div');
      offer.className = 'git-checkout__restore';
      offer.setAttribute('role', 'alert');
      offer.append(
        text(`${target.label} is open in ${worktreeName(state.worktrees.find((w) => panelPathsEqual(w.path, target.path)) ?? { path: target.path } as ParsedWorktree)}`, 'git-checkout__title'),
        text('Git keeps a branch in one worktree at a time.', 'git-checkout__detail'),
      );
      const go = button(options.inline ? 'Use that checkout' : 'Open worktree', 'git-checkout__action', () => {
        movedTo = undefined;
        void selectWorktree(target.path);
      }, 'gitWorktree');
      go.disabled = busy;
      offer.append(go);
      notices.append(offer);
    }
    if (message) {
      const error = text(message, 'git-checkout__error');
      error.setAttribute('role', 'alert');
      notices.append(error);
      if (messageDetails) {
        const details = document.createElement('details');
        details.className = 'git-checkout__details';
        const summary = document.createElement('summary');
        summary.textContent = 'Technical details';
        const pre = document.createElement('pre');
        pre.textContent = messageDetails;
        details.append(summary, pre);
        notices.append(details);
      }
    }
    const saved = state.savedChanges.find((entry) => entry.branch === state.branch);
    if (saved) {
      const offer = document.createElement('div');
      offer.className = 'git-checkout__restore';
      offer.append(text(`Saved changes on ${saved.branch}`, 'git-checkout__title'));
      offer.append(text(`${saved.fileCount} ${saved.fileCount === 1 ? 'file' : 'files'} saved, including staged and new files.`, 'git-checkout__detail'));
      const restoreBtn = button(busy ? 'Working…' : 'Restore changes', 'git-checkout__action', () => void restore(saved), 'undo');
      restoreBtn.disabled = busy;
      offer.append(restoreBtn);
      notices.append(offer);
    }
  }
  function renderRows(list: HTMLElement) {
    list.replaceChildren();
    const needle = query.toLocaleLowerCase();
    if (tab === 'branches') {
      const branches = [
        ...state.branches.map((branch) => ({ branch, label: branch, remote: false })),
        ...[...new Set((state.remoteBranches ?? []).filter((ref) => !isSkippedRemoteRef(ref)).map(displayRemoteRef))]
          .map((ref) => ({ branch: shortLocalNameFromRemote(ref), label: ref, remote: true })),
      ];
      const matches = branches.filter(({ label }) => label.toLocaleLowerCase().includes(needle));
      matches.sort((a, b) => {
        const byRemote = Number(a.remote) - Number(b.remote);
        const byMain = Number(b.label === 'main') - Number(a.label === 'main');
        return byRemote || byMain || branchNameOrder.compare(a.label, b.label);
      });
      const branchRow = ({ branch, label, remote }: { branch: string; label: string; remote: boolean }) => {
        const create = remote && !state.branches.includes(branch);
        const wt = state.worktrees.find((w) => w.branch === branch && !panelPathsEqual(w.path, state.cwd));
        const current = branch === state.branch;
        const row = button('', 'git-checkout__item', () => {
          if (current) resetSelection();
          else if (wt) void selectWorktree(wt.path);
          else void requestSwitch({ branch, cwd: state.cwd, expectedBranch: state.branch, ...(create ? { create: true, startPoint: label } : {}) });
        }, current ? 'check' : 'gitBranch');
        row.disabled = busy;
        if (current) row.setAttribute('aria-current', 'true');
        const identity = document.createElement('span');
        identity.className = 'git-checkout__identity';
        identity.append(text(label, 'git-checkout__branch'));
        if (current || wt) identity.append(text(current ? 'Current branch' : `Open in ${worktreeName(wt)}`, 'git-checkout__detail'));
        row.append(identity);
        if (remote) row.append(text('remote', 'git-checkout__tag'));
        if (state.savedChanges.some((s) => s.branch === branch)) row.append(text('Saved changes', 'git-checkout__tag'));
        return row;
      };
      // Shortcuts to the branches last used here; the full list follows unchanged.
      const recent = needle ? [] : (recentByCheckout.get(recentKey(state.cwd)) ?? [])
        .filter((name) => name !== state.branch && state.branches.includes(name))
        .slice(0, RECENT_LIMIT);
      if (recent.length) {
        list.append(text('Recent', 'git-checkout__group'));
        for (const name of recent) list.append(branchRow({ branch: name, label: name, remote: false }));
        if (matches.length) list.append(text('All branches', 'git-checkout__group'));
      }
      for (const match of matches) list.append(branchRow(match));
    } else if (tab === 'worktrees') {
      for (const wt of state.worktrees.filter((w) => `${w.branch} ${w.path}`.toLocaleLowerCase().includes(needle))) {
        const current = panelPathsEqual(wt.path, state.cwd);
        const row = button('', 'git-checkout__item', () => void selectWorktree(wt.path), current ? 'check' : 'gitWorktree');
        row.disabled = busy;
        if (current) row.setAttribute('aria-current', 'true');
        const identity = document.createElement('span');
        identity.className = 'git-checkout__identity';
        identity.append(text(worktreeName(wt), 'git-checkout__title'), text(wt.branch || 'Detached HEAD', 'git-checkout__branch'), text(wt.path, 'git-checkout__detail'));
        row.append(identity);
        if (current) row.append(text('Current', 'git-checkout__tag'));
        list.append(row);
      }
    } else {
      const result = pulls?.result;
      if (!result?.ok) {
        const status = text(result ? result.error ?? 'Could not load pull requests.' : 'Loading pull requests…', 'git-checkout__empty');
        status.setAttribute('role', 'status');
        list.append(status);
        if (result) {
          const retry = button('Retry', 'git-checkout__action', () => {
            pulls = undefined;
            renderRows(list);
            focusSearch();
            void loadPullRequests(result.status?.supported === false);
          }, 'refresh');
          retry.disabled = busy;
          list.append(retry);
        }
        return;
      }
      for (const pr of result.prs ?? []) {
        if (!`#${pr.number} ${pr.title} ${pr.headRef}`.toLocaleLowerCase().includes(needle)) continue;
        // Same-repo PRs check out under their head name; fork heads say nothing locally.
        const sameName = !pr.crossRepository;
        const current = sameName && pr.headRef === state.branch;
        const wt = sameName && !current
          ? state.worktrees.find((w) => w.branch === pr.headRef && !panelPathsEqual(w.path, state.cwd))
          : undefined;
        const row = button('', 'git-checkout__item', () => {
          if (wt) void selectWorktree(wt.path);
          else void requestSwitch({
            branch: pr.headRef,
            pullRequest: {
              number: pr.number, url: pr.url, headRef: pr.headRef,
              ...(pr.headRefOid ? { headRefOid: pr.headRefOid } : {}),
              ...(pr.crossRepository !== undefined ? { crossRepository: pr.crossRepository } : {}),
            },
            cwd: state.cwd, expectedBranch: state.branch,
          });
        }, current ? 'check' : pr.draft ? 'gitPullRequestDraft' : 'gitPullRequest');
        row.disabled = busy;
        if (current) row.setAttribute('aria-current', 'true');
        const identity = document.createElement('span');
        identity.className = 'git-checkout__identity';
        const where = current ? ' · Checked out here' : wt ? ` · Open in ${worktreeName(wt)}` : '';
        identity.append(text(`#${pr.number} ${pr.title}`, 'git-checkout__title'), text(`${pr.headRef}${where}`, 'git-checkout__detail'));
        row.append(identity);
        if (pr.draft) row.append(text('Draft', 'git-checkout__tag'));
        if (pr.crossRepository) row.append(text('Fork', 'git-checkout__tag'));
        list.append(row);
      }
      if (!list.childElementCount) list.append(text(query ? 'No matching pull requests' : 'No open pull requests', 'git-checkout__empty'));
      return;
    }
    if (!list.childElementCount) list.append(text(query ? 'No matching checkouts' : 'No checkouts available', 'git-checkout__empty'));
  }
  function render() {
    const currentWt = state.worktrees.find((w) => panelPathsEqual(w.path, state.cwd));
    trigger.replaceChildren(createIcon('gitBranch', { size: 18 }));
    const identity = document.createElement('span');
    identity.className = 'git-checkout__identity';
    identity.append(text(state.branch || 'Loading checkout…', 'git-checkout__branch'), text(busy ? 'Working…' : worktreeName(currentWt), 'git-checkout__detail'));
    trigger.append(identity, createIcon('chevronDown', { size: 14 }));
    trigger.setAttribute('aria-label', `Choose checkout, ${state.branch || 'loading'}, ${worktreeName(currentWt)}`);
    trigger.setAttribute('aria-expanded', String(open));
    trigger.disabled = busy || !state.branch;
    root.setAttribute('aria-busy', String(busy));
    renderNotices();
    menu.hidden = !open;
    if (open && !options.inline) markPreviewOccluder(menu, 'menu');
    else unmarkPreviewOccluder(menu);
    menu.replaceChildren();
    if (!open) return;
    if (pending) {
      const heading = document.createElement('h3');
      heading.className = 'git-checkout__heading';
      const target = pending.pullRequest ? `PR #${pending.pullRequest.number}` : pending.branch;
      heading.textContent = `Switch to ${target}?`;
      const detail = text(`You have ${pendingCount} uncommitted ${pendingCount === 1 ? 'file' : 'files'} on ${pending.expectedBranch}.`, 'git-checkout__detail');
      menu.append(heading, detail);
      for (const [choice, title, description, icon] of [
        ['bring', 'Bring my changes', `Continue working on these files on ${target}.`, 'arrowUp'],
        ['leave', `Leave changes on ${pending.expectedBranch}`, 'Save in a stash. Offer to restore when I return.', 'gitStash'],
      ] as const) {
        const row = button('', 'git-checkout__choice', () => void requestSwitch({ ...pending!, dirtyHandling: choice }), icon);
        row.disabled = busy;
        const copy = document.createElement('span');
        copy.append(text(title, 'git-checkout__title'), text(description, 'git-checkout__detail'));
        row.append(copy);
        menu.append(row);
      }
      const cancel = button(busy ? 'Switching…' : 'Cancel switch', 'git-checkout__action', resetSelection);
      cancel.disabled = busy;
      menu.append(cancel);
      return;
    }
    const tabs = document.createElement('div');
    tabs.className = 'git-checkout__tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Checkout type');
    for (const [type, label] of checkoutTabs) {
      const tabBtn = button(label, 'git-checkout__tab', () => { tab = type; query = ''; render(); focusSearch(); });
      tabBtn.id = `${id}Tab-${type}`;
      tabBtn.setAttribute('role', 'tab');
      tabBtn.setAttribute('aria-selected', String(tab === type));
      tabBtn.setAttribute('aria-controls', `${id}List`);
      tabBtn.disabled = busy;
      tabs.append(tabBtn);
    }
    const searchField = document.createElement('div');
    searchField.className = 'git-checkout__search';
    const search = document.createElement('input');
    search.type = 'search';
    search.value = query;
    const [, tabLabel, placeholder] = checkoutTabs.find(([type]) => type === tab)!;
    search.placeholder = placeholder;
    search.setAttribute('aria-label', `Search ${tabLabel.toLowerCase()}`);
    search.disabled = busy;
    searchField.append(search);
    const list = document.createElement('div');
    list.className = 'git-checkout__list';
    list.id = `${id}List`;
    list.setAttribute('role', 'tabpanel');
    list.setAttribute('aria-labelledby', `${id}Tab-${tab}`);
    search.addEventListener('input', () => { query = search.value; renderRows(list); });
    search.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); list.querySelector<HTMLButtonElement>('button')?.focus(); } });
    tabs.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const index = checkoutTabs.findIndex(([type]) => type === tab);
        tab = checkoutTabs[(index + (e.key === 'ArrowRight' ? 1 : checkoutTabs.length - 1)) % checkoutTabs.length][0];
        query = '';
        render();
        menu.querySelector<HTMLButtonElement>(`#${id}Tab-${tab}`)?.focus();
      }
    });
    renderRows(list);
    const hint = text(options.inline ? '↑↓ move · Enter switch · ←→ tabs' : '↑↓ move · Enter switch · ←→ tabs · Esc close', 'git-checkout__hint');
    hint.setAttribute('aria-hidden', 'true');
    menu.append(tabs, searchField, list, hint);
    if (tab === 'pulls') {
      void loadPullRequests();
      return;
    }
    if (options.inline) return;
    const footer = document.createElement('div');
    footer.className = 'git-checkout__footer';
    const add = button(tab === 'branches' ? 'New branch…' : 'Add worktree…', 'git-checkout__action', () => {
      const selectedTab = tab; close();
      if (selectedTab === 'branches') options.onNewBranch(trigger); else options.onNewWorktree(trigger);
    }, 'plus');
    const remove = button(tab === 'branches' ? 'Delete current branch…' : 'Remove current worktree…', 'git-checkout__action', () => {
      const selectedTab = tab; close();
      if (selectedTab === 'branches') options.onDeleteBranch(); else options.onRemoveWorktree();
    }, 'trash');
    remove.disabled = busy || (tab === 'branches' ? !state.branch || /^(main|master)$/.test(state.branch) : panelPathsEqual(state.cwd, state.workspace));
    add.disabled = busy;
    footer.append(add, remove);
    if (tab === 'worktrees') footer.append(text('Each worktree keeps its own files and changes.', 'git-checkout__detail'));
    menu.append(footer);
  }
  const outside = (e: PointerEvent) => { if (!root.contains(e.target as Node)) close(); };
  if (!options.inline) document.addEventListener('pointerdown', outside);
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !options.inline) { e.preventDefault(); close(); trigger.focus(); }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && (e.target as HTMLElement).matches('.git-checkout__item')) {
      e.preventDefault();
      const rows = Array.from(menu.querySelectorAll<HTMLButtonElement>('.git-checkout__item'));
      const index = rows.indexOf(e.target as HTMLButtonElement);
      rows[(index + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus();
    }
  });
  render();
  return {
    root, requestSwitch, close, focusSearch,
    update(next: CheckoutPickerState) {
      if (JSON.stringify(next) === JSON.stringify(state)) return;
      const cwdChanged = !panelPathsEqual(next.cwd, state.cwd);
      const moved = cwdChanged || next.branch !== state.branch;
      const branchesChanged = JSON.stringify([next.branches, next.remoteBranches]) !== JSON.stringify([state.branches, state.remoteBranches]);
      state = next;
      if (cwdChanged) pulls = undefined;
      if (moved) { open = Boolean(options.inline); pending = undefined; message = ''; messageDetails = ''; movedTo = undefined; blocked = undefined; query = ''; if (!busy) pendingComplete = undefined; }
      // A poll must not steal focus from a user searching or choosing an action.
      if (!open || moved) render();
      else {
        renderNotices();
        const list = menu.querySelector<HTMLElement>('.git-checkout__list');
        if (list && tab === 'branches' && branchesChanged) {
          const focused = list.contains(document.activeElement)
            ? document.activeElement?.querySelector('.git-checkout__branch')?.textContent
            : undefined;
          renderRows(list);
          if (focused) [...list.querySelectorAll<HTMLButtonElement>('button')]
            .find((row) => row.querySelector('.git-checkout__branch')?.textContent === focused)?.focus();
        }
      }
    },
    dispose() { disposed = true; document.removeEventListener('pointerdown', outside); root.remove(); },
  };
}
