import { createOsIcon } from '../os/icons';
import { formatRelativeTime } from '../notifications/preview';
import {
  clearRecentViewerFiles,
  listRecentViewerFiles,
  removeRecentViewerFile,
} from '../state/recent-viewer-files';
import { getFileTreeListingWorkspaceRoot } from './file-tree-listing-root';
import { basename, dirname } from './file-tree-path';
import { createCodeReadinessActions } from './code-readiness-actions';

/** Active workspace key for recent-files persistence (listing root preferred). */
function activeWorkspaceRoot(): string | undefined {
  return getFileTreeListingWorkspaceRoot();
}

/** Parent folder label for a workspace-relative path (empty for root files). */
function parentLabel(path: string): string {
  const parent = dirname(path);
  if (!parent || parent === '.') return '';
  return parent;
}

/** Mount the recent-files empty state into the viewer host. */
export function renderViewerRecentFilesEmptyState(host: HTMLElement): void {
  const workspaceRoot = activeWorkspaceRoot();
  const recent = listRecentViewerFiles(workspaceRoot);

  host.replaceChildren();

  const root = document.createElement('div');
  root.className = 'file-viewer-recent';
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'Recent files');

  const head = document.createElement('div');
  head.className = 'file-viewer-recent__head';

  const iconWrap = document.createElement('div');
  iconWrap.className = 'file-viewer-recent__icon';
  iconWrap.appendChild(createOsIcon('fileText', { size: 28 }));

  const title = document.createElement('h2');
  title.className = 'file-viewer-recent__title';
  title.textContent = recent.length ? 'Recent files' : 'No file open';

  const subtitle = document.createElement('p');
  subtitle.className = 'file-viewer-recent__subtitle';
  subtitle.textContent = recent.length
    ? 'Pick up where you left off, or open a file from the tree.'
    : 'Open a file from the Files tab to start editing.';

  head.append(iconWrap, title, subtitle);
  root.appendChild(head);

  root.appendChild(createCodeReadinessActions());

  if (recent.length === 0) {
    host.appendChild(root);
    return;
  }

  const list = document.createElement('ul');
  list.className = 'file-viewer-recent__list';
  list.setAttribute('role', 'list');

  recent.forEach((entry, index) => {
    const item = document.createElement('li');
    item.className = 'file-viewer-recent__item';
    item.style.setProperty('--fv-recent-i', String(index));

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'file-viewer-recent__open';
    const name = basename(entry.path);
    const parent = parentLabel(entry.path);
    const when = formatRelativeTime(entry.openedAt);
    openBtn.setAttribute(
      'aria-label',
      parent ? `Open ${name} in ${parent}, ${when}` : `Open ${name}, ${when}`,
    );

    const glyph = document.createElement('span');
    glyph.className = 'file-viewer-recent__glyph';
    glyph.appendChild(createOsIcon('fileText', { size: 16 }));

    const text = document.createElement('span');
    text.className = 'file-viewer-recent__text';

    const nameEl = document.createElement('span');
    nameEl.className = 'file-viewer-recent__name';
    nameEl.textContent = name;

    const meta = document.createElement('span');
    meta.className = 'file-viewer-recent__meta';
    meta.textContent = parent ? `${parent} · ${when}` : when;

    text.append(nameEl, meta);
    openBtn.append(glyph, text);
    openBtn.addEventListener('click', () => {
      void import('./file-viewer').then((m) => m.openFileInViewer(entry.path));
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'file-viewer-recent__remove';
    removeBtn.setAttribute('aria-label', `Remove ${name} from recent files`);
    removeBtn.title = 'Remove from recent';
    removeBtn.appendChild(createOsIcon('close', { size: 14 }));
    removeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      removeRecentViewerFile(entry.path, workspaceRoot);
      renderViewerRecentFilesEmptyState(host);
    });

    item.append(openBtn, removeBtn);
    list.appendChild(item);
  });

  root.appendChild(list);

  const foot = document.createElement('div');
  foot.className = 'file-viewer-recent__foot';
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'file-viewer-recent__clear';
  clearBtn.textContent = 'Clear recent';
  clearBtn.addEventListener('click', () => {
    clearRecentViewerFiles(workspaceRoot);
    renderViewerRecentFilesEmptyState(host);
  });
  foot.appendChild(clearBtn);
  root.appendChild(foot);

  host.appendChild(root);
}
