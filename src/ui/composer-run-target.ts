import { isActiveChatStreaming, isChatStreaming } from '../chat/streaming-state.ts';
import {
  branchesLockedToOtherWorktrees,
  filterUserFacingBranches,
  parseWorktreeListPorcelain,
} from '../lib/worktree-list-parse.ts';
import {
  applyChatRunTargetChoice,
  chatTitleForGitRef,
  composerGitRepoRoot,
  enableChatWorktreeOnSend,
  isChatWorktreeSetupPending,
  subscribeChatWorktreeSetup,
  isChatWorktreeMode,
  type ChatRunTargetChoice,
} from '../state/chat-worktree.ts';
import { gitBranches } from '../state/git-api.ts';
import { parseGitError } from '../lib/git-error-parse.ts';
import { getActiveChat, isExpertChat, scheduleSaveSessions, sessionState, touchChat } from '../state/sessions.ts';
import { isLocalServerAvailable } from '../tools/config.ts';
import { listWorktrees } from '../state/worktree-service.ts';
import type { Chat } from '../types.ts';
import { isComposerRecoveryBlocked } from './composer-send.ts';
import { runCheckoutFlow } from './git-checkout-confirm.ts';
import { otherChatsInCheckout, sharedFolderGuard } from './chat-checkout-guard.ts';
import { getLiveCheckoutBranch, refreshSidebarGitFacts, subscribeSidebarGitState } from './sidebar-git-state.ts';
import { createGitWorktreeIcon } from './git-worktree-icons.ts';
import {
  closeGitPanelNamePopover,
} from './git-panel-name-popover.ts';
import {
  closeRunTargetPicker,
  fillRunTargetMenu,
  positionRunTargetMenu,
} from './composer-run-target-menu.ts';
import {
  observeModeSelectorComposerSibling,
  refreshModeSelectorLayout,
} from './mode-selector.ts';
import { setStatus } from './status.ts';
import { showToast } from './toast.ts';

let wrapEl: HTMLDivElement | null = null;
let runTargetBtn: HTMLButtonElement | null = null;
let runTargetMenu: HTMLDivElement | null = null;
let runTargetOpen = false;
let menuGeneration = 0;
let outsideHandler: ((e: PointerEvent) => void) | null = null;
let escapeHandler: ((e: KeyboardEvent) => void) | null = null;
const busyChats = new Set<string>();
let displayedChatId: string | undefined;

// ── Menus ────────────────────────────────────────────────────────────────────

function controlsDisabled(): boolean {
  return isActiveChatStreaming() || isComposerRecoveryBlocked() || busyChats.has(getActiveChat().id) || isChatWorktreeSetupPending(getActiveChat().id);
}

function shouldShowForChat(chat: Chat): boolean {
  if (isExpertChat(chat)) return false;
  if (chat.boardTaskId?.trim()) return false;
  return isLocalServerAvailable();
}

function detachGlobalListeners(): void {
  if (outsideHandler) {
    document.removeEventListener('pointerdown', outsideHandler, true);
    outsideHandler = null;
  }
  if (escapeHandler) {
    document.removeEventListener('keydown', escapeHandler, true);
    escapeHandler = null;
  }
}

function closeMenus(): void {
  menuGeneration++;
  runTargetOpen = false;
  runTargetBtn?.setAttribute('aria-expanded', 'false');
  runTargetMenu?.classList.add('hidden');
  detachGlobalListeners();
  closeRunTargetPicker();
}

/** Close Local / branch menus (compact layout swap and overflow sheet). */
export function closeComposerRunTargetMenus(): void {
  closeMenus();
}

function positionMenu(anchor: HTMLElement, menu: HTMLElement): void {
  positionRunTargetMenu(anchor, menu);
}

function attachGlobalListeners(): void {
  outsideHandler = (e: PointerEvent) => {
    const target = e.target as Node | null;
    if (
      runTargetMenu?.contains(target) ||
      runTargetBtn?.contains(target)
    ) {
      return;
    }
    closeMenus();
  };
  document.addEventListener('pointerdown', outsideHandler, true);

  escapeHandler = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    closeMenus();
    closeGitPanelNamePopover();
    runTargetBtn?.focus();
  };
  document.addEventListener('keydown', escapeHandler, true);
}

// ── Controls ─────────────────────────────────────────────────────────────────

