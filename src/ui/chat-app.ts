import { sendMessage } from '../chat/messaging';
import { stopGeneration } from '../chat/stop-generation';
import { isActiveChatStreaming, subscribeChatStreamEnd } from '../chat/streaming-state';
import { getChatsWorkspacePath } from '../lib/chats-workspace';
import { normalizeWorkspacePath } from '../lib/normalize-workspace-path';
import { isOsAppHash, isOsShellEnabled } from '../os/page-bridge';
import { iconHtml } from './icon';
import { navigateToDesktop } from '../os/router';
import {
  CHAT_APP_ID,
  createAssistantChat,
  ensureActiveAssistantChat,
} from '../state/chat-app-sessions';
import {
  ensureChatHistoryLoaded,
  getActiveChat,
  getAssistantChats,
  isEphemeralEmptyChat,
  markSessionScalarsDirty,
  newChatId,
  pruneEphemeralEmptyChats,
  rememberActiveChatForApp,
  scheduleSaveSessions,
  sessionState,
} from '../state/sessions';
import { refreshChatAppOutputsPanel } from './chat-app-outputs';
import { acknowledgeChatViewed } from '../notifications/acknowledge';
import { refreshChatJumpChipVisibility } from './chat-scroll';
import { closeContextUsageBreakdown } from './context-usage-breakdown';
import { refreshContextUsageRing } from './context-usage-ring';
import { closeBenchmark } from './benchmark-page';
import { closeCompare } from './compare-page';
import { syncChatItemDotsInDom } from './chat-item-dot';
import { syncChatItemLoopIconsInDom } from './chat-item-loop-icon';
import {
  handleComposerPrimaryAction,
  initComposerSteerInputListener,
  syncComposerFromStreamingState,
} from './composer-send';
import { handleComposerPromptHistoryKeydown } from './composer-prompt-history';
import { autoResize, composerFieldSizingSupported } from './input';
import { handleSkillPickerKeydown, initComposerSlashPicker, isSkillPickerOpen } from './skill-picker';
import { renderChatFromHistory } from './messages';
import { closeSettings } from './settings-page';
import { ICON_CHEVRON_LEFT, ICON_CHEVRON_RIGHT } from '../constants';
import { appendChatRow } from './sidebar';
import {
  flushActiveComposerDraftBeforeNewChat,
  initComposerDraftListener,
  resetComposerForEphemeralReuse,
  switchComposerDraft,
} from './composer-draft';
import { setStatus } from './status';
import { syncAgentCliView } from './agent-cli-view';

const CHAT_APP_MOUNT = '#chatAppMessageCol';

let chatsWorkspacePath: string | null = null;
let streamEndUnsubscribe: (() => void) | null = null;
/** Mobile session rail starts hidden until the menubar toggle opens it. */
let chatAppRailHidden = true;
/** Desktop session rail starts collapsed (dots only) until expanded. */
let chatAppRailExpanded = false;

function getRoot(): HTMLElement | null {
  return document.getElementById('chatView');
}

function getChatShell(): HTMLElement | null {
  return document.getElementById('appBody');
}

/** Close other full-page overlays before opening Chat. */
function closeOtherOverlays(): void {
  closeSettings({ skipNavigate: true });
  closeBenchmark({ skipNavigate: true });
  closeCompare({ skipNavigate: true });
  void import('../research/panel').then((m) => {
    if (m.isResearchPageOpen()) m.closeResearch({ skipNavigate: true });
  });
  void import('./welcome-page').then((m) => {
    if (m.isWelcomePageOpen()) m.closeWelcome({ skipHash: true });
  });
  void import('./experts/experts-hub').then((m) => {
    if (m.isExpertsPageOpen()) m.closeExpertsHub({ skipNavigate: true });
  });
}

/** Paint the quiet empty state when the active assistant chat has no history. */
function renderChatAppEmptyState(area: HTMLElement): void {
  area.replaceChildren();
  const empty = document.createElement('div');
  empty.className = 'chat-app-empty';
  empty.innerHTML = `
    <div class="chat-app-empty-ico" aria-hidden="true">
      ${iconHtml('appChat')}
    </div>
    <h2>Start a conversation</h2>
    <p>General assistant with tools and file outputs. Ask anything below.</p>
  `;
  area.appendChild(empty);
}

