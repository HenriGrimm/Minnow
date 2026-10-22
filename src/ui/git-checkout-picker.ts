import { createIcon, type IconName } from './icon';
import type { GitCheckoutSwitchInput, GitOpResult, GitSavedCheckoutChanges } from '../state/git-api';
import { panelPathsEqual } from './panel-worktree-cwd';
import type { ParsedWorktree } from '../lib/worktree-list-parse';

export interface CheckoutPickerState {
  cwd: string;
  workspace: string;
  branch: string;
  branches: string[];
  worktrees: ParsedWorktree[];
  savedChanges: GitSavedCheckoutChanges[];
}

interface PickerOptions {
  onSwitch(input: GitCheckoutSwitchInput): Promise<GitOpResult>;
  onWorktree(path: string): void;
  onRestore(input: { cwd: string; sha: string; expectedBranch: string }): Promise<GitOpResult>;
  onNewBranch(anchor: HTMLButtonElement): void;
  onNewWorktree(anchor: HTMLButtonElement): void;
  onDeleteBranch(): void;
  onRemoveWorktree(): void;
}

export function createGitCheckoutPicker(options: PickerOptions) {
  const root = document.createElement('div');
  root.className = 'git-checkout';
  const trigger = button('', 'git-checkout__trigger', () => {
    open = !open;
    pending = undefined;
    render();
    if (open) focusSearch();
  });
  trigger.id = 'gitCheckoutTrigger';
  trigger.setAttribute('aria-controls', 'gitCheckoutMenu');
  const menu = document.createElement('div');
  menu.className = 'git-checkout__menu';
  menu.id = 'gitCheckoutMenu';
  menu.setAttribute('role', 'region');
  menu.setAttribute('aria-label', 'Choose a checkout');
  const notices = document.createElement('div');
  notices.className = 'git-checkout__notices';
  notices.setAttribute('aria-live', 'polite');
  root.append(trigger, notices, menu);
  let state: CheckoutPickerState = { cwd: '', workspace: '', branch: '', branches: [], worktrees: [], savedChanges: [] };
  let open = false;
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
    open = false;
    pending = undefined;
    pendingComplete = undefined;
    query = '';
    render();
  }
  function focusSearch() {
    menu.querySelector<HTMLInputElement>('input')?.focus();
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
        open = false;
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
      for (const branch of state.branches.filter((b) => b.toLocaleLowerCase().includes(needle))) {
        const wt = state.worktrees.find((w) => w.branch === branch && !panelPathsEqual(w.path, state.cwd));
        const current = branch === state.branch;
        const row = button('', 'git-checkout__item', () => {
          if (current) { close(); trigger.focus(); }
          else if (wt) { close(); options.onWorktree(wt.path); trigger.focus(); }
          else void requestSwitch({ branch, cwd: state.cwd, expectedBranch: state.branch });
        }, current ? 'check' : 'gitBranch');
        row.disabled = busy;
        const identity = document.createElement('span');
        identity.className = 'git-checkout__identity';
        identity.append(text(branch, 'git-checkout__branch'));
        if (current || wt) identity.append(text(current ? 'Current branch' : `Open in ${worktreeName(wt)}`, 'git-checkout__detail'));
        row.append(identity);
        if (state.savedChanges.some((s) => s.branch === branch)) row.append(text('Saved changes', 'git-checkout__tag'));
        list.append(row);
      }
    } else {
      for (const wt of state.worktrees.filter((w) => `${w.branch} ${w.path}`.toLocaleLowerCase().includes(needle))) {
        const current = panelPathsEqual(wt.path, state.cwd);
        const row = button('', 'git-checkout__item', () => { close(); options.onWorktree(wt.path); trigger.focus(); }, current ? 'check' : 'gitWorktree');
        row.disabled = busy;
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
      const cancel = button(busy ? 'Switching…' : 'Cancel switch', 'git-checkout__action', () => { close(); trigger.focus(); });
      cancel.disabled = busy;
      menu.append(cancel);
      return;
    }
    const tabs = document.createElement('div');
    tabs.className = 'git-checkout__tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Checkout type');
    for (const [id, label] of [['branches', 'Branches'], ['worktrees', 'Worktrees']] as const) {
      const tabBtn = button(label, 'git-checkout__tab', () => { tab = id; query = ''; render(); focusSearch(); });
      tabBtn.id = `gitCheckoutTab-${id}`;
      tabBtn.setAttribute('role', 'tab');
      tabBtn.setAttribute('aria-selected', String(tab === id));
      tabBtn.setAttribute('aria-controls', 'gitCheckoutList');
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
    list.id = 'gitCheckoutList';
    list.setAttribute('role', 'tabpanel');
    list.setAttribute('aria-labelledby', `gitCheckoutTab-${tab}`);
    search.addEventListener('input', () => { query = search.value; renderRows(list); });
    search.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); list.querySelector<HTMLButtonElement>('button')?.focus(); } });
    tabs.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        tab = tab === 'branches' ? 'worktrees' : 'branches'; query = ''; render();
        menu.querySelector<HTMLButtonElement>(`#gitCheckoutTab-${tab}`)?.focus();
      }
    });
    renderRows(list);
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
    menu.append(tabs, label, list, footer);
  }
  const outside = (e: PointerEvent) => { if (!root.contains(e.target as Node)) close(); };
  document.addEventListener('pointerdown', outside);
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); trigger.focus(); }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && (e.target as HTMLElement).closest('.git-checkout__list')) {
      e.preventDefault();
      const rows = Array.from(menu.querySelectorAll<HTMLButtonElement>('.git-checkout__item'));
      const index = rows.indexOf(e.target as HTMLButtonElement);
      rows[(index + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus();
    }
  });
  render();
  return {
    root, requestSwitch, close,
    update(next: CheckoutPickerState) {
      if (JSON.stringify(next) === JSON.stringify(state)) return;
      const moved = !panelPathsEqual(next.cwd, state.cwd) || next.branch !== state.branch;
      state = next;
      if (moved) { open = false; pending = undefined; message = ''; query = ''; if (!busy) pendingComplete = undefined; }
      // A poll must not steal focus from a user searching or choosing an action.
      if (!open || moved) render(); else renderNotices();
    },
    dispose() { disposed = true; document.removeEventListener('pointerdown', outside); root.remove(); },
  };
}
