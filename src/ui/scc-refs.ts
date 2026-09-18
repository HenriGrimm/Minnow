import { appConfirm } from './app-dialog';
import {
  gitBranches,
  gitBranchTree,
  gitCheckout,
  gitDeleteBranch,
  gitDeleteRemoteBranch,
  gitMerge,
  gitStashApply,
  gitStashDrop,
  gitStashList,
  gitStashPop,
  gitStashPush,
  gitWorktreeAdd,
  gitWorktreeRemove,
  type GitBranchTreeEntry,
  type GitOpResult,
} from '../state/git-api';
import { getWorkspacePath } from '../state/workspace';
import { listWorktrees } from '../state/worktree-service';
import {
  filterUserFacingWorktrees,
  getPrincipalWorktree,
  parseWorktreeListPorcelain,
  type ParsedWorktree,
  worktreePathsEqual,
} from '../lib/worktree-list-parse';
import { expandGitmojiShortcodes } from '../lib/gitmoji-shortcodes.mjs';
import { isProtectedBranchName } from '../lib/git-trunk-branch';
import { panelPathsEqual } from './panel-worktree-cwd';
import { confirmDirtyCheckout } from './git-checkout-confirm';
import { openGitPanelNamePopover, openGitRefNamePopover } from './git-panel-name-popover';
import { gitUiCtx, inferGitUiLabel, runGitUiOp } from './git-ui-op';
import { createIcon } from './icon';
import { showToast } from './toast';
import {
  button,
  chip,
  el,
  emptyState,
  errorStrip,
  listNavigator,
  relativeTime,
  skeletonRows,
  type SccContext,
  type SccView,
} from './scc-shared';

