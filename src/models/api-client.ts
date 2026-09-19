import { StreamEventSource as EventSource } from '../api/stream-event-source';
/**
 * Models app server API client.
 */

import { withSessionToken } from '../api/session-token.ts';
import type { GgufGeometryFacts } from './serve-memory-estimate.ts';
import type { SpecDecodeType } from './spec-decode.d.mts';

export type { GgufGeometryFacts, SpecDecodeType };

/** GGUF fetches one file; MLX fetches a whole repo snapshot into a directory. */
export type ModelDownloadFormat = 'gguf' | 'mlx';

export interface DownloadJob {
  id: string;
  repoId: string;
  /** Empty for MLX jobs — the whole repo is the artifact, not one file. */
  filename: string;
  repoFilePath?: string;
  quant: string;
  /** Absent on jobs persisted before MLX support; treat as 'gguf'. */
  format?: ModelDownloadFormat;
  status: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  bytesReceived: number;
  totalBytes: number | null;
  destPath: string;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
  /** Byte offset to resume from (`.partial` size). */
  resumeAt?: number | null;
  /** EWMA download speed from progress ticks. */
  bytesPerSec?: number | null;
  /** Remaining time from EWMA speed; 0 when complete. */
  etaMs?: number | null;
  /** True after a tool-server restart requeued this job. */
  interrupted?: boolean;
}