function createMenuButton(
  id: string,
  className: string,
  ariaLabel: string,
  iconKind: 'local' | 'branch' | 'worktree',
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = id;
  btn.className = className;
  btn.setAttribute('aria-label', ariaLabel);
  btn.setAttribute('aria-haspopup', 'true');
  btn.setAttribute('aria-expanded', 'false');
  const icon = createGitWorktreeIcon(iconKind, 'composer-run-target__icon');
  const label = document.createElement('span');
  label.className = 'composer-run-target__label';
  btn.append(icon, label);
  return btn;
}

function createMenuPanel(id: string): HTMLDivElement {
  const menu = document.createElement('div');
  menu.id = id;
  menu.className = 'composer-run-target-menu hidden';
  menu.setAttribute('role', 'menu');
  return menu;
}

function menuSection(title: string): HTMLDivElement {
  const section = document.createElement('div');
  section.className = 'composer-run-target-menu__section';
  const heading = document.createElement('div');
  heading.className = 'composer-run-target-menu__heading';
  heading.textContent = title;
  section.appendChild(heading);
  return section;
}

function menuItem(
  label: string,
  onClick: () => void,
  options?: { icon?: 'local' | 'branch' | 'worktree'; disabled?: boolean; keepOpen?: boolean },
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'composer-run-target-menu__item';
  btn.setAttribute('role', 'menuitem');
  btn.disabled = options?.disabled === true;
  if (options?.icon) {
    btn.appendChild(createGitWorktreeIcon(options.icon, 'composer-run-target-menu__item-icon'));
  }
  const text = document.createElement('span');
  text.textContent = label;
  btn.appendChild(text);
  btn.addEventListener('click', () => {
    if (!options?.keepOpen) closeMenus();
    void onClick();
  });
  return btn;
}

function reopenRunTargetMenu(): void {
  if (!runTargetMenu || !runTargetBtn) return;
  runTargetOpen = true;
  runTargetBtn?.setAttribute('aria-expanded', 'true');
  runTargetMenu.classList.remove('hidden');
  positionMenu(runTargetBtn, runTargetMenu);
  detachGlobalListeners();
  attachGlobalListeners();
}

function ensureControls(): HTMLDivElement {
  if (wrapEl?.isConnected && wrapEl.ownerDocument === document) return wrapEl;

  wrapEl = document.createElement('div');
  wrapEl.id = 'composerRunTargetWrap';
  wrapEl.className = 'composer-control composer-run-target-wrap hidden';

  runTargetBtn = createMenuButton(
    'composerRunTargetBtn',
    'composer-run-target-btn',
    'Run target',
    'branch',
  );
  runTargetMenu = createMenuPanel('composerRunTargetMenu');
  runTargetMenu.setAttribute('aria-label', 'Worktree and branch');
  runTargetBtn.setAttribute('aria-controls', 'composerRunTargetMenu');
  runTargetBtn.addEventListener('click', () => {
    if (controlsDisabled()) return;
    if (runTargetOpen) {
      closeMenus();
      return;
    }
    closeMenus();
    const chat = getActiveChat();
    if (!isChatWorktreeMode(chat) && !chat.worktreeEnabled && !chat.worktreeSetupRequired) {
      void applyChoice({ kind: 'automatic' }, chat);
      return;
    }
    runTargetOpen = true;
    runTargetBtn?.setAttribute('aria-expanded', 'true');
    void rebuildRunTargetMenu().then(() => {
      if (!runTargetOpen || getActiveChat().id !== chat.id) return;
      reopenRunTargetMenu();
      runTargetMenu?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    });
  });
  runTargetBtn.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' || controlsDisabled()) return;
    event.preventDefault();
    closeMenus();
    runTargetOpen = true;
    void rebuildRunTargetMenu().then(() => {
      if (!runTargetOpen) return;
      reopenRunTargetMenu();
      runTargetMenu?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    });
  });
  wrapEl.append(runTargetBtn);
  document.body.append(runTargetMenu);

  const host = document.getElementById('composerControls');
  const anchor = document.getElementById('composerThinkingWrap');
  if (host) {
    if (anchor?.parentNode === host) {
      host.insertBefore(wrapEl, anchor);
    } else {
      host.appendChild(wrapEl);
    }
    observeModeSelectorComposerSibling(wrapEl);
    document.dispatchEvent(new CustomEvent('minnow:composer-controls-changed'));
  }

  return wrapEl;
}

// ── Apply ────────────────────────────────────────────────────────────────────

async function refreshGitPanelFromComposer(): Promise<void> {
  try {
    const mod = await import('./git-panel.ts');
    mod.clearPanelCwdUserOverride();
    mod.syncPanelFromActiveChat({ forceFileTree: true });
  } catch {
  }
}

