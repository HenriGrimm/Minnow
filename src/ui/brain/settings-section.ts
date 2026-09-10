import { appAlert, appConfirm, appPrompt } from '../app-dialog';
/**
 * Brain app — Settings: synthesis, embeddings, and code index (config.brain.*).
 */

import {
  clearBrainCodeIndex,
  clearBrainProposals,
  clearBrainSources,
  clearBrainWiki,
  fetchBrainCodeConfig,
  fetchBrainCodeStatus,
  fetchBrainGitHookStatus,
  fetchBrainStatus,
  installBrainGitHook,
  saveBrainCodeConfig,
  uninstallBrainGitHook,
} from '../../brain/client';
import type { BrainCodeStatus } from '../../brain/types';
import {
  fetchMemoryEmbeddingsStatus,
  reindexMemoryEmbeddings,
  saveMemoryEmbeddingsConfig,
  warmupMemoryEmbeddings,
} from '../../memory/client';
import type { MemoryEmbeddingsConfig } from '../../memory/types';
import {
  fetchSynthesisConfig,
  saveSynthesisConfig,
} from '../../synthesis/client';
import { fillProviderSelect } from '../settings-model-binding';

type StatusFn = (kind: 'ok' | 'err' | 'spin', message: string) => void;

let bindingsDone = false;

const setStatus: StatusFn = (kind, message) => {
  const el = document.getElementById('brainSettingsStatus');
  if (!el) return;
  el.textContent = message;
  el.dataset.kind = kind;
};

function formatThrottleHint(pairs: number): string {
  if (pairs <= 1) return 'Runs after every completed user+assistant turn.';
  return `Runs after every ${pairs} completed user+assistant turns.`;
}

function formatBlendWeight(value: number): string {
  return `${Math.round(value * 100)}% vector`;
}

function readEmbeddingsForm(): Partial<MemoryEmbeddingsConfig> {
  const enabledEl = document.getElementById(
    'brainEmbeddingsEnabled',
  ) as HTMLInputElement | null;
  const backendEl = document.getElementById(
    'brainEmbeddingsBackend',
  ) as HTMLSelectElement | null;
  const modelEl = document.getElementById('brainEmbeddingsModel') as HTMLInputElement | null;
  const providerEl = document.getElementById(
    'brainEmbeddingsProvider',
  ) as HTMLSelectElement | null;
  const blendEl = document.getElementById('brainEmbeddingsBlend') as HTMLInputElement | null;

  return {
    enabled: enabledEl?.checked === true,
    backend: (backendEl?.value === 'provider' ? 'provider' : 'local') as 'local' | 'provider',
    modelId: modelEl?.value.trim() ?? '',
    providerId: providerEl?.value.trim() ?? '',
    blendWeight: Number(blendEl?.value ?? 0.5),
  };
}

function validateEmbeddingsForm(partial: Partial<MemoryEmbeddingsConfig>): string | null {
  if (!partial.enabled) return null;
  if (!partial.modelId?.trim()) {
    return 'Model id is required when semantic embeddings are enabled.';
  }
  if (partial.backend === 'provider' && !partial.providerId?.trim()) {
    return 'Select a provider when using provider embeddings.';
  }
  return null;
}

function validateDownloadForm(partial: Partial<MemoryEmbeddingsConfig>): string | null {
  if (partial.backend === 'provider') {
    if (!partial.enabled) {
      return 'Enable semantic embeddings before probing a provider backend.';
    }
    if (!partial.providerId?.trim()) {
      return 'Select a provider when using provider embeddings.';
    }
    if (!partial.modelId?.trim()) {
      return 'Model id is required when using provider embeddings.';
    }
    return null;
  }
  if (!partial.modelId?.trim()) {
    return 'Model id is required to download a local embedding model.';
  }
  return null;
}

