/** Files tab: folder-by-folder browsing, go-to-file search, and recent files. */

import { executeTool } from '../tools/client';
import { parseListDirectoryResult } from '../lib/list-directory-parse';
import { createFileTypeIconElement, createFolderTypeIconElement } from '../ui/file-type-icons';
import { fetchSharedFileIndex } from '../ui/file-tree-index-client';
import { listRecentViewerFiles } from '../state/recent-viewer-files';
import { getWorkspaceLabel, getWorkspacePath, subscribeWorkspace } from '../state/workspace';
import { attachPullToRefresh, screenHeader, searchField } from './chrome';
import { el, emptyState, icon, shortTime } from './dom';
import { fuzzyScore, listFromIndex } from './file-index';
import type { MobileScreen } from './nav';

export interface FilesDeps {
  openDir(path: string): void;
  openFile(path: string): void;
}

/** Folders that are noise on a phone; still reachable from search results' parents. */
const HIDDEN_DIRS = new Set(['.git', 'node_modules', '.DS_Store']);

function joinPath(dir: string, name: string): string {
  return dir === '.' || !dir ? name : `${dir}/${name}`;
}

function baseName(path: string): string {
  return path.split('/').pop() || path;
}

function dirName(path: string): string {
  const index = path.lastIndexOf('/');
  return index > 0 ? path.slice(0, index) : '';
}

function entryRow(options: { name: string; path: string; kind: 'dir' | 'file'; meta?: string; onClick: () => void }): HTMLElement {
  return el(
    'button',
    {
      className: `m-file-row m-file-row--${options.kind}`,
      attrs: { type: 'button' },
      dataset: { path: options.path },
      on: { click: options.onClick },
    },
    el('span', { className: 'm-file-row__icon' }, options.kind === 'dir' ? createFolderTypeIconElement(options.name) : createFileTypeIconElement(options.name)),
    el(
      'span',
      { className: 'm-file-row__main' },
      el('span', { className: 'm-file-row__name', text: options.name }),
      options.meta ? el('span', { className: 'm-file-row__meta', text: options.meta }) : null,
    ),
    options.kind === 'dir' ? icon('fi-rr-angle-small-right', 18) : null,
  );
}

let indexCache: { workspace: string; at: number; files: Promise<string[] | { error: string }> } | null = null;

/** The workspace's file list (one request, shared by search and listing fallback). */
function workspaceIndex(options: { fresh?: boolean } = {}): Promise<string[] | { error: string }> {
  const workspace = getWorkspacePath();
  if (!options.fresh && indexCache && indexCache.workspace === workspace && Date.now() - indexCache.at < 30_000) {
    return indexCache.files;
  }
  const files = fetchSharedFileIndex('.', workspace, new AbortController().signal).then((result) => {
    if ('error' in result) indexCache = null;
    return result;
  });
  indexCache = { workspace, at: Date.now(), files };
  return files;
}


/**
 * Folder listing. Prefers the `list_directory` tool (it shows ignored files
 * too); when that tool is turned off for agents, the file index still works.
 */
async function listDir(path: string): Promise<{ dirs: string[]; files: string[] } | { error: string }> {
  try {
    const raw = (await executeTool('list_directory', { path })).content;
    const parsed = parseListDirectoryResult(typeof raw === 'string' ? raw : String(raw ?? ''));
    if (!('error' in parsed) || !/disabled|not allowed|permission/i.test(parsed.error)) return parsed;
  } catch {}
  const files = await workspaceIndex();
  return 'error' in files ? files : listFromIndex(files, path);
}


