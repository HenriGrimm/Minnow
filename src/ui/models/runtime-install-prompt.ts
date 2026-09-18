import {
  fetchLlamaRuntime,
  fetchRuntimes,
  installLlamaRuntime,
  subscribeLlamaInstallProgress,
  type LlamaRuntimeStatus,
} from '../../models/api-client';
import type { LibraryModel } from '../../models/library';
import { fetchServerInstallStatus, installManagedServer } from '../../servers/client';
import { el, textButton } from './dom';

/** Give up on a stalled managed install rather than spin forever. */
const MANAGED_INSTALL_TIMEOUT_MS = 30 * 60_000;
const MANAGED_POLL_MS = 1_000;

type ProgressFn = (message: string, percent: number | null) => void;

interface RuntimePromptSpec {
  title: string;
  /** Paragraphs shown when this machine can install the runtime. */
  body: string[];
  installLabel: string;
  /** Resolves true once the runtime is usable. */
  install: (onProgress: ProgressFn) => Promise<boolean>;
  /** Shown instead when the runtime cannot run here at all — no Install button. */
  unsupported?: {
    body: string[];
    actionLabel: string;
    onAction: () => void;
  };
}

function renderProgressBar(percent: number | null): HTMLElement {
  const wrap = el('div', 'models-progress');
  const bar = el('div', 'models-progress__fill');
  if (percent != null && percent > 0) {
    bar.style.width = `${Math.min(100, percent)}%`;
  } else {
    bar.classList.add('is-indeterminate');
  }
  wrap.appendChild(bar);
  return wrap;
}

let dialogSeq = 0;

function promptRuntimeInstall(spec: RuntimePromptSpec): Promise<boolean> {
  return new Promise((resolve) => {
    const titleId = `modelsRuntimeInstallTitle${(dialogSeq += 1)}`;
    const backdrop = el('div', 'models-dialog__backdrop');
    const dialog = el('div', 'models-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', titleId);

    const title = el('h2', 'models-dialog__title', spec.title);
    title.id = titleId;
    dialog.appendChild(title);

    const body = el('div', 'models-dialog__body');
    dialog.appendChild(body);

    const progressWrap = el('div', 'models-dialog__progress hidden');
    const progressBarHost = el('div');
    const progressLabel = el('p', 'models-dialog__progress-label', '');
    progressLabel.setAttribute('role', 'status');
    progressWrap.append(progressBarHost, progressLabel);
    dialog.appendChild(progressWrap);

    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(ok);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !primaryBtn.disabled) finish(false);
    };

    const actions = el('div', 'models-dialog__actions');
    const cancelBtn = textButton('Cancel', () => finish(false));
    const primaryBtn = textButton(spec.installLabel, () => {}, 'primary');
    actions.append(cancelBtn, primaryBtn);
    dialog.appendChild(actions);

    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
    document.addEventListener('keydown', onKey);
    primaryBtn.focus();

    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop && !primaryBtn.disabled) finish(false);
    });

    if (spec.unsupported) {
      for (const line of spec.unsupported.body) {
        body.appendChild(el('p', 'models-muted', line));
      }
      primaryBtn.textContent = spec.unsupported.actionLabel;
      primaryBtn.addEventListener('click', () => {
        spec.unsupported?.onAction();
        finish(false);
      });
      return;
    }

    for (const line of spec.body) {
      body.appendChild(el('p', 'models-muted', line));
    }

    primaryBtn.addEventListener('click', () => {
      if (primaryBtn.disabled) return;
      primaryBtn.disabled = true;
      cancelBtn.disabled = true;
      progressWrap.classList.remove('hidden');
      progressLabel.textContent = 'Starting install…';
      progressBarHost.replaceChildren(renderProgressBar(null));

      const onProgress: ProgressFn = (message, percent) => {
        progressLabel.textContent = message;
        progressBarHost.replaceChildren(renderProgressBar(percent));
      };

      void spec
        .install(onProgress)
        .then((ok) => finish(ok))
        .catch((err: unknown) => {
          progressLabel.textContent =
            err instanceof Error ? err.message : 'Runtime install failed';
          primaryBtn.disabled = false;
          cancelBtn.disabled = false;
        });
    });
  });
}

function openEngineSection(): void {
  void import('../models-page').then(({ openModels }) => openModels('engine'));
}

/** Resolves true when llama-server is available (already installed, or the user approved and the install succeeded), false when cancelled or failed. */
export async function ensureLlamaRuntimeInstalled(): Promise<boolean> {
  const runtime = await fetchLlamaRuntime();
  if (runtime.path) return true;
  if (runtime.engineId && runtime.engineId !== 'upstream') return promptForkNotReady(runtime);
  return promptLlamaInstall(runtime);
}