/** Render transcript via shared history path; empty chats keep the Chat app landing copy. */
function renderChatAppMessages(): void {
  const chat = getActiveChat();
  const title = document.getElementById('chatAppTitle');
  if (title) title.textContent = chat.name || 'Chat';

  if (!chat.history.length) {
    const area =
      document.getElementById('chatAppMessageCol') ?? document.getElementById('chatAppArea');
    if (area) renderChatAppEmptyState(area);
    return;
  }

  renderChatFromHistory(chat, CHAT_APP_MOUNT);
}

/** Activate an assistant chat for the Chat app without touching Code sidebar DOM. */
async function activateAssistantChat(chatId: string): Promise<void> {
  if (!sessionState) return;
  const prevId = sessionState.activeId;
  const chat = sessionState.chats.find((c) => c.id === chatId);
  if (!chat) return;
  sessionState.activeId = chatId;
  markSessionScalarsDirty();
  await ensureChatHistoryLoaded(chatId);
  if (!sessionState || sessionState.activeId !== chatId) return;
  acknowledgeChatViewed(chatId);
  rememberActiveChatForApp(CHAT_APP_ID, chatId);
  switchComposerDraft(prevId, chat);
  scheduleSaveSessions();
  renderChatAppSurface();
  void import('../tools/stream-chat-dom').then((m) => m.remountStreamDomForChat(chatId));
}

/** Public: switch session rail thread (also used by background-stream hint). */
export function activateChatAppThread(chatId: string): void {
  void activateAssistantChat(chatId);
}

/** Create a new assistant chat and make it active. */
async function createNewAssistantChat(): Promise<void> {
  const path = chatsWorkspacePath ?? (await getChatsWorkspacePath());
  if (!path || !sessionState) return;
  chatsWorkspacePath = path;
  flushActiveComposerDraftBeforeNewChat();
  try {
    const active = getActiveChat();
    if (
      isEphemeralEmptyChat(active) &&
      normalizeWorkspacePath(active.workspacePath ?? '') === normalizeWorkspacePath(path)
    ) {
      resetComposerForEphemeralReuse();
      activateAssistantChat(active.id);
      renderSessionRail();
      return;
    }
  } catch {
  }
  const chat = createAssistantChat(path, newChatId());
  sessionState.chats.unshift(chat);
  pruneEphemeralEmptyChats(sessionState, chat.id);
  activateAssistantChat(chat.id);
  resetComposerForEphemeralReuse();
  renderSessionRail();
}

/** Rebuild the Chat app session rail after draft visibility changes. */
export function refreshChatAppSessionRail(): void {
  renderSessionRail();
}

/** Render session rail threads for the chats workspace. */
function renderSessionRail(): void {
  const list = document.getElementById('chatAppSessionList');
  if (!list || !sessionState) return;
  list.replaceChildren();
  const path = chatsWorkspacePath;
  if (!path) return;
  const chats = getAssistantChats(path, sessionState);
  const activeId = sessionState.activeId;
  for (const chat of chats) {
    appendChatRow(list, chat, activeId, {
      draggable: false,
      onActivate: (item) => activateAssistantChat(item.id),
    });
  }
  syncChatItemDotsInDom();
  syncChatItemLoopIconsInDom();
}

function syncComposerSendState(): void {
  const input = document.getElementById('chatAppInput') as HTMLTextAreaElement | null;
  const sendBtn = document.getElementById('chatAppSendBtn') as HTMLButtonElement | null;
  if (!sendBtn) return;
  if (isActiveChatStreaming()) {
    sendBtn.disabled = false;
    return;
  }
  const hasText = Boolean(input?.value.trim());
  sendBtn.disabled = !hasText;
}

function isMobileChatAppLayout(): boolean {
  return window.matchMedia('(max-width: 640px)').matches;
}

function isChatAppSessionRailVisible(): boolean {
  if (isMobileChatAppLayout()) return !chatAppRailHidden;
  return chatAppRailExpanded;
}

function syncChatAppRailToggleButton(): void {
  const btn = document.getElementById('btnChatAppRailToggle');
  if (!btn) return;
  const expanded = isChatAppSessionRailVisible();
  btn.innerHTML = expanded ? ICON_CHEVRON_LEFT : ICON_CHEVRON_RIGHT;
  btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  btn.setAttribute('aria-label', expanded ? 'Collapse sessions' : 'Expand sessions');
  btn.setAttribute('title', expanded ? 'Collapse sessions' : 'Expand sessions');
}

function syncMenubarChatToggle(): void {
  const btn = document.querySelector<HTMLButtonElement>('.mn-os-mb-chat-toggle');
  if (!btn || !isChatAppOpen()) return;
  btn.setAttribute('aria-pressed', isChatAppSessionRailVisible() ? 'true' : 'false');
}

