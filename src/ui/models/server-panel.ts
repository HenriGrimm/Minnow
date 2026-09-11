import { subscribeServeLog, type ServeRecord } from '../../models/api-client';
import { classifyLogLine, foldServeLogEvent, toLogLines } from '../../models/serve-log';
import { isLiveServeStatus, isRetryableServeStatus, retryLabelForServe, serveStatusLabel } from '../../models/serve-status';
import { setStatus } from '../status';
import {
  chip,
  copyField,
  copyText,
  el,
  emptyState,
  formatElapsed,
  icon,
  iconButton,
  textButton,
} from './dom';
import { showServeInInspector } from './inspector';
import { serveFailureBlock } from './serve-failure-view';
import {
  attentionServes,
  getInspectedServe,
  getModelsState,
  refreshModels,
  retryServe,
  runningServes,
  subscribeModelsStore,
  unloadServe,
  type LoadProgress,
} from './store';
import type { ServeActivity } from '../../models/api-client';
import { serveActivityChipLabels } from '../../models/serve-activity-chips';
import { activityForLoadedServe } from '../../models/mlx-serve-activity';
import {
  getInFlightPromptOverlay,
  subscribeInFlightPromptOverlay,
} from '../../models/in-flight-prompt';

/** OpenAI-compatible surface llama-server exposes. */
const ENDPOINTS: Array<{ method: string; path: string; note: string }> = [
  { method: 'GET', path: '/v1/models', note: 'List loaded models' },
  { method: 'POST', path: '/v1/chat/completions', note: 'Chat, streaming or not' },
  { method: 'POST', path: '/v1/completions', note: 'Raw text completion' },
  { method: 'POST', path: '/v1/embeddings', note: 'Embeddings, when the model supports them' },
  { method: 'GET', path: '/health', note: 'Readiness probe' },
];

let bound = false;
let overlayUnsub: (() => void) | null = null;
let logSource: string | null = null;
/** Last `runId` we opened EventSource for — null until spawn assigns the log file. */
let logRunId: string | null = null;
let logUnsub: (() => void) | null = null;
let logBuffer = '';
let autoScroll = true;
let elapsedTimer: number | null = null;

function dedupeServes(serves: ServeRecord[]): ServeRecord[] {
  const seen = new Set<string>();
  const out: ServeRecord[] = [];
  for (const serve of serves) {
    if (seen.has(serve.id)) continue;
    seen.add(serve.id);
    out.push(serve);
  }
  return out;
}

function mount(): HTMLElement | null {
  return document.getElementById('modelsServerBody');
}

function isActive(): boolean {
  return Boolean(document.getElementById('modelsSection-server')?.classList.contains('is-active'));
}

/** Live row whose log the pane should follow (sticky selection, else newest). */
function preferredLogServe(serves: ServeRecord[]): ServeRecord | undefined {
  return serves.find((s) => s.id === logSource) ?? serves[0];
}

/** Follow the log of whichever serve is selected in the log header. */
function bindLogStream(serve: ServeRecord | null): void {
  const serveId = serve?.id ?? null;
  const runId = serve?.runId ?? null;
  const alreadyBound =
    logSource === serveId && logRunId === runId && (serveId === null || Boolean(logUnsub));
  if (alreadyBound) return;
  logUnsub?.();
  logUnsub = null;
  logBuffer = '';
  logSource = serveId;
  logRunId = runId;
  if (!serveId) {
    renderLogBody();
    return;
  }
  logUnsub = subscribeServeLog(serveId, (event) => {
    logBuffer = foldServeLogEvent(logBuffer, event);
    renderLogBody();
  });
}

function renderLogBody(): void {
  const body = document.getElementById('modelsLogBody');
  if (!body) return;
  const lines = toLogLines(logBuffer);
  const fragment = document.createDocumentFragment();
  for (const line of lines) {
    if (!line.trim()) continue;
    fragment.appendChild(el('div', `models-log-line models-log-line--${classifyLogLine(line)}`, line));
  }
  body.replaceChildren(fragment);
  if (autoScroll) body.scrollTop = body.scrollHeight;
}