export interface InstalledArtifact {
  repoId: string;
  filename: string;
  path: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface ServeFailure {
  code: string;
  title?: string;
  detail?: string;
  remediation?: string;
  retryable?: boolean;
  /** Manual load payload for one-click Retry (ctx / cache_type / extra_args). */
  suggestedSettings?: LlamaServeSettings;
  /**
   * bad_template: first-class LlamaServeSettings keys the UI can point at
   * (`--chat-template` / `--chat-template-file`). Values are omitted — we do
   * not invent a template string llama-server would try to parse.
   */
  chatTemplateFields?: string[];
  exitCode?: number | null;
}

export interface MlxServeSettings {
  snapshotPath: string;
  quant: string | null;
  mlxLmVersion: string;
  port: number;
  contextLength: number | null;
}

export interface ServeRecord {
  id: string;
  runtime: string;
  modelPath: string;
  modelLabel: string;
  port: number;
  baseUrl: string;
  providerId: string;
  /** llama.cpp engine that spawned the serve: `upstream` or a fork id. */
  engineId?: string;
  status: 'starting' | 'running' | 'stopped' | 'error' | 'crashed' | 'unhealthy';
  runId: string | null;
  pid: number | null;
  error: string | null;
  startedAt: number;
  stoppedAt: number | null;
  llamaSettings?: Record<string, unknown> | null;
  /** mlx-lm inspector snapshot; absent on llama.cpp rows. */
  mlxSettings?: MlxServeSettings | null;
  /** Library row id when the serve was started from My Models / picker. */
  libraryId?: string | null;
  exitCode?: number | null;
  failure?: ServeFailure | null;
}

export interface LlamaServeSettings {
  ctx?: number;
  n_gpu_layers?: number;
  cache_type?: string;
  n_cpu_moe?: number;
  batch_size?: number;
  ubatch_size?: number;
  parallel?: number;
  /** `-t`; manual override of the partial-offload thread heuristic. */
  threads?: number;
  /** `--kv-unified` / `--no-kv-unified`. */
  kv_unified?: boolean;
  /** `--no-kv-offload` when explicitly `false`. KV on GPU is the default. */
  kv_offload?: boolean;
  /** `-ctxcp`; max context checkpoints per slot. */
  ctx_checkpoints?: number;
  /** `--reasoning-budget-message`. */
  reasoning_budget_message?: string;
  /** `--rope-freq-base`. */
  rope_freq_base?: number;
  /** `--rope-freq-scale`. */
  rope_freq_scale?: number;
  /** `-s`; `-1` is llama.cpp's explicit "random". */
  seed?: number;
  /** Manual override of the per-variant `plan.flash_attn`. */
  flash_attn?: 'on' | 'off' | 'auto';
  /** `--cache-type-k`; overrides `cache_type` for K when set. */
  cache_type_k?: string;
  /** `--cache-type-v`; overrides `cache_type` for V when set. */
  cache_type_v?: string;
  /** `--context-shift` / `--no-context-shift`. */
  context_shift?: boolean;
  /** `--swa-full`; invalidates the sliding-window saving in the memory estimate. */
  swa_full?: boolean;
  /** Minnow-side idle eviction for this model. Not a llama-server flag. */
  idle_ttl_ms?: number;
  /**
   * `--spec-type`. `draft-mtp` needs no draft model (the heads ship inside the GGUF);
   * `draft-simple` / `draft-eagle3` cannot start without `spec_draft_model`.
   */
  spec_type?: SpecDecodeType;
  /** `--spec-draft-model`: path to the draft GGUF. */
  spec_draft_model?: string;
  /** `--spec-draft-ngl`: draft model layers on the GPU. */
  spec_draft_ngl?: number;
  /** `--spec-draft-n-max`: max tokens drafted per step. */
  spec_draft_n_max?: number;
  /** `--spec-draft-n-min`: min tokens drafted per step. */
  spec_draft_n_min?: number;
  /** `--spec-draft-p-min`: minimum draft probability. */
  spec_draft_p_min?: number;
  /** `--device` / `-dev`: comma-separated GGML ids, check order. */
  device?: string;
  split_mode?: string;
  tensor_split?: string;
  main_gpu?: number;
  fit?: boolean;
  /**
   * `auto` (default) — server `planLlamaLaunch` owns ctx / n_gpu_layers / cache_type.
   * `manual` — those three pass through unclamped. `fit: true` is not manual.
   */
  fit_mode?: 'auto' | 'manual';
  no_warmup?: boolean;
  /**
   * Omit `--jinja` (Phase 3 retry after a bad chat template). Not a llama-server flag.
   */
  skip_jinja?: boolean;
  /** `--no-mmap`; default off. mmap_failed retry also uses extra_args. */
  no_mmap?: boolean;
  /** Never attach the sibling `mmproj*.gguf` (vision off for this load). */
  no_mmproj?: boolean;
  /** `--mlock`; default off. */
  mlock?: boolean;
  /** llama-server `--chat-template` (may contain spaces). */
  chat_template?: string;
  /** llama-server `--chat-template-file`. */
  chat_template_file?: string;
  extra_args?: string[];
  env?: Record<string, string>;
}

export interface CachedModelRow {
  repo_id: string;
  size_bytes: number;
  nb_files: number;
  has_incomplete: boolean;
  path: string;
  is_gguf?: boolean;
  is_ollama?: boolean;
  is_local_dir?: boolean;
  is_diffusion?: boolean;
  /** Absolute snapshot directory when this repo holds MLX-quantized weights. */
  mlx_root?: string;
  /** e.g. `mlx-4bit`, matching the labels quant.ts already scores. */
  mlx_quant?: string;
  /** Context window from config.json when the MLX repo was scanned. */
  mlx_context_length?: number;
  status?: string;
  gguf_files?: Array<{
    name: string;
    rel_path: string;
    size_bytes: number;
    role: string;
    quant: string;
  }>;
}

export interface ServeProfile {
  key: string;
  label: string;
  quant: string;
  n_gpu_layers: number;
  n_cpu_moe: number;
  cache_type: string;
  ctx: number;
  est_vram_gb: number;
  fits: boolean;
  note: string;
  llama_args?: string[];
}

export interface LlamaRuntimeStatus {
  path: string | null;
  source: string | null;
  variant: string | null;
  /** Installed meta.version when known; otherwise the pinned release tag. */
  version: string;
  /** ggml-org tag Minnow currently ships (`LLAMA_CPP_RELEASE_TAG`). */
  pinnedVersion: string;
  /** meta.json `version` for a managed install, or null when unknown. */
  installedVersion: string | null;
  /** True when a managed llama.cpp tree exists and its version differs from the pin. */
  upgradeAvailable: boolean;
  assetNames: string[];
  installedAt: string | null;
  installable: boolean;
  gpuCapable: boolean;
  preferredVariant: string;
  installableVariants: string[];
  /**
   * Rolling bytes-per-ms for this variant from `~/.minnow/llama-cpp.json`, or null
   * before any load has been recorded. The load bar's fallback ETA for a model that
   * has never been loaded on this machine.
   */
  loadRateBytesPerMs?: number | null;
  /** GPU rows from `llama-server --list-devices`, or synthesized from hardware. */
  devices?: Array<{ id: string; name: string; memoryMiB: number; freeMiB: number | null }>;
  /** Engine the next serve spawns: `upstream` or a fork id (Models → Engine). */
  engineId?: string;
  engineLabel?: string;
  /** Why the selected engine has no binary, when `path` is null. */
  engineReason?: string | null;
  /** `--cache-type-k` values the active binary accepts (from `--help`). */
  kvCacheTypes?: string[];
  /** Active engine runs different K and V cache types without a CPU fallback. */
  asymmetricKv?: boolean;
}

export interface LlamaEngineMissingTool {
  tool: string;
  hint: string;
  url: string;
}

export interface LlamaEngineStatus {
  id: string;
  label: string;
  description: string | null;
  kind: 'upstream' | 'fork';
  origin: 'approved' | 'custom';
  source?: 'github' | 'local';
  repo?: string | null;
  ref?: string | null;
  branch?: string | null;
  homepage?: string | null;
  backend?: 'cuda' | 'vulkan' | 'metal' | 'rocm' | 'cpu';
  minCudaSm?: number | null;
  cmakeFlags?: string[];
  binaryPath: string | null;
  installed: boolean;
  installKind?: 'source' | 'release' | 'local' | null;
  version?: string | null;
  installedSha?: string | null;
  pinnedSha?: string | null;
  pinUpdateAvailable?: boolean;
  commitsBehind?: number | null;
  builtAt?: string | null;
  supported: boolean;
  unsupportedReason: string | null;
  prereqs?: { ok: boolean; missing: LlamaEngineMissingTool[] } | null;
  kvCacheTypes?: string[];
  asymmetricKv?: boolean;
}

export interface LlamaEngineBuildJob {
  engineId: string;
  phase: 'checking' | 'downloading' | 'configuring' | 'building' | 'installing' | 'completed' | 'failed' | 'cancelled';
  percent: number;
  message: string;
  error: string | null;
  logTail: string[];
  sha: string | null;
  startedAt: number;
}

export interface LlamaEnginesView {
  active: string;
  engines: LlamaEngineStatus[];
  build: LlamaEngineBuildJob | null;
}

export interface CustomLlamaForkInput {
  label: string;
  source: 'github' | 'local';
  repo?: string;
  ref?: string;
  binaryPath?: string;
  backend: 'cuda' | 'vulkan' | 'metal' | 'rocm' | 'cpu';
  cmakeFlags?: string;
}

export interface LlamaInstallJob {
  phase: 'idle' | 'installing' | 'completed' | 'failed';
  percent: number;
  message: string;
  error: string | null;
}

export interface ModelsConfigView {
  hfTokenConfigured: boolean;
  hfTokenMasked: string;
  modelDirs: string[];
}

export interface RuntimeDetection {
  llamaCpp: {
    available: boolean;
    path: string | null;
    bundled: boolean;
    installable: boolean;
    variant?: string | null;
    gpuCapable?: boolean;
  };
  mlxLm: {
    /** True on Apple Silicon whether or not the runtime is installed yet. */
    available: boolean;
    installed: boolean;
    installable: boolean;
    running: boolean;
    port: number | null;
  };
  ollama: { available: boolean; path: string | null; serving: boolean; baseUrl: string | null };
  lmStudio: { available: boolean; baseUrl: string | null };
}

/** One row from `GET /api/models/hf/search`. */
export interface HubSearchResult {
  repoId: string;
  format: ModelDownloadFormat;
  /** `mlx-4bit`, `Q4_K_M`, or '' when the Hub did not expose it. */
  quant: string;
  arch: string;
  paramsB: number | null;
  sizeBytes: number | null;
  downloads: number;
  likes: number;
  gated: boolean;
  toolCapable: boolean;
  pipelineTag: string;
}

export interface HubSearchResponse {
  nextCursor?: string | null;
  results: HubSearchResult[];
  /** Set when results were withheld (e.g. MLX asked for off Apple Silicon). */
  reason: string | null;
  /** Whether a Hugging Face token is configured, for gated-repo affordances. */
  hasToken: boolean;
}

async function parseJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

// ── Hub downloads ────────────────────────────────────────────────────────────

export async function fetchModelsPing(): Promise<boolean> {
  const res = await fetch('/api/models/ping');
  return res.ok;
}

/** Search the Hugging Face Hub for downloadable weights. */
export async function searchHubModels(payload: {
  query: string;
  format: ModelDownloadFormat;
  limit?: number;
  sort?: 'downloads' | 'likes' | 'lastModified';
  signal?: AbortSignal;
  cursor?: string;
}): Promise<HubSearchResponse> {
  const params = new URLSearchParams({ q: payload.query, format: payload.format });
  if (payload.limit) params.set('limit', String(payload.limit));
  if (payload.sort) params.set('sort', payload.sort);
  if (payload.cursor) params.set('cursor', payload.cursor);
  const res = await fetch(`/api/models/hf/search?${params.toString()}`, {
    signal: payload.signal,
  });
  return parseJson<HubSearchResponse>(res);
}

export async function startModelDownload(payload: {
  repoId: string;
  quant?: string;
  filename?: string;
  format?: ModelDownloadFormat;
  /** Repo size the Hub already reported, so MLX can precheck disk without HEADs. */
  sizeBytes?: number;
}): Promise<DownloadJob> {
  const res = await fetch('/api/models/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await parseJson<{ job: DownloadJob }>(res);
  return data.job;
}

export function subscribeDownloadProgress(
  jobId: string,
  onEvent: (event: {
    jobId: string;
    status: DownloadJob['status'];
    bytesReceived: number;
    totalBytes: number | null;
    bytesPerSec?: number | null;
    etaMs?: number | null;
    interrupted?: boolean;
    resumeAt?: number | null;
    error?: string | null;
  }) => void,
): () => void {
  const source = new EventSource(withSessionToken(`/api/models/download/${jobId}/stream`));
  source.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data));
    } catch {}
  };
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) {
      void listModelDownloads()
        .then((jobs) => jobs.find((job) => job.id === jobId))
        .then((job) => {
          if (!job) return;
          onEvent({
            jobId: job.id,
            status: job.status,
            bytesReceived: job.bytesReceived,
            totalBytes: job.totalBytes,
            bytesPerSec: job.bytesPerSec,
            etaMs: job.etaMs,
            interrupted: job.interrupted,
            resumeAt: job.resumeAt,
            error: job.error,
          });
        })
        .catch(() => {});
    }
  };
  return () => source.close();
}