function toggleDownloadButtonVisibility(): void {
  const backendEl = document.getElementById(
    'brainEmbeddingsBackend',
  ) as HTMLSelectElement | null;
  const downloadBtn = document.getElementById('brainEmbeddingsDownload');
  if (!downloadBtn || !backendEl) return;
  downloadBtn.classList.toggle('hidden', backendEl.value !== 'local');
}

function bindSettingsSection(): void {
  if (bindingsDone) return;
  bindingsDone = true;

  const throttleEl = document.getElementById(
    'brainSynthesisThrottle',
  ) as HTMLInputElement | null;
  throttleEl?.addEventListener('input', () => {
    const hint = document.getElementById('brainSynthesisThrottleHint');
    if (hint && throttleEl) {
      hint.textContent = formatThrottleHint(
        Math.max(1, Math.round(Number(throttleEl.value) || 1)),
      );
    }
  });

  document.getElementById('brainSynthesisSave')?.addEventListener('click', () => {
    void (async () => {
      const enabledEl = document.getElementById(
        'brainSynthesisEnabled',
      ) as HTMLInputElement | null;
      const throttle = Number(throttleEl?.value ?? 4);
      if (!Number.isFinite(throttle) || throttle < 1) {
        setStatus('err', 'Throttle must be at least 1 message pair');
        return;
      }
      const autoWrite = readNumberField('brainSynthesisAutoWrite', 0.85);
      if (autoWrite < 0 || autoWrite > 1) {
        setStatus('err', 'Auto-write confidence must be between 0 and 1');
        return;
      }

      const includeBoardsEl = document.getElementById(
        'brainSynthesisIncludeBoards',
      ) as HTMLInputElement | null;

      const saved = await saveSynthesisConfig({
        enabled: enabledEl?.checked === true,
        throttleMessagePairs: Math.round(throttle),
        autoWriteConfidence: autoWrite,
        includeBoardChats: includeBoardsEl?.checked === true,
        skillMinRounds: Math.round(readNumberField('brainSkillMinRounds', 2)),
        skillMinToolCalls: Math.round(readNumberField('brainSkillMinToolCalls', 2)),
        skillMinOccurrences: Math.round(readNumberField('brainSkillMinOccurrences', 2)),
      });
      setStatus(saved ? 'ok' : 'err', saved ? 'Synthesis settings saved' : 'Save failed');
      if (saved) await refreshSynthesisFields();
    })();
  });

  const blendEl = document.getElementById('brainEmbeddingsBlend') as HTMLInputElement | null;
  blendEl?.addEventListener('input', () => {
    const label = document.getElementById('brainEmbeddingsBlendLabel');
    if (label && blendEl) {
      label.textContent = `${Math.round(Number(blendEl.value) * 100)}% vector`;
    }
  });

  document.getElementById('brainEmbeddingsBackend')?.addEventListener('change', () => {
    toggleProviderRow();
    toggleDownloadButtonVisibility();
  });
  document.getElementById('brainEmbeddingsEnabled')?.addEventListener('change', () => {
    toggleProviderRow();
    toggleDownloadButtonVisibility();
  });

  document.getElementById('brainEmbeddingsSave')?.addEventListener('click', () => {
    void (async () => {
      const partial = readEmbeddingsForm();
      const validationError = validateEmbeddingsForm(partial);
      if (validationError) {
        setStatus('err', validationError);
        return;
      }
      const saved = await saveMemoryEmbeddingsConfig(partial);
      setStatus(saved.kind === 'ok' ? 'ok' : 'err', saved.kind === 'ok' ? 'Embeddings settings saved' : saved.error);
      if (saved.kind === 'ok') await refreshEmbeddingsFields();
    })();
  });

  document.getElementById('brainEmbeddingsDownload')?.addEventListener('click', () => {
    const downloadBtn = document.getElementById('brainEmbeddingsDownload') as HTMLButtonElement | null;
    void (async () => {
      downloadBtn?.setAttribute('disabled', 'true');
      try {
        const partial = readEmbeddingsForm();
        const validationError = validateDownloadForm(partial);
        if (validationError) {
          setStatus('err', validationError);
          return;
        }

        setStatus('spin', 'Saving settings…');
        const saved = await saveMemoryEmbeddingsConfig(partial);
        if (saved.kind === 'err') {
          setStatus('err', saved.error);
          return;
        }

        setStatus('spin', 'Downloading embedding model…');
        const result = await warmupMemoryEmbeddings();
        if (result.kind === 'err') {
          setStatus('err', result.error);
          return;
        }
        const readyMsg = `Model ready: ${result.value.model} (${result.value.dim} dims, ${result.value.durationMs} ms)`;
        setStatus('ok', readyMsg);
        await refreshEmbeddingsFields();
      } finally {
        downloadBtn?.removeAttribute('disabled');
      }
    })();
  });

  document.getElementById('brainEmbeddingsReindex')?.addEventListener('click', () => {
    void (async () => {
      setStatus('spin', 'Reindexing vectors…');
      const partial = readEmbeddingsForm();
      const validationError = validateEmbeddingsForm(partial);
      if (validationError) {
        setStatus('err', validationError);
        return;
      }
      const saved = await saveMemoryEmbeddingsConfig(partial);
      if (saved.kind === 'err') {
        setStatus('err', saved.error);
        return;
      }
      const result = await reindexMemoryEmbeddings();
      setStatus(
        result.kind === 'ok' ? 'ok' : 'err',
        result.kind === 'ok' ? `Indexed ${result.value.indexed} pages` : result.error,
      );
      await refreshEmbeddingsFields();
    })();
  });

  document.getElementById('brainCodeGitHookInstall')?.addEventListener('click', () => {
    void (async () => {
      setStatus('spin', 'Installing git hook…');
      const result = await installBrainGitHook();
      if (!result) {
        setStatus('err', 'Git hook install failed — is Minnow running?');
        return;
      }
      if (result.error || result.installed === false) {
        setStatus('err', result.error ?? 'Git hook install failed');
        await refreshGitHookStatus();
        return;
      }
      setStatus(
        'ok',
        result.alreadyPresent
          ? 'Git hook already installed'
          : 'Git post-commit hook installed',
      );
      await refreshGitHookStatus();
    })();
  });

  document.getElementById('brainCodeGitHookUninstall')?.addEventListener('click', () => {
    void (async () => {
      setStatus('spin', 'Removing git hook…');
      const result = await uninstallBrainGitHook();
      setStatus(
        result?.removed ? 'ok' : 'err',
        result?.removed ? 'Git hook removed' : 'Git hook was not installed',
      );
      await refreshGitHookStatus();
    })();
  });

  document.getElementById('brainCodeSettingsSave')?.addEventListener('click', () => {
    void (async () => {
      const enabledEl = document.getElementById(
        'brainCodeEnabled',
      ) as HTMLInputElement | null;
      const includeEl = document.getElementById(
        'brainCodeIncludeGlobs',
      ) as HTMLTextAreaElement | null;
      const excludeEl = document.getElementById(
        'brainCodeExcludeGlobs',
      ) as HTMLTextAreaElement | null;
      const budgetEl = document.getElementById(
        'brainCodeTokenBudget',
      ) as HTMLInputElement | null;
      const injectionBudgetEl = document.getElementById(
        'brainCodeInjectionTokenBudget',
      ) as HTMLInputElement | null;
      const cadenceEl = document.getElementById(
        'brainCodeReindexCadence',
      ) as HTMLSelectElement | null;
      const embEl = document.getElementById(
        'brainCodeEmbeddingsEnabled',
      ) as HTMLInputElement | null;
      const scaffoldEl = document.getElementById(
        'brainCodeAutoScaffold',
      ) as HTMLInputElement | null;
      const budget = Number(budgetEl?.value ?? 1500);
      const injectionBudget = Number(injectionBudgetEl?.value ?? 10000);
      if (!Number.isFinite(budget) || budget < 200) {
        setStatus('err', 'Token budget must be at least 200');
        return;
      }
      if (budget > 128_000) {
        setStatus('err', 'Token budget cannot exceed 128000');
        return;
      }
      if (!Number.isFinite(injectionBudget) || injectionBudget < 200) {
        setStatus('err', 'Injection token budget must be at least 200');
        return;
      }
      if (injectionBudget > 128_000) {
        setStatus('err', 'Injection token budget cannot exceed 128000');
        return;
      }
      const parseLines = (raw: string) =>
        raw
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
      const saved = await saveBrainCodeConfig({
        enabled: enabledEl?.checked === true,
        includeGlobs: parseLines(includeEl?.value ?? ''),
        excludeGlobs: parseLines(excludeEl?.value ?? ''),
        repoMapTokenBudget: Math.round(budget),
        repoMapInjectionTokenBudget: Math.round(injectionBudget),
        reindexCadence:
          cadenceEl?.value === 'on-switch' || cadenceEl?.value === 'git-hook'
            ? cadenceEl.value
            : 'on-demand',
        codeEmbeddingsEnabled: embEl?.checked === true,
        autoScaffoldIndexConfig: scaffoldEl?.checked !== false,
      });
      setStatus(saved ? 'ok' : 'err', saved ? 'Code index settings saved' : 'Save failed');
      if (saved) await refreshCodeSettingsFields();
    })();
  });

  document.getElementById('brainDangerClearWiki')?.addEventListener('click', () => {
    void (async () => {
      const backupEl = document.getElementById(
        'brainDangerWikiBackup',
      ) as HTMLInputElement | null;
      const archive = backupEl?.checked === true;
      const ok = await appConfirm(
        `Clear every wiki page${archive ? ' (after backup)' : ''}? This cannot be undone.`,
      );
      if (!ok) return;
      setStatus('spin', 'Clearing wiki…');
      const result = await clearBrainWiki(archive);
      if (!result.ok) {
        setStatus('err', result.error ?? 'Clear failed');
        return;
      }
      const backupNote = result.archivePath ? ` Backup: ${result.archivePath}` : '';
      setStatus('ok', `Cleared ${result.removed ?? 0} page(s).${backupNote}`);
      await Promise.all([refreshBrainStatusLine(), refreshCodeSettingsFields()]);
    })();
  });

  document.getElementById('brainDangerClearProposals')?.addEventListener('click', () => {
    void (async () => {
      const ok = await appConfirm('Clear all pending memory and skill proposals?');
      if (!ok) return;
      setStatus('spin', 'Clearing proposals…');
      const result = await clearBrainProposals('pending');
      setStatus(
        result.ok ? 'ok' : 'err',
        result.ok
          ? `Cleared ${result.removed ?? 0} proposal(s).`
          : (result.error ?? 'Clear failed'),
      );
    })();
  });

  document.getElementById('brainDangerClearSources')?.addEventListener('click', () => {
    void (async () => {
      const backupEl = document.getElementById(
        'brainDangerSourcesBackup',
      ) as HTMLInputElement | null;
      const archive = backupEl?.checked === true;
      const ok = await appConfirm(
        `Delete all raw ingest source files${archive ? ' (after backup)' : ''}? Wiki pages are kept.`,
      );
      if (!ok) return;
      setStatus('spin', 'Clearing sources…');
      const result = await clearBrainSources(archive);
      if (!result.ok) {
        setStatus('err', result.error ?? 'Clear failed');
        return;
      }
      const backupNote = result.archivePath ? ` Backup: ${result.archivePath}` : '';
      setStatus('ok', `Cleared ${result.removed ?? 0} source file(s).${backupNote}`);
    })();
  });

  document.getElementById('brainDangerClearCode')?.addEventListener('click', () => {
    void (async () => {
      const ok = await appConfirm('Reset the code index for this workspace?');
      if (!ok) return;
      setStatus('spin', 'Resetting code index…');
      const result = await clearBrainCodeIndex();
      setStatus(
        result.ok ? 'ok' : 'err',
        result.ok
          ? `Reset code index (${result.removed ?? 0} database).`
          : (result.error ?? 'Reset failed'),
      );
      if (result.ok) await refreshCodeSettingsFields();
    })();
  });

  const clearAllConfirmEl = document.getElementById(
    'brainDangerClearCodeAllConfirm',
  ) as HTMLInputElement | null;
  const clearAllBtn = document.getElementById(
    'brainDangerClearCodeAll',
  ) as HTMLButtonElement | null;
  clearAllConfirmEl?.addEventListener('input', () => {
    if (clearAllBtn) {
      clearAllBtn.disabled = clearAllConfirmEl.value.trim() !== 'CLEAR';
    }
  });

  document.getElementById('brainDangerClearCodeAll')?.addEventListener('click', () => {
    void (async () => {
      const confirmEl = document.getElementById(
        'brainDangerClearCodeAllConfirm',
      ) as HTMLInputElement | null;
      if (confirmEl?.value.trim() !== 'CLEAR') {
        setStatus('err', 'Type CLEAR in the confirmation field first.');
        return;
      }
      const ok = await appConfirm('Reset code indexes for every workspace?');
      if (!ok) return;
      setStatus('spin', 'Resetting all code indexes…');
      const result = await clearBrainCodeIndex({ all: true });
      if (!result.ok) {
        setStatus('err', result.error ?? 'Reset failed');
        return;
      }
      if (confirmEl) confirmEl.value = '';
      if (clearAllBtn) clearAllBtn.disabled = true;
      setStatus('ok', `Reset ${result.removed ?? 0} code index database(s).`);
      await refreshCodeSettingsFields();
    })();
  });
}