async function applyChoice(choice: ChatRunTargetChoice, chat = getActiveChat()): Promise<void> {
  if (busyChats.has(chat.id) || isChatStreaming(chat.id)) return;
  if (choice.kind === 'automatic' && !chat.worktreeSetupRequired) {
    enableChatWorktreeOnSend(chat);
    touchChat(chat);
    scheduleSaveSessions();
    syncComposerRunTargetFromActiveChat();
    return;
  }
  busyChats.add(chat.id);
  updateButtonLabels(getActiveChat());
  refreshComposerRunTargetDisabled();
  try {
    const setup = applyChatRunTargetChoice(chat, choice);
    touchChat(chat);
    scheduleSaveSessions();
    const res = await setup;
    if (!res.ok) {
      const msg = res.error ?? 'Could not set run target';
      setStatus('error', msg);
      return;
    }
    if (choice.kind === 'local') {
      const branch = await gitBranches(chat.workspacePath?.trim() || composerGitRepoRoot());
      if (branch.ok && branch.current?.trim()) chat.gitBranch = branch.current.trim();
      else delete chat.gitBranch;
    }
    touchChat(chat);
    scheduleSaveSessions();
    syncComposerRunTargetFromActiveChat();
    if (getActiveChat().id === chat.id) await refreshGitPanelFromComposer();
    if (choice.kind === 'local') {
      setStatus('ok', 'Run target: Local');
      return;
    }
    const label =
      chat.gitBranch?.trim() ||
      (choice.kind === 'create'
        ? choice.name
        : choice.kind === 'attach' ? choice.path.split(/[/\\]/).pop() : '') ||
      'Worktree';
    setStatus('ok', `Worktree: ${label}`);
    if (choice.kind === 'create' || choice.kind === 'automatic') {
      showToast(`Worktree: ${label}`, 'success');
    }
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    busyChats.delete(chat.id);
    updateButtonLabels(getActiveChat());
    refreshComposerRunTargetDisabled();
  }
}

async function applyBranchCheckout(branch: string, chat = getActiveChat()): Promise<void> {
  if (busyChats.has(chat.id) || isChatStreaming(chat.id)) return;
  busyChats.add(chat.id);
  refreshComposerRunTargetDisabled();
  try {
    const workspace = chat.workspacePath?.trim() || composerGitRepoRoot();
    const cwd = chat.worktreeRoot?.trim() || workspace;
    const current = await gitBranches(cwd);
    const expectedBranch = current.ok ? current.current?.trim() || undefined : undefined;
    const input = { branch, cwd, expectedBranch };
    // Same flow as the thread picker: shared-folder prompt, dirty-file choice,
    // and routing to a worktree that already has the branch.
    const res = await runCheckoutFlow(input, {
      isCurrent: () => getActiveChat().id === chat.id,
      shared: sharedFolderGuard(chat, cwd, workspace, input),
      openWorktreeLabel: 'Use that checkout',
      openWorktree: async (path) => {
        const attached = await applyChatRunTargetChoice(chat, { kind: 'attach', path, branch });
        if (!attached.ok) throw new Error(attached.error || 'Could not select the worktree.');
      },
    });
    if (!res.ok) {
      if ((res.error ?? '').toLowerCase() !== 'cancelled') {
        const parsed = parseGitError(res.error, `Could not check out ${branch}`, res.code);
        setStatus('error', parsed.kind === 'generic' ? parsed.summary : `${parsed.title}. ${parsed.summary}`);
      }
      return;
    }
    chat.gitBranch = res.branch ?? branch;
    touchChat(chat);
    scheduleSaveSessions();
    syncComposerRunTargetFromActiveChat();
    if (getActiveChat().id === chat.id) await refreshGitPanelFromComposer();
    setStatus('ok', res.location === 'worktree' ? `Worktree: ${chat.gitBranch}` : `Branch: ${chat.gitBranch}`);
  } catch (error) {
    setStatus('error', error instanceof Error ? error.message : String(error));
  } finally {
    busyChats.delete(chat.id);
    refreshComposerRunTargetDisabled();
  }
}

