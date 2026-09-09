import { appAlert, appConfirm, appPrompt } from './app-dialog';
/**
 * Right-click context menu for git history graph commit rows.
 */

import { commitUrl } from '../lib/git-remote-url';
import { expandGitmojiShortcodes } from '../lib/gitmoji-shortcodes.mjs';
import { isProtectedBranchName } from '../lib/git-trunk-branch';
import { filterUserFacingBranches } from '../lib/worktree-list-parse';
import {
  gitCheckout,
  gitCheckoutDetach,
  gitCherryPick,
  gitCreateTag,
  gitDeleteBranch,
  gitRemoteUrl,
} from '../state/git-api';
import { confirmDirtyCheckout } from './git-checkout-confirm';
import { openCherryPickDialog } from './git-advanced-actions';
import { extractLocalBranchRefs, type CommitVisual } from './git-graph';
import { openGitPanelNamePopover, openGitRefNamePopover } from './git-panel-name-popover';
import { CAPTURE_MENU_KINDS, legacyCaptureMenuItems } from './issue-capture';
import { gitUiCtx, runGitUiOp } from './git-ui-op';
import { showToast } from './toast';

export interface GitGraphContextMenuCtx {
  cwd?: string;
  onOpenChanges: (sha: string) => void;
  onRefresh: () => void | Promise<void>;
  onConflict?: (message: string, kind: 'cherry-pick') => void;
  getCurrentBranch?: () => string;
  conflictHost?: HTMLElement | null;
}

type MenuItemDef =
  | { kind: 'sep' }
  | {
      kind: 'item';
      label: string;
      disabled?: boolean;
      title?: string;
      action?: () => void;
    }
  | {
      kind: 'submenu';
      label: string;
      disabled?: boolean;
      children: MenuItemDef[];
    };

let menuEl: HTMLDivElement | null = null;
let dismissBound = false;
let activeSubmenuEl: HTMLDivElement | null = null;

// ── Menu shell ───────────────────────────────────────────────────────────────

function hideGitGraphContextMenu(): void {
  activeSubmenuEl?.remove();
  activeSubmenuEl = null;
  if (menuEl) menuEl.hidden = true;
}

function bindDismissOnce(): void {
  if (dismissBound) return;
  dismissBound = true;
  document.addEventListener('click', () => hideGitGraphContextMenu());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideGitGraphContextMenu();
  });
  document.addEventListener('scroll', () => hideGitGraphContextMenu(), { capture: true, passive: true });
}

function ensureMenuElement(): HTMLDivElement {
  if (menuEl) return menuEl;
  menuEl = document.createElement('div');
  menuEl.className = 'git-graph-context-menu';
  menuEl.setAttribute('role', 'menu');
  menuEl.hidden = true;
  document.body.appendChild(menuEl);
  return menuEl;
}

function positionMenu(el: HTMLElement, clientX: number, clientY: number): void {
  const margin = 8;
  el.style.left = `${clientX}px`;
  el.style.top = `${clientY}px`;
  const rect = el.getBoundingClientRect();
  let left = clientX;
  let top = clientY;
  if (left + rect.width > window.innerWidth - margin) {
    left = Math.max(margin, window.innerWidth - rect.width - margin);
  }
  if (top + rect.height > window.innerHeight - margin) {
    top = Math.max(margin, window.innerHeight - rect.height - margin);
  }
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

// ── Items ────────────────────────────────────────────────────────────────────

function renderSubmenuItems(
  container: HTMLElement,
  items: MenuItemDef[],
  onAction: () => void,
): void {
  for (const item of items) {
    if (item.kind === 'sep') {
      const sep = document.createElement('div');
      sep.className = 'git-graph-context-menu__sep';
      sep.setAttribute('role', 'separator');
      container.appendChild(sep);
      continue;
    }

    if (item.kind === 'submenu') {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'git-graph-context-menu__item git-graph-context-menu__item--submenu';
      row.setAttribute('role', 'menuitem');
      row.disabled = Boolean(item.disabled);
      row.textContent = item.label;
      const arrow = document.createElement('span');
      arrow.className = 'git-graph-context-menu__submenu-arrow';
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '›';
      row.appendChild(arrow);
      container.appendChild(row);
      continue;
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'git-graph-context-menu__item';
    btn.setAttribute('role', 'menuitem');
    btn.textContent = item.label;
    if (item.disabled) {
      btn.disabled = true;
      if (item.title) btn.title = item.title;
    } else if (item.action) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        hideGitGraphContextMenu();
        onAction();
        item.action!();
      });
    }
    container.appendChild(btn);
  }
}

