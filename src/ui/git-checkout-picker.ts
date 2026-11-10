import { createIcon, type IconName } from './icon';
import type { GitCheckoutSwitchInput, GitOpResult, GitSavedCheckoutChanges } from '../state/git-api';
import { panelPathsEqual } from './panel-worktree-cwd';
import type { ParsedWorktree } from '../lib/worktree-list-parse';
import { displayRemoteRef, isSkippedRemoteRef, shortLocalNameFromRemote } from '../lib/git-ref-start.mjs';

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
  root.className = 'git-checkout';
  const id = options.inline ? 'threadCheckout' : 'gitCheckout';
  const trigger = button('', 'git-checkout__trigger', () => {
    open = !open;
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
  let tab: 'branches' | 'worktrees' = 'branches';
  let query = '';
  let busy = false;
  let disposed = false;
  let message = '';
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
  function worktreeName(wt?: ParsedWorktree) {
    const path = wt?.path ?? state.cwd;
    if (panelPathsEqual(path, state.workspace)) return 'Workspace';
    return path.replace(/\\/g, '/').split('/').pop() || 'Worktree';
  }
  function close() {
    if (busy) return;
    open = Boolean(options.inline);
    pending = undefined;
    pendingComplete = undefined;
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
  async function requestSwitch(input: GitCheckoutSwitchInput, onComplete = pendingComplete) {
    if (busy || disposed) return;
    const key = contextKey();
    busy = true;
    message = '';
    render();
    try {
      const result = await options.onSwitch(input);
      if (disposed) return;
      if (result.ok) {
        pending = undefined;
        pendingComplete = undefined;
        open = Boolean(options.inline);
        if (input.cwd && panelPathsEqual(input.cwd, state.cwd)) await onComplete?.();
        return;
      }
      if (contextKey() !== key) return;
      if (result.needsChoice) {
        pending = { ...input, expectedBranch: result.branch };
        pendingComplete = onComplete;
        pendingCount = result.fileCount ?? 0;
        open = true;
      } else {
        message = result.error ?? 'Could not switch branches.';
        pending = undefined;
        open = true;
      }
    } catch (err) {
      if (!disposed && contextKey() === key) message = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
      if (!disposed) {
        render();
        if (pending) menu.querySelector<HTMLButtonElement>('.git-checkout__choice')?.focus();
        else if (options.inline && document.activeElement === document.body) focusSearch();
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
    if (message) {
      const error = text(message, 'git-checkout__error');
      error.setAttribute('role', 'alert');
      notices.append(error);
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
      for (const { branch, label, remote } of branches.filter((entry) => entry.label.toLocaleLowerCase().includes(needle))) {
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
        list.append(row);
      }
    } else {
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
    menu.replaceChildren();
    if (!open) return;
    if (pending) {
      const heading = document.createElement('h3');
      heading.className = 'git-checkout__heading';
      heading.textContent = `Switch to ${pending.branch}?`;
      const detail = text(`You have ${pendingCount} uncommitted ${pendingCount === 1 ? 'file' : 'files'} on ${pending.expectedBranch}.`, 'git-checkout__detail');
      menu.append(heading, detail);
      for (const [choice, title, description, icon] of [
        ['bring', 'Bring my changes', `Continue working on these files on ${pending.branch}.`, 'arrowUp'],
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
    for (const [type, label] of [['branches', 'Branches'], ['worktrees', 'Worktrees']] as const) {
      const tabBtn = button(label, 'git-checkout__tab', () => { tab = type; query = ''; render(); focusSearch(); });
      tabBtn.id = `${id}Tab-${type}`;
      tabBtn.setAttribute('role', 'tab');
      tabBtn.setAttribute('aria-selected', String(tab === type));
      tabBtn.setAttribute('aria-controls', `${id}List`);
      tabBtn.disabled = busy;
      tabs.append(tabBtn);
    }
    const label = document.createElement('label');
    label.className = 'git-checkout__search';
    label.append(text(tab === 'branches' ? 'Find a branch' : 'Find a worktree', 'git-checkout__detail'));
    const search = document.createElement('input');
    search.type = 'search';
    search.value = query;
    search.placeholder = tab === 'branches' ? 'Branch name…' : 'Name or path…';
    search.disabled = busy;
    label.append(search);
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
        tab = tab === 'branches' ? 'worktrees' : 'branches'; query = ''; render();
        menu.querySelector<HTMLButtonElement>(`#${id}Tab-${tab}`)?.focus();
      }
    });
    renderRows(list);
    menu.append(tabs, label, list);
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
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && (e.target as HTMLElement).closest('.git-checkout__list')) {
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
      const moved = !panelPathsEqual(next.cwd, state.cwd) || next.branch !== state.branch;
      const branchesChanged = JSON.stringify([next.branches, next.remoteBranches]) !== JSON.stringify([state.branches, state.remoteBranches]);
      state = next;
      if (moved) { open = Boolean(options.inline); pending = undefined; message = ''; query = ''; if (!busy) pendingComplete = undefined; }
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
