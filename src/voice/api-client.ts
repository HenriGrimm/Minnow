import { StreamEventSource as EventSource } from '../api/stream-event-source';
/**
 * Voice runtime API client — install, worker lifecycle, SSE progress.
 */

import { withSessionToken } from '../api/session-token.ts';

export type VoiceRuntimeHealth =
  | 'not_installed'
  | 'installing'
  | 'starting'
  | 'ready'
  | 'stopped'
  | 'error';

export type VoiceInstallPhase = 'pending' | 'installing' | 'completed' | 'failed';

export interface VoiceInstallJob {
  phase: VoiceInstallPhase;
  percent: number;
  message: string;
  error: string | null;
}

export interface VoiceRuntimeStatus {
  installed: boolean;
  running: boolean;
  health: VoiceRuntimeHealth;
  cudaAvailable: boolean;
  torchVariant: 'cpu' | 'cuda' | null;
  port: number | null;
  installedAt: string | null;
  installedPackages: string[];
  skippedPackages: string[];
  installJob: VoiceInstallJob | null;
  worker: { ok: boolean; status: string; port?: number };
}

async function parseJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {}
    throw new Error(detail || `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

/** Fetch combined voice runtime status. */
export async function fetchRuntimeStatus(): Promise<VoiceRuntimeStatus> {
  const res = await fetch('/api/voice/runtime/status', { cache: 'no-store' });
  return parseJson(res);
}

/** Start background voice runtime install. */
export async function installRuntime(): Promise<{
  ok: boolean;
  started?: boolean;
  inProgress?: boolean;
  alreadyInstalled?: boolean;
  job: VoiceInstallJob | null;
}> {
  const res = await fetch('/api/voice/runtime/install', { method: 'POST' });
  return parseJson(res);
}

/** Re-run voice runtime provisioning. */
export async function repairRuntime(): Promise<{
  ok: boolean;
  started?: boolean;
  inProgress?: boolean;
  job: VoiceInstallJob | null;
}> {
  const res = await fetch('/api/voice/runtime/repair', { method: 'POST' });
  return parseJson(res);
}

/** Start the Python voice worker process. */
export async function startVoiceWorker(): Promise<{
  ok: boolean;
  alreadyRunning?: boolean;
  port?: number;
  pid?: number | null;
}> {
  const res = await fetch('/api/voice/runtime/start', { method: 'POST' });
  return parseJson(res);
}

const VOICE_WORKER_POLL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Whether the voice worker is installed and reporting ready health. */
export function isVoiceWorkerReady(status: VoiceRuntimeStatus): boolean {
  return status.installed && status.running && status.health === 'ready';
}

/**
 * Start the Python voice worker when installed but stopped; poll until ready.
 * No-op when the worker is already healthy.
 */
export async function ensureVoiceWorker(options?: {
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<VoiceRuntimeStatus> {
  const timeoutMs = options?.timeoutMs ?? 120_000;
  const pollIntervalMs = options?.pollIntervalMs ?? VOICE_WORKER_POLL_MS;

  let status = await fetchRuntimeStatus();

  if (!status.installed) {
    throw new Error('Voice runtime is not installed. Open Models → Voice.');
  }

  if (status.health === 'installing') {
    throw new Error('Voice runtime is installing. Wait for install to finish.');
  }

  if (isVoiceWorkerReady(status)) {
    return status;
  }

  if (!status.running || status.health === 'stopped' || status.health === 'error') {
    await startVoiceWorker();
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    status = await fetchRuntimeStatus();
    if (isVoiceWorkerReady(status)) {
      return status;
    }
    if (status.health === 'error') {
      throw new Error('Voice worker failed to start. Open Models → Voice.');
    }
    await sleep(pollIntervalMs);
  }

  throw new Error('Voice worker did not become ready in time. Open Models → Voice.');
}

/** Stop the Python voice worker process. */
export async function stopVoiceWorker(): Promise<{ ok: boolean; wasRunning: boolean }> {
  const res = await fetch('/api/voice/runtime/stop', { method: 'POST' });
  return parseJson(res);
}

/** Subscribe to install/repair progress via SSE. */
export function subscribeInstallProgress(
  onEvent: (event: VoiceInstallJob) => void,
): () => void {
  const source = new EventSource(withSessionToken('/api/voice/runtime/install/stream'));
  source.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data) as VoiceInstallJob);
    } catch {}
  };
  return () => source.close();
}

export type VoiceDownloadStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface VoiceDownloadJob {
  id: string;
  kind: 'stt' | 'tts';
  modelId: string;
  status: VoiceDownloadStatus;
  bytesReceived: number;
  totalBytes: number | null;
  destDir: string;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
}

export interface InstalledVoiceModel {
  modelId: string;
  path: string;
  installedAt: number;
  sizeBytes?: number;
  kind?: 'stt' | 'tts';
  mode?: 'custom_voice' | 'voice_design' | 'voice_clone' | 'tokenizer';
}

export interface InstalledVoiceManifest {
  version: number;
  stt: InstalledVoiceModel[];
  tts: InstalledVoiceModel[];
}

/** Start a voice model download (STT Whisper or TTS Qwen snapshot). */
export async function downloadVoiceModel(
  modelId: string,
  kind: 'stt' | 'tts',
): Promise<VoiceDownloadJob> {
  const res = await fetch('/api/voice/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelId, kind }),
  });
  const body = await parseJson<{ job: VoiceDownloadJob }>(res);
  return body.job;
}

/** Subscribe to download progress via SSE. */
export function subscribeDownloadProgress(
  jobId: string,
  onEvent: (event: {
    jobId: string;
    status: VoiceDownloadStatus;
    bytesReceived: number;
    totalBytes: number | null;
    error?: string | null;
  }) => void,
): () => void {
  const source = new EventSource(
    withSessionToken(`/api/voice/download/${encodeURIComponent(jobId)}/stream`),
  );
  source.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data));
    } catch {}
  };
  return () => source.close();
}

/** Cancel an in-flight voice model download. */
export async function cancelVoiceDownload(jobId: string): Promise<VoiceDownloadJob> {
  const res = await fetch(`/api/voice/download/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
  });
  const body = await parseJson<{ job: VoiceDownloadJob }>(res);
  return body.job;
}

