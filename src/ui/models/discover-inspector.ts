import { fetchHubFiles, type HubFile, type ModelDownloadFormat } from '../../models/api-client';
import { discoverFit, recommendDiscoverVariant } from '../../models/discover-fit';
import type { HardwareSnapshot } from '../../models/types';
import { el, formatBytes, icon, textButton } from './dom';
import { downloadModel, getModelsState } from './store';
import { openDownloadedModels } from './discover-downloads';

export interface DiscoverSelection {
  repoId: string;
  name: string;
  reason?: string;
  params: number | null;
  arch?: string;
  maxContext?: number;
  format: ModelDownloadFormat;
  sizeBytes?: number | null;
  preferredFilename?: string;
}

function quantName(file: HubFile): string {
  return file.quant || file.filename.split('/').pop()!;
}

const compactFitLabels: Record<string, string> = {
  'Fits GPU memory': 'Fits GPU',
  'Fits unified memory': 'Fits unified',
  'Fits in RAM': 'Fits RAM',
  'Exceeds memory budget': 'Over budget',
};

export function createDiscoverInspector(
  host: HTMLElement,
  environment: () => { hardware: HardwareSnapshot | null; context: number },
  backToResults: () => void,
) {
  let selection: DiscoverSelection | null = null;
  let files: HubFile[] = [];
  let chosenFilename = '';
  let showQuants = false;
  let targetEngine: 'mtplx' | undefined;
  let loading = false;
  let error = '';
  let downloadError = '';
  const pendingRepos = new Set<string>();
  let controller: AbortController | null = null;
  let disposed = false;
  host.setAttribute('aria-label', 'Model details');

  const render = () => {
    const focused = document.activeElement;
    const focusKey = host.contains(focused) ? (focused as HTMLElement).dataset.discoverFocus : undefined;
    const scrollTop = host.scrollTop;
    const quantScroll = host.querySelector('.discover-quant-options')?.scrollTop ?? 0;
    host.replaceChildren();
    paint();
    host.scrollTop = scrollTop;
    const options = host.querySelector('.discover-quant-options');
    if (options) options.scrollTop = quantScroll;
    if (focusKey) {
      const replacement = [...host.querySelectorAll<HTMLElement>('[data-discover-focus]')]
        .find((node) => node.dataset.discoverFocus === focusKey && !node.matches(':disabled'));
      (replacement ?? host.querySelector<HTMLElement>('h3'))?.focus({ preventScroll: true });
    }
  };

  function paint(): void {
    if (!selection) {
      host.append(
        el('h3', undefined, 'Choose a model'),
        el('p', 'models-muted', 'Select a model to see its download and estimated memory fit.'),
      );
      return;
    }
    const model = selection;
    const back = textButton('Back to models', backToResults);
    back.classList.add('discover-inspector__back');
    back.dataset.discoverFocus = 'back';
    const heading = el('h3', undefined, model.name);
    heading.tabIndex = -1;
    heading.dataset.discoverFocus = 'heading';
    host.append(back, heading);
    if (model.reason) host.append(el('p', 'models-muted', model.reason));
    const link = el('a', 'discover-source', 'Model card on Hugging Face');
    link.href = `https://huggingface.co/${model.repoId}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.dataset.discoverFocus = 'source';
    host.append(link);
    if (loading) {
      const message = el('p', 'models-muted discover-file-status', 'Finding a download…');
      message.setAttribute('role', 'status');
      host.append(message);
      return;
    }
    if (error) {
      const message = el('p', 'discover-error discover-file-status', error);
      message.setAttribute('role', 'alert');
      host.append(
        message,
        textButton('Try again', () => void select(model, true)),
        textButton(
          'Hugging Face settings',
          () => void import('../models-page').then((m) => m.openModels('settings')),
        ),
      );
      return;
    }
    if (model.format === 'gguf' && !files.length) {
      host.append(el('p', 'models-muted discover-file-status', 'No GGUF model weights found in this repository.'));
      return;
    }

    const env = environment();
    const variants = files.map((file) => ({
      file,
      fit: discoverFit({ ...env, ...model, sizeBytes: file.sizeBytes }),
    }));
    const suggested = recommendDiscoverVariant(variants, model.preferredFilename);
    let variant = variants.find(({ file }) => file.filename === chosenFilename) ?? suggested;
    const summary = el('section', 'discover-variant-summary');
    summary.setAttribute('aria-label', 'Download options');
    host.append(summary);
    const paintDownload = () => {
      summary.replaceChildren();
      if (model.format === 'mlx') {
        summary.append(el('h4', undefined, 'MLX snapshot'));
        const label = el('label', 'models-field');
        label.append(el('span', 'models-field__label', 'Download destination'));
        const target = el('select', 'models-select');
        for (const [value, name] of [['', 'Minnow MLX cache'], ['mtplx', 'MTPLX cache (runtime contract required)']]) {
          const option = el('option', undefined, name);
          option.value = value;
          target.append(option);
        }
        target.value = targetEngine ?? '';
        target.dataset.discoverFocus = 'destination';
        target.addEventListener('change', () => { targetEngine = target.value === 'mtplx' ? 'mtplx' : undefined; });
        label.append(target);
        summary.append(label);
      } else if (variant) {
        const { file, fit } = variant;
        const heading = el('h4', undefined, variant === suggested && fit.fits ? 'Recommended download' : 'Selected download');
        const identity = el('div', 'discover-variant-summary__file');
        const quant = el('strong', undefined, quantName(file));
        quant.title = file.filename;
        identity.append(quant, el('span', 'models-muted', file.sizeBytes ? `${formatBytes(file.sizeBytes)} download` : 'Download size unknown'));
        const status = el('div', 'discover-variant-summary__fit');
        const badge = el('span', `discover-fit discover-fit--${fit.tone}`);
        if (fit.fits) badge.append(icon('check'));
        badge.append(fit.label);
        status.append(badge);
        if (fit.memoryGb !== null) status.append(el('span', 'models-muted', `~${fit.memoryGb.toFixed(1)} GiB at ${env.context.toLocaleString()} tokens`));
        status.title = fit.detail;
        summary.append(heading, identity, status);
        if (fit.label === 'Context too long') summary.append(el('p', 'models-muted', fit.detail));
        if (fit.label === 'Fits in RAM' && env.hardware?.hasGpu) {
          summary.append(el('p', 'models-muted', 'Running from RAM can be slower.'));
        }
      } else {
        summary.append(el('p', 'models-muted', 'No complete download is available.'));
        return;
      }
      appendDownload(summary, model, variant?.file);
    };
    paintDownload();

    if (variants.length > 1 || variants.some(({ file }) => file.error)) {
      const options = el('div', 'discover-quant-options');
      options.id = 'discover-quant-options';
      const toggle = textButton('', () => {
        showQuants = !showQuants;
        paintOptions();
      });
      toggle.classList.add('discover-quant-toggle');
      toggle.dataset.discoverFocus = 'quants';
      toggle.setAttribute('aria-controls', options.id);
      const paintOptions = () => {
        toggle.setAttribute('aria-expanded', String(showQuants));
        toggle.replaceChildren(icon(showQuants ? 'angle-small-up' : 'angle-small-down'), showQuants ? 'Hide quants' : 'Show all quants');
        options.hidden = !showQuants;
        options.replaceChildren();
        if (!showQuants) return;
        const fieldset = el('fieldset', 'discover-files');
        fieldset.setAttribute('aria-label', 'Quantizations');
        const quantCounts = new Map<string, number>();
        for (const { file } of variants) quantCounts.set(file.quant, (quantCounts.get(file.quant) ?? 0) + 1);
        for (const row of variants) {
          const { file, fit } = row;
          const label = el('label', 'discover-file');
          label.title = file.error ?? `${file.filename}\n${fit.detail}`;
          const radio = el('input');
          radio.type = 'radio';
          radio.name = 'discover-gguf-file';
          radio.value = file.filename;
          radio.dataset.discoverFocus = `file:${file.filename}`;
          radio.checked = variant === row;
          radio.disabled = Boolean(file.error) || pendingRepos.has(model.repoId);
          radio.addEventListener('change', () => {
            chosenFilename = file.filename;
            variant = row;
            downloadError = '';
            paintDownload();
          });
          const copy = el('span', 'discover-file__copy');
          copy.append(el('strong', undefined, quantName(file)));
          if (file.quant && (quantCounts.get(file.quant) ?? 0) > 1) {
            copy.append(el('span', 'discover-file__name', file.filename));
          }
          const size = el('span', 'discover-file__size', file.sizeBytes ? formatBytes(file.sizeBytes) : 'Unknown size');
          const status = el('span', `discover-fit discover-fit--${file.error ? 'unknown' : fit.tone}`);
          if (!file.error && fit.fits) status.append(icon('check'));
          status.append(file.error ? 'Unavailable' : (compactFitLabels[fit.label] ?? fit.label));
          label.append(radio, copy, size, status);
          fieldset.append(label);
        }
        options.append(fieldset);
      };
      paintOptions();
      host.append(toggle, options);
    }
  }

  function appendDownload(summary: HTMLElement, model: DiscoverSelection, file?: HubFile): void {
    const exactInstalled = file && getModelsState().library.some(
      (row) => row.repoId === model.repoId && row.path?.replace(/\\/g, '/').endsWith(`/${file.filename}`),
    );
    if (exactInstalled) {
      const open = textButton('Open in My Models', openDownloadedModels, 'primary');
      open.dataset.discoverFocus = 'download';
      summary.append(open);
      return;
    }
    const active = getModelsState().downloads.find(
      (job) => job.repoId === model.repoId &&
        (model.format === 'mlx' || (job.repoFilePath ?? job.filename) === file?.filename) &&
        ['queued', 'running', 'paused', 'interrupted'].includes(job.status),
    );
    const pending = pendingRepos.has(model.repoId);
    const button = textButton(
      active ? (active.status === 'paused' ? 'Paused in downloads' : 'In download queue')
        : pending ? 'Adding to downloads…' : 'Download',
      () => {
        pendingRepos.add(model.repoId);
        downloadError = '';
        render();
        void downloadModel(model.repoId, file?.quant, {
          format: model.format,
          engine: targetEngine,
          filename: file?.filename,
          sizeBytes: file?.sizeBytes ?? model.sizeBytes ?? undefined,
        }).catch((err: unknown) => {
          if (selection === model) {
            downloadError = err instanceof Error ? err.message : 'Could not queue download. Try again.';
          }
        }).finally(() => {
          pendingRepos.delete(model.repoId);
          if (!disposed && selection?.repoId === model.repoId) render();
        });
      },
      'primary',
    );
    button.disabled = pending || Boolean(active);
    if (file && !button.disabled) button.setAttribute('aria-label', `Download ${quantName(file)}`);
    button.dataset.discoverFocus = 'download';
    summary.append(button);
    if (downloadError) {
      const feedback = el('p', 'discover-error', downloadError);
      feedback.setAttribute('role', 'alert');
      summary.append(feedback);
    }
    if (file && file.files.length > 1) {
      summary.append(el('p', 'models-muted', `Includes all ${file.files.length} parts of this model.`));
    }
  }

  async function select(model: DiscoverSelection, focus = false): Promise<void> {
    controller?.abort();
    const request = new AbortController();
    controller = request;
    selection = model;
    files = [];
    chosenFilename = '';
    showQuants = false;
    targetEngine = undefined;
    error = '';
    downloadError = '';
    loading = model.format === 'gguf';
    host.scrollTop = 0;
    render();
    if (focus) host.querySelector('h3')?.focus({ preventScroll: true });
    if (!loading) return;
    try {
      const result = await fetchHubFiles(model.repoId, request.signal);
      if (!request.signal.aborted) files = result;
    } catch (err) {
      if (!request.signal.aborted) error = err instanceof Error ? err.message : 'Could not find repository downloads.';
    } finally {
      if (!request.signal.aborted) {
        loading = false;
        render();
      }
    }
  }

  render();
  return { select, refresh: render, dispose: () => { disposed = true; controller?.abort(); } };
}
