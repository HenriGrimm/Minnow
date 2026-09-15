import '../../styles/settings-general.css';
import '../../styles/settings-voice.css';

import { loadVoiceMeta, saveVoiceMeta, type VoiceConfig, type VoiceTtsLocalConfig } from '../../config/voice-meta';
import { fetchHardware } from '../../models/hardware-client';
import type { HardwareSnapshot } from '../../models/types';
import { fillProviderSelect } from '../settings-model-binding';
import { setStatus } from '../status';
import { STT_CATALOG, findSttCatalogEntry } from '../../voice/catalog-stt';
import { recordedBlobToWav } from '../../voice/recorded-audio';
import { connectMicAnalyser, watchSilence } from '../../voice/silence-detector';
import { TTS_CATALOG, findTtsCatalogEntry } from '../../voice/catalog-tts';
import {
  cancelVoiceDownload,
  deleteVoiceModel,
  downloadVoiceModel,
  fetchRuntimeStatus,
  installRuntime,
  listClonePrompts,
  listInstalledVoiceModels,
  repairRuntime,
  startVoiceWorker,
  stopVoiceWorker,
  subscribeDownloadProgress,
  subscribeInstallProgress,
  uploadRefAudio,
  type InstalledVoiceManifest,
  type VoiceClonePrompt,
  type VoiceDownloadJob,
  type VoiceRuntimeHealth,
  type VoiceRuntimeStatus,
} from '../../voice/api-client';
import {
  fillSttProviderPanel,
  fillTtsBrowserPanel,
  fillTtsProviderPanel,
  getTtsRefAudioUpload,
  readSttLocalFromForm,
  readSttProviderFromForm,
  readTtsBrowserFromForm,
  readTtsLocalFromForm,
  readTtsProviderFromForm,
  renderSttSettingsForm,
  renderTtsSettingsForm,
  setSttBackendUi,
  setTtsBackendUi,
} from '../../voice/settings-form';
import { analyzeSttFit, analyzeTtsFit, VOICE_FIT_BADGE_CLASS } from '../../voice/voice-fit';
import { fetchSttStatus, fetchTtsStatus, synthesizeSpeech } from '../voice-controls';
import { createSettingsActionsRow } from '../settings-controls';
import { appendSettingsCrosslinks, appendSettingsGroup } from '../settings-layout';

type VoiceSubSection = 'stt' | 'tts';

