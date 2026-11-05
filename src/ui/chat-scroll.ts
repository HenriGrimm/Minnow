import { getSharedChatHost } from './shared-chat-host-state';
import { isChatAppForeground } from './chat-mount';
import { queryCodeMapChatHost } from './code-map/chat-state';
import { OB_CHAT_SCROLL_SELECTOR } from './orchestrate-board-chat-state';
import { getTranscriptScroller, transcriptBottomDistance, type TranscriptScrollAnchor } from './transcript-scroll';

export const CHAT_PIN_THRESHOLD_PX = 80;
export const CHAT_JUMP_CHIP_ID = 'chatJumpLatest';
export const CHAT_APP_JUMP_CHIP_ID = 'chatAppJumpLatest';

let chatAreaEl: HTMLElement | null = null;
let jumpChipEl: HTMLButtonElement | null = null;
let chatAppJumpChipEl: HTMLButtonElement | null = null;
const BOARD_INIT_SPLIT_CHAT_TESTID = 'boardInitSplitChat';
const DESKTOP_CHAT_TRANSCRIPT_SELECTOR = '.mn-os-chat-transcript';

let frameCachedScrollRoot: HTMLElement | null | undefined;
let frameCacheHandle = 0;
export type ChatScrollAnchor = TranscriptScrollAnchor;

/** Drop the per-frame scroll-root cache (chat switch, board/chat chrome). */
export function invalidateChatScrollRootCache(): void {
  frameCachedScrollRoot = undefined;
  if (frameCacheHandle && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameCacheHandle);
  frameCacheHandle = 0;
}

function resolveChatScrollRoot(): HTMLElement | null {
  if (getSharedChatHost()) return getSharedChatHost()!.transcript;
  const mapChatHost = queryCodeMapChatHost();
  if (mapChatHost) return mapChatHost;
  const boardChatPane = document.querySelector<HTMLElement>(OB_CHAT_SCROLL_SELECTOR);
  if (boardChatPane) return boardChatPane;
  const splitPane = document.querySelector<HTMLElement>(`[data-testid="${BOARD_INIT_SPLIT_CHAT_TESTID}"]`);
  if (splitPane) return splitPane;
  if (isChatAppForeground()) return document.getElementById('chatAppArea') ?? chatAreaEl;
  return chatAreaEl;
}

/** Scroll container for the currently presented conversation. */
export function getChatScrollRoot(): HTMLElement | null {
  if (typeof requestAnimationFrame !== 'function') return resolveChatScrollRoot();
  if (frameCachedScrollRoot !== undefined) return frameCachedScrollRoot;
  const root = resolveChatScrollRoot();
  frameCachedScrollRoot = root;
  frameCacheHandle = requestAnimationFrame(() => {
    frameCacheHandle = 0;
    frameCachedScrollRoot = undefined;
  });
  return root;
}

export function isChatAtBottom(el?: HTMLElement): boolean {
  const root = el ?? getChatScrollRoot();
  return !root || transcriptBottomDistance(root) <= CHAT_PIN_THRESHOLD_PX;
}

function updateJumpChipVisibility(): void {
  const root = getChatScrollRoot();
  if (!root) return;
  const chatApp = isChatAppForeground();
  const board = !getSharedChatHost()
    && document.getElementById('mainColumn')?.classList.contains('main-column--board-view');
  const show = !board && root.scrollHeight > root.clientHeight && !getTranscriptScroller(root).isPinned();
  jumpChipEl?.classList.toggle('hidden', chatApp || !show);
  chatAppJumpChipEl?.classList.toggle('hidden', !chatApp || !show);
}

export function scrollChatIfPinned(): void {
  const root = getChatScrollRoot();
  if (root) getTranscriptScroller(root).follow();
  updateJumpChipVisibility();
}

