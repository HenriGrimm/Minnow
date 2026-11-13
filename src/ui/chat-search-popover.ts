import { markPreviewOccluder, unmarkPreviewOccluder } from './preview-occlusion';
import {
  filterChatsByWorkspacePath,
  searchChats,
  type ChatSearchResult,
} from '../chat/chat-search';
import { searchSessions } from '../config/api-client';
import { isServerStorageMode } from '../config/storage-mode';
import { getChatsWorkspacePath } from '../lib/chats-workspace';
import { isMinnowSandboxWorkspacePath } from '../lib/workspace-sandbox';
import { findChatById, sessionState } from '../state/sessions';
import { getWorkspacePath } from '../state/workspace';
import { isChatArchived } from '../state/chat-archive';
import { listIssues } from '../state/issues-store';
import { normalizeWorkspacePath } from '../lib/normalize-workspace-path';
import type { Chat, IssueCard } from '../types';
import { createIcon } from './icon';
import { createSettingsToggleRow } from './settings-switch';

/** Where the popover was opened from — drives default search scope. */
type ChatSearchContext = 'code' | 'desktop';
type SearchFilter = 'all' | 'title' | 'message' | 'issue';
type SearchResult = ChatSearchResult | { issue: IssueCard };

const ALL_WORKSPACES_STORAGE_KEY = 'minnow.chatSearch.allWorkspaces';

/** True when the chat opens on the desktop chat surface (assistant or desktop sandbox). */
function isDesktopSurfaceChat(chat: Chat): boolean {
  return isMinnowSandboxWorkspacePath(chat.workspacePath ?? '');
}

let popoverEl: HTMLDivElement | null = null;
let backdropEl: HTMLButtonElement | null = null;
let anchorEl: HTMLElement | null = null;
let returnFocusEl: HTMLElement | null = null;
let inputEl: HTMLInputElement | null = null;
let resultsEl: HTMLDivElement | null = null;
let searchAllWorkspaces = false;
let searchContext: ChatSearchContext = 'code';
let open = false;
let results: SearchResult[] = [];
let filter: SearchFilter = 'all';
let includeArchived = false;
let countEl: HTMLElement | null = null;
let activeIndex = -1;
let outsidePointerHandler: ((e: PointerEvent) => void) | null = null;
let escapeHandler: ((e: KeyboardEvent) => void) | null = null;

