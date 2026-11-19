import { appConfirm } from './app-dialog';
import { isUnmergedBranchDelete } from './git-branch-delete';
import {
  gitBranches,
  gitBranchTree,
  gitDeleteBranch,
  gitDeleteRemoteBranch,
  gitMerge,
  gitStashApply,
  gitStashDrop,
  gitStashList,
  gitStashPop,
  gitStashPush,
  gitStatus,
  gitWorktreeAdd,
  gitWorktreeRemove,
  type GitBranchTreeEntry,
  type GitOpResult,
} from '../state/git-api';
import { getWorkspacePath } from '../state/workspace';
import { getChatMirrorBinding } from '../state/chat-worktree';
import { listWorktrees } from '../state/worktree-service';
import {
  filterUserFacingWorktrees,
  getPrincipalWorktree,
  parseWorktreeListPorcelain,
  type ParsedWorktree,
  worktreePathsEqual,
} from '../lib/worktree-list-parse';
import { expandGitmojiShortcodes } from '../lib/gitmoji-shortcodes.mjs';
import { describeWorktreeIssue, worktreeKey, worktreeOrigin, type WorktreeIssue } from '../lib/worktree-issues';
import type { Chat } from '../types';
import { isProtectedBranchName } from '../lib/git-trunk-branch';
import { displayRemoteRef, isSkippedRemoteRef } from '../lib/git-ref-start.mjs';
import { panelPathsEqual } from './panel-worktree-cwd';
import { checkoutBranchWithChoice, checkoutRecoveryActions } from './git-checkout-confirm';
import { chatsBoundToWorktree, detachChatsFromRemovedWorktree } from './chat-checkout-guard';
import { displayWorktreeTitle } from './worktree-display';
import { openGitPanelNamePopover, openGitRefNamePopover } from './git-panel-name-popover';
import { gitUiCtx, inferGitUiLabel, runGitUiOp, type GitUiOpResult } from './git-ui-op';
import { createIcon } from './icon';
import { showToast, type NotifyAction } from './toast';
import {
  button,
  chip,
  el,
  emptyState,
  errorStrip,
  listNavigator,
  pageBar,
  relativeTime,
  searchBox,
  skeletonRows,
  type SccContext,
  type SccView,
} from './scc-shared';

/** List sections share the page bar; the bar root keeps the toolbar class for bulk selection. */
function listBar(title: string) {
  const bar = pageBar(title);
  bar.root.classList.add('scc-list-view__toolbar');
  return bar;
}

async function run(
  fn: () => Promise<GitOpResult>,
  ctx: SccContext,
  successMessage?: string,
  recoveryActions?: (result: GitUiOpResult) => NotifyAction[],
): Promise<boolean> {
  const result = await runGitUiOp(fn, {
    label: inferGitUiLabel(successMessage),
    successMessage,
    ctx: gitUiCtx(ctx.getCwd(), ctx.getBranch()),
    recoveryActions,
  });
  if (!result.ok) return false;
  await ctx.refreshAll();
  return true;
}

/** Row scaffold shared by all three sections. */
function refRow(options: {
  name: string;
  meta?: (HTMLElement | string)[];
  current?: boolean;
  actions: HTMLElement[];
  onActivate?: () => void;
  prose?: boolean;
}): HTMLElement {
  const row = el('div', options.prose ? 'scc-refrow scc-refrow--prose' : 'scc-refrow');
  row.tabIndex = 0;
  if (options.current) row.classList.add('is-current');

  const main = el('div', 'scc-refrow__main');
  const name = el('span', 'scc-refrow__name', options.name);
  main.appendChild(name);
  if (options.current) main.appendChild(chip('checked out', 'current'));

  if (options.meta?.length) {
    const meta = el('div', 'scc-refrow__meta');
    for (const item of options.meta) {
      meta.appendChild(typeof item === 'string' ? el('span', undefined, item) : item);
    }
    main.appendChild(meta);
  }

  const actions = el('div', 'scc-refrow__actions');
  actions.append(...options.actions);

  row.append(main, actions);

  if (options.onActivate) {
    row.addEventListener('dblclick', options.onActivate);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target === row) {
        event.preventDefault();
        options.onActivate!();
      }
    });
  }
  return row;
}

// ── Branches ─────────────────────────────────────────────────────────────────

interface SelectionFailure {
  key: string;
  label: string;
  result: GitOpResult;
}

/**
 * Selection is scoped to the visible rows and captured before confirmation.
 * `onFailures` takes over reporting (it runs before the refresh, so rows can
 * paint their own explanation); without it failures collect in one strip.
 */