export async function cancelModelDownload(jobId: string): Promise<DownloadJob> {
  const res = await fetch(`/api/models/download/${jobId}/cancel`, { method: 'POST' });
  const data = await parseJson<{ job: DownloadJob }>(res);
  return data.job;
}

export interface HubFile {
  filename: string;
  quant: string;
  files: string[];
  sizeBytes: number | null;
  error: string | null;
}

export async function fetchHubFiles(repoId: string, signal?: AbortSignal): Promise<HubFile[]> {
  const res = await fetch(`/api/models/hf/files?${new URLSearchParams({ repo: repoId })}`, { signal });
  return (await parseJson<{ files: HubFile[] }>(res)).files;
}

export async function controlModelDownload(jobId: string, action: 'pause' | 'resume'): Promise<DownloadJob> {
  const res = await fetch(`/api/models/download/${encodeURIComponent(jobId)}/${action}`, { method: 'POST' });
  return (await parseJson<{ job: DownloadJob }>(res)).job;
}

// ── Installed ────────────────────────────────────────────────────────────────

export async function listModelDownloads(): Promise<DownloadJob[]> {
  const res = await fetch('/api/models/downloads');
  const data = await parseJson<{ jobs: DownloadJob[] }>(res);
  return data.jobs;
}

export async function fetchInstalledModels(): Promise<{
  artifacts: InstalledArtifact[];
  downloads: DownloadJob[];
}> {
  const res = await fetch('/api/models/installed');
  return parseJson(res);
}