/** A fork is selected but has no binary; installing upstream would not help. */
function promptForkNotReady(runtime: LlamaRuntimeStatus): Promise<boolean> {
  return promptRuntimeInstall({
    title: `${runtime.engineLabel ?? 'The selected engine'} is not built`,
    body: [],
    installLabel: 'Install',
    install: async () => false,
    unsupported: {
      body: [
        runtime.engineReason ??
          'The selected llama.cpp engine has no binary yet. Build it, or switch back to upstream llama.cpp.',
      ],
      actionLabel: 'Open Engine settings',
      onAction: openEngineSection,
    },
  });
}

/** Ask before downloading the llama.cpp server binary. */
export function promptLlamaInstall(runtime: LlamaRuntimeStatus): Promise<boolean> {
  const variant = runtime.preferredVariant ?? 'cpu';

  if (!runtime.installable) {
    return promptRuntimeInstall({
      title: 'llama.cpp runtime required',
      body: [],
      installLabel: 'Install',
      install: async () => false,
      unsupported: {
        body: [
          'llama-server was not found, and Minnow has no prebuilt binary for this platform.',
          'Build or install llama.cpp yourself and put llama-server on your PATH, or run the model through Ollama or LM Studio instead.',
        ],
        actionLabel: 'Open Engine settings',
        onAction: openEngineSection,
      },
    });
  }

  return promptRuntimeInstall({
    title: 'llama.cpp runtime required',
    body: [
      `Loading GGUF weights needs the llama-server binary — about 20 MB, ${variant} build.`,
      'Download it now?',
    ],
    installLabel: 'Install',
    install: async (onProgress) => {
      const unsub = subscribeLlamaInstallProgress((job) => {
        onProgress(job.phase === 'failed' ? (job.error ?? job.message) : job.message || job.phase, job.percent);
      });
      try {
        const result = await installLlamaRuntime({ variant });
        return Boolean(result.path);
      } finally {
        unsub();
      }
    },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Drive the managed mlx-lm install and follow its job to completion. */
async function installMlxRuntime(onProgress: ProgressFn): Promise<boolean> {
  const kick = await installManagedServer('mlx-lm');
  if (!kick.ok) throw new Error(kick.error);
  if (kick.alreadyInstalled) return true;

  const deadline = Date.now() + MANAGED_INSTALL_TIMEOUT_MS;
  let missedPolls = 0;

  while (Date.now() < deadline) {
    await sleep(MANAGED_POLL_MS);
    const job = await fetchServerInstallStatus('mlx-lm');
    if (!job) {
      missedPolls += 1;
      if (missedPolls > 30) {
        throw new Error('Lost contact with the install job. Check Models → Engine.');
      }
      continue;
    }
    missedPolls = 0;
    if (job.phase === 'done') {
      onProgress('Installed', 100);
      return true;
    }
    if (job.phase === 'error') {
      throw new Error(job.error ?? job.message ?? 'MLX runtime install failed');
    }
    onProgress(job.message || 'Installing…', null);
  }

  throw new Error('The MLX runtime install timed out. Check Models → Engine.');
}

/** Resolves true when mlx-lm is ready to serve, false when the user cancelled, the install failed, or this machine cannot run MLX at all. */
export async function ensureMlxRuntimeInstalled(): Promise<boolean> {
  const runtimes = await fetchRuntimes();
  const mlx = runtimes.mlxLm;
  if (mlx?.installed) return true;

  if (!mlx?.installable) {
    return promptRuntimeInstall({
      title: 'MLX runtime required',
      body: [],
      installLabel: 'Install',
      install: async () => false,
      unsupported: {
        body: [
          'MLX runs only on Apple Silicon Macs. These weights cannot load on this machine.',
          'Use GGUF weights with llama.cpp instead — Discover lists the ones that fit this hardware.',
        ],
        actionLabel: 'Browse GGUF models',
        onAction: () => {
          void import('../models-page').then((m) => m.openModels('recommend'));
        },
      },
    });
  }

  return promptRuntimeInstall({
    title: 'MLX runtime required',
    body: [
      'MLX weights run through mlx-lm, a Python server Minnow installs and manages for you.',
      'This downloads a private Python runtime and the mlx-lm packages — a few hundred megabytes, and a good deal slower than the llama.cpp install. The Python runtime is shared with Minnow’s other managed servers, so it is only fetched once.',
      'Install it now?',
    ],
    installLabel: 'Install',
    install: installMlxRuntime,
  });
}

/** Ensure whatever runtime this row needs is installed, prompting if not. */
export async function ensureRuntimeForModel(model: LibraryModel): Promise<boolean> {
  if (model.source === 'ollama') return true;
  if (model.format === 'MLX') return ensureMlxRuntimeInstalled();
  return ensureLlamaRuntimeInstalled();
}