function openSubmenu(
  anchor: HTMLButtonElement,
  children: MenuItemDef[],
  onAction: () => void,
): void {
  activeSubmenuEl?.remove();
  const flyout = document.createElement('div');
  flyout.className = 'git-graph-context-menu git-graph-context-menu__submenu';
  flyout.setAttribute('role', 'menu');
  renderSubmenuItems(flyout, children, onAction);
  document.body.appendChild(flyout);
  activeSubmenuEl = flyout;

  const anchorRect = anchor.getBoundingClientRect();
  flyout.style.left = `${anchorRect.right - 2}px`;
  flyout.style.top = `${anchorRect.top}px`;
  const flyoutRect = flyout.getBoundingClientRect();
  if (flyoutRect.right > window.innerWidth - 8) {
    flyout.style.left = `${anchorRect.left - flyoutRect.width + 2}px`;
  }
  if (flyoutRect.bottom > window.innerHeight - 8) {
    flyout.style.top = `${Math.max(8, window.innerHeight - flyoutRect.height - 8)}px`;
  }
}

function renderMenuItems(items: MenuItemDef[], onAction: () => void): void {
  const menu = ensureMenuElement();
  menu.innerHTML = '';
  for (const item of items) {
    if (item.kind === 'sep') {
      const sep = document.createElement('div');
      sep.className = 'git-graph-context-menu__sep';
      sep.setAttribute('role', 'separator');
      menu.appendChild(sep);
      continue;
    }

    if (item.kind === 'submenu') {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'git-graph-context-menu__item git-graph-context-menu__item--submenu';
      row.setAttribute('role', 'menuitem');
      row.setAttribute('aria-haspopup', 'true');
      row.disabled = Boolean(item.disabled);
      row.textContent = item.label;
      const arrow = document.createElement('span');
      arrow.className = 'git-graph-context-menu__submenu-arrow';
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '›';
      row.appendChild(arrow);

      if (!item.disabled && item.children.length > 0) {
        row.addEventListener('mouseenter', () => openSubmenu(row, item.children, onAction));
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          openSubmenu(row, item.children, onAction);
        });
      }
      menu.appendChild(row);
      continue;
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'git-graph-context-menu__item';
    btn.setAttribute('role', 'menuitem');
    btn.textContent = item.label;
    if (item.disabled) {
      btn.disabled = true;
      if (item.title) btn.title = item.title;
    } else if (item.action) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        hideGitGraphContextMenu();
        onAction();
        item.action!();
      });
    }
    menu.appendChild(btn);
  }
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function runCheckout(
  ctx: GitGraphContextMenuCtx,
  branch: string,
  successMessage: string,
): Promise<void> {
  if (!(await confirmDirtyCheckout(ctx.cwd))) return;
  const result = await runGitUiOp(() => gitCheckout({ branch, cwd: ctx.cwd }), {
    label: 'Switching branch…',
    successMessage,
    chatKind: 'checkout',
    ctx: gitUiCtx(ctx.cwd, ctx.getCurrentBranch?.()),
  });
  if (!result.ok) return;
  await ctx.onRefresh();
}

async function runCheckoutDetach(ctx: GitGraphContextMenuCtx, sha: string): Promise<void> {
  if (!(await confirmDirtyCheckout(ctx.cwd))) return;
  const result = await runGitUiOp(() => gitCheckoutDetach({ sha, cwd: ctx.cwd }), {
    label: 'Checking out commit…',
    successMessage: 'Checked out commit (detached HEAD)',
    chatKind: 'checkout',
    ctx: gitUiCtx(ctx.cwd, ctx.getCurrentBranch?.()),
  });
  if (!result.ok) return;
  await ctx.onRefresh();
}

