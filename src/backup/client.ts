/**
 * Browser client for backup and restore (/api/backup/*).
 */

export interface BackupCategoryInfo {
  id: string;
  label: string;
  description: string;
  defaultOn: boolean;
  requiresPassphrase: boolean;
}

export interface BackupCategorySize {
  id: string;
  files: number;
  bytes: number;
}

export type SnapshotFrequency = 'daily' | 'weekly';

export interface BackupSettings {
  categories: string[];
  lastDestDir: string;
  schedule: {
    enabled: boolean;
    frequency: SnapshotFrequency;
    destDir: string;
    keep: number;
    hasPassphrase: boolean;
  };
  state: {
    lastRunAt: string | null;
    lastSuccessAt: string | null;
    lastStatus: 'ok' | 'skipped' | 'failed' | null;
    lastError: string;
    lastFile: string;
    nextRunAt: string | null;
    failures: number;
  };
  lastExport: null | {
    at: string;
    file: string;
    archiveBytes: number;
    encrypted: boolean;
    kind: 'manual' | 'scheduled';
  };
}

export interface BackupArchiveRef {
  file: string;
  createdAt: string;
  appVersion: string;
  encrypted: boolean;
}

export interface PendingRestore {
  id: string;
  kind: 'restore' | 'rollback';
  createdAt: string;
  archive: BackupArchiveRef | null;
  categories: string[];
  warnings: string[];
  attempts: number;
  lastError: string;
  failed: boolean;
}

export interface LastRestore {
  id: string;
  appliedAt: string;
  rolledBackAt: string | null;
  archive: BackupArchiveRef | null;
  categories: string[];
  keyChanged: boolean;
  setAside: number;
  canUndo: boolean;
  previousDataBytes: number;
}

export interface BackupProgress {
  bytes: number;
  totalBytes: number;
  files: number;
  totalFiles: number;
}

export interface BackupJob<T = unknown> {
  id: string;
  kind: 'export' | 'snapshot' | 'restore';
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  progress: BackupProgress;
  result: T | null;
  error: string;
  errorCode: string;
}

export interface BackupStatus {
  home: string;
  packaged: boolean;
  defaultDir: string;
  fileExtension: string;
  minPassphraseLength: number;
  keepRange: { min: number; max: number };
  credentialsCategory: string;
  categories: BackupCategoryInfo[];
  settings: BackupSettings;
  restore: { pending: PendingRestore | null; last: LastRestore | null };
  job: BackupJob | null;
}

export interface ExportResult {
  file: string;
  archiveBytes: number;
  files: number;
  bytes: number;
  encrypted: boolean;
  includesCredentials: boolean;
  credentialsOmitted: number;
}

export interface SnapshotResult {
  status: 'ok' | 'skipped' | 'failed';
  file?: string;
  error?: string;
}

export interface BackupListEntry {
  file: string;
  name: string;
  archiveBytes: number;
  createdAt: string;
  appVersion: string;
  encrypted: boolean;
  includesCredentials: boolean;
  label: string;
}

export interface BackupPreview {
  file: string;
  archiveBytes: number;
  createdAt: string;
  appVersion: string;
  platform: string;
  label: string;
  encrypted: boolean;
  includesCredentials: boolean;
  totals: { files: number; bytes: number };
  categories: Array<BackupCategorySize & { label: string; description: string; known: boolean }>;
  warnings: string[];
  passphraseOk: boolean | null;
}

export interface StagedRestore {
  id: string;
  files: number;
  bytes: number;
  categories: string[];
  warnings: string[];
  restartRequired: boolean;
}

/** Error from the backup API, carrying the server's machine-readable code. */
export class BackupApiError extends Error {
  code: string;

  constructor(message: string, code = '') {
    super(message);
    this.name = 'BackupApiError';
    this.code = code;
  }
}