function toggleProviderRow(): void {
  const backendEl = document.getElementById('brainEmbeddingsBackend') as HTMLSelectElement | null;
  const row = document.getElementById('brainEmbeddingsProviderRow');
  if (!row || !backendEl) return;
  row.classList.toggle('hidden', backendEl.value !== 'provider');
}

async function refreshSynthesisFields(): Promise<void> {
  const offlineEl = document.getElementById('brainSynthesisOffline');
  const enabledEl = document.getElementById('brainSynthesisEnabled') as HTMLInputElement | null;
  const includeBoardsEl = document.getElementById(
    'brainSynthesisIncludeBoards',
  ) as HTMLInputElement | null;
  const throttleEl = document.getElementById('brainSynthesisThrottle') as HTMLInputElement | null;
  const hint = document.getElementById('brainSynthesisThrottleHint');
  const config = await fetchSynthesisConfig();
  offlineEl?.classList.toggle('hidden', config !== null);
  if (!config) return;
  if (enabledEl && !enabledEl.matches(':focus')) {
    enabledEl.checked = config.enabled !== false;
  }
  if (includeBoardsEl && !includeBoardsEl.matches(':focus')) {
    includeBoardsEl.checked = config.includeBoardChats === true;
  }
  if (throttleEl && !throttleEl.matches(':focus')) {
    throttleEl.value = String(config.throttleMessagePairs ?? 4);
  }
  if (hint && throttleEl) {
    hint.textContent = formatThrottleHint(
      Math.max(1, Math.round(Number(throttleEl.value) || 1)),
    );
  }

  setNumberField('brainSynthesisAutoWrite', config.autoWriteConfidence, 0.85);
  setNumberField('brainSkillMinRounds', config.skillMinRounds, 2);
  setNumberField('brainSkillMinToolCalls', config.skillMinToolCalls, 2);
  setNumberField('brainSkillMinOccurrences', config.skillMinOccurrences, 2);
}

