import { actionApi, type Release } from '../state/actions-api';
import { createIcon } from './icon';
import { confirmAction, field, labeled, operationButton, statusLine } from './scc-action-form';
import { el } from './scc-shared';

interface ReleaseAssetsOptions {
  release: Release;
  repo: string;
  cwd: string | undefined;
  writable: boolean;
  isCurrent: () => boolean;
  onChange: (assets: Release['assets']) => void;
}

function assetSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

export function createReleaseAssets({ release, repo, cwd, writable, isCurrent, onChange }: ReleaseAssetsOptions): HTMLElement {
  const section = el('section', 'scc-release__assets');
  const heading = el('h3', undefined, 'Assets');
  const count = el('span', 'scc-release__asset-count');
  const head = el('div', 'scc-release__assets-head');
  const list = el('ul', 'scc-release__asset-list');
  list.setAttribute('aria-label', 'Release assets');
  const empty = el('p', 'scc-release__muted', 'No assets attached.');
  const directory = field('Download directory', '.');
  const destination = labeled('Download to (relative to worktree)', directory);
  const upload = field('Asset path');
  upload.placeholder = 'dist/app.zip';
  const status = statusLine();
  let assets = release.assets;
  let changing = false;

  function updateCount() {
    count.textContent = String(assets.length);
    destination.hidden = list.hidden = !assets.length;
    empty.hidden = Boolean(assets.length);
  }

  async function mutate(operation: () => ReturnType<typeof actionApi>) {
    if (changing) return { ok: false, error: 'An asset change is already in progress.' };
    changing = true;
    try { return await operation(); }
    finally { changing = false; }
  }

  function assetRow(asset: Release['assets'][number]): HTMLElement {
    const row = el('li', 'scc-release__asset');
    const file = el('div', 'scc-release__file');
    const info = el('div');
    info.append(
      el('p', 'scc-release__file-name', asset.name),
      el('p', 'scc-release__muted', `${assetSize(asset.size)} · ${asset.downloads.toLocaleString()} ${asset.downloads === 1 ? 'download' : 'downloads'}`),
    );
    file.append(createIcon('archive', { size: 17 }), info);
    const assetStatus = statusLine();
    const controls = el('div', 'scc-release__asset-actions');
    const download = operationButton('Download', assetStatus, async () => {
      const response = await actionApi('releaseAssetDownload', { cwd, id: release.id, assetId: asset.id, directory: directory.value });
      return response.ok ? { ...response, note: 'Download complete.' } : response;
    });
    download.setAttribute('aria-label', `Download ${asset.name}`);
    controls.append(download);
    if (writable) {
      const remove = operationButton('Delete asset', assetStatus, () => mutate(async () =>
        await confirmAction({ message: `Delete ${asset.name} from ${repo} · ${release.tag}?`, danger: true })
          ? actionApi('releaseAssetDelete', { cwd, id: release.id, assetId: asset.id }) : { ok: true, note: 'Cancelled' },
      ), response => {
        if (!isCurrent() || response.note === 'Cancelled') return;
        const restoreFocus = row.contains(document.activeElement);
        row.remove();
        assets = assets.filter(item => item.id !== asset.id);
        updateCount();
        onChange(assets);
        status.textContent = `Deleted ${asset.name}.`;
        if (restoreFocus) upload.focus();
      });
      remove.classList.add('scc-btn--ghost');
      remove.setAttribute('aria-label', `Delete asset ${asset.name}`);
      controls.append(remove);
    }
    row.append(file, controls, assetStatus);
    return row;
  }

  head.append(heading, count);
  section.append(head, destination, list, empty);
  list.append(...assets.map(assetRow));
  updateCount();
  if (writable) {
    const transfer = el('div', 'scc-release__asset-upload');
    const send = operationButton('Upload asset', status, () => mutate(async () => {
      const path = upload.value.trim();
      if (!path) return { ok: false, error: 'Enter a file path relative to the worktree.' };
      const name = path.replaceAll('\\', '/').split('/').pop();
      const collision = assets.some(asset => asset.name === name);
      if (collision && !(await confirmAction({ message: `Replace ${name} in ${repo} · ${release.tag}?`, danger: true, confirmLabel: 'Replace' })))
        return { ok: true, note: 'Cancelled' };
      const response = await actionApi('releaseAssetUpload', { cwd, id: release.id, path, replace: collision });
      if (!response.ok || !isCurrent()) return response;
      if (upload.value.trim() === path) upload.value = '';
      const updated = await actionApi('releaseView', { cwd, id: release.id });
      if (isCurrent() && updated.release) {
        assets = updated.release.assets;
        list.replaceChildren(...assets.map(assetRow));
        updateCount();
        onChange(assets);
      }
      return { ok: true, note: updated.release ? `Uploaded ${name}.` : `Uploaded ${name}. Refresh to update the asset list.` };
    }));
    transfer.append(labeled('Upload file (relative to worktree)', upload), send);
    section.append(transfer);
  }
  section.append(status);
  return section;
}