function statusBar(serves: ServeRecord[]): HTMLElement {
  const running = serves.filter((s) => s.status === 'running');
  const starting = serves.filter((s) => s.status === 'starting');
  const unhealthy = serves.filter((s) => s.status === 'unhealthy');
  const crashed = getModelsState().serves.filter((s) => s.status === 'crashed');
  const isUp = running.length > 0 || unhealthy.length > 0;

  let tone: 'running' | 'starting' | 'unhealthy' | 'crashed' | 'stopped' = 'stopped';
  let label = 'Stopped';
  if (running.length) {
    tone = 'running';
    label = 'Running';
  } else if (starting.length) {
    tone = 'starting';
    label = 'Starting';
  } else if (unhealthy.length) {
    tone = 'unhealthy';
    label = 'Unhealthy';
  } else if (crashed.length) {
    tone = 'crashed';
    label = 'Crashed';
  }

  const bar = el('div', 'models-status-bar');

  const state = el('div', 'models-status-bar__state');
  const toggle = el('button', 'models-switch');
  toggle.type = 'button';
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-checked', String(isUp));
  toggle.setAttribute(
    'aria-label',
    isUp ? 'Stop the local server' : 'Load a model to start the local server',
  );
  toggle.appendChild(el('span', 'models-switch__thumb'));
  toggle.addEventListener('click', () => {
    if (isUp) {
      toggle.disabled = true;
      const toStop = [...running, ...unhealthy];
      void Promise.all(toStop.map((s) => unloadServe(s.id)))
        .catch((err: unknown) => {
          setStatus('err', err instanceof Error ? err.message : 'Could not stop the server');
        })
        .finally(() => {
          toggle.disabled = false;
        });
      return;
    }
    void import('../models-page').then((m) => m.openModels('installed'));
  });

  const labelEl = el('span', 'models-status-bar__label', label);
  labelEl.prepend(el('span', `models-dot models-dot--${tone}`));
  state.append(labelEl, toggle);
  bar.appendChild(state);

  if (isUp) {
    const reach = el('div', 'models-status-bar__reach');
    reach.append(
      el('span', 'models-field-label', 'Reachable at'),
      copyField((running[0] ?? unhealthy[0]).baseUrl, 'Copy server URL'),
    );
    bar.appendChild(reach);
  } else {
    bar.appendChild(
      el(
        'p',
        'models-status-bar__hint',
        crashed.length
          ? 'The runtime exited. Retry with the suggested settings, or load another model from My Models.'
          : 'No model is loaded, so nothing is listening yet.',
      ),
    );
  }

  const loadBtn = textButton(
    'Load model',
    () => {
      void import('../models-page').then((m) => m.openModels('installed'));
    },
    'primary',
  );
  loadBtn.prepend(icon('plus-small'));
  bar.appendChild(loadBtn);
  return bar;
}

/** `CSS.escape` with a fallback — happy-dom and older runtimes may omit it. */
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** "~12s left" for a predicted remainder. */
function formatEta(etaMs: number | null): string | null {
  if (etaMs == null || !Number.isFinite(etaMs) || etaMs <= 0) return null;
  const seconds = Math.round(etaMs / 1000);
  if (seconds < 1) return null;
  if (seconds < 60) return `~${seconds}s left`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `~${minutes}m ${rest}s left` : `~${minutes}m left`;
}

/** Spawning starts at a modelled 0. */
function shownLoadPercent(load: LoadProgress): number | null {
  return load.percent != null && load.percent > 0 ? Math.round(load.percent) : null;
}

function loadChipLabel(load: LoadProgress): string {
  if (load.error) return 'Failed';
  const percent = shownLoadPercent(load);
  return percent != null ? `Loading ${percent}%` : 'Loading';
}

function loadMetaText(load: LoadProgress): string {
  const parts = [load.phase, formatElapsed(load.startedAt)];
  const eta = formatEta(load.etaMs);
  if (eta) parts.push(eta);
  return parts.join(' · ');
}