export async function fetchRuntimes(): Promise<RuntimeDetection> {
  const res = await fetch('/api/models/runtimes');
  return parseJson(res);
}

/**
 * Attention geometry read from a local GGUF header.
 * Resolves to null when the file is gone or is not a GGUF Minnow can parse.
 */
export async function fetchGgufGeometry(
  filePath: string,
): Promise<GgufGeometryFacts | null> {
  const res = await fetch(`/api/models/gguf-meta?path=${encodeURIComponent(filePath)}`);
  if (!res.ok) return null;
  return parseJson<GgufGeometryFacts>(res);
}

export async function fetchCachedModels(): Promise<CachedModelRow[]> {
  const res = await fetch('/api/models/cached');
  const data = await parseJson<{ models: CachedModelRow[] }>(res);
  return data.models;
}

export async function fetchModelsConfig(): Promise<ModelsConfigView> {
  const res = await fetch('/api/models/config');
  return parseJson(res);
}

export async function saveModelsConfig(patch: {
  hfToken?: string;
  clearHfToken?: boolean;
  modelDirs?: string[];
}): Promise<ModelsConfigView> {
  const res = await fetch('/api/models/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return parseJson(res);
}

export async function fetchServeProfiles(query: {
  model: string;
  quant?: string;
  params_b?: number;
  weights_gb?: number;
  is_moe?: boolean;
}): Promise<{ profiles: ServeProfile[] }> {
  const qp = new URLSearchParams();
  qp.set('model', query.model);
  if (query.quant) qp.set('quant', query.quant);
  if (query.params_b != null) qp.set('params_b', String(query.params_b));
  if (query.weights_gb != null) qp.set('weights_gb', String(query.weights_gb));
  if (query.is_moe) qp.set('is_moe', '1');
  const res = await fetch(`/api/models/profiles?${qp}`);
  return parseJson(res);
}

export async function fetchLlamaRuntime(): Promise<LlamaRuntimeStatus> {
  const res = await fetch('/api/models/llama-runtime');
  return parseJson(res);
}

export async function installLlamaRuntime(payload?: {
  variant?: string;
  tag?: string;
  reinstall?: boolean;
}): Promise<LlamaRuntimeStatus & { ok: boolean; path?: string }> {
  const res = await fetch('/api/models/llama-runtime/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  return parseJson(res);
}

/** Window event fired after the active llama.cpp engine or its binary changes. */
export const LLAMA_ENGINE_CHANGED_EVENT = 'minnow:llama-engine-changed';

export function notifyLlamaEngineChanged(): void {
  window.dispatchEvent(new CustomEvent(LLAMA_ENGINE_CHANGED_EVENT));
}

export async function fetchLlamaEngines(): Promise<LlamaEnginesView> {
  return parseJson(await fetch('/api/models/llama-engines'));
}

export async function setActiveLlamaEngine(id: string): Promise<LlamaEnginesView> {
  const res = await fetch('/api/models/llama-engines/active', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  return parseJson(res);
}

export async function addCustomLlamaFork(
  input: CustomLlamaForkInput,
): Promise<LlamaEnginesView & { id: string }> {
  const res = await fetch('/api/models/llama-engines/custom', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return parseJson(res);
}

/** Uninstall an approved fork's build, or remove a custom fork entirely. */
export async function removeLlamaEngine(id: string): Promise<LlamaEnginesView> {
  const res = await fetch(`/api/models/llama-engines/${encodeURIComponent(id)}`, { method: 'DELETE' });
  return parseJson(res);
}

export async function buildLlamaEngine(
  id: string,
  target: 'pinned' | 'head' = 'pinned',
): Promise<{ ok: boolean; build: LlamaEngineBuildJob }> {
  const res = await fetch(`/api/models/llama-engines/${encodeURIComponent(id)}/build`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target }),
  });
  return parseJson(res);
}

export async function cancelLlamaEngineBuild(): Promise<{ ok: boolean }> {
  return parseJson(await fetch('/api/models/llama-engines/build/cancel', { method: 'POST' }));
}

/** Follow the fork build job (log tail + phase) via SSE. */
export function subscribeLlamaEngineBuild(
  onEvent: (job: LlamaEngineBuildJob) => void,
): () => void {
  const source = new EventSource(withSessionToken('/api/models/llama-engines/build/stream'));
  source.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data) as LlamaEngineBuildJob);
    } catch {}
  };
  return () => source.close();
}