async function request<T>(method: string, route: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/backup${route}`, {
    method,
    cache: 'no-store',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = {};
  }
  if (!res.ok) {
    throw new BackupApiError(
      typeof json.error === 'string' ? json.error : `Request failed (HTTP ${res.status})`,
      typeof json.code === 'string' ? json.code : '',
    );
  }
  return json as T;
}

export function fetchBackupStatus(): Promise<BackupStatus> {
  return request<BackupStatus>('GET', '/status');
}

export async function fetchBackupSizes(): Promise<BackupCategorySize[]> {
  return (await request<{ categories: BackupCategorySize[] }>('GET', '/sizes')).categories;
}

export async function saveBackupSettings(patch: {
  categories?: string[];
  schedule?: {
    enabled?: boolean;
    frequency?: SnapshotFrequency;
    destDir?: string;
    keep?: number;
    /** A string sets it, `null` removes it, omitted leaves it. */
    passphrase?: string | null;
  };
}): Promise<BackupSettings> {
  return (await request<{ settings: BackupSettings }>('PUT', '/settings', patch)).settings;
}

export async function startBackupExport(input: {
  destDir: string;
  categories: string[];
  passphrase: string;
}): Promise<BackupJob<ExportResult>> {
  return (await request<{ job: BackupJob<ExportResult> }>('POST', '/export', input)).job;
}

export async function startSnapshotNow(): Promise<BackupJob<SnapshotResult>> {
  return (await request<{ job: BackupJob<SnapshotResult> }>('POST', '/snapshot')).job;
}

export async function fetchBackupJob<T>(id: string): Promise<BackupJob<T>> {
  return (await request<{ job: BackupJob<T> }>('GET', `/jobs/${encodeURIComponent(id)}`)).job;
}

export async function listBackups(dir: string): Promise<BackupListEntry[]> {
  return (await request<{ backups: BackupListEntry[] }>('POST', '/list', { dir })).backups;
}

export async function inspectBackup(path: string, passphrase?: string): Promise<BackupPreview> {
  return (await request<{ backup: BackupPreview }>('POST', '/inspect', { path, passphrase })).backup;
}

export async function startRestore(input: {
  path: string;
  passphrase?: string;
  categories?: string[];
}): Promise<BackupJob<StagedRestore>> {
  return (await request<{ job: BackupJob<StagedRestore> }>('POST', '/restore', input)).job;
}

export function cancelPendingRestore(): Promise<{ cancelled: boolean }> {
  return request('POST', '/restore/cancel');
}

export function retryPendingRestore(): Promise<{ retried: boolean }> {
  return request('POST', '/restore/retry');
}

export function undoLastRestore(): Promise<{ id: string; restartRequired: boolean }> {
  return request('POST', '/restore/undo');
}

export function discardPreviousData(): Promise<{ removed: boolean }> {
  return request('POST', '/restore/discard-previous');
}

const JOB_POLL_MS = 400;

/**
 * Poll a job until it finishes, reporting progress along the way. Resolves with
 * the finished job whether it succeeded or failed.
 */
export async function waitForBackupJob<T>(
  job: BackupJob<T>,
  onProgress?: (job: BackupJob<T>) => void,
): Promise<BackupJob<T>> {
  let current = job;
  onProgress?.(current);
  while (current.status === 'running') {
    await new Promise((resolve) => setTimeout(resolve, JOB_POLL_MS));
    current = await fetchBackupJob<T>(job.id);
    onProgress?.(current);
  }
  return current;
}

// ── Formatting ───────────────────────────────────────────────────────────────

/** "1.4 GB", "312 KB" — binary units, one decimal below 100. */
export function formatBackupBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

/** Local date and time for an ISO stamp, or an em dash when there is none. */
export function formatBackupWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Last path segment, for showing a file without its folder. */
export function backupFileName(file: string): string {
  return file.split(/[\\/]/).filter(Boolean).pop() ?? file;
}

/** 0–100 for a progress bar; bytes when known, files otherwise. */
export function backupProgressPercent(progress: BackupProgress): number {
  const ratio =
    progress.totalBytes > 0
      ? progress.bytes / progress.totalBytes
      : progress.totalFiles > 0
        ? progress.files / progress.totalFiles
        : 0;
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}
