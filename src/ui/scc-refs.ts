import { appConfirm } from './app-dialog';
import {
  gitBranches,
  gitCheckout,
  gitDeleteBranch,
  gitMerge,
  gitStashApply,
  gitStashDrop,
  gitStashList,
  gitStashPop,
  gitStashPush,
  gitWorktreeAdd,
  gitWorktreeRemove,
  type GitOpResult,
} from '../state/git-api';
import { getWorkspacePath } from '../state/workspace';
import { listWorktrees } from '../state/worktree-service';
import {
  filterUserFacingBranches,
  filterUserFacingWorktrees,
  getPrincipalWorktree,
  parseWorktreeListPorcelain,
  type ParsedWorktree,
  worktreePathsEqual,
} from '../lib/worktree-list-parse';
import { expandGitmojiShortcodes } from '../lib/gitmoji-shortcodes.mjs';
import { isProtectedBranchName, resolveTrunkBranchName } from '../lib/git-trunk-branch';
import { panelPathsEqual } from './panel-worktree-cwd';
import { confirmDirtyCheckout } from './git-checkout-confirm';
import { openGitPanelNamePopover, openGitRefNamePopover } from './git-panel-name-popover';
import { gitUiCtx, inferGitUiLabel, runGitUiOp } from './git-ui-op';
import { showToast } from './toast';
import {
  button,
  chip,
  el,
  emptyState,
  errorStrip,
  listNavigator,
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
      if (event.key === 'Enter') {
        event.preventDefault();
        options.onActivate!();
      }
    });
  }
  return row;
}

// ── Branches ─────────────────────────────────────────────────────────────────

export function createBranchesView(ctx: SccContext): SccView {
  const root = el('div', 'scc-list-view');
  const toolbar = el('div', 'scc-list-view__toolbar');
  const body = el('div', 'scc-list-view__body');
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
    onClick: () =>
      openGitRefNamePopover({
        anchor: newBranchBtn,
        title: 'New branch',
        kind: 'branch',
        cwd: ctx.getCwd(),
        defaultPath: ctx.getCwd() || getWorkspacePath(),
        reserved: [ctx.getBranch(), 'main', 'master'],
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
      }),
  });

  toolbar.append(search, remoteToggle, newBranchBtn);

  async function refresh(): Promise<void> {
    if (destroyed) return;
    if (!body.firstChild) body.appendChild(skeletonRows(8));

    const result = await gitBranches(ctx.getCwd());
    if (destroyed) return;

    if (!result.ok) {
      body.replaceChildren(errorStrip(result.error ?? 'Could not list branches', () => void refresh()));
      return;
    }

    const current = result.current ?? '';
    const locals = filterUserFacingBranches(result.local ?? []);
    const remotes = showRemote ? (result.remote ?? []) : [];
    const trunk = resolveTrunkBranchName(locals, result.remote ?? [], result.lockedLocal ?? []);

    ctx.setBadge('branches', locals.length ? { kind: 'count', value: locals.length } : null);

    const visibleLocals = locals.filter((name) => !filter || name.toLowerCase().includes(filter));
    const visibleRemotes = remotes.filter((name) => !filter || name.toLowerCase().includes(filter));

    if (visibleLocals.length === 0 && visibleRemotes.length === 0) {
      body.replaceChildren(
        filter
          ? emptyState({ title: 'No branches match', body: `Nothing named like “${filter}”.` })
          : emptyState({
              icon: 'gitBranch',
              title: 'One branch only',
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

    if (visibleLocals.length) {
      frag.appendChild(groupHead('Local', visibleLocals.length));
      for (const name of visibleLocals) {
        frag.appendChild(buildLocalRow(name, current, trunk));
      }
    }
    if (visibleRemotes.length) {
      frag.appendChild(groupHead('Remote', visibleRemotes.length));
      for (const name of visibleRemotes) {
        frag.appendChild(buildRemoteRow(name));
      }
    }
    body.replaceChildren(frag);
  }

  function buildLocalRow(name: string, current: string, trunk: string): HTMLElement {
    const isCurrent = name === current;
    const actions: HTMLElement[] = [];

    if (!isCurrent) {
      actions.push(
        button({
          label: 'Checkout',
          onClick: () => void checkout(name),
        }),
      );
      actions.push(
        button({
          label: 'Merge in',
          title: `Merge ${name} into ${current || 'the current branch'}`,
          variant: 'ghost',
          onClick: () => void mergeIn(name, current),
        }),
      );
    }

    actions.push(
      button({
        icon: 'trash',
        title: isProtectedBranchName(name) ? 'Protected branch' : `Delete ${name}`,
        variant: 'ghost',
        className: 'scc-btn--danger-hover',
        onClick: () => void deleteBranch(name, current, trunk),
      }),
    );
    if (isProtectedBranchName(name)) {
      (actions[actions.length - 1] as HTMLButtonElement).disabled = true;
    }

    const meta: (HTMLElement | string)[] = [];
    if (name === trunk && !isCurrent) meta.push(chip('trunk', 'trunk'));

    return refRow({
      name,
      current: isCurrent,
      meta,
      actions,
      onActivate: isCurrent ? undefined : () => void checkout(name),
    });
  }

  function buildRemoteRow(name: string): HTMLElement {
    const local = name.replace(/^[^/]+\//, '');
    return refRow({
      name,
      meta: [chip('remote', 'remote')],
      actions: [
        button({
          label: 'Check out locally',
          variant: 'ghost',
          onClick: () =>
            void run(
              () => gitCheckout({ branch: local, create: true, startPoint: name, cwd: ctx.getCwd() }),
              ctx,
              `Checked out ${local}`,
            ),
        }),
      ],
    });
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

  async function refresh(): Promise<void> {
    if (destroyed) return;

    const workspace = getWorkspacePath().trim();
    const result = await listWorktrees();
    if (destroyed) return;

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

      frag.appendChild(
        refRow({
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
        }),
      );
    }
    body.replaceChildren(frag);
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
