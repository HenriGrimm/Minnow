import type { Chat } from '../types';
import { resolveChatWorktreeRoot } from '../state/chat-worktree';
import { gitWorktreeStatus, type GitWorktreeStatusResult } from '../state/git-api';
import { normalizeWorkspacePath } from '../lib/normalize-workspace-path';
import { isLocalServerAvailable } from '../tools/config';
import { applyIcon, createIcon } from './icon';

const REFRESH_MS = 15_000;
const cache = new Map<string, { at: number; result?: GitWorktreeStatusResult; pending?: Promise<void> }>();
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let refreshQueued = false;

function applyStatus(icon: HTMLElement, result?: GitWorktreeStatusResult): void {
  const merged = result?.ok === true && result.merged === true && !result.dirty;
  const state = merged ? 'merged' : 'worktree';
  if (icon.dataset.worktreeState !== state) {
    applyIcon(icon, merged ? 'gitMerge' : 'gitBranch');
    icon.dataset.worktreeState = state;
  }
  const branch = result?.ok && result.branch && result.branch !== 'HEAD' ? ` · ${result.branch}` : '';
  const status = result?.ok && result.trunk && result.merged != null
    ? merged ? ` · Merged into ${result.trunk}`
      : result.dirty ? ` · Uncommitted changes${result.merged ? '' : ` · Not merged into ${result.trunk}`}`
        : ` · Not merged into ${result.trunk}`
    : ' · Merge status unavailable';
  const label = `Worktree${branch}${status}`;
  icon.title = `${label}\n${icon.dataset.worktreeRoot}`;
  icon.setAttribute('aria-label', label);
  const row = icon.closest<HTMLElement>('.chat-item-row');
  if (row) {
    const previous = row.dataset.worktreeLabel;
    for (const [attribute, separator] of [['aria-label', ', '], ['title', '\n']]) {
      let base = row.getAttribute(attribute) ?? '';
      if (previous && base.endsWith(`${separator}${previous}`)) {
        base = base.slice(0, -(separator.length + previous.length));
      }
      row.setAttribute(attribute, `${base}${separator}${label}`);
    }
    row.dataset.worktreeLabel = label;
  }
}

function refreshIcons(): void {
  if (document.visibilityState === 'hidden' || !isLocalServerAvailable()) return;
  document.querySelectorAll<HTMLElement>('.chat-item-icon[data-worktree-root]').forEach((icon) => {
    const root = icon.dataset.worktreeRoot!;
    const key = normalizeWorkspacePath(root);
    let entry = cache.get(key);
    if (!entry) {
      if (cache.size >= 100) {
        const oldest = [...cache].find(([, value]) => !value.pending);
        if (oldest) cache.delete(oldest[0]);
      }
      entry = { at: 0 };
      cache.set(key, entry);
    }
    if (entry.pending || Date.now() - entry.at < REFRESH_MS) return;
    const current = entry;
    current.at = Date.now();
    current.pending = gitWorktreeStatus(root).then((result) => {
      current.result = result;
      document.querySelectorAll<HTMLElement>('.chat-item-icon[data-worktree-root]').forEach((target) => {
        if (normalizeWorkspacePath(target.dataset.worktreeRoot!) === key) applyStatus(target, result);
      });
    }).finally(() => { current.pending = undefined; });
  });
}

function scheduleRefresh(): void {
  if (refreshTimer !== undefined) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    if (!document.querySelector('.chat-item-icon[data-worktree-root]')) return;
    refreshIcons();
    scheduleRefresh();
  }, REFRESH_MS);
}

/** Update only the worktree indicator, preserving the row and its live status dot. */
export function syncChatItemWorktreeIcon(row: HTMLElement, chat: Chat): void {
  const titleRow = row.querySelector('.chat-item-title-row');
  if (!titleRow) return;
  let icon = titleRow.querySelector<HTMLElement>('.chat-item-icon');
  const root = resolveChatWorktreeRoot(chat);
  if (!root) {
    icon?.remove();
    delete row.dataset.worktreeLabel;
    return;
  }
  if (!icon) {
    icon = createIcon('gitBranch', { className: 'chat-item-icon chat-item-worktree-icon' });
    icon.removeAttribute('aria-hidden');
    icon.setAttribute('role', 'img');
    titleRow.prepend(icon);
  }
  icon.dataset.worktreeRoot = root;
  applyStatus(icon, cache.get(normalizeWorkspacePath(root))?.result);
  if (!refreshQueued) {
    refreshQueued = true;
    queueMicrotask(() => {
      refreshQueued = false;
      refreshIcons();
    });
  }
  scheduleRefresh();
}