/** Update percent / phase / bar on an existing loading card without replacing it. */
function applyLoadProgress(
  card: HTMLElement,
  load: LoadProgress,
  serve: ServeRecord | undefined,
): void {
  const label = card.querySelector('.models-loaded__state-label');
  if (label) {
    const next = loadChipLabel(load);
    if (label.textContent !== next) label.textContent = next;
  }

  const name = card.querySelector('.models-loaded__name');
  if (name && serve?.modelLabel && name.textContent !== serve.modelLabel) {
    name.textContent = serve.modelLabel;
  }

  const meta = card.querySelector('.models-loaded__meta');
  if (meta) {
    const next = loadMetaText(load);
    if (meta.textContent !== next) meta.textContent = next;
  }

  const fill = card.querySelector('.models-progress__fill') as HTMLElement | null;
  if (!fill) return;
  const percent = shownLoadPercent(load);
  if (percent != null) {
    fill.classList.remove('is-indeterminate');
    const progress = String(Math.min(100, percent) / 100);
    if (fill.style.getPropertyValue('--progress') !== progress) {
      fill.style.setProperty('--progress', progress);
    }
  } else if (!fill.classList.contains('is-indeterminate')) {
    fill.classList.add('is-indeterminate');
    fill.style.removeProperty('--progress');
  }
}

/** True when every in-flight load already has a card we can patch. */
function tryPatchInFlightLoads(
  host: HTMLElement,
  loads: LoadProgress[],
  serves: ServeRecord[],
): boolean {
  if (!loads.length || loads.some((entry) => entry.error)) return false;
  const list = host.querySelector('.models-loaded-list');
  if (!list) return false;
  const existing = list.querySelectorAll('.models-loaded.is-loading');
  if (existing.length !== loads.length) return false;
  for (const load of loads) {
    const card = list.querySelector(
      `.models-loaded.is-loading[data-serve-id="${cssEscape(load.serveId)}"]`,
    );
    if (!card) return false;
  }
  for (const load of loads) {
    const card = list.querySelector(
      `.models-loaded.is-loading[data-serve-id="${cssEscape(load.serveId)}"]`,
    ) as HTMLElement;
    applyLoadProgress(
      card,
      load,
      serves.find((row) => row.id === load.serveId),
    );
  }
  return true;
}

/** Local Server cards open the inspector by serve id. */
function makeServeCardSelectable(card: HTMLElement, serveId: string): void {
  card.classList.add('is-selectable');
  if (getInspectedServe()?.id === serveId) card.classList.add('is-selected');
  card.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('button')) return;
    showServeInInspector(serveId);
  });
}

function loadingCard(load: LoadProgress, serve: ServeRecord | undefined): HTMLElement {
  const card = el('article', 'models-loaded is-loading');
  card.dataset.serveId = load.serveId;

  const head = el('div', 'models-loaded__head');
  const stateChip = el('span', 'models-loaded__state');
  if (load.error) {
    stateChip.classList.add('is-error');
    stateChip.textContent = 'Failed';
  } else {
    const spinner = el('span', 'models-spinner');
    spinner.setAttribute('aria-hidden', 'true');
    stateChip.append(el('span', 'models-loaded__state-label', loadChipLabel(load)), spinner);
  }
  head.appendChild(stateChip);
  head.appendChild(el('span', 'models-loaded__name', serve?.modelLabel ?? 'Model'));

  const actions = el('div', 'models-loaded__actions');
  if (load.error) {
    if (serve && isRetryableServeStatus(serve.status)) {
      actions.appendChild(
        textButton(
          retryLabelForServe(serve),
          () => {
            void retryServe(serve).catch((err: unknown) => {
              setStatus('err', err instanceof Error ? err.message : 'Retry failed');
            });
          },
          'primary',
        ),
      );
    }
    actions.appendChild(
      textButton('Clear', () => {
        void unloadServe(load.serveId).catch((err: unknown) => {
          setStatus('err', err instanceof Error ? err.message : 'Clear failed');
        });
      }),
    );
  } else {
    actions.appendChild(
      textButton('Cancel', () => {
        void unloadServe(load.serveId).catch((err: unknown) => {
          setStatus('err', err instanceof Error ? err.message : 'Cancel failed');
        });
      }),
    );
  }
  head.appendChild(actions);
  card.appendChild(head);

  if (load.error) {
    const failure = serve ? serveFailureBlock(serve) : null;
    if (failure) card.appendChild(failure);
    else card.appendChild(el('p', 'models-loaded__meta', load.error));
  } else {
    card.appendChild(el('p', 'models-loaded__meta', loadMetaText(load)));
  }

  if (!load.error) {
    const track = el('div', 'models-progress');
    const fill = el('div', 'models-progress__fill');
    const percent = shownLoadPercent(load);
    if (percent != null) {
      fill.style.setProperty('--progress', String(Math.min(100, percent) / 100));
    } else {
      fill.classList.add('is-indeterminate');
    }
    track.appendChild(fill);
    card.appendChild(track);
  }
  makeServeCardSelectable(card, serve?.id ?? load.serveId);
  return card;
}