/** Sync session rail visibility with mobile hide state and desktop expand state. */
export function applyChatAppRailVisuals(): void {
  const root = getRoot();
  if (!root) return;
  if (!isMobileChatAppLayout()) {
    root.classList.remove('is-rail-hidden');
    root.classList.toggle('is-rail-expanded', chatAppRailExpanded);
  } else {
    root.classList.remove('is-rail-expanded');
    root.classList.toggle('is-rail-hidden', chatAppRailHidden);
    if (!chatAppRailHidden) chatAppRailExpanded = true;
  }
  syncChatAppRailToggleButton();
  syncMenubarChatToggle();
}

/** Menubar / rail control: hide rail on mobile, expand/collapse on desktop. */
export function toggleChatAppSessionRail(): void {
  if (isMobileChatAppLayout()) {
    chatAppRailHidden = !chatAppRailHidden;
    if (!chatAppRailHidden) chatAppRailExpanded = true;
  } else {
    chatAppRailExpanded = !chatAppRailExpanded;
  }
  applyChatAppRailVisuals();
}

/** Whether the session rail is hidden (mobile) or collapsed (desktop). */
export function isChatAppSessionRailHidden(): boolean {
  return !isChatAppSessionRailVisible();
}

/** Concierge / launch_minnow_app seed: auto-send as first message when chat is empty. */
async function applyConciergeSeed(seed?: string): Promise<void> {
  if (!seed?.trim()) return;
  const input = document.getElementById('chatAppInput') as HTMLTextAreaElement | null;
  if (!input || input.value.trim()) return;

  const chat = getActiveChat();
  if (chat.history.length > 0) return;

  const text = seed.trim();
  input.value = text;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  syncComposerSendState();

  if (!(await ensureReadyForSend())) return;
  try {
    await sendMessage();
    renderChatAppMessages();
    const { clearForegroundSeed } = await import('../os/instances');
    clearForegroundSeed();
  } catch {
  } finally {
    syncComposerSendState();
  }
}

/** Refresh rail, messages, outputs, and composer chrome. */
function renderChatAppSurface(): void {
  syncAgentCliView();
  renderSessionRail();
  renderChatAppMessages();
  void refreshChatAppOutputsPanel();
  syncComposerSendState();
  syncComposerFromStreamingState();
  refreshChatJumpChipVisibility();
  refreshContextUsageRing();
}

async function ensureChatsWorkspaceReady(): Promise<boolean> {
  chatsWorkspacePath = await getChatsWorkspacePath();
  return Boolean(chatsWorkspacePath);
}

/** Ensure an assistant chat is active before send (General mode, chats workspace). */
async function ensureReadyForSend(): Promise<boolean> {
  try {
    const chat = getActiveChat();
    if (isEphemeralEmptyChat(chat)) {
      await ensureActiveAssistantChat();
    }
    const active = getActiveChat();
    if (active.historyLoaded === false) {
      await ensureChatHistoryLoaded(active.id);
      if (!sessionState || sessionState.activeId !== active.id) return false;
    }
    if (!chatsWorkspacePath) {
      chatsWorkspacePath = await getChatsWorkspacePath();
    }
    return true;
  } catch {
    setStatus('err', 'Chats workspace unavailable — open Minnow');
    return false;
  }
}

async function handleChatAppSend(): Promise<void> {
  if (!(await ensureReadyForSend())) return;
  if (isActiveChatStreaming()) {
    handleComposerPrimaryAction();
    syncComposerSendState();
    return;
  }
  await sendMessage();
  syncComposerSendState();
}

function onChatStreamEnded(chatId: string): void {
  if (!isChatAppOpen()) return;
  renderSessionRail();
  void refreshChatAppOutputsPanel();
  if (getActiveChat().id === chatId) {
    renderChatAppMessages();
    syncComposerSendState();
    syncComposerFromStreamingState();
  }
}

/** Whether the Chat app page is open. */
export function isChatAppOpen(): boolean {
  return getRoot()?.classList.contains('is-open') ?? false;
}

/** Options when opening the Chat app from the shell or a notification deep-link. */
export interface ChatAppOpenOptions {
  seed?: string;
  chatId?: string;
}

