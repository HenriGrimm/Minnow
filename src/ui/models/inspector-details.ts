import type { ServeRecord } from '../../models/api-client';
import { getLibraryLaunchSettingsForId } from '../../config/library-launch-meta';
import { defaultEngineFor, enginesForModel } from '../../models/engine-support';
import { capabilityLabel, type LibraryModel } from '../../models/library';
import { serveStatusLabel } from '../../models/serve-status';
import { modelProducerLogoSvg } from '../../providers/model-producer';
import { copyField, el, formatBytes, formatContext, formatParams, icon, iconButton } from './dom';
import { setModelsInspectorOpen } from './inspector-visibility';
import { serveFailureBlock } from './serve-failure-view';

const openDisclosures = new Set<string>();

export function inspectorEngineLabel(runtime: string | null | undefined): string {
  return runtime === 'llama-cpp' ? 'llama.cpp' : runtime === 'mtplx' ? 'MTPLX'
    : runtime === 'mlx-lm' ? 'mlx-lm' : runtime === 'ollama' ? 'Ollama' : runtime || 'Local runtime';
}

export function inspectorDisclosure(key: string, label: string): HTMLDetailsElement {
  const details = el('details', 'models-details__disclosure');
  details.open = openDisclosures.has(key);
  details.appendChild(el('summary', '', label));
  details.addEventListener('toggle', () => {
    if (details.open) openDisclosures.add(key);
    else openDisclosures.delete(key);
  });
  return details;
}

function closeInspector(): void {
  setModelsInspectorOpen(false);
  document.getElementById('btnModelsInspector')?.focus();
}

export function inspectorHead(model: LibraryModel | null, serve?: ServeRecord, loading = false): HTMLElement {
  const head = el('header', 'models-inspector__head models-details__head');
  const top = el('div', 'models-details__heading-row');
  top.append(el('span', 'models-details__caption', 'Model details'),
    iconButton('cross-small', 'Close model details', closeInspector));
  head.appendChild(top);
  if (!model && !serve) return head;

  const identity = el('div', 'models-details__identity');
  const mark = el('span', 'models-details__mark');
  mark.setAttribute('aria-hidden', 'true');
  const logo = model && modelProducerLogoSvg(model.producerLogoId);
  if (logo) mark.innerHTML = logo;
  else mark.appendChild(icon('chip'));
  const names = el('div', 'models-details__names');
  const title = el('h2', 'models-inspector__title', model?.name ?? serve!.modelLabel);
  title.title = title.textContent ?? '';
  const repo = el('p', 'models-details__repo', model?.repoId ?? 'Local session');
  repo.title = repo.textContent ?? '';
  names.append(title, repo);
  identity.append(mark, names);
  head.appendChild(identity);

  const status = loading ? 'starting' : serve?.status;
  const state = el('div', 'models-details__state');
  const badge = el('span', 'models-details__status');
  badge.append(el('span', `models-dot models-dot--${status ?? 'stopped'}`),
    el('span', '', loading ? 'Loading' : status ? serveStatusLabel(status) : 'Not loaded'));
  state.appendChild(badge);
  const savedEngine = model ? getLibraryLaunchSettingsForId(model.id)?.engine : null;
  const engine = serve?.runtime ?? (model ? savedEngine && enginesForModel(model).includes(savedEngine)
    ? savedEngine : defaultEngineFor(model) : null);
  if (engine) state.appendChild(el('span', 'models-details__engine', inspectorEngineLabel(engine)));
  head.appendChild(state);
  return head;
}

function fact(label: string, value: string): HTMLElement {
  const row = el('div', 'models-details__fact');
  row.append(el('dt', '', label), el('dd', '', value));
  return row;
}

export function appendInspectorConnection(body: HTMLElement, serve: ServeRecord): void {
  const failure = serveFailureBlock(serve);
  if (failure) body.appendChild(failure);
  if (serve.status !== 'running') return;
  const section = el('section', 'models-details__section models-details__connection');
  section.append(el('h3', 'models-details__section-title', 'Connection'),
    el('p', 'models-details__help', 'Use this model in any OpenAI-compatible client.'));
  const urlLabel = el('p', 'models-details__field-label', 'Base URL');
  const modelLabel = el('p', 'models-details__field-label', 'Model identifier');
  section.append(urlLabel, copyField(serve.baseUrl, 'Copy base URL'),
    modelLabel, copyField(serve.modelLabel, 'Copy model identifier'));
  body.appendChild(section);
}

export function appendInspectorOverview(body: HTMLElement, model: LibraryModel, serve?: ServeRecord): void {
  const facts = el('dl', 'models-details__facts');
  facts.append(fact('Parameters', formatParams(model.paramsB)),
    fact('Trained context', `${formatContext(model.contextLength)}${model.contextLength ? ' tokens' : ''}`),
    fact('Weights', [model.format, model.quant].filter(Boolean).join(' · ')),
    fact('Size on disk', formatBytes(model.sizeBytes)));
  body.appendChild(facts);

  if (model.capabilities.length) {
    const capabilities = el('section', 'models-details__section models-details__capabilities');
    capabilities.appendChild(el('h3', 'models-details__section-title', 'Capabilities'));
    const list = el('ul', 'models-details__capability-list');
    for (const label of new Set(model.capabilities.map(capabilityLabel))) {
      list.appendChild(el('li', '', label));
    }
    capabilities.appendChild(list);
    body.appendChild(capabilities);
  }

  if (serve) appendInspectorConnection(body, serve);
  if (!model.servable) {
    body.appendChild(el('p', 'models-details__notice', model.unavailableReason ??
      (model.incomplete ? 'This download is incomplete. Finish downloading before loading the model.'
        : 'These weights cannot be loaded with an available local runtime.')));
  } else if (!serve || serve.status === 'stopped') {
    body.appendChild(el('p', 'models-details__notice', 'Load this model to start a local API endpoint.'));
  }

  const files = inspectorDisclosure(`${model.id}:files`, 'Model & files');
  const metadata = el('dl', 'models-details__metadata');
  metadata.append(fact('Architecture', model.arch || 'Unknown'), fact('Model maker', model.producerName),
    fact('Publisher', model.publisher), fact('Domain', model.domain));
  files.appendChild(metadata);
  if (model.repoId.includes('/') && model.source !== 'ollama' && model.source !== 'local-dir') {
    const source = el('a', 'models-details__source', 'Model repository');
    source.href = `https://huggingface.co/${model.repoId.split('/').map(encodeURIComponent).join('/')}`;
    source.target = '_blank';
    source.rel = 'noopener noreferrer';
    source.appendChild(icon('arrow-up-right'));
    files.appendChild(source);
  }
  if (model.fileName) files.append(el('p', 'models-details__field-label', 'Weight file'),
    el('p', 'models-details__filename', model.fileName));
  if (model.path) files.append(el('p', 'models-details__field-label', 'Local path'),
    copyField(model.path, 'Copy file path'));
  body.appendChild(files);
}

export function inspectorEmpty(): HTMLElement {
  const body = el('div', 'models-inspector__body models-details__empty');
  body.append(icon('chip'), el('h2', '', 'A closer look'),
    el('p', '', 'Select a model or local session to see its capabilities, files, and connection details.'));
  return body;
}