/** Write a config value into a number input, leaving a focused field alone. */
function setNumberField(id: string, value: unknown, fallback: number): void {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (!el || el.matches(':focus')) return;
  el.value = String(typeof value === 'number' && Number.isFinite(value) ? value : fallback);
}

/** Read a number input, falling back when it's missing or unparseable. */
function readNumberField(id: string, fallback: number): number {
  const el = document.getElementById(id) as HTMLInputElement | null;
  const value = Number(el?.value);
  return Number.isFinite(value) ? value : fallback;
}

async function refreshEmbeddingsFields(): Promise<void> {
  const offlineEl = document.getElementById('brainEmbeddingsOffline');
  const statusEl = document.getElementById('brainEmbeddingsStatus');
  const enabledEl = document.getElementById('brainEmbeddingsEnabled') as HTMLInputElement | null;
  const backendEl = document.getElementById('brainEmbeddingsBackend') as HTMLSelectElement | null;
  const modelEl = document.getElementById('brainEmbeddingsModel') as HTMLInputElement | null;
  const providerEl = document.getElementById('brainEmbeddingsProvider') as HTMLSelectElement | null;
  const blendEl = document.getElementById('brainEmbeddingsBlend') as HTMLInputElement | null;
  const label = document.getElementById('brainEmbeddingsBlendLabel');
  const badge = document.getElementById('brainEmbeddingsReindexBadge');

  const status = await fetchMemoryEmbeddingsStatus();
  offlineEl?.classList.toggle('hidden', status !== null);
  if (!status) {
    if (statusEl) statusEl.textContent = 'Embeddings unavailable.';
    if (modelEl && !modelEl.value.trim()) {
      modelEl.value = 'Xenova/all-MiniLM-L6-v2';
    }
    return;
  }

  if (statusEl) {
    if (!status.enabled) {
      statusEl.textContent = 'Semantic retrieval off. Matching uses keywords only on send.';
    } else {
      const pageHint =
        typeof status.pageCount === 'number' && status.pageCount > 0
          ? ` · ${status.pageCount} wiki pages`
          : '';
      statusEl.textContent = `${status.vectorCount} vectors indexed${pageHint} · dim ${status.dim} · model ${status.model} · ${status.healthy ? 'healthy' : 'needs reindex'}`;
    }
  }
  badge?.classList.toggle('hidden', !status.reindexNeeded);

  if (enabledEl && !enabledEl.matches(':focus')) enabledEl.checked = status.enabled;
  if (backendEl && !backendEl.matches(':focus')) {
    backendEl.value = status.backend === 'provider' ? 'provider' : 'local';
  }
  if (modelEl && !modelEl.matches(':focus')) modelEl.value = status.model ?? '';
  if (providerEl && !providerEl.matches(':focus')) {
    await fillProviderSelect(providerEl, status.providerId ?? '');
    if (status.providerId && providerEl.value !== status.providerId) {
      const missing = document.createElement('option');
      missing.value = status.providerId;
      missing.textContent = `${status.providerId} (missing)`;
      providerEl.appendChild(missing);
      providerEl.value = status.providerId;
    }
  }
  if (blendEl && !blendEl.matches(':focus')) blendEl.value = String(status.blendWeight ?? 0.5);
  if (label && blendEl) {
    label.textContent = formatBlendWeight(Number(blendEl.value));
  }
  toggleProviderRow();
  toggleDownloadButtonVisibility();
}