/** One chip per working slot, Ready when idle, plus queue depth when the host is deferring requests. */
function activityChips(activity: ServeActivity | undefined): HTMLElement[] {
  return serveActivityChipLabels(activity, getInFlightPromptOverlay()).map((label) => {
    const queued = /\bqueued$/i.test(label);
    const ready = /^Ready/i.test(label);
    const chipEl = el(
      'span',
      `models-loaded__state${queued ? ' is-queued' : ready ? ' is-ready' : ' is-busy'}`,
      label,
    );
    if (!queued && !ready) {
      chipEl.appendChild(el('span', 'models-spinner'));
    }
    return chipEl;
  });
}

function loadedCard(serve: ServeRecord): HTMLElement {
  const card = el('article', 'models-loaded');
  const overlay = getInFlightPromptOverlay();
  const activity = activityForLoadedServe(
    serve,
    getModelsState().activity.get(serve.id),
    overlay,
  );

  const head = el('div', 'models-loaded__head');
  for (const chipEl of activityChips(activity)) head.appendChild(chipEl);
  head.appendChild(el('span', 'models-loaded__name', serve.modelLabel));

  const actions = el('div', 'models-loaded__actions');
  actions.append(
    iconButton('copy', 'Copy model identifier', (): void => {
      void copyText(serve.modelLabel);
    }),
    iconButton('code-simple', 'Copy a cURL request', (): void => {
      const curl = [
        `curl ${serve.baseUrl}/v1/chat/completions \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '{"model":"${serve.modelLabel}","messages":[{"role":"user","content":"Hello"}]}'`,
      ].join('\n');
      void copyText(curl).then((ok) => {
        if (ok) setStatus('ok', 'cURL request copied.');
      });
    }),
    textButton(
      'Eject',
      () => {
        void unloadServe(serve.id).catch((err: unknown) => {
          setStatus('err', err instanceof Error ? err.message : 'Eject failed');
        });
      },
      'danger',
    ),
  );
  head.appendChild(actions);
  card.appendChild(head);

  const meta = el('div', 'models-loaded__facts');
  meta.append(
    chip(serve.runtime),
    chip(`port ${serve.port}`),
    chip(`up ${formatElapsed(serve.startedAt)}`),
  );
  const settings = serve.llamaSettings as
    | { ctx?: number; parallel?: number; spec_type?: string }
    | null;
  if (settings?.ctx) meta.appendChild(chip(`ctx ${settings.ctx}`));
  if (serve.mlxSettings?.contextLength) {
    meta.appendChild(chip(`ctx ${serve.mlxSettings.contextLength}`));
  }
  if (settings?.parallel) meta.appendChild(chip(`parallel ${settings.parallel}`));
  if (settings?.spec_type && settings.spec_type !== 'none') {
    meta.appendChild(chip(settings.spec_type));
  }
  const rate = activity?.slots.find((slot) => slot.tokensPerSecond != null)?.tokensPerSecond;
  if (rate != null && rate > 0) meta.appendChild(chip(`${rate.toFixed(1)} tok/s`));
  card.appendChild(meta);

  card.appendChild(copyField(serve.baseUrl, 'Copy base URL'));

  makeServeCardSelectable(card, serve.id);
  return card;
}

