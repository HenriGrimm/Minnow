import type { DownloadJob } from '../../models/api-client';
import { el, formatBytes, textButton } from './dom';
import { cancelDownload, controlDownload, getModelsState } from './store';

export function openDownloadedModels(): void {
  void import('../models-page').then((m) => m.openModels('installed'));
}

function jobRow(job: DownloadJob): HTMLElement {
  const row = el('article', 'discover-transfer');
  row.dataset.job = job.id;
  row.dataset.status = job.status;
  const identity = el('div', 'discover-transfer__identity');
  identity.append(
    el('strong', undefined, job.repoId.split('/').pop() ?? job.repoId),
    el('span', 'models-muted', job.filename || 'MLX snapshot'),
  );
  const status = el('div', 'discover-transfer__status');
  status.append(el('span', 'discover-transfer__label'), el('span', 'discover-transfer__bytes'));
  const progress = el('progress', 'discover-transfer__progress') as HTMLProgressElement;
  progress.max = 100;
  progress.setAttribute('aria-label', `Download progress for ${job.repoId}`);
  const actions = el('div', 'discover-transfer__actions');
  const error = el('p', 'discover-transfer__error', job.error ?? '');
  error.setAttribute('role', 'status');
  const action = (label: string, run: () => Promise<void>) => {
    const btn = textButton(label, () => {
      btn.disabled = true;
      void run().catch((err: unknown) => {
        error.textContent =
          err instanceof Error ? err.message : 'Could not update this download. Try again.';
        btn.disabled = false;
      });
    });
    actions.append(btn);
  };
  if (['running', 'queued', 'interrupted'].includes(job.status))
    action('Pause', () => controlDownload(job.id, 'pause'));
  if (['paused', 'failed', 'interrupted'].includes(job.status))
    action(job.status === 'failed' ? 'Retry download' : 'Resume', () =>
      controlDownload(job.id, 'resume'),
    );
  if (['running', 'queued', 'paused', 'interrupted'].includes(job.status))
    action('Cancel & discard', () => cancelDownload(job.id));
  if (job.status === 'completed')
    actions.append(textButton('Open in My Models', openDownloadedModels));
  row.append(identity, status, actions, progress, error);
  return row;
}

/** Preserve controls and focus while bytes update; replace a row only when its state changes. */
export function syncDownloadShelf(host: HTMLElement): void {
  const jobs = getModelsState().downloads.filter((job) => job.status !== 'cancelled');
  const visible = [
    ...jobs.filter((job) => job.status !== 'completed'),
    ...jobs.filter((job) => job.status === 'completed').slice(0, 3),
  ];
  let shelf = host.querySelector<HTMLDetailsElement>('.discover-downloads');
  if (!visible.length) {
    shelf?.remove();
    return;
  }
  if (!shelf) {
    shelf = el('details', 'discover-downloads') as HTMLDetailsElement;
    shelf.open = true;
    shelf.append(el('summary'), el('div', 'discover-downloads__list'));
    host.append(shelf);
  }
  const active = jobs.filter((job) =>
    ['queued', 'running', 'interrupted'].includes(job.status),
  ).length;
  const attention = jobs.filter((job) => job.status === 'failed').length;
  shelf.querySelector('summary')!.textContent =
    `Downloads · ${active} active${attention ? ` · ${attention} need attention` : ''}`;
  const list = shelf.querySelector<HTMLElement>('.discover-downloads__list')!;
  for (const row of Array.from(list.children))
    if (!visible.some((job) => job.id === (row as HTMLElement).dataset.job)) row.remove();
  for (const job of visible) {
    let row = Array.from(list.children).find(
      (node) => (node as HTMLElement).dataset.job === job.id,
    ) as HTMLElement | undefined;
    if (!row || row.dataset.status !== job.status) {
      const next = jobRow(job);
      if (row) row.replaceWith(next);
      else list.append(next);
      row = next;
    }
    const pct =
      job.totalBytes && job.totalBytes > 0
        ? Math.min(100, (job.bytesReceived / job.totalBytes) * 100)
        : null;
    const names: Record<DownloadJob['status'], string> = {
      queued: 'Queued',
      running: 'Downloading',
      paused: 'Paused',
      failed: 'Download failed',
      completed: 'Ready on disk',
      cancelled: 'Cancelled',
      interrupted: 'Resuming',
    };
    row.querySelector('.discover-transfer__label')!.textContent =
      `${names[job.status]}${job.status === 'running' && pct != null ? ` · ${pct.toFixed(1)}%` : ''}`;
    const speed =
      job.status === 'running' && job.bytesPerSec ? ` · ${formatBytes(job.bytesPerSec)}/s` : '';
    const eta =
      job.status === 'running' && job.etaMs && job.etaMs > 0
        ? ` · ~${Math.ceil(job.etaMs / 60000)} min left`
        : '';
    row.querySelector('.discover-transfer__bytes')!.textContent =
      `${job.bytesReceived ? formatBytes(job.bytesReceived) : '0 B'}${job.totalBytes ? ` / ${formatBytes(job.totalBytes)}` : ' · total size unknown'}${speed}${eta}`;
    const progress = row.querySelector('progress')!;
    if (pct == null) progress.removeAttribute('value');
    else progress.value = pct;
    progress.hidden = job.status === 'completed' || job.status === 'failed';
  }
}