/** Subscribe to llama.cpp runtime install progress via SSE. */
export function subscribeLlamaInstallProgress(
  onEvent: (event: LlamaInstallJob) => void,
): () => void {
  const source = new EventSource(withSessionToken('/api/models/llama-runtime/install/stream'));
  source.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data) as LlamaInstallJob);
    } catch {}
  };
  return () => source.close();
}

// ── Serve ────────────────────────────────────────────────────────────────────

export async function startModelServe(payload: {
  modelPath: string;
  runtime?: 'llama-cpp' | 'mlx-lm' | 'ollama' | 'lm-studio';
  modelLabel?: string;
  profile?: string;
  hardware?: Record<string, unknown>;
  quant?: string;
  paramsB?: number;
  isMoe?: boolean;
  weightsGb?: number;
  llama?: LlamaServeSettings;
  /** Library row id so startServe can merge saved models.launch prefs. */
  libraryId?: string;
  /** Return as soon as the process spawns; poll fetchModelServe for readiness. */
  async?: boolean;
}): Promise<ServeRecord> {
  const res = await fetch('/api/models/serve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await parseJson<{ serve: ServeRecord }>(res);
  return data.serve;
}

export async function stopModelServe(serveId: string): Promise<ServeRecord> {
  const res = await fetch(`/api/models/serve/${serveId}/stop`, { method: 'POST' });
  const data = await parseJson<{ serve: ServeRecord }>(res);
  return data.serve;
}

export async function listModelServes(): Promise<ServeRecord[]> {
  const res = await fetch('/api/models/serve');
  const data = await parseJson<{ serves: ServeRecord[] }>(res);
  return data.serves;
}

/** Poll a single serve — used while an async start is still loading. */
export async function fetchModelServe(serveId: string): Promise<ServeRecord | null> {
  const res = await fetch(`/api/models/serve/${serveId}`);
  if (res.status === 404) return null;
  const data = await parseJson<{ serve: ServeRecord }>(res);
  return data.serve;
}

/** Read the trailing bytes of a serve's runtime log. */
export async function fetchServeLog(
  serveId: string,
  bytes?: number,
): Promise<{ text: string; offset: number }> {
  const qs = bytes ? `?bytes=${bytes}` : '';
  const res = await fetch(`/api/models/serve/${serveId}/logs${qs}`);
  return parseJson(res);
}

// ── Streams ──────────────────────────────────────────────────────────────────

/** Follow a serve's runtime log — emits the tail, then appended chunks. */
export function subscribeServeLog(
  serveId: string,
  onChunk: (event: { text: string; offset: number; initial?: boolean }) => void,
): () => void {
  const source = new EventSource(withSessionToken(`/api/models/serve/${serveId}/logs/stream`));
  source.onmessage = (msg) => {
    try {
      onChunk(JSON.parse(msg.data));
    } catch {}
  };
  return () => source.close();
}

/** Live serve-list snapshots from commitServes. 15s poll in the store is the fallback. */
export function subscribeServeEvents(
  onEvent: (payload: { serves: ServeRecord[]; reason: string }) => void,
): () => void {
  const source = new EventSource(withSessionToken('/api/models/serve/events'));
  source.onmessage = (msg) => {
    try {
      const data = JSON.parse(msg.data) as { serves?: ServeRecord[]; reason?: string };
      if (data && Array.isArray(data.serves)) {
        onEvent({ serves: data.serves, reason: data.reason ?? 'update' });
      }
    } catch {}
  };
  return () => source.close();
}

/**
 * One llama.cpp slot's live state, normalised server-side from `/slots`.
 *
 * There is no prefill percentage here on purpose: during prompt processing llama.cpp's
 * `/slots` reports the running count in both `n_prompt_tokens` and
 * `n_prompt_tokens_processed`, so no total exists to divide by. A real percentage is
 * available only in the chat stream (`prompt_progress`).
 */
export interface ServeActivitySlot {
  id: number;
  taskId: number | null;
  state: 'idle' | 'prompt' | 'generating';
  /** Prompt tokens fed so far. A count, not a fraction. */
  promptProcessed: number;
  /** Prefix reused from the prompt cache. */
  promptCached: number;
  /** Tokens generated for the current task. */
  decoded: number;
  /** Tokens still allowed for the current task. */
  remaining: number | null;
  /** Derived from consecutive samples; null until there are two. */
  tokensPerSecond: number | null;
}

export interface ServeActivity {
  serveId: string;
  /** Identity for surfaces that never hold a serve list (the header picker). */
  modelLabel: string;
  /** Library row id, when the serve was started from one. */
  libraryId: string | null;
  updatedAt: number;
  /** `/slots` answered at least once. */
  available: boolean;
  /** The last sample is too old to trust — a saturated server stops answering. */
  stale: boolean;
  /**
   * llama.cpp deferred requests waiting for a free slot (`requests_deferred`).
   * Zero when `/metrics` is unavailable or the host is not backed up.
   */
  queued: number;
  slots: ServeActivitySlot[];
}

/** Live `/slots` telemetry for every running llama.cpp serve. */
export function subscribeServeActivity(
  onEvent: (activity: ServeActivity) => void,
): () => void {
  const source = new EventSource(withSessionToken('/api/models/serve/activity/stream'));
  source.onmessage = (msg) => {
    try {
      const data = JSON.parse(msg.data) as ServeActivity;
      if (data && typeof data.serveId === 'string') onEvent(data);
    } catch {}
  };
  return () => source.close();
}

/** Resolve the GGUF download repo for a catalog row. */
export function resolveDownloadRepo(model: {
  name: string;
  gguf_sources?: Array<{ repo: string }>;
}): string | null {
  const gguf = model.gguf_sources?.[0]?.repo;
  if (gguf) return gguf;
  if (model.name.includes('/')) return model.name;
  return null;
}