let mounted = false;
let activeSub: VoiceSubSection = 'stt';
let runtimeStatus: VoiceRuntimeStatus | null = null;
let installUnsub: (() => void) | null = null;
let hardware: HardwareSnapshot | null = null;
let installedManifest: InstalledVoiceManifest | null = null;
let voiceConfig: VoiceConfig | null = null;
let sttBackend: 'builtin' | 'local' | 'provider' = 'local';
let ttsBackend: 'local' | 'provider' | 'browser' = 'local';
let clonePrompts: VoiceClonePrompt[] = [];
const downloadUnsubs = new Map<string, () => void>();
const activeDownloads = new Map<string, VoiceDownloadJob>();

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function voiceActionButton(label: string, variant?: 'primary'): HTMLButtonElement {
  const btn = el(
    'button',
    variant === 'primary'
      ? 'settings-action-btn settings-action-btn--primary'
      : 'settings-action-btn',
    label,
  );
  btn.type = 'button';
  return btn;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function setActiveSubSection(sub: VoiceSubSection): void {
  activeSub = sub;
  document.getElementById('modelsVoiceSttPanel')?.toggleAttribute('hidden', sub !== 'stt');
  document.getElementById('modelsVoiceTtsPanel')?.toggleAttribute('hidden', sub !== 'tts');
  for (const id of ['stt', 'tts'] as const) {
    const tab = document.querySelector(`[data-voice-subnav="${id}"]`);
    const selected = id === sub;
    tab?.setAttribute('aria-selected', selected ? 'true' : 'false');
    tab?.classList.toggle('is-active', selected);
  }
}

function healthLabel(health: VoiceRuntimeHealth): string {
  switch (health) {
    case 'ready':
      return 'Ready';
    case 'installing':
      return 'Installing…';
    case 'starting':
      return 'Starting…';
    case 'stopped':
      return 'Stopped';
    case 'error':
      return 'Error';
    default:
      return 'Not installed';
  }
}

function runtimeHealthDotClass(health: VoiceRuntimeHealth): string {
  switch (health) {
    case 'ready':
      return 'settings-voice-runtime__dot--ready';
    case 'installing':
    case 'starting':
      return 'settings-voice-runtime__dot--busy';
    case 'error':
      return 'settings-voice-runtime__dot--error';
    case 'stopped':
      return 'settings-voice-runtime__dot--stopped';
    default:
      return 'settings-voice-runtime__dot--idle';
  }
}

function runtimeUsesCuda(): boolean {
  if (runtimeStatus?.cudaAvailable) return true;
  if (runtimeStatus?.torchVariant === 'cuda') return true;
  const packages = runtimeStatus?.installedPackages ?? [];
  if (packages.some((label) => /cuda/i.test(label))) return true;
  if (hardware?.backend === 'cuda' && runtimeStatus?.installed) {
    return !packages.some((label) => label.includes('torch (CPU)'));
  }
  return false;
}

function updateRuntimeCardUi(): void {
  const card = document.getElementById('modelsVoiceRuntime');
  if (!card || !runtimeStatus) return;

  const dotEl = card.querySelector('.settings-voice-runtime__dot');
  const statusEl = card.querySelector('.settings-voice-runtime__status');
  const detailEl = card.querySelector('.settings-voice-runtime__detail');
  const progressEl = card.querySelector('.settings-voice-runtime__progress');
  const installBtn = card.querySelector('[data-voice-action="install"]') as HTMLButtonElement | null;
  const repairBtn = card.querySelector('[data-voice-action="repair"]') as HTMLButtonElement | null;
  const startBtn = card.querySelector('[data-voice-action="start"]') as HTMLButtonElement | null;
  const stopBtn = card.querySelector('[data-voice-action="stop"]') as HTMLButtonElement | null;

  if (dotEl) {
    dotEl.className = `settings-voice-runtime__dot ${runtimeHealthDotClass(runtimeStatus.health)}`;
  }

  if (statusEl) {
    statusEl.textContent = healthLabel(runtimeStatus.health);
  }

  if (detailEl) {
    const parts: string[] = [];
    parts.push(runtimeUsesCuda() ? 'CUDA' : 'CPU');
    if (runtimeStatus.running && runtimeStatus.port) {
      parts.push(`127.0.0.1:${runtimeStatus.port}`);
    }
    if (runtimeStatus.installJob?.message && runtimeStatus.health === 'installing') {
      parts.push(runtimeStatus.installJob.message);
    }
    detailEl.textContent = parts.join(' · ');
  }

  if (progressEl) {
    const job = runtimeStatus.installJob;
    const bar = progressEl.querySelector('.models-download-progress__bar') as HTMLElement | null;
    const label = progressEl.querySelector('.models-download-progress__label');
    if (job?.phase === 'installing') {
      if (bar) bar.style.width = `${job.percent}%`;
      if (label) label.textContent = `${job.percent}% · ${job.message}`;
      progressEl.classList.remove('is-hidden');
    } else if (job?.phase === 'failed' && job.error) {
      if (bar) bar.style.width = '0%';
      if (label) label.textContent = job.error;
      progressEl.classList.remove('is-hidden');
    } else {
      progressEl.classList.add('is-hidden');
    }
  }

  const installing = runtimeStatus.health === 'installing';
  const installed = runtimeStatus.installed;
  const running = runtimeStatus.running;

  if (installBtn) {
    installBtn.disabled = installing || installed;
    installBtn.hidden = installed;
  }
  if (repairBtn) {
    repairBtn.disabled = installing;
    repairBtn.hidden = !installed;
  }
  if (startBtn) startBtn.disabled = installing || !installed || running;
  if (stopBtn) stopBtn.disabled = installing || !running;
}

async function refreshRuntimeStatus(): Promise<void> {
  try {
    runtimeStatus = await fetchRuntimeStatus();
    updateRuntimeCardUi();
    if (runtimeStatus.running) {
      await Promise.all([fetchSttStatus(), fetchTtsStatus()]);
    }
  } catch {
    runtimeStatus = {
      installed: false,
      running: false,
      health: 'error',
      cudaAvailable: hardware?.backend === 'cuda',
      torchVariant: hardware?.backend === 'cuda' ? 'cuda' : null,
      port: null,
      installedAt: null,
      installedPackages: [],
      skippedPackages: [],
      installJob: null,
      worker: { ok: false, status: 'error' },
    };
    updateRuntimeCardUi();
  }
}

function beginInstallProgressStream(): void {
  installUnsub?.();
  installUnsub = subscribeInstallProgress((event) => {
    if (!runtimeStatus) return;
    runtimeStatus = {
      ...runtimeStatus,
      health: event.phase === 'installing' ? 'installing' : runtimeStatus.health,
      installJob: event,
    };
    updateRuntimeCardUi();
    if (event.phase === 'completed' || event.phase === 'failed') {
      installUnsub?.();
      installUnsub = null;
      void refreshRuntimeStatus();
    }
  });
}

function renderRuntimeCard(mount: HTMLElement): void {
  const card = el('div', 'settings-voice-runtime');
  card.id = 'modelsVoiceRuntime';
  card.dataset.settingsSearchKey = 'models.voice.runtime';

  const statusRow = el('div', 'settings-voice-runtime__status-row');
  statusRow.append(
    el('span', 'settings-voice-runtime__dot settings-voice-runtime__dot--idle'),
    el('span', 'settings-voice-runtime__label', 'Worker status'),
    el('span', 'settings-voice-runtime__status', 'Not installed'),
  );
  card.appendChild(statusRow);
  card.appendChild(
    el('p', 'settings-voice-runtime__detail', 'Whisper STT and Qwen3-TTS worker'),
  );

  const progressWrap = el('div', 'settings-voice-runtime__progress is-hidden');
  const progress = el('div', 'models-download-progress');
  const bar = el('div', 'models-download-progress__bar');
  bar.style.width = '0%';
  progress.append(bar, el('span', 'models-download-progress__label', ''));
  progressWrap.appendChild(progress);
  card.appendChild(progressWrap);

  card.appendChild(
    createSettingsActionsRow(
      [
        {
          label: 'Install',
          variant: 'primary',
          dataset: { voiceAction: 'install' },
          onClick: () => {
            void (async () => {
              beginInstallProgressStream();
              await installRuntime();
              await refreshRuntimeStatus();
            })();
          },
        },
        {
          label: 'Repair',
          dataset: { voiceAction: 'repair' },
          onClick: () => {
            void (async () => {
              beginInstallProgressStream();
              await repairRuntime();
              await refreshRuntimeStatus();
            })();
          },
        },
        {
          label: 'Start',
          dataset: { voiceAction: 'start' },
          onClick: () => {
            void (async () => {
              await startVoiceWorker();
              await refreshRuntimeStatus();
            })();
          },
        },
        {
          label: 'Stop',
          dataset: { voiceAction: 'stop' },
          onClick: () => {
            void (async () => {
              await stopVoiceWorker();
              await refreshRuntimeStatus();
            })();
          },
        },
      ],
      { searchKey: 'models.voice.runtime.actions' },
    ),
  );

  mount.appendChild(card);
}

function isModelInstalled(modelId: string, kind: 'stt' | 'tts' = 'stt'): boolean {
  const list = kind === 'stt' ? installedManifest?.stt : installedManifest?.tts;
  return list?.some((row) => row.modelId === modelId) ?? false;
}

function ensureDownloadSubscription(job: VoiceDownloadJob): void {
  if (downloadUnsubs.has(job.id)) return;
  if (job.status !== 'queued' && job.status !== 'running') return;
  const unsub = subscribeDownloadProgress(job.id, (event) => {
    const current = activeDownloads.get(job.id);
    if (current) {
      activeDownloads.set(job.id, {
        ...current,
        status: event.status,
        bytesReceived: event.bytesReceived,
        totalBytes: event.totalBytes,
        error: event.error ?? null,
      });
    }
    void refreshVoicePanelUi();
    if (event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled') {
      downloadUnsubs.get(job.id)?.();
      downloadUnsubs.delete(job.id);
      void refreshInstalledManifest();
    }
  });
  downloadUnsubs.set(job.id, unsub);
}

function renderDownloadProgress(job: VoiceDownloadJob): HTMLElement {
  const wrap = el('div', 'models-download-progress');
  const pct =
    job.totalBytes && job.totalBytes > 0
      ? Math.min(100, Math.round((job.bytesReceived / job.totalBytes) * 100))
      : null;
  const bar = el('div', 'models-download-progress__bar');
  bar.style.width = pct != null ? `${pct}%` : '30%';
  if (pct == null) bar.classList.add('is-indeterminate');
  wrap.appendChild(bar);
  wrap.appendChild(
    el(
      'span',
      'models-download-progress__label',
      pct != null
        ? `${pct}% · ${formatBytes(job.bytesReceived)} / ${formatBytes(job.totalBytes || 0)}`
        : `${formatBytes(job.bytesReceived)} · ${job.status}`,
    ),
  );
  return wrap;
}

function renderCatalogRowActions(
  row: HTMLElement,
  main: HTMLElement,
  entry: { modelId: string },
  kind: 'stt' | 'tts',
  installed: boolean,
): void {
  const actions = el('div', 'settings-voice-catalog-item__actions');
  const activeJob = [...activeDownloads.values()].find(
    (j) =>
      j.modelId === entry.modelId &&
      j.kind === kind &&
      (j.status === 'queued' || j.status === 'running'),
  );

  if (activeJob) {
    ensureDownloadSubscription(activeJob);
    const main = row.querySelector('.settings-voice-catalog-item__main');
    if (main) main.appendChild(renderDownloadProgress(activeJob));
    const cancelBtn = voiceActionButton('Cancel');
    cancelBtn.addEventListener('click', () => {
      void cancelVoiceDownload(activeJob.id).then(() => refreshVoicePanelUi());
    });
    actions.appendChild(cancelBtn);
  } else {
    const downloadBtn = voiceActionButton(installed ? 'Installed' : 'Download', installed ? undefined : 'primary');
    downloadBtn.disabled = installed;
    downloadBtn.addEventListener('click', () => {
      void (async () => {
        try {
          const job = await downloadVoiceModel(entry.modelId, kind);
          activeDownloads.set(job.id, job);
          ensureDownloadSubscription(job);
          await refreshVoicePanelUi();
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Download failed';
          setStatus('err', message);
        }
      })();
    });
    actions.appendChild(downloadBtn);
  }
  row.appendChild(actions);
}

function renderSttCatalogRow(entry: (typeof STT_CATALOG)[number]): HTMLElement {
  const row = el('li', 'settings-entity-list__item settings-voice-catalog-item');
  const fit = hardware ? analyzeSttFit(entry, hardware) : null;
  const main = el('div', 'settings-voice-catalog-item__main');
  const head = el('div', 'settings-voice-catalog-item__head');
  head.append(el('span', 'settings-voice-catalog-item__name', entry.label));
  if (fit) {
    head.append(
      el('span', `models-fit-badge ${VOICE_FIT_BADGE_CLASS[fit.fitLevel]}`, fit.label),
    );
  } else {
    head.append(el('span', 'models-fit-badge', `~${entry.estVramGb} GB VRAM`));
  }
  main.appendChild(head);
  main.appendChild(
    el('p', 'settings-voice-catalog-item__meta', `${entry.modelId} · ${entry.params}`),
  );
  row.appendChild(main);

  const installed = isModelInstalled(entry.modelId, 'stt');
  renderCatalogRowActions(row, main, entry, 'stt', installed);
  return row;
}

function renderInstalledList(): HTMLElement {
  const list = el('ul', 'settings-entity-list');
  const rows = installedManifest?.stt ?? [];
  if (!rows.length) {
    return el('p', 'settings-field-hint', 'No Whisper models downloaded yet.');
  }
  for (const row of rows) {
    const item = el('li', 'settings-entity-list__item settings-voice-catalog-item');
    const main = el('div', 'settings-voice-catalog-item__main');
    const head = el('div', 'settings-voice-catalog-item__head');
    head.append(el('span', 'settings-voice-catalog-item__name', row.modelId));
    if (row.sizeBytes) {
      head.append(el('span', 'models-fit-badge', formatBytes(row.sizeBytes)));
    }
    main.appendChild(head);
    item.appendChild(main);

    const actions = el('div', 'settings-voice-catalog-item__actions');
    const useBtn = voiceActionButton('Use', 'primary');
    useBtn.addEventListener('click', () => {
      void applySttModelSelection(row.modelId);
    });
    const delBtn = voiceActionButton('Delete');
    delBtn.addEventListener('click', () => {
      void deleteVoiceModel('stt', row.modelId).then(() => refreshInstalledManifest());
    });
    actions.append(useBtn, delBtn);
    item.appendChild(actions);
    list.appendChild(item);
  }
  return list;
}

async function applySttModelSelection(modelId: string): Promise<void> {
  const entry = findSttCatalogEntry(modelId);
  const current = voiceConfig ?? (await loadVoiceMeta());
  const local = {
    ...current.stt.local,
    modelId,
    ...(entry?.recommendedDefaults ?? {}),
  };
  const saved = await saveVoiceMeta({
    stt: { backend: 'local', local },
  });
  if (saved) {
    voiceConfig = saved;
    sttBackend = 'local';
    renderSttSettingsSection();
    setStatus('ok', `STT model set to ${modelId}`);
    await refreshActiveBackendSummary();
  }
}

function renderSttSettingsSection(): void {
  const shell = document.getElementById('modelsVoiceSttSettings');
  if (!shell || !voiceConfig) return;
  const catalogEntry = findSttCatalogEntry(voiceConfig.stt.local.modelId);
  renderSttSettingsForm({
    mount: shell,
    config: voiceConfig,
    catalogEntry,
    onBackendChange: (backend) => {
      sttBackend = backend;
      setSttBackendUi(backend);
    },
  });
  void fillProviderSelect(
    document.getElementById('voiceSttProviderId') as HTMLSelectElement,
    voiceConfig.stt.provider.providerId,
  ).then(() => fillSttProviderPanel(voiceConfig!));

  void (async () => {
    const hintId = 'modelsVoiceSttStreamingHint';
    document.getElementById(hintId)?.remove();
    if (voiceConfig!.stt.backend !== 'local') return;
    const status = await fetchSttStatus();
    const shellEl = document.getElementById('modelsVoiceSttSettings');
    if (!shellEl) return;
    const hint = document.createElement('p');
    hint.id = hintId;
    hint.className = 'field-hint models-voice-streaming-hint';
    if (!status?.healthy) {
      hint.textContent =
        'Start the voice worker above for live dictation. The composer mic will try to start it automatically when you press the mic button.';
    } else if (status.streamingSupported) {
      hint.textContent = 'Live dictation is available — words appear in the composer while the mic is open.';
    } else if (voiceConfig!.stt.local.streamingEnabled === false) {
      hint.textContent = 'Live dictation is off — enable the checkbox above and save settings.';
    } else {
      hint.textContent = 'Live dictation requires local Whisper with the voice worker running.';
    }
    shellEl.appendChild(hint);
  })();
}

async function saveSttSettings(): Promise<void> {
  if (!voiceConfig) voiceConfig = await loadVoiceMeta();
  const local = readSttLocalFromForm(voiceConfig.stt.local);
  const provider = readSttProviderFromForm(voiceConfig);
  const saved = await saveVoiceMeta({
    stt: {
      enabled: true,
      backend: sttBackend,
      local,
      provider,
    },
  });
  if (!saved) {
    setStatus('err', 'Could not save STT settings. Open or restart Minnow.');
    return;
  }
  voiceConfig = saved;
  setStatus('ok', 'STT settings saved');
  await refreshActiveBackendSummary();
}

let micRecorder: MediaRecorder | null = null;
let micChunks: BlobPart[] = [];
let micStream: MediaStream | null = null;
let micTestSilenceStop: (() => void) | null = null;
let micTestAnalyserDisconnect: (() => void) | null = null;
let micTestMaxTimer: ReturnType<typeof setTimeout> | null = null;

const MIC_TEST_MAX_SECONDS = 30;

function clearMicTestMonitors(): void {
  micTestSilenceStop?.();
  micTestSilenceStop = null;
  micTestAnalyserDisconnect?.();
  micTestAnalyserDisconnect = null;
  if (micTestMaxTimer) {
    clearTimeout(micTestMaxTimer);
    micTestMaxTimer = null;
  }
}

async function runMicTest(): Promise<void> {
  const testBtn = document.getElementById('modelsVoiceSttTestMic') as HTMLButtonElement | null;
  const resultEl = document.getElementById('modelsVoiceSttTestResult');
  if (micRecorder?.state === 'recording') {
    micRecorder.stop();
    return;
  }

  try {
    const silenceTimeout =
      voiceConfig?.limits?.silenceTimeoutSeconds ??
      (await loadVoiceMeta()).limits.silenceTimeoutSeconds;

    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micChunks = [];
    micRecorder = new MediaRecorder(micStream);
    micRecorder.ondataavailable = (ev) => {
      if (ev.data.size) micChunks.push(ev.data);
    };
    micRecorder.onstop = () => {
      clearMicTestMonitors();
      for (const track of micStream?.getTracks() ?? []) track.stop();
      micStream = null;
      micRecorder = null;
      if (testBtn) {
        testBtn.textContent = 'Test mic';
        testBtn.disabled = false;
      }
      void (async () => {
        const blob = new Blob(micChunks, { type: 'audio/webm' });
        micChunks = [];
        if (!blob.size) {
          if (resultEl) resultEl.textContent = 'No audio captured.';
          return;
        }
        if (resultEl) resultEl.textContent = 'Transcribing…';
        try {
          const wavBlob = await recordedBlobToWav(blob);
          const form = new FormData();
          form.append('file', wavBlob, 'test.wav');
          const res = await fetch('/api/stt/transcribe', { method: 'POST', body: form });
          const data = (await res.json()) as { text?: string; error?: string };
          if (!res.ok) throw new Error(data.error || 'Transcription failed');
          if (resultEl) resultEl.textContent = data.text?.trim() || '(no speech detected)';
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Transcription failed';
          if (resultEl) resultEl.textContent = message;
        }
      })();
    };
    if (testBtn) {
      testBtn.textContent = 'Stop recording';
      testBtn.disabled = false;
    }
    if (resultEl) {
      resultEl.textContent =
        silenceTimeout > 0
          ? `Listening… pause for ${silenceTimeout}s to transcribe (or click Stop).`
          : 'Listening… click Stop when finished.';
    }
    micRecorder.start();

    if (silenceTimeout > 0 && micStream) {
      const { analyser, disconnect } = connectMicAnalyser(micStream);
      micTestAnalyserDisconnect = disconnect;
      micTestSilenceStop = watchSilence(analyser, {
        silenceTimeoutMs: Math.round(silenceTimeout * 1000),
        onSilenceTimeout: () => {
          if (micRecorder?.state === 'recording') {
            micRecorder.stop();
          }
        },
      });
    }

    micTestMaxTimer = setTimeout(() => {
      if (micRecorder?.state === 'recording') {
        micRecorder.stop();
        if (resultEl) resultEl.textContent = `Stopped after ${MIC_TEST_MAX_SECONDS}s limit.`;
      }
    }, MIC_TEST_MAX_SECONDS * 1000);
  } catch (err) {
    clearMicTestMonitors();
    const message = err instanceof Error ? err.message : 'Microphone access denied';
    if (resultEl) resultEl.textContent = message;
    if (testBtn) testBtn.disabled = false;
  }
}

function mountSttPanel(panel: HTMLElement): void {
  const summary = el('p', 'settings-voice-panel-summary');
  summary.id = 'modelsVoiceSttBackendSummary';
  panel.appendChild(summary);

  const catalogBody = appendSettingsGroup(
    panel,
    'Catalog',
    'Download a Whisper model sized for your GPU.',
    'models.voice.stt.catalog',
    { emphasis: true },
  );
  const catalogMount = el('ul', 'settings-entity-list');
  catalogMount.id = 'modelsVoiceSttCatalog';
  catalogBody.appendChild(catalogMount);

  const installedBody = appendSettingsGroup(
    panel,
    'Installed',
    undefined,
    'models.voice.stt.installed',
    { emphasis: true },
  );
  const installedMount = el('div');
  installedMount.id = 'modelsVoiceSttInstalledMount';
  installedBody.appendChild(installedMount);

  const configBody = appendSettingsGroup(
    panel,
    'Configuration',
    'Backend, decoding options, and provider overrides.',
    'models.voice.stt.config',
    { emphasis: true },
  );
  const settingsShell = el('div', 'settings-voice-form-shell');
  settingsShell.id = 'modelsVoiceSttSettings';
  configBody.appendChild(settingsShell);

  const benchBody = appendSettingsGroup(
    panel,
    'Test bench',
    'Save settings, then record a short clip to verify transcription.',
    'models.voice.stt.bench',
    { emphasis: true },
  );
  benchBody.appendChild(
    createSettingsActionsRow(
      [
        {
          label: 'Save settings',
          variant: 'primary',
          onClick: () => {
            void saveSttSettings();
          },
        },
        {
          label: 'Test mic',
          id: 'modelsVoiceSttTestMic',
          onClick: () => {
            void runMicTest();
          },
        },
      ],
      { searchKey: 'models.voice.stt.bench.actions' },
    ),
  );

  const resultEl = el('p', 'settings-voice-bench-result settings-field-hint', '');
  resultEl.id = 'modelsVoiceSttTestResult';
  benchBody.appendChild(resultEl);
}

function renderTtsCatalogRow(entry: (typeof TTS_CATALOG)[number]): HTMLElement {
  const row = el('li', 'settings-entity-list__item settings-voice-catalog-item');
  const fit = hardware ? analyzeTtsFit(entry, hardware) : null;
  const main = el('div', 'settings-voice-catalog-item__main');
  const head = el('div', 'settings-voice-catalog-item__head');
  head.append(el('span', 'settings-voice-catalog-item__name', entry.label));
  if (fit) {
    head.append(
      el('span', `models-fit-badge ${VOICE_FIT_BADGE_CLASS[fit.fitLevel]}`, fit.label),
    );
  } else {
    head.append(el('span', 'models-fit-badge', `~${entry.estVramGb} GB VRAM`));
  }
  main.appendChild(head);
  main.appendChild(
    el('p', 'settings-voice-catalog-item__meta', `${entry.modelId} · ${entry.params}`),
  );
  row.appendChild(main);

  const installed = isModelInstalled(entry.modelId, 'tts');
  renderCatalogRowActions(row, main, entry, 'tts', installed);
  return row;
}

function renderTtsInstalledList(): HTMLElement {
  const list = el('ul', 'settings-entity-list');
  const rows = (installedManifest?.tts ?? []).filter((row) => row.mode !== 'tokenizer');
  if (!rows.length) {
    return el('p', 'settings-field-hint', 'No Qwen3-TTS models downloaded yet.');
  }
  for (const row of rows) {
    const item = el('li', 'settings-entity-list__item settings-voice-catalog-item');
    const main = el('div', 'settings-voice-catalog-item__main');
    const head = el('div', 'settings-voice-catalog-item__head');
    head.append(el('span', 'settings-voice-catalog-item__name', row.modelId));
    if (row.sizeBytes) {
      head.append(el('span', 'models-fit-badge', formatBytes(row.sizeBytes)));
    }
    main.appendChild(head);
    item.appendChild(main);

    const actions = el('div', 'settings-voice-catalog-item__actions');
    const useBtn = voiceActionButton('Use', 'primary');
    useBtn.addEventListener('click', () => {
      void applyTtsModelSelection(row.modelId);
    });
    const delBtn = voiceActionButton('Delete');
    delBtn.addEventListener('click', () => {
      void deleteVoiceModel('tts', row.modelId).then(() => refreshInstalledManifest());
    });
    actions.append(useBtn, delBtn);
    item.appendChild(actions);
    list.appendChild(item);
  }
  return list;
}

async function applyTtsModelSelection(modelId: string): Promise<void> {
  const entry = findTtsCatalogEntry(modelId);
  const current = voiceConfig ?? (await loadVoiceMeta());
  const mode: VoiceConfig['tts']['local']['mode'] =
    entry?.mode === 'voice_design' || entry?.mode === 'voice_clone'
      ? entry.mode
      : 'custom_voice';
  const local = {
    ...current.tts.local,
    modelId,
    mode,
    ...(entry?.recommendedDefaults ?? {}),
    generation: {
      ...current.tts.local.generation,
      ...(entry?.recommendedDefaults?.generation ?? {}),
    },
  } satisfies VoiceTtsLocalConfig;
  const saved = await saveVoiceMeta({
    tts: { backend: 'local', local },
  });
  if (saved) {
    voiceConfig = saved;
    ttsBackend = 'local';
    await renderTtsSettingsSection();
    setStatus('ok', `TTS model set to ${modelId}`);
    await refreshActiveBackendSummary();
  }
}

async function renderTtsSettingsSection(): Promise<void> {
  const shell = document.getElementById('modelsVoiceTtsSettings');
  if (!shell || !voiceConfig) return;
  try {
    clonePrompts = await listClonePrompts();
  } catch {
    clonePrompts = [];
  }
  const catalogEntry = findTtsCatalogEntry(voiceConfig.tts.local.modelId);
  renderTtsSettingsForm({
    mount: shell,
    config: voiceConfig,
    catalogEntry,
    clonePrompts: clonePrompts.map((p) => ({ id: p.id, label: p.label })),
    onBackendChange: (backend) => {
      ttsBackend = backend;
      setTtsBackendUi(backend);
    },
  });
  fillTtsBrowserPanel(voiceConfig);
  await fillProviderSelect(
    document.getElementById('voiceTtsProviderId') as HTMLSelectElement,
    voiceConfig.tts.provider.providerId,
  );
  fillTtsProviderPanel(voiceConfig);
  void (async () => {
    const hintId = 'modelsVoiceTtsStreamingHint';
    document.getElementById(hintId)?.remove();
    if (voiceConfig!.tts.backend !== 'local') return;
    const status = await fetchTtsStatus();
    const shellEl = document.getElementById('modelsVoiceTtsSettings');
    if (!shellEl) return;
    const hint = document.createElement('p');
    hint.id = hintId;
    hint.className = 'field-hint models-voice-streaming-hint';
    if (!status?.healthy) {
      hint.textContent =
        'Start the voice worker above for read-aloud. Without it, message playback falls back to batch synthesis.';
    } else if (status.streamingSupported) {
      hint.textContent =
        'Streaming read-aloud is available — assistant messages play as PCM chunks arrive over WebSocket.';
    } else if (voiceConfig!.tts.streaming === false) {
      hint.textContent = 'Streaming read-aloud is off — enable the checkbox above and save settings.';
    } else {
      hint.textContent = 'Streaming read-aloud requires local Qwen TTS with the voice worker running.';
    }
    shellEl.appendChild(hint);
  })();
}

async function saveTtsSettings(): Promise<void> {
  if (!voiceConfig) voiceConfig = await loadVoiceMeta();
  let local = readTtsLocalFromForm(voiceConfig.tts.local);
  const refUpload = getTtsRefAudioUpload();
  if (refUpload) {
    try {
      const ref = await uploadRefAudio(refUpload);
      local = { ...local, voiceClone: { ...local.voiceClone, refAudioPath: ref.path } };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Reference upload failed';
      setStatus('err', message);
      return;
    }
  }
  const provider = readTtsProviderFromForm(voiceConfig);
  const browser = readTtsBrowserFromForm(voiceConfig);
  const streaming =
    (document.getElementById('voiceTtsStreaming') as HTMLInputElement | null)?.checked ??
    voiceConfig.tts.streaming;
  const saved = await saveVoiceMeta({
    tts: {
      enabled: true,
      backend: ttsBackend,
      streaming,
      local,
      provider,
      browser,
    },
  });
  if (!saved) {
    setStatus('err', 'Could not save TTS settings. Open or restart Minnow.');
    return;
  }
  voiceConfig = saved;
  setStatus('ok', 'TTS settings saved');
  await refreshActiveBackendSummary();
}

let ttsTestAudio: HTMLAudioElement | null = null;

async function runTtsVoiceTest(): Promise<void> {
  const resultEl = document.getElementById('modelsVoiceTtsTestResult');
  const sample =
    (document.getElementById('modelsVoiceTtsTestText') as HTMLInputElement | null)?.value?.trim() ||
    'Hello from Minnow voice.';
  if (resultEl) resultEl.textContent = 'Synthesizing…';

  try {
    if (ttsBackend === 'browser') {
      const { speakWithBrowser } = await import('../voice-controls');
      const browser = readTtsBrowserFromForm(voiceConfig ?? (await loadVoiceMeta()));
      speakWithBrowser(sample, browser.voiceUri, browser.rate, browser.pitch, browser.volume);
      if (resultEl) resultEl.textContent = 'Playing via browser speechSynthesis.';
      return;
    }

    await saveTtsSettings();
    const blob = await synthesizeSpeech(sample);
    if (ttsTestAudio) {
      ttsTestAudio.pause();
      ttsTestAudio.src = '';
    }
    const url = URL.createObjectURL(blob);
    ttsTestAudio = new Audio(url);
    const voiceMeta = voiceConfig ?? (await loadVoiceMeta());
    const sinkable = ttsTestAudio as HTMLAudioElement & {
      setSinkId?: (id: string) => Promise<void>;
    };
    if (voiceMeta.audio.outputDeviceId && typeof sinkable.setSinkId === 'function') {
      try {
        await sinkable.setSinkId(voiceMeta.audio.outputDeviceId);
      } catch {
      }
    }
    ttsTestAudio.onended = () => {
      URL.revokeObjectURL(url);
      if (resultEl) resultEl.textContent = 'Playback finished.';
    };
    await ttsTestAudio.play();
    if (resultEl) resultEl.textContent = 'Playing synthesized sample…';
  } catch (err) {
    const message = err instanceof Error ? err.message : 'TTS test failed';
    if (resultEl) resultEl.textContent = message;
  }
}

function mountTtsPanel(panel: HTMLElement): void {
  const summary = el('p', 'settings-voice-panel-summary');
  summary.id = 'modelsVoiceTtsBackendSummary';
  panel.appendChild(summary);

  const catalogBody = appendSettingsGroup(
    panel,
    'Catalog',
    'Download a Qwen3-TTS checkpoint for local read-aloud.',
    'models.voice.tts.catalog',
    { emphasis: true },
  );
  const catalogMount = el('ul', 'settings-entity-list');
  catalogMount.id = 'modelsVoiceTtsCatalog';
  catalogBody.appendChild(catalogMount);

  const installedBody = appendSettingsGroup(
    panel,
    'Installed',
    undefined,
    'models.voice.tts.installed',
    { emphasis: true },
  );
  const installedMount = el('div');
  installedMount.id = 'modelsVoiceTtsInstalledMount';
  installedBody.appendChild(installedMount);

  const configBody = appendSettingsGroup(
    panel,
    'Configuration',
    'Backend, voice mode, and synthesis parameters.',
    'models.voice.tts.config',
    { emphasis: true },
  );
  const settingsShell = el('div', 'settings-voice-form-shell');
  settingsShell.id = 'modelsVoiceTtsSettings';
  configBody.appendChild(settingsShell);

  const benchBody = appendSettingsGroup(
    panel,
    'Test bench',
    'Save settings, then play a short sample phrase.',
    'models.voice.tts.bench',
    { emphasis: true },
  );

  const testInput = el('input', 'settings-input settings-voice-bench-input');
  testInput.type = 'text';
  testInput.id = 'modelsVoiceTtsTestText';
  testInput.value = 'Hello from Minnow voice.';
  testInput.placeholder = 'Sample phrase';
  testInput.setAttribute('aria-label', 'Sample text for voice test');
  benchBody.appendChild(testInput);

  benchBody.appendChild(
    createSettingsActionsRow(
      [
        {
          label: 'Save settings',
          variant: 'primary',
          onClick: () => {
            void saveTtsSettings();
          },
        },
        {
          label: 'Test voice',
          id: 'modelsVoiceTtsTestBtn',
          onClick: () => {
            void runTtsVoiceTest();
          },
        },
      ],
      { searchKey: 'models.voice.tts.bench.actions' },
    ),
  );

  const resultEl = el('p', 'settings-voice-bench-result settings-field-hint', '');
  resultEl.id = 'modelsVoiceTtsTestResult';
  benchBody.appendChild(resultEl);
}

async function refreshInstalledManifest(): Promise<void> {
  try {
    installedManifest = await listInstalledVoiceModels();
  } catch {
    installedManifest = { version: 1, stt: [], tts: [] };
  }
  await refreshVoicePanelUi();
}

async function refreshVoicePanelUi(): Promise<void> {
  const sttCatalogMount = document.getElementById('modelsVoiceSttCatalog');
  if (sttCatalogMount) {
    sttCatalogMount.replaceChildren();
    for (const entry of STT_CATALOG) {
      sttCatalogMount.appendChild(renderSttCatalogRow(entry));
    }
    const sttInstalledMount = document.getElementById('modelsVoiceSttInstalledMount');
    if (sttInstalledMount) {
      sttInstalledMount.replaceChildren(renderInstalledList());
    }
  }

  const ttsCatalogMount = document.getElementById('modelsVoiceTtsCatalog');
  if (ttsCatalogMount) {
    ttsCatalogMount.replaceChildren();
    for (const entry of TTS_CATALOG) {
      if (entry.mode === 'tokenizer') continue;
      ttsCatalogMount.appendChild(renderTtsCatalogRow(entry));
    }
    const ttsInstalledMount = document.getElementById('modelsVoiceTtsInstalledMount');
    if (ttsInstalledMount) {
      ttsInstalledMount.replaceChildren(renderTtsInstalledList());
    }
  }
}

async function refreshActiveBackendSummary(): Promise<void> {
  const config = voiceConfig ?? (await loadVoiceMeta());
  voiceConfig = config;
  sttBackend = config.stt.backend;
  ttsBackend = config.tts.backend;
  const sttSummary = document.getElementById('modelsVoiceSttBackendSummary');
  const ttsSummary = document.getElementById('modelsVoiceTtsBackendSummary');
  if (sttSummary) {
    if (config.stt.backend === 'local') {
      const streamingOn = config.stt.local.streamingEnabled !== false;
      sttSummary.textContent = streamingOn
        ? `Local · ${config.stt.local.modelId} · live dictation`
        : `Local · ${config.stt.local.modelId} · batch`;
    } else if (config.stt.backend === 'builtin') {
      sttSummary.textContent = 'Built-in · on-device dictation';
    } else {
      sttSummary.textContent = `Provider · ${config.stt.provider.providerId || 'not configured'}`;
    }
  }
  if (ttsSummary) {
    ttsSummary.textContent =
      config.tts.backend === 'local'
        ? `Local · ${config.tts.local.modelId}`
        : config.tts.backend === 'browser'
          ? 'System voice'
          : `Provider · ${config.tts.provider.providerId || 'not configured'}`;
  }
}

/** Mount Models → Voice panel on first activation. */
export function mountVoicePanel(): void {
  const body = document.getElementById('modelsVoiceBody');
  if (!body || mounted) return;
  mounted = true;

  body.replaceChildren();
  const shell = el('div', 'settings-general settings-voice');
  body.appendChild(shell);

  const advanced = el('details', 'settings-voice-advanced');
  advanced.appendChild(el('summary', 'settings-row__title', 'Advanced local voice setup'));
  const runtimeBody = appendSettingsGroup(
    advanced,
    'Advanced local voice',
    'Optional Python runtime for larger Whisper models and Qwen voices. Built-in dictation and system voices work without it.',
    'models.voice.runtime',
    { emphasis: true },
  );
  renderRuntimeCard(runtimeBody);

  const tabs = el('div', 'settings-profile-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Speech-to-text and text-to-speech');
  for (const id of ['stt', 'tts'] as const) {
    const btn = el(
      'button',
      'settings-profile-tab',
      id === 'stt' ? 'Speech-to-text' : 'Text-to-speech',
    );
    btn.type = 'button';
    btn.id = id === 'stt' ? 'modelsVoiceTabStt' : 'modelsVoiceTabTts';
    btn.role = 'tab';
    btn.dataset.voiceSubnav = id;
    btn.setAttribute('aria-controls', id === 'stt' ? 'modelsVoiceSttPanel' : 'modelsVoiceTtsPanel');
    btn.addEventListener('click', () => setActiveSubSection(id));
    tabs.appendChild(btn);
  }
  shell.appendChild(tabs);

  const content = el('div', 'settings-general__content settings-voice-panels');
  const sttPanel = el('section', 'settings-voice-panel');
  sttPanel.id = 'modelsVoiceSttPanel';
  sttPanel.role = 'tabpanel';
  sttPanel.setAttribute('aria-labelledby', 'modelsVoiceTabStt');
  mountSttPanel(sttPanel);
  content.appendChild(sttPanel);

  const ttsPanel = el('section', 'settings-voice-panel');
  ttsPanel.id = 'modelsVoiceTtsPanel';
  ttsPanel.role = 'tabpanel';
  ttsPanel.hidden = true;
  ttsPanel.setAttribute('aria-labelledby', 'modelsVoiceTabTts');
  mountTtsPanel(ttsPanel);
  content.appendChild(ttsPanel);

  shell.appendChild(content);
  shell.appendChild(advanced);

  appendSettingsCrosslinks(shell, [{ label: 'Audio devices', sectionId: 'audio' }]);

  setActiveSubSection(activeSub);

  void (async () => {
    try {
      hardware = await fetchHardware();
    } catch {
      hardware = null;
    }
    voiceConfig = await loadVoiceMeta();
    sttBackend = voiceConfig.stt.backend;
    ttsBackend = voiceConfig.tts.backend;
    renderSttSettingsSection();
    await renderTtsSettingsSection();
    await Promise.all([
      refreshActiveBackendSummary(),
      refreshRuntimeStatus(),
      refreshInstalledManifest(),
    ]);
  })();
}

/** Re-render voice panel when section is re-activated. */
export async function refreshVoicePanel(): Promise<void> {
  if (!mounted) {
    mountVoicePanel();
    return;
  }
  voiceConfig = await loadVoiceMeta();
  sttBackend = voiceConfig.stt.backend;
  ttsBackend = voiceConfig.tts.backend;
  renderSttSettingsSection();
  await renderTtsSettingsSection();
  try {
    hardware = await fetchHardware();
  } catch {
    hardware = null;
  }
  await Promise.all([
    refreshActiveBackendSummary(),
    refreshRuntimeStatus(),
    refreshInstalledManifest(),
  ]);
}