async function rebuildRunTargetMenu(): Promise<void> {
  if (!runTargetMenu || !runTargetBtn) return;
  const chat = getActiveChat();
  const generation = menuGeneration;
  await fillRunTargetMenu({
    menu: runTargetMenu,
    currentPath: isChatWorktreeMode(chat) ? chat.worktreeRoot : undefined,
    currentBranch: chat.gitBranch,
    currentName: worktreeName(chat),
    localLabel: chat.worktreeEnabled || chat.worktreeSetupRequired ? 'Back to Local' : undefined,
    automaticLabel: chat.worktreeSetupRequired ? 'Retry worktree setup' : chat.worktreeEnabled ? 'Worktree enabled · creates on send' : undefined,
    automaticDisabled: chat.worktreeEnabled && !chat.worktreeSetupRequired,
    onSelectBranch: chat.worktreeEnabled && !isChatWorktreeMode(chat) ? undefined : () => {
      void rebuildBranchMenu().then(() => {
        if (runTargetOpen) reopenRunTargetMenu();
      });
    },
    isCurrent: () => runTargetOpen && menuGeneration === generation && getActiveChat().id === chat.id,
    repoRoot: chat.workspacePath?.trim() || composerGitRepoRoot(),
    localDisabled: !isChatWorktreeMode(chat) && !chat.worktreeEnabled && !chat.worktreeSetupRequired,
    defaultTitle: chatTitleForGitRef(chat),
    defaultPath: chat.workspacePath || composerGitRepoRoot(),
    reserved: [chat.gitBranch, 'main', 'master'],
    popoverAnchor: runTargetBtn,
    closeMenu: closeMenus,
    reopenMenu: reopenRunTargetMenu,
    onPick: (choice) => applyChoice(choice, chat),
  });
}

async function rebuildBranchMenu(): Promise<void> {
  const menu = runTargetMenu;
  if (!menu) return;
  const chat = getActiveChat();
  const generation = menuGeneration;
  const cwd = chat.worktreeRoot?.trim() || chat.workspacePath?.trim() || composerGitRepoRoot();
  const [res, list] = await Promise.all([gitBranches(cwd), listWorktrees(cwd)]);
  if (!runTargetOpen || generation !== menuGeneration || getActiveChat().id !== chat.id) return;
  menu.replaceChildren(menuItem('← Back', () => {
    void rebuildRunTargetMenu().then(() => { if (runTargetOpen) reopenRunTargetMenu(); });
  }, { keepOpen: true }));
  const section = menuSection('Switch branch');
  menu.append(section);
  if (!res.ok) {
    const error = document.createElement('p');
    error.className = 'composer-run-target-menu__note';
    error.textContent = res.error ?? 'Could not load branches';
    section.append(error);
    return;
  }
  const worktrees = list.ok && list.output ? parseWorktreeListPorcelain(list.output) : [];
  const locked = branchesLockedToOtherWorktrees(worktrees, cwd);
  const current = res.current?.trim();
  for (const name of filterUserFacingBranches(res.local ?? [], locked)) {
    const item = menuItem(name, () => { void applyBranchCheckout(name, chat); }, {
      icon: 'branch', disabled: name === current,
    });
    if (name === current) item.setAttribute('aria-current', 'true');
    section.append(item);
  }
  // Branches held by another worktree: use that checkout instead of a doomed switch.
  const elsewhere = worktrees.filter((wt) => wt.branch && locked.has(wt.branch));
  if (elsewhere.length) {
    const held = menuSection('In other worktrees');
    menu.append(held);
    for (const wt of elsewhere) {
      const leaf = wt.path.replace(/\\/g, '/').split('/').filter(Boolean).pop() || wt.path;
      const item = menuItem(`${wt.branch} · ${leaf}`, () => {
        void applyChoice({ kind: 'attach', path: wt.path, branch: wt.branch }, chat);
      }, { icon: 'worktree' });
      item.title = `Use the checkout at ${wt.path} for this chat`;
      held.append(item);
    }
  }
}

function worktreeName(chat: Chat): string {
  const leaf = chat.worktreeRoot?.replace(/\\/g, '/').split('/').filter(Boolean).pop();
  const branch = liveBranch(chat);
  return ((chat.chatWorktreeManaged || leaf === chat.id) ? branch : leaf) || branch || 'Worktree';
}

/** Folder this chat's tools run in. */
function chatCheckoutPath(chat: Chat): string {
  const workspace = chat.workspacePath?.trim() || composerGitRepoRoot();
  return isChatWorktreeMode(chat) ? chat.worktreeRoot!.trim() : workspace;
}

/** What is checked out there now; the saved label only until the first read. */
function liveBranch(chat: Chat): string | undefined {
  return getLiveCheckoutBranch(chatCheckoutPath(chat)) ?? chat.gitBranch?.trim() ?? undefined;
}