function readSearchAllWorkspacesPreference(): boolean {
  try {
    return localStorage.getItem(ALL_WORKSPACES_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function persistSearchAllWorkspacesPreference(value: boolean): void {
  try {
    localStorage.setItem(ALL_WORKSPACES_STORAGE_KEY, value ? 'true' : 'false');
  } catch {
  }
}

function chatsForCurrentScope(): Chat[] {
  const all = (sessionState?.chats ?? []).filter(chat => !chat.background && (includeArchived || !isChatArchived(chat)));
  if (searchAllWorkspaces) return all;
  if (searchContext === 'desktop') {
    return all.filter(isDesktopSurfaceChat);
  }
  return filterChatsByWorkspacePath(all, getWorkspacePath());
}

function searchPlaceholder(): string {
  if (searchContext === 'code') return 'Search every thread and message';
  if (searchContext === 'desktop') return 'Search desktop chats…';
  return 'Search this workspace…';
}

function emptyQueryHint(): string {
  if (searchAllWorkspaces) return 'Type to search chat titles and messages';
  if (searchContext === 'desktop') return 'Type to search desktop chat titles and messages';
  return 'Type to search chats in this workspace';
}

function noResultsMessage(): string {
  if (searchAllWorkspaces) return 'No matching chats';
  if (searchContext === 'desktop') return 'No matching desktop chats';
  return 'No matching chats in this workspace';
}

function detachGlobalListeners(): void {
  if (outsidePointerHandler) {
    document.removeEventListener('pointerdown', outsidePointerHandler, true);
    outsidePointerHandler = null;
  }
  if (escapeHandler) {
    document.removeEventListener('keydown', escapeHandler, true);
    escapeHandler = null;
  }
}

/** Close the chat search popover if open. */
export function closeChatSearchPopover(): void {
  if (!open) return;
  const restoreFocus = popoverEl?.contains(document.activeElement);
  open = false;
  searchSeq += 1;
  detachGlobalListeners();
  anchorEl?.setAttribute('aria-expanded', 'false');
  if (restoreFocus) returnFocusEl?.focus();
  anchorEl = null;
  returnFocusEl = null;
  inputEl = null;
  resultsEl = null;
  searchContext = 'code';
  results = [];
  activeIndex = -1;
  countEl = null;
  if (popoverEl) unmarkPreviewOccluder(popoverEl);
  popoverEl?.remove();
  popoverEl = null;
  if (backdropEl) unmarkPreviewOccluder(backdropEl);
  backdropEl?.remove();
  backdropEl = null;
}

/** Whether the chat search popover is visible. */
export function isChatSearchPopoverOpen(): boolean {
  return open;
}

function positionPopover(anchor: HTMLElement, popover: HTMLElement): void {
  if (searchContext === 'code') return;
  const rect = anchor.getBoundingClientRect();
  const margin = 8;
  const popoverWidth = popover.offsetWidth || 320;

  let left = rect.left;
  left = Math.max(margin, Math.min(left, window.innerWidth - popoverWidth - margin));
  const top = Math.min(rect.bottom + 4, window.innerHeight - margin - 80);

  popover.style.top = `${top}px`;
  popover.style.left = `${left}px`;
}

function attachGlobalListeners(): void {
  outsidePointerHandler = (e: PointerEvent) => {
    const target = e.target as Node | null;
    if (!popoverEl || popoverEl.contains(target) || anchorEl?.contains(target)) return;
    closeChatSearchPopover();
  };
  document.addEventListener('pointerdown', outsidePointerHandler, true);

  escapeHandler = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    closeChatSearchPopover();
  };
  document.addEventListener('keydown', escapeHandler, true);
}

/** Foreground the surface that owns the chat (desktop assistant vs Code workspace). */
function openSearchResult(result: SearchResult): void {
  if ('issue' in result) {
    closeChatSearchPopover();
    void import('./issues-page').then(({ openIssues }) => openIssues({ issueId: result.issue.id }));
    return;
  }
  const { chat, messageIndex } = result;
  const isDesktop = isDesktopSurfaceChat(chat);
  closeChatSearchPopover();
  void import('../os/chat-launch').then(async (m) => {
    if (isDesktop) await m.launchChatWithThread(chat.id);
    else await m.launchCodeWithChat(chat.id);
    if (messageIndex === undefined || sessionState?.activeId !== chat.id) return;
    const mount = document.getElementById('chatArea');
    if (!mount) return;
    const selector = `.msg[data-history-index="${messageIndex}"]`;
    const show = () => {
      if (sessionState?.activeId !== chat.id) return true;
      const row = mount.querySelector<HTMLElement>(selector);
      if (!row) return false;
      row.scrollIntoView({ block: 'center' });
      row.classList.add('chat-search-hit');
      setTimeout(() => row.classList.remove('chat-search-hit'), 1_600);
      return true;
    };
    if (show()) return;
    const observer = new MutationObserver(() => { if (show()) observer.disconnect(); });
    observer.observe(mount, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 3_000);
  });
}

function workspaceBasename(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

function setActiveIndex(next: number): void {
  if (!resultsEl) return;
  const rows = resultsEl.querySelectorAll<HTMLElement>('.chat-search-result');
  if (!rows.length) {
    activeIndex = -1;
    return;
  }
  activeIndex = Math.max(0, Math.min(next, rows.length - 1));
  rows.forEach((row, i) => {
    row.classList.toggle('is-active', i === activeIndex);
    row.setAttribute('aria-selected', i === activeIndex ? 'true' : 'false');
  });
  inputEl?.setAttribute('aria-activedescendant', rows[activeIndex].id);
  rows[activeIndex].scrollIntoView?.({ block: 'nearest' });
}

function syncSearchInputPlaceholder(): void {
  if (!inputEl) return;
  const placeholder = searchPlaceholder();
  inputEl.placeholder = placeholder;
  inputEl.setAttribute('aria-label', placeholder);
}

/** Map server FTS hits onto in-memory Chat rows (summary placeholders are enough to open). */
function mapServerHitsToResults(
  hits: Awaited<ReturnType<typeof searchSessions>>,
): ChatSearchResult[] {
  const scoped = new Set(chatsForCurrentScope().map((c) => c.id));
  const out: ChatSearchResult[] = [];
  for (const hit of hits) {
    if (!scoped.has(hit.chatId)) continue;
    const chat = findChatById(hit.chatId);
    if (!chat) continue;
    out.push({
      chat,
      score: hit.score,
      matchedIn: hit.matchedIn,
      messageIndex: hit.messageIndex,
      role: hit.role,
      snippet: hit.snippet ?? '',
    });
  }
  return out;
}

let searchSeq = 0;

function paintResults(query: string, next: SearchResult[]): void {
  if (!resultsEl) return;
  resultsEl.replaceChildren();
  activeIndex = -1;
  inputEl?.removeAttribute('aria-activedescendant');
  results = next;
  if (countEl) countEl.textContent = query.trim() ? `${results.length} ${results.length === 1 ? 'result' : 'results'}` : '';

  if (!query.trim()) {
    const hint = document.createElement('div');
    hint.className = 'chat-search-empty';
    hint.textContent = emptyQueryHint();
    resultsEl.appendChild(hint);
    return;
  }

  if (!results.length) {
    const empty = document.createElement('div');
    empty.className = 'chat-search-empty';
    empty.textContent = noResultsMessage();
    resultsEl.appendChild(empty);
    return;
  }

  results.forEach((result, index) => {
    if ('issue' in result) {
      const row = document.createElement('div');
      row.id = `chat-search-result-${index}`;
      row.className = 'chat-search-result';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');
      const head = document.createElement('div');
      head.className = 'chat-search-result__head';
      const name = document.createElement('span');
      name.className = 'chat-search-result__name';
      name.textContent = result.issue.title;
      head.append(createIcon('appIssues', { size: 14 }), name, result.issue.id);
      row.append(head);
      row.addEventListener('click', () => openSearchResult(result));
      row.addEventListener('pointerenter', () => setActiveIndex(index));
      resultsEl?.append(row);
      return;
    }
    const { chat } = result;
    const isDesktop = isDesktopSurfaceChat(chat);

    const row = document.createElement('div');
    row.className = 'chat-search-result';
    row.id = `chat-search-result-${index}`;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', 'false');
    row.dataset.chatId = chat.id;

    const head = document.createElement('div');
    head.className = 'chat-search-result__head';

    const badge = document.createElement('span');
    badge.className =
      'chat-search-result__badge' +
      (isDesktop ? ' chat-search-result__badge--chat' : ' chat-search-result__badge--code');
    badge.textContent = isDesktop ? 'Chat' : 'Code';
    head.appendChild(badge);

    const name = document.createElement('span');
    name.className = 'chat-search-result__name';
    name.textContent = chat.name;
    head.appendChild(name);

    if (!isDesktop && chat.workspacePath && searchAllWorkspaces) {
      const ws = document.createElement('span');
      ws.className = 'chat-search-result__workspace';
      ws.textContent = workspaceBasename(chat.workspacePath);
      ws.title = chat.workspacePath;
      head.appendChild(ws);
    }

    row.appendChild(head);

    if (result.snippet) {
      const snippet = document.createElement('div');
      snippet.className = 'chat-search-result__snippet';
      snippet.textContent =
        result.matchedIn === 'message' && result.role === 'user'
          ? `You: ${result.snippet}`
          : result.snippet;
      row.appendChild(snippet);
    }

    row.addEventListener('click', () => openSearchResult(result));
    row.addEventListener('pointerenter', () => setActiveIndex(index));
    resultsEl?.appendChild(row);
  });
  if (searchContext === 'code') setActiveIndex(0);
}

/** Run search — server FTS when file-backed; pure scorer for localStorage fallback. */
function renderResults(query: string): void {
  const seq = ++searchSeq;
  const trimmed = query.trim();
  if (!trimmed) {
    paintResults(query, []);
    return;
  }

  const match = filter === 'title' || filter === 'message' ? filter : undefined;
  const workspace = searchAllWorkspaces || searchContext === 'desktop' ? undefined : getWorkspacePath();
  const issues: SearchResult[] = filter === 'all' || filter === 'issue'
    ? listIssues().filter(issue => {
      if (workspace && normalizeWorkspacePath(issue.workspacePath) !== normalizeWorkspacePath(workspace)) return false;
      const haystack = `${issue.id} ${issue.title} ${issue.description}`.toLowerCase();
      return trimmed.toLowerCase().split(/\s+/).every(term => haystack.includes(term));
    }).slice(0, 20).map(issue => ({ issue }))
    : [];
  const local = () => searchChats(chatsForCurrentScope().map(chat => chat.historyLoaded === false
    ? { ...chat, history: [] } : chat), query, { match });
  if (filter === 'issue') {
    paintResults(query, issues);
    return;
  }
  if (!isServerStorageMode()) {
    paintResults(query, [...local(), ...issues]);
    return;
  }

  void searchSessions(trimmed, {
    workspace,
    limit: 30,
    match,
  })
    .then((hits) => {
      if (seq !== searchSeq || !resultsEl) return;
      let mapped = mapServerHitsToResults(hits);
      if (searchContext === 'desktop' && !searchAllWorkspaces) {
        mapped = mapped.filter((r) => isDesktopSurfaceChat(r.chat));
      }
      paintResults(query, [...mapped, ...issues]);
    })
    .catch(() => {
      if (seq !== searchSeq || !resultsEl) return;
      paintResults(query, [...local(), ...issues]);
    });
}

function onInputKeydown(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    setActiveIndex(activeIndex + 1);
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    setActiveIndex(activeIndex - 1);
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const target = results[activeIndex] ?? results[0];
    if (target) openSearchResult(target);
  }
}

function buildPopover(): HTMLDivElement {
  const popover = document.createElement('div');
  popover.className = 'chat-search-popover';
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-modal', 'false');
  popover.setAttribute('aria-label', 'Search chats');

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'chat-search-input';
  input.addEventListener('input', () => renderResults(input.value));
  input.addEventListener('keydown', onInputKeydown);

  const { row: scopeRow, input: scopeToggle } = createSettingsToggleRow('All workspaces', {
    id: 'chatSearchAllWorkspaces',
    checked: searchAllWorkspaces,
    onChange: (checked) => {
      searchAllWorkspaces = checked;
      persistSearchAllWorkspacesPreference(checked);
      syncSearchInputPlaceholder();
      renderResults(input.value);
    },
  });
  scopeRow.classList.add('chat-search-scope-toggle');

  const list = document.createElement('div');
  list.id = 'chatSearchResults';
  list.className = 'chat-search-results';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Matching chats');

  if (searchContext === 'code') {
    popover.classList.add('chat-search-popover--graphite');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', list.id);
    const searchBar = document.createElement('div');
    searchBar.className = 'chat-search-bar';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'chat-search-close';
    close.textContent = 'esc';
    close.setAttribute('aria-label', 'Close search');
    close.addEventListener('click', closeChatSearchPopover);
    searchBar.append(createIcon('search', { size: 16 }), input, close);
    const toolbar = document.createElement('div');
    toolbar.className = 'chat-search-toolbar';
    const filters = document.createElement('div');
    filters.className = 'chat-search-filters';
    filters.setAttribute('role', 'group');
    filters.setAttribute('aria-label', 'Search in');
    for (const [id, label] of [['all', 'All'], ['title', 'Threads'], ['message', 'Messages'], ['issue', 'Issues']] as const) {
      const option = document.createElement('button');
      option.type = 'button';
      option.textContent = label;
      option.setAttribute('aria-pressed', String(filter === id));
      option.addEventListener('click', () => {
        filter = id;
        for (const button of filters.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button === option));
        renderResults(input.value);
      });
      filters.append(option);
    }
    const archived = document.createElement('label');
    archived.className = 'chat-search-archived';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = includeArchived;
    checkbox.addEventListener('change', () => { includeArchived = checkbox.checked; renderResults(input.value); });
    archived.append(checkbox, 'Include archived');
    toolbar.append(filters, archived);
    const footer = document.createElement('div');
    footer.className = 'chat-search-footer';
    countEl = document.createElement('span');
    footer.append('↑ ↓ Move', '↵ Open at the message', countEl);
    popover.append(searchBar, toolbar, list, footer, scopeRow);
  } else {
    popover.append(input, scopeRow, list);
  }
  inputEl = input;
  resultsEl = list;
  syncSearchInputPlaceholder();
  scopeToggle.checked = searchAllWorkspaces;
  return popover;
}

/** Open centered Code search or position desktop search beside its trigger. */
export function openChatSearchPopover(anchor?: HTMLElement): void {
  closeChatSearchPopover();

  void getChatsWorkspacePath();

  searchContext = anchor?.id === 'btnDesktopChatSearch' ? 'desktop' : 'code';
  const focused = document.activeElement;
  returnFocusEl = anchor ?? (focused instanceof HTMLElement ? focused : null);
  searchAllWorkspaces = readSearchAllWorkspacesPreference();
  filter = 'all';
  includeArchived = searchContext === 'desktop';

  popoverEl = buildPopover();
  if (searchContext === 'code') {
    backdropEl = document.createElement('button');
    backdropEl.type = 'button';
    backdropEl.className = 'chat-search-scrim';
    backdropEl.tabIndex = -1;
    backdropEl.setAttribute('aria-label', 'Close search');
    backdropEl.addEventListener('click', closeChatSearchPopover);
    document.body.append(backdropEl);
    markPreviewOccluder(backdropEl, 'panel');
  }
  document.body.appendChild(popoverEl);
  anchorEl = anchor ?? null;
  open = true;
  markPreviewOccluder(popoverEl, 'panel');
  anchor?.setAttribute('aria-expanded', 'true');

  renderResults('');
  if (anchor) positionPopover(anchor, popoverEl);
  attachGlobalListeners();

  requestAnimationFrame(() => inputEl?.focus());
}

/** Toggle search from a shortcut or its anchor button. */
export function toggleChatSearchPopover(anchor?: HTMLElement): void {
  if (open && anchorEl === (anchor ?? null)) {
    closeChatSearchPopover();
    return;
  }
  openChatSearchPopover(anchor);
}
