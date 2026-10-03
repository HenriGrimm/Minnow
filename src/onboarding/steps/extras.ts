/**
 * S4 — Parallel optional extras: SearXNG, embeddings, voice, llama.cpp runtime.
 */

import { saveSearchConfig, loadSearchConfig } from '../../config/search-config';
import {
  fetchLlamaRuntime,
  installLlamaRuntime,
  subscribeLlamaInstallProgress,
} from '../../models/api-client';
import { warmupMemoryEmbeddings } from '../../memory/client';
import {
  fetchManagedServers,
  fetchServerInstallStatus,
  installManagedServer,
  setManagedServerAutoStart,
  setManagedServerEnabled,
  startManagedServer,
} from '../../servers/client';
import {
  fetchRuntimeStatus,
  installRuntime,
  startVoiceWorker,
  subscribeInstallProgress,
} from '../../voice/api-client';
import { el, renderStepHeader } from '../ui-helpers';
import {
  createInstallConsole,
  EXTRA_LOG_SOURCE,
  type InstallConsole,
  type InstallLogLevel,
} from '../install-console';
import type { OnboardingContext, OnboardingStep } from '../types';
import { recordStepProgress } from '../state-core';

type ExtraId = 'searxng' | 'embeddings' | 'voice' | 'llama';

interface ExtraRow {
  id: ExtraId;
  title: string;
  description: string;
  selected: boolean;
  status: 'idle' | 'working' | 'ok' | 'err' | 'skip';
  message: string;
}

let rows: ExtraRow[] = [
  {
    id: 'searxng',
    title: 'Private web search (SearXNG)',
    description: 'Local metasearch for agents using web_search.',
    selected: true,
    status: 'idle',
    message: '',
  },
  {
    id: 'embeddings',
    title: 'Semantic memory embeddings',
    description: 'Downloads a small local model for memory recall (~80 MB).',
    selected: true,
    status: 'idle',
    message: '',
  },
  {
    id: 'voice',
    title: 'Voice I/O runtime',
    description: 'Speech-to-text and text-to-speech worker (larger download).',
    selected: false,
    status: 'idle',
    message: '',
  },
  {
    id: 'llama',
    title: 'llama.cpp runtime only',
    description: 'Server binary without a model (skip if you used managed models).',
    selected: false,
    status: 'idle',
    message: '',
  },
];

let searxngSkipped = false;
let installStarted = false;
let installConsole: InstallConsole | null = null;

interface ExtrasUi {
  paint: () => void;
  log: (rowId: ExtraId, level: InstallLogLevel, text: string) => void;
}