/** List installed voice models from ~/.minnow/voice/installed.json. */
export async function listInstalledVoiceModels(): Promise<InstalledVoiceManifest> {
  const res = await fetch('/api/voice/models/installed');
  return parseJson(res);
}

/** Remove an installed voice model artifact. */
export async function deleteVoiceModel(
  kind: 'stt' | 'tts',
  modelId: string,
): Promise<{ ok: boolean; modelId: string; kind: string }> {
  const res = await fetch(
    `/api/voice/models/${kind}/${encodeURIComponent(modelId)}`,
    { method: 'DELETE' },
  );
  return parseJson(res);
}

export interface VoiceRefUpload {
  id: string;
  path: string;
  filename: string;
  mime: string;
  sizeBytes: number;
}

export interface VoiceClonePrompt {
  id: string;
  label: string;
  refAudioPath: string;
  refText: string;
  language: string;
  xVectorOnlyMode: boolean;
  createdAt: number;
}

/** Upload reference audio for voice clone mode. */
export async function uploadRefAudio(file: File): Promise<VoiceRefUpload> {
  const form = new FormData();
  form.append('file', file, file.name);
  const res = await fetch('/api/voice/refs/upload', { method: 'POST', body: form });
  const body = await parseJson<{ ok: boolean; ref: VoiceRefUpload }>(res);
  return body.ref;
}

/** List saved voice-clone prompts. */
export async function listClonePrompts(): Promise<VoiceClonePrompt[]> {
  const res = await fetch('/api/voice/clone-prompts');
  const body = await parseJson<{ prompts: VoiceClonePrompt[] }>(res);
  return body.prompts ?? [];
}
