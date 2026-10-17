import type { PresentedFile } from '../chat/presented-files';
import { getSessionToken } from '../api/session-token';
import { workspacePreviewUrl } from './preview-load-url';
import { createIcon } from './icon';
import '../styles/presented-file-cards.css';

/** True for files Open should render in preview rather than as source. */
export function isPresentedHtmlFile(file: PresentedFile): boolean {
  return /\.html?$/i.test(file.name || file.path);
}

/**
 * Open in this window, scoped to the originating workspace (including worktrees and
 * the chat sandbox) without switching the window's workspace. HTML opens in preview.
 */
export async function openPresentedFile(file: PresentedFile): Promise<void> {
  if (isPresentedHtmlFile(file)) {
    const { openScopedWorkspaceFileInPreview } = await import('./preview-panel');
    await openScopedWorkspaceFileInPreview(file.path, file.workspaceRoot);
    return;
  }
  await openPresentedFileSource(file);
}

/** Open the file's contents in Code's viewer, read from its originating workspace. */
export async function openPresentedFileSource(file: PresentedFile): Promise<void> {
  const absolute = /^(?:[A-Za-z]:[\\/]|\/)/.test(file.path)
    ? file.path : `${file.workspaceRoot.replace(/[\\/]$/, '')}/${file.path}`;
  const { getFileTreeListingWorkspaceRoot } = await import('./file-tree-listing-root');
  const { getWorkspacePath } = await import('../state/workspace');
  const { panelPathsEqual } = await import('./panel-worktree-cwd');
  const sameRoot = panelPathsEqual(getFileTreeListingWorkspaceRoot() ?? getWorkspacePath(), file.workspaceRoot);
  const { openFileInViewer } = await import('./file-viewer');
  await openFileInViewer(sameRoot ? file.path : absolute, { workspaceRoot: file.workspaceRoot });
}

export async function downloadPresentedFile(file: PresentedFile): Promise<void> {
  const url = new URL(workspacePreviewUrl(file.path, { workspaceRoot: file.workspaceRoot, raw: true }), window.location.origin);
  url.searchParams.set('download', '1');
  const response = await fetch(url, { cache: 'no-store', headers: { 'X-Minnow-Token': getSessionToken() } });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.error || `Could not download file (HTTP ${response.status})`);
  }
  const blobUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = blobUrl;
  anchor.download = file.name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function createPresentedFileCards(files: PresentedFile[]): HTMLElement | null {
  if (!files.length) return null;
  const section = document.createElement('section');
  section.className = 'chat-presented-files';
  section.setAttribute('aria-label', 'Files from the assistant');
  for (const file of files) {
    const card = document.createElement('article');
    card.className = 'presented-file';
    card.appendChild(createIcon('fileText', { className: 'presented-file__icon', size: 20 }));
    const info = document.createElement('div');
    info.className = 'presented-file__info';
    const title = document.createElement('strong');
    title.className = 'presented-file__title';
    title.textContent = file.title;
    const path = document.createElement('div');
    path.className = 'presented-file__path';
    path.textContent = file.path;
    path.title = file.workspaceRoot;
    const meta = document.createElement('div');
    meta.className = 'presented-file__meta';
    const extension = file.name.includes('.') ? file.name.split('.').pop()!.toUpperCase() : 'File';
    meta.textContent = `${extension === 'MD' ? 'Markdown' : extension} · ${fileSize(file.bytes)}`;
    info.append(title, path, meta);
    const actions = document.createElement('div');
    actions.className = 'presented-file__actions';
    const status = document.createElement('p');
    status.className = 'presented-file__status';
    status.setAttribute('role', 'status');
    status.hidden = true;
    const buttons: Array<readonly [string, (file: PresentedFile) => Promise<void>, string?]> = [['Open', openPresentedFile]];
    if (isPresentedHtmlFile(file)) buttons.push(['Source', openPresentedFileSource, 'View source of']);
    buttons.push(['Download', downloadPresentedFile]);
    for (const [label, action, ariaVerb] of buttons) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'presented-file__action';
      button.textContent = label;
      button.setAttribute('aria-label', `${ariaVerb ?? label} ${file.title}`);
      button.addEventListener('click', async () => {
        button.disabled = true;
        status.hidden = true;
        try { await action(file); }
        catch (error) {
          status.textContent = error instanceof Error ? error.message : `Could not ${(ariaVerb ?? label).toLowerCase()} file`;
          status.hidden = false;
        } finally { button.disabled = false; }
      });
      actions.appendChild(button);
    }
    card.append(info, actions, status);
    section.appendChild(card);
  }
  return section;
}