async function run(
  fn: () => Promise<GitOpResult>,
  ctx: SccContext,
  successMessage?: string,
): Promise<boolean> {
  const result = await runGitUiOp(fn, {
    label: inferGitUiLabel(successMessage),
    successMessage,
    ctx: gitUiCtx(ctx.getCwd(), ctx.getBranch()),
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
}): HTMLElement {
  const row = el('div', 'scc-refrow');
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

/** Selection is scoped to the visible rows and captured before confirmation. */
function refSelection(toolbar: HTMLElement, ctx: SccContext, kind: string) {
  const selected = new Set<string>();
  const entries = new Map<string, { label: string; remove: () => Promise<GitOpResult>; checkbox: HTMLInputElement }>();
  let busy = false;
  let scope: string | undefined;
  let failureStrip: HTMLElement | undefined;
  const all = el('input');
  all.type = 'checkbox';
  all.setAttribute('aria-label', `Select all deletable ${kind}`);
  all.className = 'scc-list-view__select-all';
  const deleteBtn = button({
    label: 'Delete selected', variant: 'ghost', className: 'scc-list-view__bulk-delete scc-btn--danger-hover',
    onClick: () => void removeSelected(),
  });
  toolbar.append(all, deleteBtn);
  function update() {
    // Bulk controls only appear once something is ticked.
    toolbar.parentElement?.classList.toggle('has-selection', selected.size > 0);
    deleteBtn.textContent = selected.size ? `Delete selected (${selected.size})` : 'Delete selected';
    deleteBtn.disabled = busy || !selected.size;
    all.disabled = busy || !entries.size;
    all.checked = entries.size > 0 && selected.size === entries.size;
    all.indeterminate = selected.size > 0 && selected.size < entries.size;
    for (const [key, entry] of entries) {
      entry.checkbox.checked = selected.has(key);
      entry.checkbox.disabled = busy;
    }
  }
  all.addEventListener('change', () => {
    selected.clear();
    if (all.checked) for (const key of entries.keys()) selected.add(key);
    update();
  });
  async function removeSelected() {
    if (busy) return;
    const targets = [...selected].map((key) => ({ key, ...entries.get(key)! }));
    if (!targets.length) return;
    busy = true;
    update();
    try {
      if (!await appConfirm(`Delete these ${kind}? ${kind === 'branches' ? 'Remote branches are deleted on the remote server.' : 'Worktree folders are removed; branches are kept.'}\n\n${targets.map((entry) => entry.label).join('\n')}`, {
        title: `Delete ${targets.length} ${kind}`, confirmLabel: 'Delete', danger: true,
      })) return;
      failureStrip?.remove();
      const failures: string[] = [];
      for (const target of targets) {
        try {
          const result = await target.remove();
          if (result.ok) selected.delete(target.key);
          else failures.push(`${target.label}: ${result.error ?? 'Deletion failed'}`);
        } catch (error) {
          failures.push(`${target.label}: ${String(error)}`);
        }
      }
      showToast(`Deleted ${targets.length - failures.length} of ${targets.length} ${kind}`, failures.length ? 'error' : 'success');
      await ctx.refreshAll();
      if (failures.length) {
        failureStrip = errorStrip(failures.join('\n'));
        toolbar.after(failureStrip);
      }
    } finally {
      busy = false;
      update();
    }
  }
  update();
  return {
    begin() {
      const nextScope = ctx.getCwd() ?? getWorkspacePath();
      if (scope !== nextScope) selected.clear();
      scope = nextScope;
      entries.clear();
    },
    end() {
      for (const key of selected) if (!entries.has(key)) selected.delete(key);
      update();
    },
    add(row: HTMLElement, key: string, label: string, remove: () => Promise<GitOpResult>) {
      const checkbox = el('input', 'scc-refrow__select');
      checkbox.type = 'checkbox';
      checkbox.setAttribute('aria-label', `Select ${label}`);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.add(key); else selected.delete(key);
        update();
      });
      checkbox.addEventListener('dblclick', (event) => event.stopPropagation());
      entries.set(key, { label, remove, checkbox });
      row.prepend(checkbox);
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
  const toolbar = el('div', 'scc-list-view__toolbar');
  const body = el('div', 'scc-list-view__body');
  body.setAttribute('role', 'tree');
  body.setAttribute('aria-label', 'Branches');
  root.append(toolbar, body);

  let destroyed = false;
  let filter = '';
  let showRemote = false;

  const search = el('input', 'scc-search');
  search.type = 'search';
  search.placeholder = 'Filter branches';
  search.setAttribute('aria-label', 'Filter branches');
  search.addEventListener('input', () => {
    filter = search.value.trim().toLowerCase();
    void refresh();
  });

  const remoteToggle = button({
    label: 'Remote',
    title: 'Show remote-tracking branches',
    variant: 'ghost',
    onClick: () => {
      showRemote = !showRemote;
      remoteToggle.classList.toggle('is-active', showRemote);
      remoteToggle.setAttribute('aria-pressed', String(showRemote));
      void refresh();
    },
  });
  remoteToggle.setAttribute('aria-pressed', 'false');

  const newBranchBtn = button({
    label: 'New branch',
    icon: 'plus',
    variant: 'primary',
    onClick: () => openNewBranch(newBranchBtn),
  });

  toolbar.append(search, remoteToggle, newBranchBtn);
  const selection = refSelection(toolbar, ctx, 'branches');
  let refreshVersion = 0;

  function collapsedSet(): Set<string> {
    const key = ctx.getCwd() ?? getWorkspacePath();
    let set = collapsedByRepo.get(key);
    if (!set) collapsedByRepo.set(key, (set = new Set()));
    return set;
  }

  function openNewBranch(anchor: HTMLElement, from?: string): void {
    openGitRefNamePopover({
      anchor,
      title: from ? `New branch from ${from}` : 'New branch',
      kind: 'branch',
      cwd: ctx.getCwd(),
      defaultPath: ctx.getCwd() || getWorkspacePath(),
      reserved: [ctx.getBranch(), 'main', 'master'],
      fixedStartPoint: from,
      onSubmit: async (result) => {
        await run(
          () =>
            gitCheckout({
              branch: result.name,
              create: true,
              startPoint: result.startPoint,
              cwd: ctx.getCwd(),
            }),
          ctx,
          `Created and checked out ${result.name}`,
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
      showRemote ? gitBranches(cwd) : Promise.resolve(undefined),
    ]);
    if (destroyed || version !== refreshVersion) return;
    selection.begin();

    if (!tree.ok) {
      selection.end();
      body.replaceChildren(errorStrip(tree.error ?? 'Could not list branches', () => void refresh()));
      return;
    }

    const entries = tree.branches ?? [];
    const current = tree.current ?? '';
    const trunk = tree.trunk || 'main';
    const remotes = (refs?.ok ? refs.remote ?? [] : [])
      .filter((name) => !name.includes(' -> '))
      .map((name) => name.replace(/^remotes\//, ''));
    const tracked = new Map(entries.filter((entry) => entry.upstream).map((entry) => [entry.upstream!, entry.name]));

    ctx.setBadge('branches', entries.length ? { kind: 'count', value: entries.length } : null);

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
            selection.add(row, `local:${entry.name}`, `Local: ${entry.name}`, () => gitDeleteBranch({ branch: entry.name, cwd }));
          } else {
            row.prepend(el('span', 'scc-refrow__select-spacer'));
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
          row.prepend(el('span', 'scc-refrow__select-spacer'));
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
    if (entry.worktree) main.appendChild(chip('in worktree', 'branch'));
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
    if (!isCurrent) {
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
    }
    row.addEventListener('keydown', (event) => {
      if (event.target !== row) return;
      if (event.key === 'Enter' && !isCurrent && !entry.worktree) {
        event.preventDefault();
        void checkout(entry.name);
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
        onClick: () =>
          void run(
            () => gitCheckout({ branch: local, create: true, startPoint: name, cwd: ctx.getCwd() }),
            ctx,
            `Checked out ${local}`,
          ),
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

  async function checkout(name: string): Promise<void> {
    if (!(await confirmDirtyCheckout(ctx.getCwd()))) return;
    await run(() => gitCheckout({ branch: name, cwd: ctx.getCwd() }), ctx, `Switched to ${name}`);
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
      const switched = await run(() => gitCheckout({ branch: trunk, cwd: ctx.getCwd() }), ctx);
      if (!switched) return;
    } else {
      const confirmed = await appConfirm(`Delete branch ${name}?`, {
        title: 'Delete branch',
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!confirmed) return;
    }

    const deleted = await run(
      () => gitDeleteBranch({ branch: name, cwd: ctx.getCwd() }),
      ctx,
      `Deleted ${name}`,
    );
    if (deleted) return;

    const force = await appConfirm(`${name} has commits that are not merged. Delete it anyway?`, {
      title: 'Force delete branch',
      confirmLabel: 'Force delete',
      danger: true,
    });
    if (!force) return;
    await run(
      () => gitDeleteBranch({ branch: name, force: true, cwd: ctx.getCwd() }),
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
  const toolbar = el('div', 'scc-list-view__toolbar');
  const body = el('div', 'scc-list-view__body');
  root.append(toolbar, body);

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
  toolbar.appendChild(stashBtn);

  async function refresh(): Promise<void> {
    if (destroyed) return;

    const result = await gitStashList(ctx.getCwd());
    if (destroyed) return;

    if (!result.ok) {
      body.replaceChildren(errorStrip(result.error ?? 'Could not list stashes', () => void refresh()));
      return;
    }

    const stashes = result.stashes ?? [];
    ctx.setBadge('stashes', stashes.length ? { kind: 'count', value: stashes.length } : null);

    if (stashes.length === 0) {
      body.replaceChildren(
        emptyState({
          icon: 'gitStash',
          title: 'No stashes',
          body: 'Stash to park uncommitted work and come back to a clean tree.',
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
  options: { onSelectWorktree: (path: string | undefined) => void },
): SccView {
  const root = el('div', 'scc-list-view');
  const toolbar = el('div', 'scc-list-view__toolbar');
  const body = el('div', 'scc-list-view__body');
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
  toolbar.appendChild(addBtn);
  const selection = refSelection(toolbar, ctx, 'worktrees');
  let refreshVersion = 0;

  async function refresh(): Promise<void> {
    if (destroyed) return;

    const workspace = getWorkspacePath().trim();
    const version = ++refreshVersion;
    const result = await listWorktrees();
    if (destroyed || version !== refreshVersion) return;
    selection.begin();
    if (!result.ok) {
      selection.end();
      body.replaceChildren(errorStrip(result.error ?? 'Could not list worktrees', () => void refresh()));
      return;
    }

    const parsed =
      result.ok && result.output ? parseWorktreeListPorcelain(result.output) : [];
    const principal = getPrincipalWorktree(parsed);
    const worktrees: ParsedWorktree[] =
      parsed.length > 0
        ? filterUserFacingWorktrees(parsed, workspace)
        : workspace
          ? [{ path: workspace, head: '', branch: undefined, detached: false }]
          : [];

    ctx.setBadge('worktrees', worktrees.length > 1 ? { kind: 'count', value: worktrees.length } : null);

    if (worktrees.length === 0) {
      selection.end();
      body.replaceChildren(
        emptyState({ icon: 'gitWorktree', title: 'No worktrees', body: 'Open a repository to see its worktrees.' }),
      );
      return;
    }

    const active = ctx.getCwd() ?? workspace;
    const frag = document.createDocumentFragment();

    for (const worktree of worktrees) {
      const isWorkspace = Boolean(workspace && panelPathsEqual(worktree.path, workspace));
      const isPrincipal = Boolean(
        principal?.path && worktreePathsEqual(worktree.path, principal.path),
      );
      const isActive = panelPathsEqual(worktree.path, active);

      const meta: (HTMLElement | string)[] = [];
      if (worktree.branch) meta.push(chip(worktree.branch, 'branch'));
      else if (worktree.detached) meta.push(chip('detached', 'warn'));
      if (isPrincipal) meta.push(chip('main worktree', 'trunk'));
      else if (isWorkspace) meta.push(chip('workspace', 'trunk'));
      meta.push(worktree.path);

      const actions: HTMLElement[] = [];
      if (!isActive) {
        actions.push(
          button({
            label: 'Work here',
            onClick: () => {
              options.onSelectWorktree(isWorkspace ? undefined : worktree.path);
              void ctx.refreshAll();
            },
          }),
        );
      }
      if (!isPrincipal && !isWorkspace) {
        actions.push(
          button({
            icon: 'trash',
            title: 'Remove this worktree',
            variant: 'ghost',
            className: 'scc-btn--danger-hover',
            onClick: () => void remove(worktree.path, workspace),
          }),
        );
      }

      const row = refRow({
          name: worktree.path.split(/[\\/]/).filter(Boolean).pop() ?? worktree.path,
          current: isActive,
          meta,
          actions,
          onActivate: isActive
            ? undefined
            : () => {
                options.onSelectWorktree(isWorkspace ? undefined : worktree.path);
                void ctx.refreshAll();
              },
        });
      if (!isPrincipal && !isWorkspace) {
        selection.add(row, worktree.path, worktree.path, async () => {
          const result = await gitWorktreeRemove({ path: worktree.path, cwd: workspace || undefined });
          if (result.ok && panelPathsEqual(worktree.path, ctx.getCwd() ?? workspace)) {
            options.onSelectWorktree(undefined);
          }
          return result;
        });
      }
      frag.appendChild(row);
    }
    body.replaceChildren(frag);
    selection.end();
  }

  async function remove(path: string, workspace: string): Promise<void> {
    const confirmed = await appConfirm(`Remove the worktree at ${path}?`, {
      title: 'Remove worktree',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!confirmed) return;

    const from = ctx.getCwd();
    if (panelPathsEqual(path, from ?? workspace)) options.onSelectWorktree(undefined);

    const removed = await run(
      () => gitWorktreeRemove({ path, cwd: workspace || undefined }),
      ctx,
      'Worktree removed',
    );
    if (removed) return;

    const force = await appConfirm('That worktree has uncommitted changes. Remove it anyway?', {
      title: 'Force remove worktree',
      confirmLabel: 'Force remove',
      danger: true,
    });
    if (!force) return;
    await run(
      () => gitWorktreeRemove({ path, force: true, cwd: workspace || undefined }),
      ctx,
      'Worktree removed',
    );
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