function formatCodeSettingsLine(status: BrainCodeStatus): string {
  const when = status.lastIndexedAt
    ? new Date(status.lastIndexedAt).toLocaleString()
    : 'never';
  return `${status.repo} · ${status.symbolCount} symbols · last indexed ${when}`;
}

function globsToText(globs: string[]): string {
  return globs.join('\n');
}

async function refreshGitHookStatus(): Promise<void> {
  const el = document.getElementById('brainCodeGitHookStatus');
  const installBtn = document.getElementById('brainCodeGitHookInstall') as HTMLButtonElement | null;
  if (!el) return;
  const status = await fetchBrainGitHookStatus();
  if (!status) {
    el.textContent = 'Hook status unavailable.';
    if (installBtn) installBtn.disabled = false;
    return;
  }
  if (status.isGitRepo === false) {
    el.textContent = 'Workspace is not a git repository — initialize git or switch workspace.';
    if (installBtn) installBtn.disabled = true;
    return;
  }
  if (installBtn) installBtn.disabled = false;
  el.textContent = status.installed
    ? `Post-commit hook installed at ${status.hookPath}`
    : 'Post-commit hook not installed';
}

async function refreshCodeSettingsFields(): Promise<void> {
  const offlineEl = document.getElementById('brainCodeSettingsOffline');
  const statusEl = document.getElementById('brainCodeSettingsStatus');
  const enabledEl = document.getElementById('brainCodeEnabled') as HTMLInputElement | null;
  const includeEl = document.getElementById('brainCodeIncludeGlobs') as HTMLTextAreaElement | null;
  const excludeEl = document.getElementById('brainCodeExcludeGlobs') as HTMLTextAreaElement | null;
  const budgetEl = document.getElementById('brainCodeTokenBudget') as HTMLInputElement | null;
  const injectionBudgetEl = document.getElementById(
    'brainCodeInjectionTokenBudget',
  ) as HTMLInputElement | null;
  const cadenceEl = document.getElementById('brainCodeReindexCadence') as HTMLSelectElement | null;
  const embEl = document.getElementById('brainCodeEmbeddingsEnabled') as HTMLInputElement | null;
  const scaffoldEl = document.getElementById('brainCodeAutoScaffold') as HTMLInputElement | null;

  const [config, status] = await Promise.all([
    fetchBrainCodeConfig(),
    fetchBrainCodeStatus(),
  ]);
  offlineEl?.classList.toggle('hidden', config !== null);

  if (statusEl) {
    statusEl.textContent = status
      ? formatCodeSettingsLine(status)
      : 'Code index unavailable.';
  }

  if (!config) return;

  if (enabledEl && !enabledEl.matches(':focus')) enabledEl.checked = config.enabled;
  if (includeEl && !includeEl.matches(':focus')) {
    includeEl.value = globsToText(config.includeGlobs);
  }
  if (excludeEl && !excludeEl.matches(':focus')) {
    excludeEl.value = globsToText(config.excludeGlobs);
  }
  if (budgetEl && !budgetEl.matches(':focus')) {
    budgetEl.value = String(config.repoMapTokenBudget);
  }
  if (injectionBudgetEl && !injectionBudgetEl.matches(':focus')) {
    injectionBudgetEl.value = String(
      config.repoMapInjectionTokenBudget ?? config.repoMapTokenBudget,
    );
  }
  if (cadenceEl && !cadenceEl.matches(':focus')) {
    cadenceEl.value = config.reindexCadence;
  }
  if (embEl && !embEl.matches(':focus')) {
    embEl.checked = config.codeEmbeddingsEnabled;
  }
  if (scaffoldEl && !scaffoldEl.matches(':focus')) {
    scaffoldEl.checked = config.autoScaffoldIndexConfig !== false;
  }
  await refreshGitHookStatus();
}

async function refreshBrainStatusLine(): Promise<void> {
  const line = document.getElementById('brainSettingsStatusLine');
  if (!line) return;
  const status = await fetchBrainStatus();
  if (!status) {
    line.textContent = 'Offline — open Minnow.';
    return;
  }
  line.textContent = `${status.enabled ? 'Wiki enabled' : 'Wiki disabled'} · ${status.pageCount} pages`;
}

/** Load Brain settings fields from the server. */
export async function renderSettingsSection(): Promise<void> {
  bindSettingsSection();
  await Promise.all([
    refreshBrainStatusLine(),
    refreshSynthesisFields(),
    refreshEmbeddingsFields(),
    refreshCodeSettingsFields(),
  ]);
}