/** Crashed / unhealthy / error — distinct from Stopped (user eject) and load Failed. */
function attentionCard(serve: ServeRecord): HTMLElement {
  const card = el('article', `models-loaded is-${serve.status}`);
  const head = el('div', 'models-loaded__head');
  const toneClass =
    serve.status === 'unhealthy'
      ? 'is-unhealthy'
      : serve.status === 'crashed'
        ? 'is-crashed'
        : 'is-error';
  head.appendChild(el('span', `models-loaded__state ${toneClass}`, serveStatusLabel(serve.status)));
  head.appendChild(el('span', 'models-loaded__name', serve.modelLabel));

  const actions = el('div', 'models-loaded__actions');
  if (isRetryableServeStatus(serve.status)) {
    actions.appendChild(
      textButton(
        retryLabelForServe(serve),
        () => {
          void retryServe(serve).catch((err: unknown) => {
            setStatus('err', err instanceof Error ? err.message : 'Retry failed');
          });
        },
        'primary',
      ),
    );
  }
  if (serve.status === 'error' || serve.status === 'crashed') {
    actions.appendChild(
      textButton('Clear', () => {
        void unloadServe(serve.id).catch((err: unknown) => {
          setStatus('err', err instanceof Error ? err.message : 'Clear failed');
        });
      }),
    );
  } else if (serve.status === 'unhealthy') {
    actions.appendChild(
      textButton(
        'Eject',
        () => {
          void unloadServe(serve.id).catch((err: unknown) => {
            setStatus('err', err instanceof Error ? err.message : 'Eject failed');
          });
        },
        'danger',
      ),
    );
  }
  head.appendChild(actions);
  card.appendChild(head);

  const failure = serveFailureBlock(serve);
  if (failure) {
    card.appendChild(failure);
  } else {
    const bits: string[] = [serve.runtime];
    if (serve.exitCode != null) bits.push(`exit ${serve.exitCode}`);
    if (serve.failure?.code && serve.failure.code !== 'unknown') bits.push(serve.failure.code);
    if (serve.error) bits.push(serve.error);
    card.appendChild(el('p', 'models-loaded__meta', bits.join(' · ')));
  }

  makeServeCardSelectable(card, serve.id);
  return card;
}

function endpointsBlock(baseUrl: string | null): HTMLElement {
  const block = el('section', 'models-block');
  const summary = el('details', 'models-endpoints');
  const head = el('summary', 'models-endpoints__summary');
  head.append(
    el('span', 'models-block__label', 'Supported endpoints'),
    el('span', 'models-endpoints__count', `${ENDPOINTS.length} routes`),
  );
  summary.appendChild(head);

  const list = el('div', 'models-endpoints__list');
  for (const endpoint of ENDPOINTS) {
    const row = el('div', 'models-endpoint');
    row.append(
      el('span', `models-endpoint__method models-endpoint__method--${endpoint.method.toLowerCase()}`, endpoint.method),
      el('span', 'models-endpoint__path', endpoint.path),
      el('span', 'models-endpoint__note', endpoint.note),
    );
    if (baseUrl) {
      row.appendChild(
        iconButton('copy', `Copy ${endpoint.path} URL`, () => {
          void copyText(`${baseUrl}${endpoint.path}`);
        }),
      );
    }
    list.appendChild(row);
  }
  summary.appendChild(list);
  block.appendChild(summary);
  return block;
}