function refSelection(
  toolbar: HTMLElement,
  ctx: SccContext,
  kind: string,
  options: { onFailures?: (failures: SelectionFailure[]) => void } = {},
) {
  const selected = new Set<string>();
  const entries = new Map<string, { label: string; remove?: () => Promise<GitOpResult>; forceRemove?: () => Promise<GitOpResult>; row: HTMLElement }>();
  let busy = false;
  let scope: string | undefined;
  let failureStrip: HTMLElement | undefined;
  let anchor: string | undefined;
  const progress = el('div', 'scc-list-view__progress');
  progress.setAttribute('role', 'status');
  progress.setAttribute('aria-live', 'polite');
  progress.hidden = true;
  toolbar.after(progress);
  const deleteBtn = button({
    label: 'Delete selected', variant: 'ghost', className: 'scc-list-view__bulk-delete scc-btn--danger-hover',
    onClick: () => void removeSelected(),
  });
  (toolbar.querySelector('.scc-bar__actions') ?? toolbar).prepend(deleteBtn);
  function targets() {
    return [...entries].filter(([key, entry]) => selected.has(key) && entry.remove)
      .map(([key, entry]) => ({ key, ...entry, remove: entry.remove! }));
  }
  function update() {
    const count = targets().length;
    toolbar.parentElement?.classList.toggle('has-selection', busy || count > 0);
    toolbar.parentElement?.setAttribute('aria-busy', String(busy));
    deleteBtn.textContent = count ? `Delete selected (${count})` : 'Delete selected';
    deleteBtn.disabled = busy || !count;
    for (const [key, entry] of entries) {
      entry.row.classList.toggle('is-selected', selected.has(key));
      entry.row.setAttribute('aria-selected', String(selected.has(key)));
    }
  }
  function select(key: string, event: MouseEvent | KeyboardEvent) {
    if (busy) return;
    const additive = event.ctrlKey || event.metaKey;
    const keys = [...entries.keys()];
    if (event.shiftKey && anchor && entries.has(anchor)) {
      if (!additive) selected.clear();
      const from = keys.indexOf(anchor);
      const to = keys.indexOf(key);
      for (const item of keys.slice(Math.min(from, to), Math.max(from, to) + 1)) selected.add(item);
    } else {
      if (!additive) selected.clear();
      if (additive && selected.has(key)) selected.delete(key); else selected.add(key);
      anchor = key;
    }
    update();
  }
  async function removeSelected() {
    if (busy) return;
    const batch = targets();
    if (!batch.length) return;
    busy = true;
    update();
    try {
      if (!await appConfirm(`Delete these ${kind}? ${kind === 'branches' ? 'Remote branches are deleted on the remote server.' : 'Worktree folders are removed; branches are kept.'}\n\n${batch.map((entry) => entry.label).join('\n')}`, {
        title: `Delete ${batch.length} ${kind}`, confirmLabel: 'Delete', danger: true,
      })) return;
      failureStrip?.remove();
      const failures: SelectionFailure[] = [];
      const fail = (target: { key: string; label: string }, result: GitOpResult) =>
        failures.push({ key: target.key, label: target.label, result });
      const unmerged: typeof batch = [];
      progress.hidden = false;
      await runGitUiOp(async () => {
        for (const [index, target] of batch.entries()) {
          progress.textContent = `Deleting ${kind}: ${index + 1} of ${batch.length} · ${target.label}`;
          try {
            const result = await target.remove();
            if (result.ok) selected.delete(target.key);
            else if (target.forceRemove && isUnmergedBranchDelete(result)) unmerged.push(target);
            else fail(target, result);
          } catch (error) {
            fail(target, { ok: false, error: String(error) });
          }
          update();
        }
        // Report individual failures together below, keeping the batch running.
        return { ok: true };
      }, { label: `Deleting ${batch.length} ${kind}…`, skipSuccessToast: true });
      if (unmerged.length) {
        progress.hidden = true;
        const force = await appConfirm(`These branches have commits that are not fully merged. Force delete them?\n\n${unmerged.map((target) => target.label).join('\n')}`, {
          title: 'Force delete branches', confirmLabel: 'Force delete', danger: true,
        });
        if (force) {
          progress.hidden = false;
          await runGitUiOp(async () => {
            for (const [index, target] of unmerged.entries()) {
              progress.textContent = `Force deleting branches: ${index + 1} of ${unmerged.length} · ${target.label}`;
              try {
                const result = await target.forceRemove!();
                if (result.ok) selected.delete(target.key);
                else fail(target, result);
              } catch (error) {
                fail(target, { ok: false, error: String(error) });
              }
              update();
            }
            return { ok: true };
          }, { label: `Force deleting ${unmerged.length} branches…`, skipSuccessToast: true });
        } else {
          for (const target of unmerged) fail(target, { ok: false, error: 'Not deleted (not fully merged)' });
        }
      }
      options.onFailures?.(failures);
      progress.textContent = 'Refreshing…';
      await ctx.refreshAll();
      showToast(`Deleted ${batch.length - failures.length} of ${batch.length} ${kind}`, failures.length ? 'error' : 'success');
      if (failures.length && !options.onFailures) {
        failureStrip = errorStrip(failures.map((f) => `${f.label}: ${f.result.error ?? 'Deletion failed'}`).join('\n'));
        progress.after(failureStrip);
      }
    } finally {
      progress.hidden = true;
      progress.textContent = '';
      busy = false;
      update();
    }
  }
  update();
  return {
    begin() {
      const nextScope = ctx.getCwd() ?? getWorkspacePath();
      if (scope !== nextScope) {
        selected.clear();
        anchor = undefined;
      }
      scope = nextScope;
      entries.clear();
    },
    end() {
      for (const key of selected) if (!entries.has(key)) selected.delete(key);
      if (anchor && !entries.has(anchor)) anchor = undefined;
      update();
    },
    add(row: HTMLElement, key: string, label: string, remove?: () => Promise<GitOpResult>, forceRemove?: () => Promise<GitOpResult>) {
      if (!row.hasAttribute('role')) row.setAttribute('role', 'treeitem');
      entries.set(key, { label, remove, forceRemove, row });
      row.addEventListener('click', (event) => {
        if (busy) {
          event.stopImmediatePropagation();
          event.preventDefault();
          return;
        }
        if ((event.target as Element).closest('button, input, a')) return;
        select(key, event);
        row.focus();
      }, true);
      row.addEventListener('dblclick', (event) => {
        if (busy || event.ctrlKey || event.metaKey || event.shiftKey || (event.target as Element).closest('button, input, a')) {
          event.stopImmediatePropagation();
          event.preventDefault();
        }
      }, true);
      row.addEventListener('keydown', (event) => {
        if (busy) {
          event.stopImmediatePropagation();
          event.preventDefault();
          return;
        }
        if (event.target !== row) return;
        if (event.key === ' ') {
          event.preventDefault();
          select(key, event);
        } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
          event.preventDefault();
          for (const item of entries.keys()) selected.add(item);
          update();
        } else if (event.key === 'Escape') {
          selected.clear();
          anchor = undefined;
          update();
        }
      }, true);
      return row;
    },
  };
}

export interface BranchTreeNode {
  entry: GitBranchTreeEntry;
  children: BranchTreeNode[];
}

/**
 * Parent links → forest. The trunk leads, other roots follow; siblings are
 * ordered by most recent commit so active work sits near its base.
 */
export function buildBranchForest(entries: readonly GitBranchTreeEntry[], trunk?: string): BranchTreeNode[] {
  const nodes = new Map(entries.map((entry) => [entry.name, { entry, children: [] as BranchTreeNode[] }]));
  const roots: BranchTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.entry.parent ? nodes.get(node.entry.parent) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  const recent = (a: BranchTreeNode, b: BranchTreeNode) =>
    (Date.parse(b.entry.date) || 0) - (Date.parse(a.entry.date) || 0) || a.entry.name.localeCompare(b.entry.name);
  const sort = (list: BranchTreeNode[]) => {
    list.sort(recent);
    for (const node of list) sort(node.children);
  };
  sort(roots);
  const trunkAt = roots.findIndex((node) => node.entry.name === trunk);
  if (trunkAt > 0) roots.unshift(...roots.splice(trunkAt, 1));
  return roots;
}

/** Collapsed branch names survive re-renders and section switches, per repo. */
const collapsedByRepo = new Map<string, Set<string>>();