function createExtrasUi(listHost: HTMLElement): ExtrasUi {
  return {
    paint: () => paintRows(listHost),
    log(rowId, level, text) {
      const source = EXTRA_LOG_SOURCE[rowId] ?? rowId;
      installConsole?.log(source, level, text);
      paintRows(listHost);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function pollServerInstall(serverId: string, onTick: (msg: string) => void): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 600_000) {
    const job = await fetchServerInstallStatus(serverId);
    if (job?.message) onTick(job.message);
    if (job?.phase === 'done') return;
    if (job?.phase === 'error') throw new Error(job.error || job.message || 'Install failed');
    await sleep(500);
  }
  throw new Error('SearXNG install timed out');
}

async function installSearxng(row: ExtraRow, ui: ExtrasUi): Promise<void> {
  row.status = 'working';
  row.message = 'Installing SearXNG…';
  ui.log(row.id, 'working', row.message);
  const install = await installManagedServer('searxng');
  if (install.ok === false) throw new Error(install.error);
  if (!install.alreadyInstalled) {
    await pollServerInstall('searxng', (msg) => {
      row.message = msg;
      ui.log(row.id, 'working', msg);
    });
  } else {
    ui.log(row.id, 'info', 'Already installed');
  }
  await setManagedServerEnabled('searxng', true);
  await setManagedServerAutoStart('searxng', true);
  ui.log(row.id, 'info', 'Starting SearXNG…');
  const start = await startManagedServer('searxng');
  if (start.ok === false) throw new Error(start.error);
  const config = await loadSearchConfig();
  await saveSearchConfig({ ...config, provider: 'searxng' });
  row.status = 'ok';
  row.message = 'SearXNG running on loopback';
  ui.log(row.id, 'ok', row.message);
  searxngSkipped = false;
}

async function installEmbeddings(row: ExtraRow, ui: ExtrasUi): Promise<void> {
  row.status = 'working';
  row.message = 'Warming up embeddings model…';
  ui.log(row.id, 'working', row.message);
  const result = await warmupMemoryEmbeddings();
  if (result.kind === 'err') throw new Error(result.error);
  row.status = 'ok';
  row.message = 'Semantic memory ready';
  ui.log(row.id, 'ok', row.message);
}

async function installVoice(row: ExtraRow, ui: ExtrasUi): Promise<void> {
  row.status = 'working';
  row.message = 'Installing voice runtime…';
  ui.log(row.id, 'working', row.message);
  const status = await fetchRuntimeStatus();
  if (!status.installed) {
    const applyVoiceJob = (message: string, phase: string | undefined): void => {
      const trimmed = message.trim();
      if (!trimmed) return;
      row.message = trimmed;
      const level: InstallLogLevel = phase === 'failed' ? 'err' : 'working';
      ui.log(row.id, level, trimmed);
    };

    const unsub = subscribeInstallProgress((job) => {
      applyVoiceJob(job.message || job.phase, job.phase);
    });
    try {
      await installRuntime();
      const started = Date.now();
      while (Date.now() - started < 600_000) {
        const next = await fetchRuntimeStatus();
        const job = next.installJob;
        if (job?.message || job?.phase) {
          applyVoiceJob(job.message || job.phase, job.phase);
        }
        const phase = job?.phase;
        if (phase === 'completed') break;
        if (phase === 'failed') {
          throw new Error(job?.error || job?.message || 'Install failed');
        }
        await sleep(500);
      }
    } finally {
      unsub();
    }
  } else {
    ui.log(row.id, 'info', 'Runtime already installed');
  }
  row.message = 'Starting voice worker…';
  ui.log(row.id, 'working', row.message);
  await startVoiceWorker();
  row.status = 'ok';
  row.message = 'Voice worker ready';
  ui.log(row.id, 'ok', row.message);
}

async function installLlamaOnly(row: ExtraRow, ui: ExtrasUi): Promise<void> {
  row.status = 'working';
  ui.log(row.id, 'working', 'Checking llama.cpp runtime…');
  const runtime = await fetchLlamaRuntime();
  if (runtime.path) {
    row.status = 'ok';
    row.message = 'Already installed';
    ui.log(row.id, 'ok', row.message);
    return;
  }
  if (!runtime.installable) {
    row.status = 'skip';
    row.message = 'Manual install required on this platform';
    ui.log(row.id, 'skip', row.message);
    return;
  }
  const unsub = subscribeLlamaInstallProgress((job) => {
    const msg = job.message || 'Installing llama.cpp…';
    row.message = msg;
    ui.log(row.id, 'working', msg);
  });
  try {
    const result = await installLlamaRuntime({ variant: runtime.preferredVariant });
    if (!result.path) throw new Error('Install did not complete');
    row.status = 'ok';
    row.message = `Installed (${result.variant ?? runtime.preferredVariant})`;
    ui.log(row.id, 'ok', row.message);
  } finally {
    unsub();
  }
}

async function runSelectedExtras(
  ctx: OnboardingContext,
  listHost: HTMLElement,
  installBtn: HTMLButtonElement | null,
  actions: { setPrimaryEnabled: (v: boolean) => void },
): Promise<void> {
  const selected = rows.filter((r) => r.selected);
  if (!selected.length) {
    searxngSkipped = !rows.find((r) => r.id === 'searxng')?.selected;
    actions.setPrimaryEnabled(true);
    return;
  }

  const ui = createExtrasUi(listHost);

  installStarted = true;
  if (installBtn) installBtn.hidden = true;
  actions.setPrimaryEnabled(false);
  installConsole?.clear();
  installConsole?.show();
  installConsole?.setHeadline('Installing…');
  installConsole?.log(
    'Setup',
    'info',
    `Starting ${selected.length} install${selected.length === 1 ? '' : 's'} in parallel`,
  );
  ui.paint();

  const tasks = selected.map(async (row) => {
    try {
      if (row.id === 'searxng') await installSearxng(row, ui);
      else if (row.id === 'embeddings') await installEmbeddings(row, ui);
      else if (row.id === 'voice') await installVoice(row, ui);
      else if (row.id === 'llama') await installLlamaOnly(row, ui);
    } catch (err) {
      row.status = 'err';
      row.message = err instanceof Error ? err.message : 'Failed';
      ui.log(row.id, 'err', row.message);
    }
    ui.paint();
  });

  await Promise.all(tasks);

  const failed = selected.filter((r) => r.status === 'err').length;
  if (failed > 0) {
    installConsole?.setHeadline(`${failed} failed`);
    installConsole?.log('Setup', 'err', `${failed} of ${selected.length} installs failed`);
  } else {
    installConsole?.setHeadline('Done');
    installConsole?.log('Setup', 'ok', 'All selected extras finished');
  }

  searxngSkipped = rows.find((r) => r.id === 'searxng')?.status !== 'ok';

  ctx.searxngSkipped = searxngSkipped;
  actions.setPrimaryEnabled(true);
  ui.paint();
}

function paintRows(listHost: HTMLElement): void {
  listHost.querySelectorAll('.mn-onboarding-extra-row').forEach((node) => {
    const id = (node as HTMLElement).dataset.extraId as ExtraId | undefined;
    const row = id ? rows.find((r) => r.id === id) : undefined;
    if (!row) return;
    const status = node.querySelector('.mn-onboarding-extra-row__status');
    const msg = node.querySelector('.mn-onboarding-extra-row__message');
    const checkbox = node.querySelector('input[type=checkbox]') as HTMLInputElement | null;
    if (checkbox) checkbox.checked = row.selected;
    if (status) {
      status.textContent =
        row.status === 'ok'
          ? 'Done'
          : row.status === 'err'
            ? 'Error'
            : row.status === 'working'
              ? '…'
              : row.status === 'skip'
                ? 'Skipped'
                : '';
      status.className = `mn-onboarding-extra-row__status is-${row.status}`;
    }
    if (msg) msg.textContent = row.message;
  });
}

export const extrasStep: OnboardingStep = {
  id: 'extras',
  title: 'Install extras',
  canSkip: true,
  isApplicable: () => true,

  render(container, ctx, actions) {
    container.innerHTML = '';
    container.className = 'mn-onboarding-step';
    renderStepHeader(container, extrasStep, actions.stepIndex, actions.totalSteps);

    if (!ctx.serverAvailable) {
      container.appendChild(
        el(
          'p',
          'mn-onboarding-notice',
          'Extras need Minnow running locally. Skip now and install later from Settings → Servers.',
        ),
      );
      actions.setPrimaryEnabled(true);
      actions.setPrimaryLabel('Continue');
      return;
    }

    container.appendChild(
      el(
        'p',
        'mn-onboarding-step-desc',
        'Optional local services run in parallel. Toggle what you want, then install.',
      ),
    );

    const managedDone = Boolean(ctx.state.steps['provider-managed']?.done);
    const visibleRows = rows.filter((r) => !(r.id === 'llama' && managedDone));

    const list = el('div', 'mn-onboarding-extra-list');
    visibleRows.forEach((row) => {
      const item = el('label', 'mn-onboarding-extra-row');
      item.dataset.extraId = row.id;
      const checkbox = el('input') as HTMLInputElement;
      checkbox.type = 'checkbox';
      checkbox.checked = row.selected;
      checkbox.disabled = installStarted;
      checkbox.addEventListener('change', () => {
        row.selected = checkbox.checked;
      });

      const copy = el('div', 'mn-onboarding-extra-row__copy');
      copy.appendChild(el('span', 'mn-onboarding-extra-row__title', row.title));
      copy.appendChild(el('span', 'mn-onboarding-extra-row__desc', row.description));
      const meta = el('div', 'mn-onboarding-extra-row__meta');
      meta.appendChild(el('span', 'mn-onboarding-extra-row__status is-idle', ''));
      meta.appendChild(el('span', 'mn-onboarding-extra-row__message', ''));
      copy.appendChild(meta);

      item.append(checkbox, copy);
      list.appendChild(item);
    });
    container.appendChild(list);

    installConsole = createInstallConsole();
    container.appendChild(installConsole.element);

    const installBtn = el('button', 'mn-onboarding-secondary-btn', 'Install selected');
    installBtn.type = 'button';
    installBtn.hidden = installStarted;
    installBtn.addEventListener('click', () => {
      void runSelectedExtras(ctx, list, installBtn, actions);
    });
    container.appendChild(installBtn);

    void fetchManagedServers().then((servers) => {
      const searxng = servers?.find((s) => s.id === 'searxng');
      if (searxng?.running) {
        const row = rows.find((r) => r.id === 'searxng');
        if (row) {
          row.status = 'ok';
          row.message = 'Already running';
        }
        paintRows(list);
      }
    });

    actions.setPrimaryLabel('Continue');
    actions.setPrimaryEnabled(installStarted);
    paintRows(list);
  },

  async commit(ctx) {
    if (!installStarted) {
      const searx = rows.find((r) => r.id === 'searxng');
      searxngSkipped = !searx?.selected || searx.status !== 'ok';
    }
    ctx.searxngSkipped = searxngSkipped;
    ctx.state = recordStepProgress(ctx.state, 'extras', {
      done: installStarted,
      data: {
        searxngSkipped,
        selections: rows.map((r) => ({ id: r.id, selected: r.selected, status: r.status })),
      },
    });
  },
};

export function resetExtrasStepState(): void {
  installStarted = false;
  searxngSkipped = false;
  installConsole = null;
  rows = rows.map((r) => ({ ...r, status: 'idle', message: '' }));
}
