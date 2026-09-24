import {
  downloadChatsWorkspaceFile,
  listChatsWorkspaceFiles,
  type ChatsWorkspaceListEntry,
} from '../lib/chats-workspace';
import type { ToolExecutionResult } from '../types';
import { isChatAppForeground } from './chat-mount';
import { setStatus } from './status';
import { iconHtml } from './icon';

const EMPTY_MESSAGE = 'Files the assistant creates will appear here';
const REFRESH_DEBOUNCE_MS = 300;

/** Built-in tools that mutate workspace files (aligned with file-tree-auto-refresh). */
const OUTPUTS_MUTATING_TOOLS = new Set<string>([
  'save_file',
  'apply_patch',
  'append_file',
  'insert_at_line',
  'replace_text_in_file',
  'make_directory',
  'move_file',
  'copy_file',
  'delete_path',
]);

const expandedDirs = new Set<string>();
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function getOutputsBody(): HTMLElement | null {
  return document.getElementById('chatAppFilesBody');
}

function renderEmptyState(body: HTMLElement, message: string): void {
  body.replaceChildren();
  const empty = document.createElement('p');
  empty.className = 'chat-app-outputs-empty';
  empty.textContent = message;
  body.appendChild(empty);
}

function renderFileRow(entry: ChatsWorkspaceListEntry, depth: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'chat-app-outputs-row chat-app-outputs-row--file';
  row.style.paddingLeft = `${22 + depth * 14}px`;
  row.setAttribute('role', 'treeitem');

  const label = document.createElement('span');
  label.className = 'chat-app-outputs-name';
  label.textContent = entry.name;
  label.title = entry.relativePath;

  const downloadBtn = document.createElement('button');
  downloadBtn.type = 'button';
  downloadBtn.className = 'chat-app-outputs-download';
  downloadBtn.setAttribute('aria-label', `Download ${entry.name}`);
  downloadBtn.innerHTML =
    iconHtml('download');

  downloadBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    void downloadChatsWorkspaceFile(entry.relativePath).then((result) => {
      if (result instanceof Error) {
        setStatus('err', result.message);
      }
    });
  });

  row.append(label, downloadBtn);
  return row;
}

function renderDirRow(entry: ChatsWorkspaceListEntry, depth: number): HTMLElement {
  const isOpen = expandedDirs.has(entry.relativePath);
  const row = document.createElement('div');
  row.className = 'chat-app-outputs-row chat-app-outputs-row--dir';
  row.style.paddingLeft = `${8 + depth * 14}px`;
  row.setAttribute('role', 'treeitem');
  row.setAttribute('aria-expanded', isOpen ? 'true' : 'false');

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'chat-app-outputs-dir-toggle';
  toggle.setAttribute('aria-label', `${isOpen ? 'Collapse' : 'Expand'} ${entry.name}`);
  toggle.innerHTML = iconHtml('chevronRight', {
    className: `chat-app-outputs-dir-chevron${isOpen ? ' is-open' : ''}`,
  });

  const label = document.createElement('span');
  label.className = 'chat-app-outputs-name';
  label.textContent = entry.name;

  row.append(toggle, label);

  const toggleDir = (): void => {
    if (expandedDirs.has(entry.relativePath)) {
      expandedDirs.delete(entry.relativePath);
    } else {
      expandedDirs.add(entry.relativePath);
    }
    void refreshChatAppOutputsPanel();
  };

  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleDir();
  });
  row.addEventListener('click', toggleDir);

  return row;
}

async function renderDirChildren(
  container: HTMLElement,
  entries: ChatsWorkspaceListEntry[],
  depth: number,
): Promise<void> {
  for (const entry of entries) {
    if (entry.kind === 'directory') {
      container.appendChild(renderDirRow(entry, depth));
      if (!expandedDirs.has(entry.relativePath)) continue;

      const childWrap = document.createElement('div');
      childWrap.className = 'chat-app-outputs-children';
      container.appendChild(childWrap);

      const childListing = await listChatsWorkspaceFiles(entry.relativePath);
      if (!childListing?.entries?.length) continue;
      await renderDirChildren(childWrap, childListing.entries, depth + 1);
      continue;
    }

    container.appendChild(renderFileRow(entry, depth));
  }
}

/** Reload the outputs file tree in #chatAppFilesBody. */
export async function refreshChatAppOutputsPanel(): Promise<void> {
  const body = getOutputsBody();
  if (!body || !isChatAppForeground()) return;

  const listing = await listChatsWorkspaceFiles('');
  if (!listing) {
    renderEmptyState(body, 'Outputs unavailable — open Minnow');
    return;
  }

  if (!listing.entries.length) {
    renderEmptyState(body, EMPTY_MESSAGE);
    return;
  }

  body.replaceChildren();
  const tree = document.createElement('div');
  tree.className = 'chat-app-outputs-tree';
  tree.setAttribute('role', 'tree');
  body.appendChild(tree);
  await renderDirChildren(tree, listing.entries, 0);
}

function flushDebouncedRefresh(): void {
  debounceTimer = null;
  void refreshChatAppOutputsPanel().catch(() => {
  });
}

/** Debounced refresh after a successful mutating tool while Chat app is foreground. */
export function scheduleChatAppOutputsRefreshAfterTool(
  toolName: string,
  result: ToolExecutionResult,
): void {
  if (!isChatAppForeground()) return;
  if (!OUTPUTS_MUTATING_TOOLS.has(toolName)) return;

  const text = typeof result.content === 'string' ? result.content : '';
  if (text.startsWith('Error:')) return;

  if (debounceTimer != null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushDebouncedRefresh, REFRESH_DEBOUNCE_MS);
}

/** Test helper: cancel pending debounced refresh. */
export function resetChatAppOutputsRefreshForTests(): void {
  if (debounceTimer != null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  expandedDirs.clear();
}