export function createBranchesView(ctx: SccContext): SccView {
  const root = el('div', 'scc-list-view');
  const bar = listBar('Branches');
  const toolbar = bar.root;
  const body = el('div', 'scc-list-view__body');
  body.setAttribute('role', 'tree');
  body.setAttribute('aria-label', 'Branches');
  body.setAttribute('aria-multiselectable', 'true');
  root.append(toolbar, body);

  let destroyed = false;
  let filter = '';

  const searchField = searchBox('Filter branches');
  const search = searchField.input;
  search.classList.add('scc-search');
  search.addEventListener('input', () => {
    filter = search.value.trim().toLowerCase();
    void refresh();
  });

  const newBranchBtn = button({
    label: 'New branch',
    icon: 'plus',
    variant: 'primary',
    onClick: () => openNewBranch(newBranchBtn),
  });

  bar.controls.append(searchField.root);
  bar.actions.append(newBranchBtn);
  const selection = refSelection(toolbar, ctx, 'branches');
  let refreshVersion = 0;
  /** What the rows were last built from; polling the same data leaves them alone. */
  let renderedFrom = '';

  function collapsedSet(): Set<string> {
    const key = ctx.getCwd() ?? getWorkspacePath();
    let set = collapsedByRepo.get(key);
    if (!set) collapsedByRepo.set(key, (set = new Set()));
    return set;
  }

  function openNewBranch(anchor: HTMLElement, from?: string): void {
    const cwd = ctx.getCwd() ?? getWorkspacePath();
    const expectedBranch = ctx.getBranch() || undefined;
    openGitRefNamePopover({
      anchor,
      title: from ? `New branch from ${from}` : 'New branch',
      kind: 'branch',
      cwd,
      defaultPath: cwd,
      reserved: [ctx.getBranch(), 'main', 'master'],
      fixedStartPoint: from,
      onSubmit: async (result) => {
        await checkout(
          result.name,
          `Created and checked out ${result.name}`,
          { cwd, expectedBranch, create: true, startPoint: result.startPoint },
        );
      },
    });
  }

  async function refresh(): Promise<void> {
    if (destroyed) return;
    if (!body.firstChild) body.appendChild(skeletonRows(8));

    const version = ++refreshVersion;
    const cwd = ctx.getCwd();
    const [tree, refs] = await Promise.all([
      gitBranchTree(cwd),
      gitBranches(cwd),
    ]);
    if (destroyed || version !== refreshVersion) return;
    const source = JSON.stringify([
      cwd, tree, refs.ok ? [refs.current, refs.local, refs.remote, refs.lockedLocal] : refs.error,
      filter, [...collapsedSet()],
    ]);
    if (source === renderedFrom && body.querySelector('.scc-refrow, .scc-empty')) return;
    renderedFrom = source;
    selection.begin();

    if (!tree.ok) {
      selection.end();
      body.replaceChildren(errorStrip(tree.error ?? 'Could not list branches', () => void refresh()));
      return;
    }

    const entries = tree.branches ?? [];
    const current = tree.current ?? '';
    const trunk = tree.trunk || 'main';
    const remotes = [...new Set((refs.ok ? refs.remote ?? [] : [])
      .filter((name) => !isSkippedRemoteRef(name))
      .map(displayRemoteRef))];
    const tracked = new Map(entries.filter((entry) => entry.upstream).map((entry) => [entry.upstream!, entry.name]));

    const count = entries.length + remotes.length;
    ctx.setBadge('branches', count ? { kind: 'count', value: count } : null);
    bar.count.textContent = `${entries.length} local · ${remotes.length} remote`;

    const matches = (name: string) => !filter || name.toLowerCase().includes(filter);
    const forest = buildBranchForest(entries, trunk);
    const visibleRemotes = remotes.filter(matches);
    const shown = new Set<string>();
    const markShown = (node: BranchTreeNode): boolean => {
      let any = matches(node.entry.name);
      for (const child of node.children) any = markShown(child) || any;
      if (any) shown.add(node.entry.name);
      return any;
    };
    forest.forEach(markShown);

    if (shown.size === 0 && visibleRemotes.length === 0) {
      selection.end();
      body.replaceChildren(
        filter
          ? emptyState({ title: 'No branches match', body: `Nothing named like “${filter}”.` })
          : emptyState({
              icon: 'gitBranch',
              title: 'No branches yet',
              body: 'Create a branch to work without touching the trunk.',
              action: button({
                label: 'New branch',
                variant: 'primary',
                onClick: () => newBranchBtn.click(),
              }),
            }),
      );
      return;
    }

    const frag = document.createDocumentFragment();
    const collapsed = collapsedSet();

    if (shown.size) {
      frag.appendChild(groupHead('Local', entries.filter((entry) => shown.has(entry.name)).length));
      const walk = (nodes: BranchTreeNode[], guides: boolean[], isRoot: boolean) => {
        const visible = nodes.filter((node) => shown.has(node.entry.name));
        visible.forEach((node, i) => {
          const last = i === visible.length - 1;
          const { entry } = node;
          const hasChildren = node.children.some((child) => shown.has(child.entry.name));
          // A filter always opens the path to its matches.
          const open = Boolean(filter) || !collapsed.has(entry.name);
          const row = buildTreeRow({
            node, current, trunk, guides, last, hasChildren, open, isRoot,
            context: !matches(entry.name),
          });
          if (entry.name !== current && !entry.worktree && !isProtectedBranchName(entry.name)) {
            selection.add(row, `local:${entry.name}`, `Local: ${entry.name}`,
              () => gitDeleteBranch({ branch: entry.name, cwd }),
              () => gitDeleteBranch({ branch: entry.name, force: true, cwd }));
          } else {
            selection.add(row, `local:${entry.name}`, `Local: ${entry.name}`);
          }
          frag.appendChild(row);
          // Roots draw no connector, so their children start at guide column zero.
          if (hasChildren && open) walk(node.children, isRoot ? [] : [...guides, !last], false);
        });
      };
      for (const rootNode of forest.filter((node) => shown.has(node.entry.name))) {
        walk([rootNode], [], true);
      }
    }
    if (visibleRemotes.length) {
      frag.appendChild(groupHead('Remote', visibleRemotes.length));
      for (const name of visibleRemotes) {
        const row = buildRemoteRow(name, tracked.get(name));
        if (!isProtectedBranchName(name.replace(/^[^/]+\//, '')) && !name.endsWith('/HEAD')) {
          selection.add(row, `remote:${name}`, `Remote: ${name}`, () => gitDeleteRemoteBranch({ branch: name, cwd }));
        } else {
          selection.add(row, `remote:${name}`, `Remote: ${name}`);
        }
        frag.appendChild(row);
      }
    }
    body.replaceChildren(frag);
    selection.end();
  }

  function buildTreeRow(options: {
    node: BranchTreeNode;
    current: string;
    trunk: string;
    guides: boolean[];
    last: boolean;
    hasChildren: boolean;
    open: boolean;
    isRoot: boolean;
    context: boolean;
  }): HTMLElement {
    const { node, current, trunk, guides, last, hasChildren, open, isRoot } = options;
    const { entry } = node;
    const isCurrent = entry.name === current;

    const row = el('div', 'scc-refrow scc-btree__row');
    row.tabIndex = 0;
    row.dataset.branch = entry.name;
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(guides.length + (isRoot ? 1 : 2)));
    if (hasChildren) row.setAttribute('aria-expanded', String(open));
    if (isCurrent) row.classList.add('is-current');
    if (options.context) row.classList.add('is-context');
    if (entry.merged) row.classList.add('is-merged');

    // Tree guides: one column per ancestor level, then this node's elbow.
    const indent = el('span', 'scc-btree__indent');
    indent.setAttribute('aria-hidden', 'true');
    if (!isRoot) {
      for (const continues of guides) {
        indent.appendChild(el('span', continues ? 'scc-btree__guide is-line' : 'scc-btree__guide'));
      }
      indent.appendChild(el('span', last ? 'scc-btree__guide is-elbow is-last' : 'scc-btree__guide is-elbow'));
    }

    let twisty: HTMLElement;
    if (hasChildren) {
      twisty = el('button', 'scc-btree__twisty');
      (twisty as HTMLButtonElement).type = 'button';
      twisty.appendChild(createIcon(open ? 'chevronDown' : 'chevronRight', { size: 12 }));
      twisty.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} ${entry.name}`);
      twisty.title = `${node.children.length} branch${node.children.length === 1 ? '' : 'es'} off ${entry.name}`;
      twisty.addEventListener('click', (event) => {
        event.stopPropagation();
        toggle(entry.name, !open);
      });
      twisty.addEventListener('dblclick', (event) => event.stopPropagation());
    } else {
      twisty = el('span', 'scc-btree__twisty is-leaf');
    }

    const main = el('div', 'scc-refrow__main scc-btree__main');
    const name = el('span', 'scc-refrow__name', entry.name);
    name.title = entry.name;
    main.appendChild(name);
    if (isCurrent) main.appendChild(chip('checked out', 'current'));
    if (entry.name === trunk && isRoot) main.appendChild(chip('trunk', 'trunk'));
    const worktreeLeaf = entry.worktreePath?.split(/[\\/]/).filter(Boolean).pop();
    if (entry.worktree) {
      const tag = chip(worktreeLeaf ? `in ${worktreeLeaf}` : 'in worktree', 'branch');
      if (entry.worktreePath) tag.title = `Checked out at ${entry.worktreePath}`;
      main.appendChild(tag);
    }
    if (entry.merged) main.appendChild(chip('merged', 'merged'));
    if (hasChildren && !open) main.appendChild(el('span', 'scc-btree__hidden', `+${countDescendants(node)}`));

    const sync = el('span', 'scc-btree__sync');
    if (!isRoot && !entry.merged && (entry.ahead || entry.behind)) {
      sync.title = `${plural(entry.ahead, 'commit')} ahead of ${entry.parent}, ${entry.behind} behind`;
      sync.append(
        el('span', entry.ahead ? 'scc-btree__ahead' : 'scc-btree__zero', `↑${entry.ahead}`),
        el('span', entry.behind ? 'scc-btree__behind' : 'scc-btree__zero', `↓${entry.behind}`),
      );
    }

    const remote = el('span', 'scc-btree__remote');
    if (!entry.upstream) {
      remote.textContent = 'local only';
      remote.title = 'No upstream branch — push to publish it';
    } else if (entry.upstreamGone) {
      remote.textContent = 'upstream gone';
      remote.classList.add('is-warn');
      remote.title = `${entry.upstream} was deleted on the remote`;
    } else if (entry.upstreamAhead || entry.upstreamBehind) {
      const parts: string[] = [];
      if (entry.upstreamAhead) parts.push(`${entry.upstreamAhead} to push`);
      if (entry.upstreamBehind) parts.push(`${entry.upstreamBehind} to pull`);
      remote.textContent = parts.join(' · ');
      remote.classList.add('is-pending');
      remote.title = `Compared with ${entry.upstream}`;
    }

    const commit = el('div', 'scc-btree__commit');
    commit.append(el('span', 'scc-btree__subject', entry.subject), remote);
    commit.title = `${entry.sha.slice(0, 8)} ${entry.subject}`;
    const when = el('span', 'scc-btree__time', relativeTime(entry.date));
    if (entry.date) when.title = new Date(entry.date).toLocaleString();

    const actions = el('div', 'scc-refrow__actions');
    const openHere = entry.worktree && entry.worktreePath && ctx.openWorktree
      ? () => void ctx.openWorktree!(entry.worktreePath!).then(() => ctx.refreshAll())
      : undefined;
    if (!isCurrent && openHere) {
      actions.appendChild(button({
        label: 'Open worktree',
        title: `${entry.name} is checked out at ${entry.worktreePath}. Work there.`,
        onClick: openHere,
      }));
    } else if (!isCurrent) {
      const checkoutBtn = button({
        label: 'Checkout',
        title: entry.worktree ? `${entry.name} is checked out in another worktree` : `Switch to ${entry.name}`,
        onClick: () => void checkout(entry.name),
      });
      checkoutBtn.disabled = entry.worktree;
      actions.appendChild(checkoutBtn);
    }
    const branchFrom = button({
      icon: 'gitBranch',
      title: `New branch from ${entry.name}`,
      variant: 'ghost',
      onClick: () => openNewBranch(branchFrom, entry.name),
    });
    actions.appendChild(branchFrom);
    if (!isCurrent) {
      actions.appendChild(button({
        icon: 'gitMerge',
        title: `Merge ${entry.name} into ${current || 'the current branch'}`,
        variant: 'ghost',
        onClick: () => void mergeIn(entry.name, current),
      }));
    }
    const protectedBranch = isProtectedBranchName(entry.name);
    const deleteBtn = button({
      icon: 'trash',
      title: protectedBranch ? 'Protected branch' : entry.worktree ? 'Remove its worktree first' : `Delete ${entry.name}`,
      variant: 'ghost',
      className: 'scc-btn--danger-hover',
      onClick: () => void deleteBranch(entry.name, current, trunk),
    });
    deleteBtn.disabled = protectedBranch || entry.worktree;
    actions.appendChild(deleteBtn);

    row.append(indent, twisty, main, commit, sync, when, actions);

    if (!isCurrent && !entry.worktree) {
      row.addEventListener('dblclick', () => void checkout(entry.name));
    } else if (!isCurrent && openHere) {
      row.addEventListener('dblclick', openHere);
    }
    row.addEventListener('keydown', (event) => {
      if (event.target !== row) return;
      if (event.key === 'Enter' && !isCurrent && !entry.worktree) {
        event.preventDefault();
        void checkout(entry.name);
      } else if (event.key === 'Enter' && !isCurrent && openHere) {
        event.preventDefault();
        openHere();
      } else if (event.key === 'ArrowRight' && hasChildren && !open) {
        event.preventDefault();
        toggle(entry.name, true);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (hasChildren && open) toggle(entry.name, false);
        else if (entry.parent) focusBranch(entry.parent);
      }
    });
    return row;
  }

  function toggle(name: string, open: boolean): void {
    const collapsed = collapsedSet();
    if (open) collapsed.delete(name);
    else collapsed.add(name);
    void refresh().then(() => focusBranch(name));
  }

  function focusBranch(name: string): void {
    const row = [...body.querySelectorAll<HTMLElement>('.scc-btree__row')].find((node) => node.dataset.branch === name);
    row?.focus();
    row?.scrollIntoView({ block: 'nearest' });
  }

  function buildRemoteRow(name: string, trackedBy?: string): HTMLElement {
    const local = name.replace(/^[^/]+\//, '');
    const meta: (HTMLElement | string)[] = [chip('remote', 'remote')];
    if (trackedBy) meta.push(`tracked by ${trackedBy}`);
    const actions: HTMLElement[] = [];
    if (!trackedBy) {
      actions.push(button({
        label: 'Check out locally',
        variant: 'ghost',
        onClick: () => void checkout(local, `Checked out ${local}`, { create: true, startPoint: name }),
      }));
    }
    const deleteBtn = button({
      icon: 'trash', title: `Delete remote branch ${name}`, variant: 'ghost',
      className: 'scc-btn--danger-hover',
      onClick: async () => {
        const cwd = ctx.getCwd();
        if (!await appConfirm(`Delete ${name} on the remote server?`, {
          title: 'Delete remote branch', confirmLabel: 'Delete', danger: true,
        })) return;
        await run(() => gitDeleteRemoteBranch({ branch: name, cwd }), ctx, `Deleted ${name}`);
      },
    });
    deleteBtn.disabled = isProtectedBranchName(local) || local === 'HEAD';
    actions.push(deleteBtn);
    return refRow({ name, meta, actions });
  }

  async function checkout(
    name: string,
    message = `Switched to ${name}`,
    input: Omit<Parameters<typeof checkoutBranchWithChoice>[0], 'branch'> = {},
  ): Promise<boolean> {
    const cwd = input.cwd ?? ctx.getCwd() ?? getWorkspacePath();
    const expectedBranch = input.expectedBranch ?? (ctx.getBranch() || undefined);
    return run(
      () => checkoutBranchWithChoice(
        { ...input, cwd, expectedBranch, branch: name },
        () => !destroyed && worktreePathsEqual(cwd, ctx.getCwd() ?? getWorkspacePath()),
        { openWorktree: ctx.openWorktree, shared: ctx.sharedCheckout?.() },
      ),
      ctx,
      message,
      (failed) => checkoutRecoveryActions(failed, { cwd, openWorktree: ctx.openWorktree }),
    );
  }

  async function mergeIn(name: string, current: string): Promise<void> {
    const confirmed = await appConfirm(`Merge ${name} into ${current || 'the current branch'}?`, {
      title: 'Merge branch',
      confirmLabel: 'Merge',
    });
    if (!confirmed) return;

    const result = await runGitUiOp(() => gitMerge({ branch: name, cwd: ctx.getCwd() }), {
      label: 'Merging…',
      successMessage: `Merged ${name}`,
      chatKind: 'merge',
      ctx: gitUiCtx(ctx.getCwd(), ctx.getBranch()),
    });
    if (!result.ok) return;
    await ctx.refreshAll();
  }

  async function deleteBranch(name: string, current: string, trunk: string): Promise<void> {
    if (isProtectedBranchName(name)) return;

    if (name === current) {
      if (!trunk || trunk === name) {
        showToast('Cannot delete the branch you are on', 'error');
        return;
      }
      const move = await appConfirm(`Switch to ${trunk} and delete ${name}?`, {
        title: 'Delete branch',
        confirmLabel: 'Switch and delete',
        danger: true,
      });
      if (!move) return;
      const switched = await checkout(trunk);
      if (!switched) return;
    } else {
      const confirmed = await appConfirm(`Delete branch ${name}?`, {
        title: 'Delete branch',
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!confirmed) return;
    }

    const cwd = ctx.getCwd();
    const deleted = await runGitUiOp(
      () => gitDeleteBranch({ branch: name, cwd }),
      { successMessage: `Deleted ${name}`, ctx: gitUiCtx(cwd, ctx.getBranch()), handlesError: isUnmergedBranchDelete },
    );
    if (deleted.ok) {
      await ctx.refreshAll();
      return;
    }
    if (!isUnmergedBranchDelete(deleted)) return;

    const force = await appConfirm(`${name} has commits that are not merged. Delete it anyway?`, {
      title: 'Force delete branch',
      confirmLabel: 'Force delete',
      danger: true,
    });
    if (!force) return;
    await run(
      () => gitDeleteBranch({ branch: name, force: true, cwd }),
      ctx,
      `Deleted ${name}`,
    );
  }

  const navigate = listNavigator({ getRows: () => [...body.querySelectorAll<HTMLElement>('.scc-refrow')] });

  void refresh();

  return {
    root,
    refresh,
    onKey: (event) => (event.target === search ? false : navigate(event)),
    activate: () => search.focus(),
    destroy: () => {
      destroyed = true;
      root.remove();
    },
  };
}

// ── Stashes ──────────────────────────────────────────────────────────────────

/** Parse `stash@{0}: WIP on main: 1a2b3c subject` into its parts. */
export function parseStashEntry(line: string, index: number): {
  ref: string;
  branch: string;
  subject: string;
} {
  const text = String(line ?? '').trim();
  const match = /^(stash@\{\d+\}):\s*(?:WIP on|On)\s+([^:]+):\s*(.*)$/.exec(text);
  if (match) {
    return { ref: match[1]!, branch: match[2]!.trim(), subject: match[3]!.trim() };
  }
  const colon = text.indexOf(':');
  return {
    ref: colon > 0 ? text.slice(0, colon) : `stash@{${index}}`,
    branch: '',
    subject: colon > 0 ? text.slice(colon + 1).trim() : text,
  };
}

export function createStashesView(ctx: SccContext): SccView {
  const root = el('div', 'scc-list-view');
  const bar = listBar('Stashes');
  const body = el('div', 'scc-list-view__body');
  root.append(bar.root, body);

  let destroyed = false;

  const stashBtn = button({
    label: 'Stash changes',
    icon: 'gitStash',
    variant: 'primary',
    onClick: () =>
      openGitPanelNamePopover({
        anchor: stashBtn,
        title: 'Stash changes',
        label: 'Description',
        placeholder: 'work in progress',
        onSubmit: async (message) => {
          await run(
            () => gitStashPush({ message, cwd: ctx.getCwd() }),
            ctx,
            'Stashed working tree changes',
          );
        },
      }),
  });
  bar.actions.appendChild(stashBtn);
  let renderedFrom = '';

  async function refresh(): Promise<void> {
    if (destroyed) return;
    if (!body.firstChild) body.appendChild(skeletonRows(4));

    const cwd = ctx.getCwd();
    const result = await gitStashList(cwd);
    if (destroyed) return;
    const source = JSON.stringify([cwd, result]);
    if (source === renderedFrom && body.querySelector('.scc-refrow, .scc-empty')) return;
    renderedFrom = source;

    if (!result.ok) {
      body.replaceChildren(errorStrip(result.error ?? 'Could not list stashes', () => void refresh()));
      return;
    }

    const stashes = result.stashes ?? [];
    ctx.setBadge('stashes', stashes.length ? { kind: 'count', value: stashes.length } : null);
    bar.count.textContent = stashes.length ? String(stashes.length) : '';

    if (stashes.length === 0) {
      body.replaceChildren(
        emptyState({
          icon: 'gitStash',
          title: 'No stashes',
          body: 'A stash parks uncommitted work so you can switch branches with a clean tree. Pop it to bring the work back.',
        }),
      );
      return;
    }

    const frag = document.createDocumentFragment();
    stashes.forEach((line, index) => {
      const { ref, branch, subject } = parseStashEntry(line, index);
      const meta: (HTMLElement | string)[] = [chip(ref, 'sha')];
      if (branch) meta.push(`on ${branch}`);

      frag.appendChild(
        refRow({
          name: expandGitmojiShortcodes(subject) || ref,
          prose: true,
          meta,
          actions: [
            button({
              label: 'Pop',
              title: 'Apply and remove this stash',
              onClick: () =>
                void run(() => gitStashPop({ index, cwd: ctx.getCwd() }), ctx, 'Popped stash'),
            }),
            button({
              label: 'Apply',
              title: 'Apply and keep this stash',
              variant: 'ghost',
              onClick: () =>
                void run(() => gitStashApply({ index, cwd: ctx.getCwd() }), ctx, 'Applied stash'),
            }),
            button({
              icon: 'trash',
              title: 'Drop this stash',
              variant: 'ghost',
              className: 'scc-btn--danger-hover',
              onClick: () => void drop(index, expandGitmojiShortcodes(subject) || ref),
            }),
          ],
        }),
      );
    });
    body.replaceChildren(frag);
  }

  async function drop(index: number, label: string): Promise<void> {
    const confirmed = await appConfirm(`Drop “${label}”? Stashed changes are lost.`, {
      title: 'Drop stash',
      confirmLabel: 'Drop',
      danger: true,
    });
    if (!confirmed) return;
    await run(() => gitStashDrop({ index, cwd: ctx.getCwd() }), ctx, 'Dropped stash');
  }

  const navigate = listNavigator({ getRows: () => [...body.querySelectorAll<HTMLElement>('.scc-refrow')] });

  void refresh();

  return {
    root,
    refresh,
    onKey: navigate,
    destroy: () => {
      destroyed = true;
      root.remove();
    },
  };
}

// ── Worktrees ────────────────────────────────────────────────────────────────

export function createWorktreesView(
  ctx: SccContext,
  options: { onSelectWorktree: (path: string) => void },
): SccView {
  const root = el('div', 'scc-list-view');
  const bar = listBar('Worktrees');
  const toolbar = bar.root;
  const body = el('div', 'scc-list-view__body');
  body.setAttribute('role', 'tree');
  body.setAttribute('aria-label', 'Worktrees');
  body.setAttribute('aria-multiselectable', 'true');
  root.append(toolbar, body);

  let destroyed = false;

  const addBtn = button({
    label: 'Add worktree',
    icon: 'plus',
    variant: 'primary',
    onClick: () =>
      openGitRefNamePopover({
        anchor: addBtn,
        title: 'Add worktree',
        kind: 'worktree',
        cwd: ctx.getCwd(),
        defaultPath: ctx.getCwd() || getWorkspacePath(),
        reserved: [ctx.getBranch(), 'main', 'master'],
        onSubmit: async (result) => {
          const addResult = await runGitUiOp(
            () =>
              gitWorktreeAdd({
                branch: result.name,
                baseRef: result.checkoutExisting ? undefined : result.startPoint,
                checkoutExisting: result.checkoutExisting,
                cwd: ctx.getCwd(),
              }),
            {
              label: 'Adding worktree…',
              successMessage: `Worktree for ${result.name} added`,
              ctx: gitUiCtx(ctx.getCwd(), ctx.getBranch()),
            },
          );
          if (!addResult.ok) return;
          if (addResult.path) options.onSelectWorktree(addResult.path);
          await ctx.refreshAll();
        },
      }),
  });
  bar.actions.appendChild(addBtn);
  /** Last failed removal per worktree, so the row can say why and offer the fix. */
  const failures = new Map<string, GitOpResult>();
  const selection = refSelection(toolbar, ctx, 'worktrees', {
    onFailures: (list) => {
      for (const failure of list) failures.set(worktreeKey(failure.key), failure.result);
    },
  });
  const notice = el('div', 'scc-wtnotice');
  notice.setAttribute('role', 'status');
  notice.hidden = true;
  root.insertBefore(notice, body);
  let refreshVersion = 0;
  let renderedFrom = '';
  let lastStatusTargets: { path: string; slot: HTMLElement }[] = [];
  let unchangedPolls = 0;

  async function refresh(): Promise<void> {
    if (destroyed) return;

    const project = getWorkspacePath().trim();
    const cwd = ctx.getCwd();
    const version = ++refreshVersion;
    const result = await listWorktrees(cwd);
    if (destroyed || version !== refreshVersion) return;

    // Same worktrees, same chats, same failures: keep the rows (and the selection).
    // Their file and sync counts are re-read every sixth poll (about 30s).
    const listed = result.ok && result.output ? parseWorktreeListPorcelain(result.output) : [];
    const principal = getPrincipalWorktree(listed);
    // A project with a Git checkout inside it has a principal checkout for each repo.
    const projectIsCheckout = listed.some(wt => panelPathsEqual(wt.path, project));
    const workspace = projectIsCheckout ? project : principal?.path ?? cwd ?? project;
    const source = JSON.stringify([
      result.ok, result.output, result.missing, ctx.getCwd() ?? workspace, [...failures.keys()],
      listed.map((wt) => chatsBoundToWorktree(wt.path).map((chat) => chat.id)),
    ]);
    if (source === renderedFrom && body.querySelector('.scc-refrow')) {
      if (++unchangedPolls % 6 === 0) void paintWorktreeStatus(lastStatusTargets, version);
      return;
    }
    renderedFrom = source;
    unchangedPolls = 0;
    selection.begin();
    if (!result.ok) {
      selection.end();
      body.replaceChildren(errorStrip(result.error ?? 'Could not list worktrees', () => void refresh()));
      return;
    }

    const worktrees: ParsedWorktree[] =
      listed.length > 0
        ? filterUserFacingWorktrees(listed, workspace)
        : workspace
          ? [{ path: workspace, head: '', branch: undefined, detached: false }]
          : [];

    ctx.setBadge('worktrees', worktrees.length > 1 ? { kind: 'count', value: worktrees.length } : null);
    bar.count.textContent = String(worktrees.length);

    if (worktrees.length === 0) {
      selection.end();
      body.replaceChildren(
        emptyState({ icon: 'gitWorktree', title: 'No worktrees', body: 'Open a repository to see its worktrees.' }),
      );
      return;
    }

    const active = ctx.getCwd() ?? workspace;
    const frag = document.createDocumentFragment();
    const statusTargets: { path: string; slot: HTMLElement }[] = [];
    const missingKeys = new Set((result.missing ?? []).map(worktreeKey));
    const listedKeys = new Set(worktrees.map((worktree) => worktreeKey(worktree.path)));
    for (const key of failures.keys()) if (!listedKeys.has(key)) failures.delete(key);
    const stale: ParsedWorktree[] = [];
    let blocked = 0;

    for (const worktree of worktrees) {
      const isWorkspace = Boolean(workspace && panelPathsEqual(worktree.path, workspace));
      const isPrincipal = Boolean(
        principal?.path && worktreePathsEqual(worktree.path, principal.path),
      );
      const isActive = panelPathsEqual(worktree.path, active);
      const key = worktreeKey(worktree.path);
      const removable = !isPrincipal && !isWorkspace;
      const missing = removable && (missingKeys.has(key) || worktree.prunable === true);
      const origin = worktreeOrigin(worktree.path);
      const issue = removable
        ? describeWorktreeIssue({
            path: worktree.path,
            missing,
            locked: worktree.locked,
            lockReason: worktree.lockReason,
            failure: failures.get(key),
          })
        : null;
      if (issue?.kind === 'stale') stale.push(worktree);
      else if (issue) blocked += 1;

      const meta: (HTMLElement | string)[] = [];
      if (worktree.branch) meta.push(chip(worktree.branch, 'branch'));
      else if (worktree.detached) meta.push(chip('detached', 'warn'));
      if (isPrincipal) meta.push(chip('main worktree', 'trunk'));
      else if (isWorkspace) meta.push(chip('workspace', 'trunk'));
      if (origin && removable) {
        const tag = chip(origin.label);
        tag.title = origin.hint;
        meta.push(tag);
      }
      if (missing) {
        const tag = chip('folder missing', 'warn');
        tag.title = 'The folder was deleted, but Git still has a record of this worktree.';
        meta.push(tag);
      }
      if (worktree.locked) {
        const tag = chip('locked', 'warn');
        tag.title = worktree.lockReason ? `Locked: ${worktree.lockReason}` : 'Locked';
        meta.push(tag);
      }
      const bound = isWorkspace ? [] : chatsBoundToWorktree(worktree.path);
      if (bound.length) {
        const tag = chip(`${bound.length} ${bound.length === 1 ? 'chat' : 'chats'}`, 'branch');
        tag.title = `Used by ${bound.map((chat) => chat.name || 'Untitled chat').join(', ')}`;
        meta.push(tag);
      }
      // Filled after paint: uncommitted files and sync state, so removal is an informed choice.
      const statusSlot = el('span', 'scc-refrow__wtstatus');
      statusSlot.hidden = true;
      meta.push(statusSlot);
      if (!missing) statusTargets.push({ path: worktree.path, slot: statusSlot });
      meta.push(el('span', 'scc-refrow__path', worktree.path));

      const actions: HTMLElement[] = [];
      if (bound.length) {
        const chat = [...bound].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
        actions.push(button({
          label: 'Open chat',
          title: `Open ${chat.name || 'the chat'} that works in this checkout`,
          variant: 'ghost',
          onClick: () => void openChat(chat.id),
        }));
      }
      if (!isActive && !missing) {
        actions.push(
          button({
            label: 'Browse checkout',
            onClick: () => {
              options.onSelectWorktree(worktree.path);
            },
          }),
        );
      }
      if (removable && !bound.some(chat => getChatMirrorBinding(chat)?.repos.some(repo => worktreePathsEqual(repo.path, worktree.path)))) {
        if (!missing && ctx.newThreadInCheckout) actions.push(button({
          label: 'New thread here',
          title: 'New thread in this checkout',
          variant: 'ghost',
          onClick: () => void ctx.newThreadInCheckout?.(worktree.path, worktree.branch),
        }));
        actions.push(
          button({
            icon: 'trash',
            title: 'Remove this worktree',
            variant: 'ghost',
            className: 'scc-btn--danger-hover',
            onClick: () => void remove(worktree.path, workspace, missing),
          }),
        );
      }

      const row = refRow({
          name: displayWorktreeTitle(worktree, { principalPath: principal?.path, workspaceRoot: workspace }),
          current: isActive,
          meta,
          actions,
          onActivate: isActive || missing
            ? undefined
            : () => options.onSelectWorktree(worktree.path),
        });
      if (issue) {
        row.classList.add('has-issue');
        row.querySelector('.scc-refrow__main')!.appendChild(issueLine(issue, worktree, workspace));
      }
      if (removable) {
        selection.add(row, worktree.path, worktree.path, async () => {
          const using = chatsBoundToWorktree(worktree.path);
          // A missing folder has nothing left to protect, so its leftover lock goes too.
          const result = await gitWorktreeRemove({
            path: worktree.path,
            cwd: workspace || undefined,
            ...(missing ? { unlock: true } : {}),
          });
          if (result.ok) {
            failures.delete(key);
            if (panelPathsEqual(worktree.path, ctx.getCwd() ?? workspace)) options.onSelectWorktree(workspace);
            await detachChatsFromRemovedWorktree(using);
          }
          return result;
        });
      } else {
        selection.add(row, worktree.path, worktree.path);
      }
      frag.appendChild(row);
    }
    body.replaceChildren(frag);
    paintNotice(stale, blocked, workspace);
    selection.end();
    lastStatusTargets = statusTargets;
    void paintWorktreeStatus(statusTargets, version);
  }

  function paintNotice(stale: ParsedWorktree[], blocked: number, workspace: string): void {
    const parts: HTMLElement[] = [];
    if (stale.length) {
      const owners = [...new Set(stale.map((wt) => worktreeOrigin(wt.path)?.label).filter(Boolean))];
      const line = el('div', 'scc-wtnotice__line');
      line.append(
        createIcon('warning', { className: 'scc-wtnotice__icon', size: 14 }),
        el('span', 'scc-wtnotice__text',
          `${stale.length === 1 ? '1 worktree points' : `${stale.length} worktrees point`} to a deleted folder` +
          `${owners.length ? ` (left by ${owners.join(', ')})` : ''}. Cleaning up removes only Git's record.`),
        button({
          label: stale.length === 1 ? 'Clean up' : `Clean up ${stale.length}`,
          onClick: () => void cleanUpStale(stale, workspace),
        }),
      );
      parts.push(line);
    }
    if (blocked) {
      const line = el('div', 'scc-wtnotice__line');
      line.append(
        createIcon('warning', { className: 'scc-wtnotice__icon', size: 14 }),
        el('span', 'scc-wtnotice__text',
          `${blocked === 1 ? '1 worktree was' : `${blocked} worktrees were`} not removed. Each one says why below.`),
      );
      parts.push(line);
    }
    notice.replaceChildren(...parts);
    notice.hidden = parts.length === 0;
  }

  function issueLine(issue: WorktreeIssue, worktree: ParsedWorktree, workspace: string): HTMLElement {
    const line = el('div', `scc-wtissue scc-wtissue--${issue.kind}`);
    line.append(
      createIcon(issue.kind === 'failed' ? 'statusFail' : 'warning', { className: 'scc-wtissue__icon', size: 14 }),
      el('span', 'scc-wtissue__text', issue.message),
    );
    const actions = el('span', 'scc-wtissue__actions');
    const path = worktree.path;
    const who = worktreeOrigin(path)?.label ?? 'another tool';
    if (issue.kind === 'stale') {
      actions.append(button({
        label: 'Clean up',
        title: 'Remove Git\'s record of this worktree. No files are deleted.',
        onClick: () => void cleanUpStale([worktree], workspace),
      }));
    } else if (issue.kind === 'locked') {
      actions.append(button({
        label: 'Unlock and remove',
        onClick: async () => {
          if (!await appConfirm(
            `${who} locked this worktree. Unlock and remove it only if ${who} is no longer working in it. Uncommitted files are still protected.\n\n${path}`,
            { title: 'Unlock and remove worktree', confirmLabel: 'Unlock and remove', danger: true },
          )) return;
          await removeWith(path, workspace, { unlock: true }, 'Unlocking worktree…');
        },
      }));
    } else if (issue.kind === 'dirty') {
      actions.append(
        button({
          label: 'Review changes',
          title: 'Work in this checkout and open its changes',
          onClick: () => {
            options.onSelectWorktree(path);
            ctx.goTo('changes');
          },
        }),
        button({
          label: 'Force remove',
          variant: 'ghost',
          className: 'scc-btn--danger-hover',
          onClick: async () => {
            if (!await appConfirm(
              `Force remove permanently deletes this worktree's uncommitted and untracked files.\n\n${path}`,
              { title: 'Force remove worktree', confirmLabel: 'Force remove', danger: true },
            )) return;
            await removeWith(path, workspace, { force: true, ...(worktree.locked ? { unlock: true } : {}) }, 'Removing worktree…');
          },
        }),
      );
    } else {
      actions.append(button({
        label: 'Retry',
        variant: 'ghost',
        onClick: () => void removeWith(path, workspace, {}, 'Removing worktree…'),
      }));
    }
    line.append(actions);
    if (issue.detail) {
      const details = el('details', 'scc-wtissue__details');
      details.append(el('summary', undefined, 'Git output'), el('pre', undefined, issue.detail));
      line.append(details);
    }
    return line;
  }

  /** Record (or clear) the outcome on the row, then release what used the checkout. */
  async function settleRemoval(path: string, workspace: string, bound: Chat[], result: GitOpResult): Promise<void> {
    const key = worktreeKey(path);
    if (!result.ok) {
      failures.set(key, result);
      await refresh();
      return;
    }
    failures.delete(key);
    // Move off the removed checkout only once it is actually gone.
    if (panelPathsEqual(path, ctx.getCwd() ?? workspace)) options.onSelectWorktree(workspace);
    const failed = await detachChatsFromRemovedWorktree(bound);
    if (failed.length) showToast(`Could not return ${failed.join(', ')} to Local. Choose a checkout in the chat.`, 'error');
    await ctx.refreshAll();
  }

  async function removeWith(
    path: string,
    workspace: string,
    flags: { force?: boolean; unlock?: boolean },
    label: string,
  ): Promise<GitOpResult> {
    const bound = chatsBoundToWorktree(path);
    const result = await runGitUiOp(
      () => gitWorktreeRemove({ path, cwd: workspace || undefined, ...flags }),
      {
        label,
        successMessage: 'Worktree removed',
        ctx: gitUiCtx(ctx.getCwd(), ctx.getBranch()),
        // The row explains the refusal and offers the fix; no second error card.
        handlesError: () => true,
      },
    );
    await settleRemoval(path, workspace, bound, result);
    return result;
  }

  /**
   * A locked record can be deliberate (Git's advice for worktrees on a removable
   * drive), so locked ones are confirmed; unlocked ones Git would prune anyway.
   */
  async function cleanUpStale(stale: ParsedWorktree[], workspace: string): Promise<void> {
    if (stale.some((wt) => wt.locked)) {
      const list = stale.map((wt) => wt.path).join('\n');
      if (!await appConfirm(
        `Remove Git's record of ${stale.length === 1 ? 'this worktree' : `these ${stale.length} worktrees`}? The folders are already gone, so no files are deleted. Skip any that live on a drive that is disconnected right now.\n\n${list}`,
        { title: 'Clean up missing worktrees', confirmLabel: 'Clean up' },
      )) return;
    }
    let removed = 0;
    const changed: string[] = [];
    await runGitUiOp(async () => {
      for (const wt of stale) {
        const bound = chatsBoundToWorktree(wt.path);
        const result = await gitWorktreeRemove({ path: wt.path, cwd: workspace || undefined, unlock: true })
          .catch((error): GitOpResult => ({ ok: false, error: String(error) }));
        const key = worktreeKey(wt.path);
        if (!result.ok) {
          failures.set(key, result);
          continue;
        }
        failures.delete(key);
        removed += 1;
        changed.push(wt.path);
        await detachChatsFromRemovedWorktree(bound);
      }
      return { ok: true };
    }, { label: `Cleaning up ${stale.length === 1 ? 'worktree' : `${stale.length} worktrees`}…`, skipSuccessToast: true });
    if (changed.some((p) => panelPathsEqual(p, ctx.getCwd() ?? workspace))) options.onSelectWorktree(workspace);
    showToast(
      stale.length === 1 && removed === 1 ? 'Worktree cleaned up' : `Cleaned up ${removed} of ${stale.length} worktrees`,
      removed === stale.length ? 'success' : 'error',
    );
    await ctx.refreshAll();
  }

  /** One at a time: leaves HTTP connections for interactive work. */
  async function paintWorktreeStatus(targets: { path: string; slot: HTMLElement }[], version: number): Promise<void> {
    for (const { path, slot } of targets) {
      const status = await gitStatus(path).catch(() => null);
      if (destroyed || version !== refreshVersion || !slot.isConnected) return;
      if (!status?.ok) continue;
      const changed = new Set([...status.staged ?? [], ...status.unstaged ?? [], ...status.untracked ?? []].map((file) => file.path)).size;
      const parts: HTMLElement[] = [];
      if (changed) {
        const tag = chip(`${changed} changed`, 'warn');
        tag.title = `${changed} uncommitted or untracked ${changed === 1 ? 'file' : 'files'}`;
        parts.push(tag);
      }
      const ahead = status.ahead ?? 0;
      const behind = status.behind ?? 0;
      if (ahead || behind) {
        const sync = chip(`↑${ahead} ↓${behind}`);
        sync.title = `${plural(ahead, 'commit')} to push, ${plural(behind, 'commit')} to pull`;
        parts.push(sync);
      }
      if (!parts.length) continue;
      slot.replaceChildren(...parts);
      slot.hidden = false;
    }
  }

  async function openChat(chatId: string): Promise<void> {
    try {
      const [{ switchChat }, { navigateToCodeChat }] = await Promise.all([import('./sidebar'), import('../os/router')]);
      navigateToCodeChat();
      await switchChat(chatId);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not open the chat', 'error');
    }
  }

  async function remove(path: string, workspace: string, missing: boolean): Promise<void> {
    const bound = chatsBoundToWorktree(path);
    const names = bound.map((chat) => chat.name || 'Untitled chat');
    const chatsLine = bound.length
      ? ` ${bound.length === 1 ? '1 chat uses' : `${bound.length} chats use`} it (${names.slice(0, 3).join(', ')}${names.length > 3 ? ', …' : ''}); ${bound.length === 1 ? 'it returns' : 'they return'} to Local.`
      : '';
    const confirmed = await appConfirm(`Remove the worktree at ${path}?${chatsLine}`, {
      title: 'Remove worktree',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!confirmed) return;

    const attempt = (force: boolean) => runGitUiOp(
      () => gitWorktreeRemove({
        path,
        cwd: workspace || undefined,
        ...(force ? { force: true } : {}),
        // A missing folder has nothing left to protect, so its leftover lock goes too.
        ...(missing ? { unlock: true } : {}),
      }),
      {
        label: 'Removing worktree…',
        successMessage: 'Worktree removed',
        ctx: gitUiCtx(ctx.getCwd(), ctx.getBranch()),
        // Refusals land on the row with their fix; only a dirty tree is offered --force here.
        handlesError: () => true,
      },
    );
    let result = await attempt(false);
    if (!result.ok && result.code === 'dirty') {
      const force = await appConfirm('That worktree has uncommitted or untracked files. Force remove deletes them permanently.', {
        title: 'Force remove worktree',
        confirmLabel: 'Force remove',
        danger: true,
      });
      if (force) result = await attempt(true);
    }
    await settleRemoval(path, workspace, bound, result);
  }

  const navigate = listNavigator({ getRows: () => [...body.querySelectorAll<HTMLElement>('.scc-refrow')] });

  void refresh();

  return {
    root,
    refresh,
    onKey: navigate,
    destroy: () => {
      destroyed = true;
      root.remove();
    },
  };
}

function groupHead(title: string, count: number): HTMLElement {
  const head = el('div', 'scc-list-view__group');
  head.append(el('span', 'scc-list-view__group-title', title), el('span', 'scc-list-view__group-count', String(count)));
  return head;
}

function countDescendants(node: { children: { children: unknown[] }[] }): number {
  let total = 0;
  for (const child of node.children) total += 1 + countDescendants(child as typeof node);
  return total;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