/** Observe row sizes as well as the fixed-height host, including late image/Markdown reflow. */
export function observeChatScrollLayout(mount: HTMLElement): () => void {
  const view = mount.ownerDocument.defaultView;
  if (!view?.ResizeObserver) return () => {};
  const root = getChatScrollRoot();
  const resize = new view.ResizeObserver(() => {
    if (!mount.isConnected) return;
    const activeRoot = getChatScrollRoot();
    if (!activeRoot || (activeRoot !== mount && !activeRoot.contains(mount))) return;
    scrollChatIfPinned();
  });
  resize.observe(mount);
  if (root && root !== mount) resize.observe(root);
  for (const child of mount.children) resize.observe(child);
  const children = new view.MutationObserver(records => {
    for (const record of records) {
      for (const node of record.removedNodes) if (node instanceof view.Element) resize.unobserve(node);
    }
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof view.Element && node.parentElement === mount) resize.observe(node);
      }
    }
  });
  children.observe(mount, { childList: true });
  return () => { children.disconnect(); resize.disconnect(); };
}

export function scrollChatToBottom(): void {
  const root = getChatScrollRoot();
  if (root) getTranscriptScroller(root).toBottom();
  updateJumpChipVisibility();
}

export function pinChatScroll(): void {
  const root = getChatScrollRoot();
  if (root) getTranscriptScroller(root).pin();
  updateJumpChipVisibility();
}

export function isChatScrollPinned(): boolean {
  const root = getChatScrollRoot();
  return !root || getTranscriptScroller(root).isPinned();
}

export function refreshChatJumpChipVisibility(): void { updateJumpChipVisibility(); }

export function captureChatScrollAnchor(): ChatScrollAnchor | null {
  const root = getChatScrollRoot();
  if (!root) return null;
  const anchor = getTranscriptScroller(root).capture();
  return { ...anchor, pinned: anchor.pinned && anchor.distanceFromBottom <= CHAT_PIN_THRESHOLD_PX };
}

export function restoreChatScrollAnchor(anchor: ChatScrollAnchor | null): void {
  const root = getChatScrollRoot();
  if (root && anchor) getTranscriptScroller(root).restore(anchor);
  updateJumpChipVisibility();
}

function bindScrollTarget(el: HTMLElement | null): void {
  if (!el || el.dataset.chatScrollBound === '1') return;
  el.dataset.chatScrollBound = '1';
  getTranscriptScroller(el).subscribe(updateJumpChipVisibility);
}

export function bindDesktopChatTranscriptScroll(): void {
  bindScrollTarget(document.querySelector<HTMLElement>(DESKTOP_CHAT_TRANSCRIPT_SELECTOR));
}

export function bindOrchestrateBoardChatScroll(): void {
  invalidateChatScrollRootCache();
  bindScrollTarget(document.querySelector<HTMLElement>(OB_CHAT_SCROLL_SELECTOR));
}

export function bindCodeMapChatScroll(): void {
  invalidateChatScrollRootCache();
  bindScrollTarget(queryCodeMapChatHost());
}

export function bindBoardInitSplitChatScroll(): void {
  invalidateChatScrollRootCache();
  bindScrollTarget(document.querySelector<HTMLElement>(`[data-testid="${BOARD_INIT_SPLIT_CHAT_TESTID}"]`));
}

function bindJumpChip(chip: HTMLButtonElement | null): void {
  if (!chip || chip.dataset.chatJumpBound === '1') return;
  chip.dataset.chatJumpBound = '1';
  chip.addEventListener('click', scrollChatToBottom);
}

export function initChatScroll(): void {
  invalidateChatScrollRootCache();
  chatAreaEl = document.getElementById('chatArea');
  jumpChipEl = document.getElementById(CHAT_JUMP_CHIP_ID) as HTMLButtonElement | null;
  chatAppJumpChipEl = document.getElementById(CHAT_APP_JUMP_CHIP_ID) as HTMLButtonElement | null;
  bindScrollTarget(chatAreaEl);
  bindScrollTarget(document.getElementById('chatAppArea'));
  bindDesktopChatTranscriptScroll();
  bindJumpChip(jumpChipEl);
  bindJumpChip(chatAppJumpChipEl);
  bindBoardInitSplitChatScroll();
  updateJumpChipVisibility();
}

export function bindSharedChatScroll(): void {
  invalidateChatScrollRootCache();
  bindScrollTarget(getSharedChatHost()?.transcript ?? null);
}