function logsBlock(serves: ServeRecord[]): HTMLElement {
  const block = el('section', 'models-logs');

  const head = el('header', 'models-logs__head');
  head.appendChild(el('h3', 'models-block__label', 'Runtime log'));

  if (serves.length > 1) {
    const select = el('select', 'models-select') as HTMLSelectElement;
    select.setAttribute('aria-label', 'Log source');
    for (const serve of serves) {
      const option = el('option', undefined, serve.modelLabel) as HTMLOptionElement;
      option.value = serve.id;
      if (serve.id === logSource) option.selected = true;
      select.appendChild(option);
    }
    select.addEventListener('change', () => {
      bindLogStream(serves.find((s) => s.id === select.value) ?? null);
    });
    head.appendChild(select);
  }

  const controls = el('div', 'models-logs__controls');
  const scrollBtn = iconButton('angle-small-down', 'Follow new output', () => {
    autoScroll = !autoScroll;
    scrollBtn.classList.toggle('is-active', autoScroll);
    scrollBtn.setAttribute('aria-pressed', String(autoScroll));
    if (autoScroll) renderLogBody();
  });
  scrollBtn.classList.toggle('is-active', autoScroll);
  scrollBtn.setAttribute('aria-pressed', String(autoScroll));
  controls.append(
    iconButton('copy', 'Copy log', () => {
      void copyText(logBuffer);
    }),
    iconButton('broom', 'Clear view', () => {
      logBuffer = '';
      renderLogBody();
    }),
    scrollBtn,
  );
  head.appendChild(controls);
  block.appendChild(head);

  const body = el('pre', 'models-logs__body');
  body.id = 'modelsLogBody';
  body.setAttribute('role', 'log');
  body.setAttribute('aria-label', 'Runtime log output');
  block.appendChild(body);
  return block;
}

/** Redraw Local Server from store state. */
export function render(): void {
  const host = mount();
  if (!host) return;

  const state = getModelsState();
  if (tryPatchInFlightLoads(host, state.loads, state.serves)) {
    bindLogStream(preferredLogServe(runningServes()) ?? null);
    return;
  }

  const serves = runningServes();
  const running = serves.filter((s) => s.status === 'running');
  const attention = attentionServes();
  const loadIds = new Set(state.loads.map((l) => l.serveId));

  const fragment = document.createDocumentFragment();
  fragment.appendChild(statusBar(serves));

  const loadedBlock = el('section', 'models-block');
  loadedBlock.appendChild(el('h3', 'models-block__label', 'Loaded models'));
  const list = el('div', 'models-loaded-list');

  for (const load of state.loads) {
    list.appendChild(loadingCard(load, state.serves.find((s) => s.id === load.serveId)));
  }
  for (const serve of running) {
    list.appendChild(loadedCard(serve));
  }
  for (const serve of attention) {
    if (serve.status === 'error' && loadIds.has(serve.id)) continue;
    if (
      serves.some(
        (s) => isLiveServeStatus(s.status) && s.modelPath === serve.modelPath && s.id !== serve.id,
      )
    ) {
      continue;
    }
    list.appendChild(attentionCard(serve));
  }

  if (!list.childElementCount) {
    list.appendChild(
      emptyState({
        glyph: 'microchip',
        title: 'Nothing loaded',
        body: 'Load a model from My Models and it will serve on a local OpenAI-compatible endpoint.',
        action: {
          label: 'Open My Models',
          onClick: () => {
            void import('../models-page').then((m) => m.openModels('installed'));
          },
        },
      }),
    );
  }
  loadedBlock.appendChild(list);
  fragment.appendChild(loadedBlock);

  fragment.appendChild(endpointsBlock(running[0]?.baseUrl ?? null));
  const logServes = dedupeServes([...serves, ...attention]);
  fragment.appendChild(logsBlock(logServes));

  host.replaceChildren(fragment);

  bindLogStream(preferredLogServe(serves) ?? null);
  renderLogBody();
}

/** Mount Local Server (idempotent). */
export function mountServerSection(): void {
  if (!bound) {
    bound = true;
    subscribeModelsStore(() => {
      if (isActive()) render();
    });
  }
  if (!overlayUnsub) {
    overlayUnsub = subscribeInFlightPromptOverlay(() => {
      if (isActive()) render();
    });
  }
  render();
  void refreshModels();

  if (elapsedTimer != null) window.clearInterval(elapsedTimer);
  elapsedTimer = window.setInterval(() => {
    if (!isActive()) return;
    if (!runningServes().length && !getModelsState().loads.length) return;
    render();
  }, 5_000);
}

/** Stop streaming when the app closes. */
export function teardownServerSection(): void {
  logUnsub?.();
  logUnsub = null;
  logSource = null;
  logRunId = null;
  overlayUnsub?.();
  overlayUnsub = null;
  if (elapsedTimer != null) window.clearInterval(elapsedTimer);
  elapsedTimer = null;
}