/** One folder. Root (`.`) adds search and recents. */
export function createDirScreen(path: string, deps: FilesDeps): MobileScreen {
  const isRoot = path === '.';
  const header = screenHeader({
    title: isRoot ? 'Files' : baseName(path),
    subtitle: isRoot ? getWorkspaceLabel() : dirName(path) || getWorkspaceLabel(),
    back: !isRoot,
    large: isRoot,
  });
  const list = el('div', { className: 'm-list', attrs: { role: 'list' } });
  const results = el('div', { className: 'm-list', attrs: { role: 'list' } });
  results.hidden = true;
  const recents = el('div', { className: 'm-recent-files' });
  let index: Promise<string[] | { error: string }> | null = null;
  let query = '';

  const search = isRoot
    ? searchField('Go to file', (text) => {
        query = text.toLowerCase();
        void runSearch();
      })
    : null;
  const body = el('div', { className: 'm-screen__body' }, search?.el ?? null, results, recents, list);
  const root = el('section', { className: `m-screen${isRoot ? ' m-screen--root' : ''}`, dataset: { screen: `dir:${path}` } }, header.el, body);

  async function runSearch(): Promise<void> {
    if (!query) {
      results.hidden = true;
      list.hidden = false;
      recents.hidden = false;
      return;
    }
    results.hidden = false;
    list.hidden = true;
    recents.hidden = true;
    if (!index) {
      index = workspaceIndex();
      results.replaceChildren(el('div', { className: 'm-skeleton' }));
    }
    const current = query;
    const files = await index;
    if (current !== query) return;
    if ('error' in files) {
      index = null;
      results.replaceChildren(emptyState({ glyph: 'fi-rr-search', title: 'Search is unavailable', body: files.error }));
      return;
    }
    const ranked = files
      .map((file) => ({ file, score: fuzzyScore(file, current) }))
      .filter((hit) => hit.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 60);
    results.replaceChildren(
      ...(ranked.length
        ? ranked.map(({ file }) => entryRow({ name: baseName(file), path: file, kind: 'file', meta: dirName(file), onClick: () => deps.openFile(file) }))
        : [emptyState({ glyph: 'fi-rr-search', title: 'No matching files' })]),
    );
  }

  function renderRecents(): void {
    if (!isRoot) return;
    const recent = listRecentViewerFiles().slice(0, 5);
    if (!recent.length) {
      recents.replaceChildren();
      return;
    }
    recents.replaceChildren(
      el('h2', { className: 'm-section-label', text: 'Recent' }),
      ...recent.map((entry) =>
        entryRow({
          name: baseName(entry.path),
          path: entry.path,
          kind: 'file',
          meta: [dirName(entry.path), shortTime(entry.openedAt)].filter(Boolean).join(' · '),
          onClick: () => deps.openFile(entry.path),
        }),
      ),
      el('h2', { className: 'm-section-label', text: getWorkspaceLabel() || 'Workspace' }),
    );
  }

  async function load(): Promise<void> {
    if (!list.childElementCount) list.append(el('div', { className: 'm-skeleton' }), el('div', { className: 'm-skeleton' }));
    try {
      const listing = await listDir(path);
      if ('error' in listing) {
        list.replaceChildren(emptyState({ glyph: 'fi-rr-folder-times', title: 'Could not open this folder', body: listing.error }));
        return;
      }
      const dirs = listing.dirs.filter((name) => !HIDDEN_DIRS.has(name));
      const rows = [
        ...dirs.map((name) => entryRow({ name, path: joinPath(path, name), kind: 'dir', onClick: () => deps.openDir(joinPath(path, name)) })),
        ...listing.files.map((name) => entryRow({ name, path: joinPath(path, name), kind: 'file', onClick: () => deps.openFile(joinPath(path, name)) })),
      ];
      list.replaceChildren(...(rows.length ? rows : [emptyState({ glyph: 'fi-rr-folder-open', title: 'Empty folder' })]));
    } catch (error) {
      list.replaceChildren(emptyState({ glyph: 'fi-rr-cloud-disabled', title: 'Could not open this folder', body: error instanceof Error ? error.message : String(error) }));
    }
  }

  attachPullToRefresh(body, async () => {
    index = null;
    await workspaceIndex({ fresh: true });
    await load();
  });

  const unsubWorkspace = isRoot
    ? subscribeWorkspace(() => {
        index = null;
        header.setSubtitle(getWorkspaceLabel());
        list.replaceChildren();
        void load();
        renderRecents();
      })
    : () => {};

  let loaded = false;
  return {
    key: `dir:${path}`,
    el: root,
    onShow() {
      renderRecents();
      if (!loaded) {
        loaded = true;
        void load();
      }
    },
    dispose() {
      unsubWorkspace();
    },
  };
}