function updateButtonLabels(chat: Chat): void {
  const busy = busyChats.has(chat.id) || isChatWorktreeSetupPending(chat.id);
  const enabled = chat.worktreeEnabled === true;
  const active = isChatWorktreeMode(chat);
  const name = worktreeName(chat);
  const branch = liveBranch(chat);
  const workspace = chat.workspacePath?.trim() || composerGitRepoRoot();
  const sharing = active ? 0 : otherChatsInCheckout(chat, workspace, workspace).length;
  const localWhere = `Local · workspace folder on ${branch || 'an unknown branch'}${sharing ? `, shared with ${sharing} other ${sharing === 1 ? 'chat' : 'chats'}` : ''}`;
  const label = runTargetBtn?.querySelector('.composer-run-target__label');
  if (label) label.textContent = busy ? 'Setting up…' : chat.worktreeSetupRequired ? 'Retry worktree' : active ? name : enabled ? 'Worktree' : '';
  runTargetBtn?.classList.toggle('composer-run-target-btn--local', !active && !enabled && !busy && !chat.worktreeSetupRequired);
  runTargetBtn?.setAttribute('aria-label', busy ? 'Setting up worktree' : chat.worktreeSetupRequired ? 'Retry worktree setup' : active ? `Worktree: ${name}. Branch: ${branch || 'detached'}` : enabled ? 'Worktree enabled. Creates when you send a message' : 'Enable worktree');
  if (!active && !busy) runTargetBtn?.setAttribute('aria-description', localWhere);
  else runTargetBtn?.removeAttribute('aria-description');
  runTargetBtn?.setAttribute('aria-busy', String(busy));
  runTargetBtn?.setAttribute('aria-pressed', String(active || enabled));
  runTargetBtn?.setAttribute('title', active
    ? `Worktree: ${chat.worktreeRoot}\nBranch: ${branch || 'detached'}\nChange branch, switch worktree, or return to Local`
    : enabled ? `Worktree enabled · Your next message creates and sets up an isolated checkout. Click for options.\nNow: ${localWhere}`
    : `Enable worktree · Set up an isolated checkout when you send a message\nNow: ${localWhere}`);
  refreshModeSelectorLayout();
}

// ── Sync ─────────────────────────────────────────────────────────────────────

/** Disable controls while streaming or busy. */
export function refreshComposerRunTargetDisabled(): void {
  const disabled = controlsDisabled();
  runTargetBtn?.toggleAttribute('disabled', disabled);
  if (disabled) closeMenus();
}

/** Sync the combined worktree and branch control from the active chat. */
export function syncComposerRunTargetFromActiveChat(): void {
  const wrap = ensureControls();
  const chat = getActiveChat();
  if (displayedChatId !== chat.id) closeMenus();
  displayedChatId = chat.id;

  if (!shouldShowForChat(chat)) {
    wrap.classList.add('hidden');
    closeMenus();
    return;
  }

  wrap.classList.remove('hidden');
  updateButtonLabels(chat);
  refreshComposerRunTargetDisabled();
  // Live HEAD for the label; honors the shared facts cache's freshness window.
  refreshSidebarGitFacts(chatCheckoutPath(chat));

  if (!chat.gitBranch?.trim()) {
    void gitBranches(chat.worktreeRoot?.trim() || chat.workspacePath?.trim() || composerGitRepoRoot()).then((res) => {
      if (!res.ok || !res.current?.trim()) return;
      if (getActiveChat().id !== chat.id) return;
      if (getActiveChat().gitBranch?.trim()) return;
      chat.gitBranch = res.current.trim();
      updateButtonLabels(chat);
    });
  }
}

/** Wire composer run-target controls (call once at boot). */
export function initComposerRunTarget(): void {
  ensureControls();
  syncComposerRunTargetFromActiveChat();
}

subscribeChatWorktreeSetup(() => {
  if (!wrapEl?.isConnected || !sessionState) return;
  updateButtonLabels(getActiveChat());
  refreshComposerRunTargetDisabled();
});

subscribeSidebarGitState(() => {
  if (!wrapEl?.isConnected || !sessionState) return;
  const chat = getActiveChat();
  const live = getLiveCheckoutBranch(chatCheckoutPath(chat));
  // Record the branch the chat last saw (server-owned chats keep their own).
  if (live && chat.chatCommandVersion !== 1 && chat.gitBranch !== live) chat.gitBranch = live;
  updateButtonLabels(chat);
});
