import '../styles/graphite-archive.css';
import { getCurrentRoute, launchApp } from '../os/router';
import { isChatArchived } from '../state/chat-archive';
import { getSidebarListedChatsForWorkspace, getUnassignedChats, sessionState } from '../state/sessions';
import { getWorkspacePath, subscribeWorkspace } from '../state/workspace';
import type { Chat } from '../types';
import { createIcon } from './icon';
import { setChatsArchivedWithUndo, subscribeSidebarRender } from './sidebar';
import { refreshSurfacePanels } from './surfaces/surfaces-column';

let root: HTMLElement | undefined;
let opener: HTMLElement | undefined;
let search: HTMLInputElement | undefined;
let list: HTMLElement | undefined;
let opened = false;
let initialized = false;
const selected = new Set<string>();

function notifyViewChange(): void {
  refreshSurfacePanels();
  window.dispatchEvent(new window.Event('minnow:graphite-archive-view'));
}

function close(restoreFocus = false): void {
  if (!opened) return;
  opened = false;
  root?.parentElement?.classList.remove('graphite-archive-open');
  if (root) root.hidden = true;
  opener?.setAttribute('aria-pressed', 'false');
  if (restoreFocus && opener?.isConnected) opener.focus();
  opener = undefined;
  notifyViewChange();
}

function visibleChats(query: string): Chat[] {
  const state = sessionState;
  if (!state) return [];
  const workspace = getWorkspacePath();
  const scoped = workspace ? [...getSidebarListedChatsForWorkspace(workspace, state), ...getUnassignedChats(state)] : getUnassignedChats(state);
  return scoped.filter(chat => isChatArchived(chat) &&
    (!query || `${chat.name} ${chat.gitBranch || ''}`.toLowerCase().includes(query)))
    .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function draw(): void {
  if (!opened || !list || !search) return;
  const query = search.value.trim().toLowerCase();
  const chats = visibleChats(query);
  list.replaceChildren();
  if (!chats.length) {
    list.append(el('p', 'graphite-archive__empty', query ? 'Nothing archived matches that.' : 'No archived threads.'));
    return;
  }
  const bulk = el('button', 'graphite-archive__restore', `Restore ${selected.size} selected`);
  bulk.type = 'button';
  bulk.hidden = selected.size === 0;
  bulk.addEventListener('click', () => {
    const targets = chats.filter(chat => selected.has(chat.id));
    selected.clear();
    setChatsArchivedWithUndo(targets, false);
  });
  list.append(bulk);
  const groups = new Map<string, HTMLElement>();
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const formatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  for (const chat of chats) {
    const label = (chat.archivedAt ?? 0) >= weekAgo ? 'This week' : 'Earlier';
    let group = groups.get(label);
    if (!group) {
      list.append(el('h3', '', label));
      group = el('div', 'graphite-archive__group');
      groups.set(label, group);
      list.append(group);
    }
    const row = el('div', 'graphite-archive__row');
    const select = el('input', 'graphite-archive__select');
    select.type = 'checkbox';
    select.checked = selected.has(chat.id);
    select.setAttribute('aria-label', `Select ${chat.name}`);
    select.addEventListener('change', () => {
      if (select.checked) selected.add(chat.id);
      else selected.delete(chat.id);
      bulk.hidden = selected.size === 0;
      bulk.textContent = `Restore ${selected.size} selected`;
    });
    const thread = el('button', 'graphite-archive__thread');
    thread.type = 'button';
    thread.append(el('span', '', chat.name));
    if (chat.gitBranch) thread.append(el('code', '', chat.gitBranch));
    thread.addEventListener('click', () => {
      close();
      void import('../os/chat-launch').then(({ launchCodeWithChat }) => launchCodeWithChat(chat.id));
    });
    const restore = el('button', 'graphite-archive__restore');
    restore.type = 'button';
    restore.append(createIcon('unarchive', { size: 14 }), 'Restore');
    restore.addEventListener('click', () => {
      selected.delete(chat.id);
      setChatsArchivedWithUndo([chat], false);
      search?.focus();
    });
    row.append(select, createIcon('archive', { size: 14 }), thread);
    const totals = chat.codeChangeTotals;
    if (totals?.additions || totals?.deletions) {
      row.append(el('code', 'graphite-thread-addition', `+${totals.additions}`), el('code', 'graphite-thread-deletion', `−${totals.deletions}`));
    }
    if (chat.archivedAt) {
      const time = el('time', '', formatter.format(chat.archivedAt));
      time.dateTime = new Date(chat.archivedAt).toISOString();
      row.append(time);
    }
    row.append(restore);
    group.append(row);
  }
}

function mount(main: HTMLElement): void {
  root = el('section', 'graphite-archive');
  root.id = 'graphiteArchive';
  root.setAttribute('aria-labelledby', 'graphiteArchiveTitle');
  const content = el('div', 'graphite-archive__content');
  const heading = el('div', 'graphite-archive__heading');
  const copy = el('div', '');
  const title = el('h2', '', 'Archived threads');
  title.id = 'graphiteArchiveTitle';
  copy.append(title, el('p', '', 'Transcripts and branches stay put. Restore a thread to pick it up again.'));
  const field = el('label', 'graphite-archive__search');
  search = el('input', '');
  search.type = 'search';
  search.placeholder = 'Search archive';
  search.setAttribute('aria-label', 'Search archive');
  search.addEventListener('input', () => {
    selected.clear();
    draw();
  });
  field.append(createIcon('search', { size: 14 }), search);
  heading.append(copy, field);
  list = el('div', 'graphite-archive__list');
  content.append(heading, list);
  root.append(content);
  main.append(root);
}

export function openGraphiteArchive(anchor?: HTMLElement): boolean {
  const main = document.getElementById('mainColumn');
  if (!main || !document.documentElement.classList.contains('mn-graphite-workspace')) return false;
  if (opened) {
    close(true);
    return true;
  }
  if (!root) mount(main);
  if (!root || !search) return false;
  if (!initialized) {
    initialized = true;
    subscribeSidebarRender(() => {
      draw();
      if (opened) queueMicrotask(() => { if (opened) opener?.setAttribute('aria-pressed', 'true'); });
    });
    subscribeWorkspace(() => close());
    window.addEventListener('hashchange', () => {
      const route = getCurrentRoute();
      if (route.appId !== 'code' || route.codeSection && route.codeSection !== 'chat') close();
    });
    document.addEventListener('click', event => {
      if (!opened || !(event.target instanceof Element)) return;
      if (event.target.closest('#chatList .chat-item-row, .mn-graphite-thread-new, #chatListViews [data-chat-view="working"]')) close();
    }, true);
    window.addEventListener('keydown', event => {
      if (!opened || event.defaultPrevented || event.key !== 'Escape') return;
      if (root?.contains(document.activeElement) || opener === document.activeElement) close(true);
    });
  }
  const route = getCurrentRoute();
  if (route.appId !== 'code' || route.codeSection && route.codeSection !== 'chat') launchApp('code', { codeSection: 'chat' });
  opened = true;
  opener = anchor;
  opener?.setAttribute('aria-controls', root.id);
  opener?.setAttribute('aria-pressed', 'true');
  selected.clear();
  search.value = '';
  root.hidden = false;
  main.classList.add('graphite-archive-open');
  notifyViewChange();
  draw();
  requestAnimationFrame(() => search?.focus());
  return true;
}
