/**
 * S4 — Parallel optional extras: SearXNG, embeddings, voice, llama.cpp runtime.
 */

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
  percent?: number;
}

let rows: ExtraRow[] = [
  {
    id: 'embeddings',
    title: 'Better memory recall',
    description: 'Helps agents find relevant memories. Small local download (~80 MB).',
    selected: true,
    status: 'idle',
    message: '',
  },
  {
    id: 'voice',
    title: 'Voice input and replies',
    description: 'Speak to your agents and hear replies. Includes a larger local runtime download.',
    selected: false,
    status: 'idle',
    message: '',
  },
  {
    id: 'llama',
    title: 'Local model runtime',
    description: 'Prepares local model hosting without downloading a model.',
    selected: false,
    status: 'idle',
    message: '',
  },
  {
    id: 'searxng',
    title: 'Local web search (SearXNG)',
    description: 'Optional self-hosted search. Tavily works without this install.',
    selected: false,
    status: 'idle',
    message: '',
  },
];

let searxngSkipped = false;
let installStarted = false;
let installingExtras = false;
let installConsole: InstallConsole | null = null;
let refreshExtrasView: (() => void) | null = null;

interface ExtrasUi {
  paint: () => void;
  log: (rowId: ExtraId, level: InstallLogLevel, text: string) => void;
}

