import { fetchHubFiles, type HubFile, type ModelDownloadFormat } from '../../models/api-client';
import { discoverFit } from '../../models/discover-fit';
import type { HardwareSnapshot } from '../../models/types';
import { el, formatBytes, textButton } from './dom';
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
}

export function createDiscoverInspector(
  host: HTMLElement,
  environment: () => { hardware: HardwareSnapshot | null; context: number },
  backToResults: () => void,
) {
  let selection: DiscoverSelection | null = null;
  let files: HubFile[] = [];
  let selected = '';
  let loading = false;
  let error = '';
  let pending = false;
  let controller: AbortController | null = null;

  const render = () => {
    host.replaceChildren();
    host.setAttribute('aria-label', 'Model file inspector');
    if (!selection) {
      host.append(
        el('h3', undefined, 'Find your next model'),
        el(
          'p',
          'models-muted',
          'Choose a recommendation or a Hugging Face result to compare files and check memory before downloading.',
        ),
        el(
          'div',
          'discover-inspector__steps',
          '1  Choose a model\n2  Check its files and fit\n3  Download, then open My Models',
        ),
      );
      return;
    }
    const model = selection;
    const back = textButton('Back to models', backToResults);
    back.classList.add('discover-inspector__back');
    host.append(back);
    const heading = el('h3', undefined, model.name);
    heading.tabIndex = -1;
    host.append(
      el('span', 'discover-eyebrow', 'Your selection'),
      heading,
      el('p', 'discover-repo', model.repoId),
    );
    if (model.reason) host.append(el('p', 'models-muted', model.reason));
    const link = el('a', 'discover-source', 'Model card on Hugging Face') as HTMLAnchorElement;
    link.href = `https://huggingface.co/${model.repoId}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    host.append(link);
    if (loading) {
      const message = el('p', 'models-muted', 'Reading repository files…');
      message.setAttribute('role', 'status');
      host.append(message);
      return;
    }
    if (error) {
      const message = el('p', 'discover-error', error);
      message.setAttribute('role', 'alert');
      host.append(
        message,
        textButton('Try again', () => void select(model)),
        textButton(
          'Hugging Face settings',
          () => void import('../models-page').then((m) => m.openModels('settings')),
        ),
      );
      return;
    }
    const fieldset = el('fieldset', 'discover-files') as HTMLFieldSetElement;
    fieldset.append(
      el('legend', undefined, model.format === 'mlx' ? 'MLX snapshot' : 'Choose a GGUF file'),
    );
    if (model.format === 'gguf' && !files.length) {
      host.append(
        el(
          'p',
          'models-muted',
          'No language-model GGUF files found. This repository may contain only projectors or a different weights format.',
        ),
      );
      return;
    }
    if (model.format === 'mlx')
      fieldset.append(
        el('p', 'models-muted', 'Downloads the repository snapshot for MLX on Apple Silicon.'),
      );
    for (const file of files) {
      const label = el('label', 'discover-file');
      const radio = el('input') as HTMLInputElement;
      radio.type = 'radio';
      radio.name = 'discover-gguf-file';
      radio.value = file.filename;
      radio.checked = selected === file.filename;
      radio.disabled = Boolean(file.error) || pending;
      radio.addEventListener('change', () => {
        selected = file.filename;
        render();
        host.querySelector<HTMLInputElement>('input:checked')?.focus();
      });
      const copy = el('span', 'discover-file__copy');
      copy.append(
        el('strong', undefined, file.quant || 'Unknown quantization'),
        el('span', 'discover-file__name', file.filename),
        el(
          'span',
          'models-muted',
          file.error ??
            `${file.files.length > 1 ? `${file.files.length} shards · ` : ''}${file.sizeBytes ? formatBytes(file.sizeBytes) : 'Size unknown'}`,
        ),
      );
      const env = environment();
      const estimate = discoverFit({
        name: model.name,
        params: model.params,
        sizeBytes: file.sizeBytes,
        arch: model.arch,
        context: env.context,
        maxContext: model.maxContext,
        hardware: env.hardware,
      });
      copy.append(
        el(
          'span',
          `discover-fit discover-fit--${estimate.tone}`,
          estimate.memoryGb
            ? `~${estimate.memoryGb.toFixed(1)} GiB memory · ${estimate.label}`
            : estimate.label,
        ),
      );
      label.append(radio, copy);
      fieldset.append(label);
    }
    host.append(fieldset);
    const file = files.find((row) => row.filename === selected);
    const env = environment();
    const fit =
      model.format === 'gguf'
        ? discoverFit({
            name: model.name,
            sizeBytes: file?.sizeBytes ?? null,
            params: model.params,
            arch: model.arch,
            maxContext: model.maxContext,
            context: env.context,
            hardware: env.hardware,
          })
        : null;
    const fitBox = el('div', 'discover-fit-detail');
    fitBox.append(
      el('strong', undefined, fit?.label ?? 'MLX memory depends on runtime settings'),
      el(
        'p',
        'models-muted',
        fit?.detail ??
          'Snapshot size is not a runtime memory estimate. Check the load settings in My Models after downloading.',
      ),
    );
    if (!model.maxContext && model.format === 'gguf')
      fitBox.append(
        el(
          'p',
          'models-muted',
          'The repository has not supplied a verified context limit. Check the model card before loading.',
        ),
      );
    host.append(fitBox);
    const exactInstalled =
      model.format === 'gguf' &&
      file &&
      getModelsState().library.some(
        (row) =>
          row.repoId === model.repoId &&
          row.path?.replace(/\\/g, '/').endsWith(`/${file.filename}`),
      );
    if (exactInstalled) {
      host.append(textButton('Open in My Models', openDownloadedModels, 'primary'));
      return;
    }
    const active = getModelsState().downloads.find(
      (job) =>
        job.repoId === model.repoId &&
        (model.format === 'mlx' || (job.repoFilePath ?? job.filename) === file?.filename) &&
        ['queued', 'running', 'paused', 'interrupted'].includes(job.status),
    );
    const feedback = el('p', 'discover-inspector__feedback');
    feedback.setAttribute('role', 'status');
    const download = textButton(
      active
        ? active.status === 'paused'
          ? 'Paused in downloads'
          : 'In download queue'
        : pending
          ? 'Adding to downloads…'
          : model.format === 'mlx'
            ? 'Download MLX snapshot'
            : `Download ${file?.quant || 'selected file'}`,
      () => {
        pending = true;
        render();
        void downloadModel(model.repoId, file?.quant, {
          format: model.format,
          filename: file?.filename,
          sizeBytes: file?.sizeBytes ?? model.sizeBytes ?? undefined,
        })
          .then(() => {
            pending = false;
            if (selection === model) render();
          })
          .catch((err: unknown) => {
            pending = false;
            if (selection !== model) return;
            render();
            host.querySelector('.discover-inspector__feedback')!.textContent =
              err instanceof Error ? err.message : 'Could not queue download. Try again.';
          });
      },
      'primary',
    );
    download.disabled =
      pending || Boolean(active) || (model.format === 'gguf' && (!file || Boolean(file.error)));
    host.append(download, feedback);
    if (file?.files.length && file.files.length > 1)
      host.append(
        el('p', 'models-muted', 'All shards download together. Minnow loads the first shard.'),
      );
  };

  const select = async (model: DiscoverSelection) => {
    controller?.abort();
    controller = new AbortController();
    const request = controller;
    selection = model;
    files = [];
    selected = '';
    error = '';
    pending = false;
    loading = model.format === 'gguf';
    render();
    host.querySelector('h3')?.focus();
    if (!loading) return;
    try {
      const result = await fetchHubFiles(model.repoId, request.signal);
      if (request.signal.aborted) return;
      files = result;
      const env = environment();
      const fitting = files.filter(
        (file) =>
          !file.error &&
          discoverFit({
            name: model.name,
            params: model.params,
            sizeBytes: file.sizeBytes,
            arch: model.arch,
            context: env.context,
            maxContext: model.maxContext,
            hardware: env.hardware,
          }).fits,
      );
      const preferred =
        fitting.find((file) => file.quant === 'Q4_K_M') ??
        fitting[0] ??
        files.find((file) => file.quant === 'Q4_K_M' && !file.error) ??
        files.find((file) => !file.error);
      selected = preferred?.filename ?? '';
    } catch (err) {
      if (request.signal.aborted) return;
      error = err instanceof Error ? err.message : 'Could not read repository files.';
    } finally {
      if (!request.signal.aborted) {
        loading = false;
        render();
      }
    }
  };
  render();
  return { select, refresh: render, dispose: () => controller?.abort() };
}
