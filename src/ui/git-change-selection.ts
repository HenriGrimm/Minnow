import { gitDiscard, gitIgnore, gitStage, gitUnstage, type GitOpResult } from '../state/git-api';
import { appConfirm } from './app-dialog';
import { openContextMenu, type ContextMenuHandle, type MenuItem } from './context-menu';
import { revealPathInSystemExplorer } from './reveal-in-system-explorer';
import { showToast } from './toast';
import '../styles/git-change-selection.css';

export interface GitChangeSelectionEntry {
  path: string;
  bucket: 'staged' | 'unstaged' | 'untracked' | 'conflicted';
}

interface Options {
  root: HTMLElement;
  getCwd: () => string;
  run: (fn: () => Promise<GitOpResult>, message: string) => Promise<unknown>;
  onOpen: (entry: GitChangeSelectionEntry) => void;
}

const key = (entry: GitChangeSelectionEntry): string => JSON.stringify([entry.bucket, entry.path]);

/** Shared change selection and batch actions for the sidebar and Changes app. */
export function createGitChangeSelection(options: Options) {
  let entries: GitChangeSelectionEntry[] = [];
  let selected = new Set<string>();
  let anchor: string | null = null;
  let cwd = options.getCwd();
  let rows = new Map<string, HTMLElement>();
  let menu: ContextMenuHandle | null = null;
  let alive = true;
  let busy = false;
  let revision = 0;
  const current = () => alive && cwd === options.getCwd();
  const selectedEntries = () => entries.filter((entry) => selected.has(key(entry)));

  function paint(): void {
    for (const [id, row] of rows) {
      row.classList.toggle('is-selected', selected.has(id));
      row.setAttribute('aria-selected', String(selected.has(id)));
    }
    options.root.setAttribute('aria-label', `Changes, ${selected.size} selected. Shift-click for a range; Command or Control-click to select multiple.`);
  }

  function choose(entry: GitChangeSelectionEntry, event?: Pick<MouseEvent, 'shiftKey' | 'metaKey' | 'ctrlKey'>, preview = true): void {
    const id = key(entry);
    const additive = event?.metaKey || event?.ctrlKey;
    if (event?.shiftKey && anchor) {
      const from = entries.findIndex((item) => key(item) === anchor);
      const to = entries.findIndex((item) => key(item) === id);
      if (!additive) selected.clear();
      for (const item of entries.slice(Math.max(0, Math.min(from, to)), Math.max(from, to) + 1)) selected.add(key(item));
    } else if (additive) {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      anchor = id;
    } else {
      selected = new Set([id]);
      anchor = id;
    }
    paint();
    if (preview && !event?.shiftKey && !additive) options.onOpen(entry);
  }

  async function mutate(fn: () => Promise<GitOpResult>, message: string, capturedCwd: string): Promise<void> {
    if (!current() || busy || capturedCwd !== cwd) return;
    busy = true;
    try { await options.run(fn, message); }
    finally { busy = false; }
  }

  async function discard(changes: GitChangeSelectionEntry[]): Promise<void> {
    const capturedCwd = cwd;
    const capturedRevision = revision;
    const paths = [...new Set(changes.map((entry) => entry.path))];
    if (!current() || !paths.length || busy) return;
    const confirmed = await appConfirm(
      `Discard ${paths.length === 1 ? `changes to ${paths[0]}` : `${paths.length} selected changes`}? Untracked files will be deleted. This cannot be undone.`,
      { title: 'Discard changes', confirmLabel: 'Discard', danger: true },
    );
    if (!confirmed || capturedRevision !== revision) return;
    const stagedPaths = [...new Set(changes.filter((entry) => entry.bucket === 'staged').map((entry) => entry.path))];
    await mutate(() => gitDiscard({ paths, stagedPaths, cwd: capturedCwd }), `Discarded ${paths.length} change${paths.length === 1 ? '' : 's'}`, capturedCwd);
  }

  function showMenu(entry: GitChangeSelectionEntry, row: HTMLElement, event?: MouseEvent, anchor = row): void {
    if (!current()) return;
    event?.preventDefault();
    event?.stopPropagation();
    if (!selected.has(key(entry))) choose(entry, undefined, false);
    const changes = selectedEntries();
    const paths = [...new Set(changes.map((item) => item.path))];
    const capturedCwd = cwd;
    const capturedRevision = revision;
    const staged = [...new Set(changes.filter((item) => item.bucket === 'staged').map((item) => item.path))];
    const unstaged = [...new Set(changes.filter((item) => item.bucket !== 'staged').map((item) => item.path))];
    const count = paths.length;
    const extensions = [...new Set(paths.map((p) => /\.[a-zA-Z0-9_-]+$/.exec(p.split('/').pop() ?? '')?.[0]).filter((ext): ext is string => !!ext))].sort();
    const guarded = (fn: () => void | Promise<void>) => () => { if (current() && capturedCwd === cwd && capturedRevision === revision) return fn(); };
    const ignoreHint = 'Adds to .gitignore. Tracked files remain tracked.';
    const items: MenuItem[] = [
      { id: 'discard', label: `Discard ${count === 1 ? 'change' : `${count} selected changes`}…`, danger: true, disabled: busy, onSelect: guarded(() => discard(changes)) },
      { kind: 'separator' },
      { id: 'ignore', label: `Ignore ${count === 1 ? 'file' : `${count} selected files`}`, hint: ignoreHint, disabled: busy, onSelect: guarded(() => mutate(() => gitIgnore({ paths, cwd: capturedCwd }), 'Updated .gitignore', capturedCwd)) },
      ...extensions.map((extension): MenuItem => ({ id: `ignore-${extension}`, label: `Ignore all ${extension} files`, hint: ignoreHint, disabled: busy, onSelect: guarded(() => mutate(() => gitIgnore({ extensions: [extension], cwd: capturedCwd }), 'Updated .gitignore', capturedCwd)) })),
      { kind: 'separator' },
      { id: 'stage', label: `Stage ${count === 1 ? 'change' : 'selected changes'}`, disabled: busy || !unstaged.length, onSelect: guarded(() => mutate(() => gitStage({ paths: unstaged, cwd: capturedCwd }), 'Staged selected changes', capturedCwd)) },
      { id: 'unstage', label: `Unstage ${count === 1 ? 'change' : 'selected changes'}`, disabled: busy || !staged.length, onSelect: guarded(() => mutate(() => gitUnstage({ paths: staged, cwd: capturedCwd }), 'Unstaged selected changes', capturedCwd)) },
      { kind: 'separator' },
      { id: 'copy-paths', label: 'Copy paths', onSelect: guarded(() => copy(paths.map((p) => `${capturedCwd.replace(/[\\/]$/, '')}/${p}`).join('\n'))) },
      { id: 'copy-relative', label: 'Copy relative paths', onSelect: guarded(() => copy(paths.join('\n'))) },
      { kind: 'separator' },
      { id: 'reveal', label: /Mac/i.test(navigator.platform) ? 'Reveal in Finder' : 'Reveal in system explorer', onSelect: guarded(async () => {
        for (const path of paths) {
          if (!current() || capturedCwd !== cwd) break;
          const result = await revealPathInSystemExplorer(path, capturedCwd);
          if (!result.ok) { showToast(result.message, 'error'); break; }
        }
      }) },
      { id: 'open', label: 'Open diff', disabled: count !== 1, onSelect: guarded(() => options.onOpen(entry)) },
    ];
    menu = openContextMenu({ items, label: `${count} selected changes`, restoreFocus: anchor,
      ...(event ? { clientX: event.clientX, clientY: event.clientY } : { anchor }) });
  }

  async function copy(text: string): Promise<void> {
    try { await navigator.clipboard.writeText(text); }
    catch { showToast('Could not copy paths to the clipboard', 'error'); }
  }

  function onKey(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select') || target.isContentEditable) return;
    const row = target.closest<HTMLElement>('[data-change-key]');
    if (!row) return;
    const entry = entries.find((item) => key(item) === row.dataset.changeKey);
    if (!entry) return;
    const handle = () => { event.preventDefault(); event.stopPropagation(); };
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      handle(); selected = new Set(entries.map(key)); paint();
    } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      handle(); showMenu(entry, row);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      handle();
      const index = entries.findIndex((item) => key(item) === key(entry));
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : Math.max(0, Math.min(entries.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
      const nextEntry = entries[next];
      if (nextEntry) {
        if (event.shiftKey && !anchor) anchor = key(entry);
        choose(nextEntry, event);
        rows.get(key(nextEntry))?.focus();
        rows.get(key(nextEntry))?.scrollIntoView({ block: 'nearest' });
      }
    } else if (event.key === 'Escape') {
      handle(); selected.clear(); paint();
    } else if (event.key === 'Enter' && target === row) {
      handle(); choose(entry);
    } else if (event.key === ' ' && target === row) {
      handle();
      if (!selected.has(key(entry))) choose(entry);
      const changes = selectedEntries();
      const unstage = entry.bucket === 'staged';
      const paths = [...new Set(changes.filter((item) => (item.bucket === 'staged') === unstage).map((item) => item.path))];
      const capturedCwd = cwd;
      void mutate(() => unstage ? gitUnstage({ paths, cwd: capturedCwd }) : gitStage({ paths, cwd: capturedCwd }), unstage ? 'Unstaged selected changes' : 'Staged selected changes', capturedCwd);
    }
  }

  options.root.setAttribute('role', 'listbox');
  options.root.setAttribute('aria-multiselectable', 'true');
  options.root.addEventListener('keydown', onKey);

  return {
    setEntries(next: GitChangeSelectionEntry[]): void {
      if (cwd !== options.getCwd()) { revision++; selected.clear(); anchor = null; menu?.close(); }
      cwd = options.getCwd();
      entries = next;
      const valid = new Set(entries.map(key));
      selected = new Set([...selected].filter((id) => valid.has(id)));
      if (anchor && !valid.has(anchor)) anchor = null;
      rows = new Map();
      paint();
    },
    bindRow(row: HTMLElement, entry: GitChangeSelectionEntry, actions?: HTMLElement): void {
      row.dataset.changeKey = key(entry);
      row.dataset.path = entry.path;
      row.dataset.bucket = entry.bucket;
      row.tabIndex = 0;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-label', `${entry.path}, ${entry.bucket}`);
      rows.set(key(entry), row);
      row.addEventListener('click', (event) => {
        if (actions?.contains(event.target as Node)) return;
        choose(entry, event);
        row.focus();
      });
      row.addEventListener('contextmenu', (event) => showMenu(entry, row, event));
      row.classList.toggle('is-selected', selected.has(key(entry)));
      row.setAttribute('aria-selected', String(selected.has(key(entry))));
    },
    discard,
    openMenu(entry: GitChangeSelectionEntry, row: HTMLElement, anchor: HTMLElement): void {
      showMenu(entry, row, undefined, anchor);
    },
    onKey(event: KeyboardEvent): boolean {
      onKey(event);
      return event.defaultPrevented;
    },
    close(): void { menu?.close(); menu = null; },
    clear(): void { revision++; selected.clear(); anchor = null; menu?.close(); paint(); },
    destroy(): void { alive = false; menu?.close(); options.root.removeEventListener('keydown', onKey); },
  };
}