function createExtrasUi(listHost: HTMLElement): ExtrasUi {
  return {
    paint: () => refreshExtrasView?.(),
    log(rowId, level, text) {
      const source = EXTRA_LOG_SOURCE[rowId] ?? rowId;
      installConsole?.log(source, level, text);
      refreshExtrasView?.();
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
  row.status = 'ok';
  row.message = 'SearXNG running on loopback';
  ui.log(row.id, 'ok', row.message);
  searxngSkipped = false;
}

async function installEmbeddings(row: ExtraRow, ui: ExtrasUi): Promise<void> {
  row.status = 'working';
  row.message = 'Preparing memory recall…';
  ui.log(row.id, 'working', row.message);
  const result = await warmupMemoryEmbeddings();
  if (result.kind === 'err') throw new Error(result.error);
  row.status = 'ok';
  row.message = 'Memory recall is ready';
  ui.log(row.id, 'ok', row.message);
}

async function installVoice(row: ExtraRow, ui: ExtrasUi): Promise<void> {
  row.status = 'working';
  row.message = 'Installing voice runtime…';
  ui.log(row.id, 'working', row.message);
  const status = await fetchRuntimeStatus();
  if (!status.installed) {
    const applyVoiceJob = (message: string, phase: string | undefined, percent?: number): void => {
      const trimmed = message.trim();
      if (!trimmed) return;
      row.message = phase === 'failed' ? 'Voice setup needs attention.' : friendlyInstallMessage('voice', trimmed);
      row.percent = typeof percent === 'number' ? Math.min(99, Math.max(0, percent)) : undefined;
      const level: InstallLogLevel = phase === 'failed' ? 'err' : 'working';
      ui.log(row.id, level, trimmed);
    };

    const unsub = subscribeInstallProgress((job) => {
      applyVoiceJob(job.message || job.phase, job.phase, job.percent);
    });
    try {
      await installRuntime();
      const started = Date.now();
      let completed = false;
      while (Date.now() - started < 600_000) {
        const next = await fetchRuntimeStatus();
        const job = next.installJob;
        if (job?.message || job?.phase) {
          applyVoiceJob(job.message || job.phase, job.phase, job.percent);
        }
        const phase = job?.phase;
        if (phase === 'completed') { completed = true; break; }
        if (phase === 'failed') {
          throw new Error(job?.error || job?.message || 'Install failed');
        }
        await sleep(500);
      }
      if (!completed) throw new Error('Voice setup timed out. Try again.');
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
  row.message = 'Checking the local model runtime…';
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
    row.message = friendlyInstallMessage('llama', msg);
    row.percent = Math.min(99, Math.max(0, job.percent));
    ui.log(row.id, 'working', msg);
  });
  try {
    const result = await installLlamaRuntime({ variant: runtime.preferredVariant });
    if (!result.path) throw new Error('Install did not complete');
    row.status = 'ok';
    row.message = 'Local model runtime is ready';
    ui.log(row.id, 'ok', `Installed (${result.variant ?? runtime.preferredVariant})`);
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
  if (installingExtras) return;
  const visibleIds = new Set(Array.from(listHost.querySelectorAll<HTMLElement>('[data-extra-id]'), node => node.dataset.extraId));
  const selected = rows.filter((r) => r.selected && visibleIds.has(r.id));
  if (!selected.length) {
    searxngSkipped = !rows.find((r) => r.id === 'searxng')?.selected;
    actions.setPrimaryEnabled(true);
    return;
  }

  const ui = createExtrasUi(listHost);

  installStarted = true;
  installingExtras = true;
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

  const tasks = selected.filter(row => row.status !== 'ok').map(async (row) => {
    row.percent = undefined;
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
  installingExtras = false;

  const failed = selected.filter((r) => r.status === 'err').length;
  if (failed > 0) {
    installConsole?.setHeadline('Some extras need attention');
    installConsole?.log('Setup', 'err', `${failed} of ${selected.length} installs failed`);
  } else {
    installConsole?.setHeadline('Your extras are ready');
    installConsole?.log('Setup', 'ok', 'All selected extras finished');
  }

  searxngSkipped = rows.find((r) => r.id === 'searxng')?.status !== 'ok';

  ctx.searxngSkipped = searxngSkipped;
  actions.setPrimaryEnabled(true);
  if (installBtn) {
    installBtn.hidden = failed === 0;
    installBtn.textContent = 'Retry failed installs';
  }
  ui.paint();
}

function friendlyInstallMessage(id: ExtraId, message: string): string {
  const name = id === 'voice' ? 'voice packages' : id === 'llama' ? 'the model runtime' : 'SearXNG';
  if (/download|fetch/i.test(message)) return `Downloading ${name}…`;
  if (/extract|unpack/i.test(message)) return `Unpacking ${name}…`;
  if (/check|verify/i.test(message)) return `Checking ${name}…`;
  if (/start|launch/i.test(message)) return `Starting ${name}…`;
  return `Installing ${name}… This can take a few minutes.`;
}

function paintRows(listHost: HTMLElement): void {
  listHost.querySelectorAll('.mn-onboarding-extra-row').forEach((node) => {
    const id = (node as HTMLElement).dataset.extraId as ExtraId | undefined;
    const row = id ? rows.find((r) => r.id === id) : undefined;
    if (!row) return;
    const status = node.querySelector('.mn-onboarding-extra-row__status');
    const msg = node.querySelector('.mn-onboarding-extra-row__message');
    const checkbox = node.querySelector('input[type=checkbox]') as HTMLInputElement | null;
    if (checkbox) { checkbox.checked = row.selected; checkbox.disabled = installingExtras; }
    if (status) {
      status.textContent =
        row.status === 'ok'
          ? 'Ready'
          : row.status === 'err'
            ? 'Needs attention'
            : row.status === 'working'
              ? 'Setting up'
              : row.status === 'skip'
                ? 'Skipped'
                : '';
      status.className = `mn-onboarding-extra-row__status is-${row.status}`;
    }
    if (msg) msg.textContent = row.message;
    const progress = node.querySelector<HTMLProgressElement>('progress');
    if (progress) {
      progress.hidden = row.status !== 'working';
      if (row.percent === undefined) progress.removeAttribute('value');
      else progress.value = row.percent;
    }
  });
  const selected = rows.filter(row => row.selected && listHost.querySelector(`[data-extra-id="${row.id}"]`));
  installConsole?.setProgress(selected.filter(row => row.status === 'ok' || row.status === 'skip').length,
    selected.length, selected.filter(row => row.status === 'err').length);
}

export const extrasStep: OnboardingStep = {
  id: 'extras',
  title: 'Install extras',
  canSkip: true,
  isApplicable: () => true,

  render(container, ctx, actions) {
    let active = true;
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
        'Add optional capabilities to your workspace. Choose what you need, or continue and add them later.',
      ),
    );

    const managedDone = Boolean(ctx.state.steps['provider-managed']?.done);
    if (!installStarted) {
      const searxng = rows.find(row => row.id === 'searxng');
      if (searxng) searxng.selected = ctx.state.steps['api-keys']?.data?.provider === 'searxng';
    }
    const visibleRows = rows.filter((r) => !(r.id === 'llama' && managedDone));

    const list = el('div', 'mn-onboarding-extra-list');
    visibleRows.forEach((row) => {
      const item = el('label', 'mn-onboarding-extra-row');
      item.dataset.extraId = row.id;
      const checkbox = el('input') as HTMLInputElement;
      checkbox.type = 'checkbox';
      checkbox.checked = row.selected;
      checkbox.disabled = installingExtras;
      checkbox.addEventListener('change', () => {
        row.selected = checkbox.checked;
        refreshExtrasView?.();
      });

      const copy = el('div', 'mn-onboarding-extra-row__copy');
      copy.appendChild(el('span', 'mn-onboarding-extra-row__title', row.title));
      copy.appendChild(el('span', 'mn-onboarding-extra-row__desc', row.description));
      const meta = el('div', 'mn-onboarding-extra-row__meta');
      meta.appendChild(el('span', 'mn-onboarding-extra-row__status is-idle', ''));
      meta.appendChild(el('span', 'mn-onboarding-extra-row__message', ''));
      copy.appendChild(meta);
      const progress = el('progress', 'mn-onboarding-install-progress');
      progress.max = 100;
      progress.hidden = true;
      progress.setAttribute('aria-label', `${row.title} setup progress`);
      copy.appendChild(progress);

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
    const consoleForView = installConsole;
    const refresh = () => {
      if (!active) return;
      paintRows(list);
      const pending = visibleRows.filter(row => row.selected && row.status !== 'ok' && row.status !== 'skip');
      installBtn.disabled = pending.length === 0;
      installBtn.hidden = installingExtras || (installStarted && pending.length === 0);
      installBtn.textContent = pending.some(row => row.status === 'err') ? 'Retry failed installs' : 'Install selected';
      actions.setPrimaryEnabled(!installingExtras);
      if (installStarted) {
        consoleForView?.show();
        consoleForView?.setHeadline(installingExtras ? 'Installing…'
          : visibleRows.some(row => row.selected && row.status === 'err') ? 'Some extras need attention' : 'Your extras are ready');
      }
    };
    refreshExtrasView = refresh;

    void fetchManagedServers().then((servers) => {
      if (!active) return;
      const searxng = servers?.find((s) => s.id === 'searxng');
      if (searxng?.running) {
        const row = rows.find((r) => r.id === 'searxng');
        if (row) {
          row.status = 'ok';
          row.message = 'Already running';
        }
        refresh();
      }
    }).catch(() => {});

    actions.setPrimaryLabel('Continue');
    actions.setPrimaryEnabled(!installingExtras);
    refresh();
    return () => {
      active = false;
      if (refreshExtrasView === refresh) {
        refreshExtrasView = null;
        installConsole = null;
      }
    };
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
  installingExtras = false;
  searxngSkipped = false;
  installConsole = null;
  refreshExtrasView = null;
  rows = rows.map((r) => ({ ...r, selected: r.id === 'embeddings', status: 'idle', message: '', percent: undefined }));
}