async function runDeleteBranch(ctx: GitGraphContextMenuCtx, name: string): Promise<void> {
  if (isProtectedBranchName(name)) return;
  if (!await appConfirm(`Delete branch "${name}"?`)) return;
  let result = await gitDeleteBranch({ branch: name, cwd: ctx.cwd });
  if (!result.ok) {
    if (!await appConfirm(`Branch "${name}" is not fully merged. Force delete?`)) return;
    result = await runGitUiOp(() => gitDeleteBranch({ branch: name, force: true, cwd: ctx.cwd }), {
      label: 'Deleting…',
      successMessage: `Deleted branch ${name}`,
      ctx: gitUiCtx(ctx.cwd, ctx.getCurrentBranch?.()),
    });
    if (!result.ok) return;
  } else {
    showToast(`Deleted branch ${name}`, 'success');
  }
  await ctx.onRefresh();
}

function openExternalUrl(url: string): void {
  if (window.minnow?.app.openExternal) {
    void window.minnow.app.openExternal(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

async function runCherryPick(ctx: GitGraphContextMenuCtx, sha: string): Promise<void> {
  const advancedCtx = {
    cwd: ctx.cwd,
    onSuccess: () => void ctx.onRefresh(),
    onConflict: (message: string, kind: 'merge' | 'rebase' | 'cherry-pick' | 'stash') => {
      if (kind === 'cherry-pick') ctx.onConflict?.(message, kind);
    },
  };

  if (ctx.conflictHost) {
    await openCherryPickDialog(advancedCtx, ctx.conflictHost, sha);
    return;
  }

  const result = await runGitUiOp(() => gitCherryPick({ sha, cwd: ctx.cwd }), {
    label: 'Cherry-picking…',
    successMessage: 'Cherry-pick completed',
    ctx: gitUiCtx(ctx.cwd, ctx.getCurrentBranch?.()),
  });
  if (!result.ok) {
    const err = result.error ?? 'Cherry-pick failed';
    if (result.conflict) ctx.onConflict?.(err, 'cherry-pick');
    return;
  }
  await ctx.onRefresh();
}

// ── Build ────────────────────────────────────────────────────────────────────

async function buildMenuItems(
  visual: CommitVisual,
  ctx: GitGraphContextMenuCtx,
): Promise<MenuItemDef[]> {
  const { commit } = visual;
  const sha = commit.hash;
  const currentBranch = ctx.getCurrentBranch?.() ?? '';
  const localBranches = filterUserFacingBranches(extractLocalBranchRefs(commit.refs));
  const deletableBranches = localBranches.filter(
    (b) => b !== currentBranch && !isProtectedBranchName(b),
  );

  const remoteResult = await gitRemoteUrl(ctx.cwd);
  const webCommitUrl =
    remoteResult.ok && remoteResult.url ? commitUrl(remoteResult.url, sha) : null;

  const checkoutChildren: MenuItemDef[] = localBranches.map((branch) => ({
    kind: 'item' as const,
    label: branch,
    action: () => void runCheckout(ctx, branch, `Switched to ${branch}`),
  }));

  const deleteChildren: MenuItemDef[] = deletableBranches.map((branch) => ({
    kind: 'item' as const,
    label: branch,
    action: () => void runDeleteBranch(ctx, branch),
  }));

  return [
    {
      kind: 'item',
      label: 'Open Changes',
      action: () => ctx.onOpenChanges(sha),
    },
    {
      kind: 'item',
      label: 'Open on GitHub',
      disabled: !webCommitUrl,
      title: webCommitUrl ? undefined : 'No origin remote or unsupported host',
      action: webCommitUrl ? () => openExternalUrl(webCommitUrl) : undefined,
    },
    { kind: 'sep' },
    {
      kind: 'submenu',
      label: 'Checkout',
      disabled: checkoutChildren.length === 0,
      children: checkoutChildren,
    },
    {
      kind: 'item',
      label: 'Checkout (Detached)',
      action: () => void runCheckoutDetach(ctx, sha),
    },
    {
      kind: 'item',
      label: 'Create Branch…',
      action: () => {
        const anchor = document.createElement('span');
        anchor.style.position = 'fixed';
        anchor.style.left = `${menuEl?.style.left ?? '0'}`;
        anchor.style.top = `${menuEl?.style.top ?? '0'}`;
        document.body.appendChild(anchor);
        openGitRefNamePopover({
          anchor,
          title: 'Create branch',
          kind: 'branch',
          cwd: ctx.cwd,
          defaultPath: ctx.cwd,
          reserved: [ctx.getCurrentBranch?.() ?? '', 'main', 'master'],
          fixedStartPoint: sha,
          onSubmit: async (result) => {
            anchor.remove();
            if (!(await confirmDirtyCheckout(ctx.cwd))) return;
            const checkoutResult = await runGitUiOp(
              () =>
                gitCheckout({
                  branch: result.name,
                  create: true,
                  startPoint: result.startPoint,
                  cwd: ctx.cwd,
                }),
              {
                label: 'Creating branch…',
                successMessage: `Created branch ${result.name}`,
                chatKind: 'checkout',
                ctx: gitUiCtx(ctx.cwd, ctx.getCurrentBranch?.()),
              },
            );
            if (!checkoutResult.ok) return;
            await ctx.onRefresh();
          },
        });
      },
    },
    {
      kind: 'submenu',
      label: 'Delete Branch',
      disabled: deleteChildren.length === 0,
      children: deleteChildren,
    },
    {
      kind: 'item',
      label: 'Create Tag…',
      action: () => {
        const anchor = document.createElement('span');
        anchor.style.position = 'fixed';
        anchor.style.left = `${menuEl?.style.left ?? '0'}`;
        anchor.style.top = `${menuEl?.style.top ?? '0'}`;
        document.body.appendChild(anchor);
        openGitPanelNamePopover({
          anchor,
          title: 'Create tag',
          label: 'Tag name',
          placeholder: 'v1.0.0',
          onSubmit: async (name) => {
            anchor.remove();
            const result = await runGitUiOp(() => gitCreateTag({ name, sha, cwd: ctx.cwd }), {
              label: 'Tagging…',
              successMessage: `Created tag ${name}`,
              ctx: gitUiCtx(ctx.cwd, ctx.getCurrentBranch?.()),
            });
            if (!result.ok) return;
            await ctx.onRefresh();
          },
        });
      },
    },
    { kind: 'sep' },
    {
      kind: 'item',
      label: 'Cherry Pick',
      disabled: visual.isHead,
      title: visual.isHead ? 'Already at HEAD' : undefined,
      action: () => void runCherryPick(ctx, sha),
    },
    { kind: 'sep' },
    ...legacyCaptureMenuItems({
      kind: CAPTURE_MENU_KINDS.commit,
      hash: sha,
      subject: expandGitmojiShortcodes(commit.subject),
    }).map((row) => ({ kind: 'item' as const, label: row.label, action: row.action })),
    { kind: 'sep' },
    {
      kind: 'item',
      label: 'Copy Commit ID',
      action: () => {
        void navigator.clipboard.writeText(sha).then(() => {
          showToast('Copied commit ID', 'success');
        });
      },
    },
    {
      kind: 'item',
      label: 'Copy Commit Message',
      action: () => {
        void navigator.clipboard.writeText(expandGitmojiShortcodes(commit.subject)).then(() => {
          showToast('Copied commit message', 'success');
        });
      },
    },
  ];
}

/** Show the commit row context menu at the pointer. */
export async function showGitGraphCommitContextMenu(
  visual: CommitVisual,
  event: MouseEvent,
  ctx: GitGraphContextMenuCtx,
): Promise<void> {
  event.preventDefault();
  bindDismissOnce();

  const items = await buildMenuItems(visual, ctx);
  renderMenuItems(items, () => {});

  const menu = ensureMenuElement();
  menu.hidden = false;
  positionMenu(menu, event.clientX, event.clientY);
}