/** Open the Chat app (`#/app/chat`). */
export async function openChatApp(options?: string | ChatAppOpenOptions): Promise<void> {
  const opts: ChatAppOpenOptions =
    typeof options === 'string' ? { seed: options } : (options ?? {});
  const root = getRoot();
  const shell = getChatShell();
  if (!root || !shell) return;
  if (window.location.hash.startsWith('#/settings')) return;

  closeOtherOverlays();
  closeContextUsageBreakdown();
  root.classList.add('is-open');

  if (!isOsShellEnabled()) {
    shell.classList.add('hidden');
    window.location.hash = '#/app/chat';
  }

  void import('./preview-electron-visibility').then((m) =>
    m.syncElectronPreviewHostVisibility(),
  );

  const ready = await ensureChatsWorkspaceReady();
  if (ready) {
    try {
      if (opts.chatId?.trim()) {
        const chat = sessionState?.chats.find((c) => c.id === opts.chatId?.trim());
        if (chat) {
          activateAssistantChat(chat.id);
        } else {
          await ensureActiveAssistantChat();
        }
      } else {
        await ensureActiveAssistantChat();
      }
    } catch {
    }
  }

  applyChatAppRailVisuals();
  renderChatAppSurface();
  await applyConciergeSeed(opts.seed);
  syncComposerFromStreamingState();

  const input = document.getElementById('chatAppInput') as HTMLTextAreaElement | null;
  input?.focus();
}

/** Close the Chat app and return to chat workspace or desktop. */
export function closeChatApp(options?: { skipNavigate?: boolean }): void {
  const root = getRoot();
  const shell = getChatShell();
  if (!root || !shell) return;

  root.classList.remove('is-open');
  closeContextUsageBreakdown();

  if (!isOsShellEnabled()) {
    shell.classList.remove('hidden');
    if (
      !options?.skipNavigate &&
      (window.location.hash === '#/app/chat' || window.location.hash.startsWith('#/app/chat/'))
    ) {
      window.location.hash = '#/';
    }
  } else if (!options?.skipNavigate) {
    navigateToDesktop();
  }

  void import('./preview-electron-visibility').then((m) =>
    m.syncElectronPreviewHostVisibility(),
  );
}

function onHashChange(): void {
  const hash = window.location.hash;
  if (hash.startsWith('#/settings')) return;
  if (hash === '#/app/chat' || hash.startsWith('#/app/chat/')) {
    void openChatApp();
    return;
  }
  if (isOsShellEnabled() && isOsAppHash(hash)) return;
  if (isChatAppOpen()) {
    closeChatApp();
  }
}

function autoResizeComposer(textarea: HTMLTextAreaElement): void {
  autoResize(textarea);
}

function bindStaticControls(): void {
  document.getElementById('btnChatAppNewChat')?.addEventListener('click', () => {
    void createNewAssistantChat();
  });

  document.getElementById('btnChatAppRailToggle')?.addEventListener('click', () => {
    toggleChatAppSessionRail();
  });

  const input = document.getElementById('chatAppInput') as HTMLTextAreaElement | null;
  initComposerSteerInputListener(input);
  initComposerDraftListener(input);
  if (input) initComposerSlashPicker(input);
  input?.addEventListener('input', () => {
    if (!composerFieldSizingSupported()) autoResizeComposer(input);
    syncComposerSendState();
  });
  input?.addEventListener('keydown', (e) => {
    if (handleSkillPickerKeydown(e)) return;
    if (handleComposerPromptHistoryKeydown(e, input)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      if (isSkillPickerOpen()) return;
      e.preventDefault();
      void handleChatAppSend();
    }
  });

  document.getElementById('chatAppSendBtn')?.addEventListener('click', () => {
    void handleChatAppSend();
  });

  document.getElementById('btnChatAppStop')?.addEventListener('click', () => {
    stopGeneration();
  });

  document.getElementById('btnChatAppOutputsToggle')?.addEventListener('click', () => {
    const panel = document.getElementById('chatAppFiles');
    const btn = document.getElementById('btnChatAppOutputsToggle');
    if (!panel || !btn) return;
    const collapsed = panel.classList.toggle('is-collapsed');
    btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  });
}

/** Wire hash routing and controls (call once from main). */
export function initChatApp(): void {
  bindStaticControls();
  window.addEventListener('resize', () => {
    if (isChatAppOpen()) applyChatAppRailVisuals();
  });
  if (!streamEndUnsubscribe) {
    streamEndUnsubscribe = subscribeChatStreamEnd(onChatStreamEnded);
  }
  window.addEventListener('hashchange', onHashChange);
  const hash = window.location.hash;
  if (hash === '#/app/chat' || hash.startsWith('#/app/chat/')) {
    void openChatApp();
  }
}
