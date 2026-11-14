/**
 * Browser client for scheduled jobs API (/api/scheduler/*).
 */

export type SchedulerScheduleKind = 'interval' | 'cron' | 'manual';

export interface SchedulerSchedule {
  kind: SchedulerScheduleKind;
  value: string;
}

export type SchedulerChannel = 'in_app' | 'email' | 'webhook';

export interface ScheduledJob {
  id: string;
  label: string;
  enabled: boolean;
  schedule: SchedulerSchedule;
  prompt: string;
  modeId: string;
  workAgentId?: string;
  providerId?: string;
  modelId?: string;
  workspacePath?: string;
  githubWatch?: { repository: string; label?: string } | null;
  /** Automation preset this job was created from. */
  preset?: { id: string; config: Record<string, any>; customInstructions?: boolean } | null;
  channels: SchedulerChannel[];
  lastRunAt?: string;
  nextRunAt?: string;
  running?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WatchedGithubIssue {
  number: number;
  title: string;
  url: string;
  phase: string;
  boardId: string;
  boardCreated?: boolean;
  prUrl?: string;
  error?: string;
}

export async function fetchWatchedGithubIssues(jobId: string): Promise<WatchedGithubIssue[]> {
  const res = await fetch(`/api/scheduler/jobs/${encodeURIComponent(jobId)}/issues`);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? 'Could not load watched issues');
  return body.issues;
}

export async function retryWatchedGithubIssue(jobId: string, number: number): Promise<void> {
  const res = await fetch(`/api/scheduler/jobs/${encodeURIComponent(jobId)}/issues/${number}/retry`, { method: 'POST' });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? body.summary ?? 'Could not retry issue');
}

export type SchedulerRunStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'cancelled';

export interface SchedulerRun {
  id: string;
  jobId: string;
  startedAt: string;
  completedAt?: string;
  status: SchedulerRunStatus;
  exitCode?: number;
  output?: string;
  error?: string;
  /** Session chat id when the run was persisted via --persist-chat. */
  chatId?: string;
  trigger?: 'schedule' | 'manual';
  /** The run found nothing to do. */
  quiet?: boolean;
  headline?: string;
  stats?: AutomationRunStats;
  reviewers?: { runId: string; role: string; label: string; status: string }[];
}

export interface SchedulerNotification {
  id: string;
  jobId: string;
  label: string;
  message: string;
  createdAt: string;
  acked: boolean;
  runId?: string;
  chatId?: string;
  workspacePath?: string;
  status?: SchedulerRunStatus;
  silent?: boolean;
}

export interface SchedulerDefaultWorkspace {
  ok?: boolean;
  path: string;
  label: string;
}

/** Whether the scheduler API is reachable. */
export async function pingSchedulerApi(): Promise<boolean> {
  try {
    const res = await fetch('/api/scheduler/ping');
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

/** Default workspace for jobs without an explicit path (~/.minnow/scheduler-workspace). */
export async function fetchSchedulerDefaultWorkspace(): Promise<SchedulerDefaultWorkspace> {
  const res = await fetch('/api/scheduler/workspace', { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Failed to load scheduler workspace (${res.status})`);
  }
  return (await res.json()) as SchedulerDefaultWorkspace;
}

/** Load all scheduled jobs. */
export async function fetchSchedulerJobs(): Promise<ScheduledJob[]> {
  const res = await fetch('/api/scheduler/jobs', { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`Failed to load scheduler jobs (${res.status})`);
  }
  const body = (await res.json()) as { jobs?: ScheduledJob[] };
  return body.jobs ?? [];
}

/** Create a new scheduled job. */
export async function createSchedulerJob(
  job: Omit<ScheduledJob, 'id' | 'createdAt' | 'updatedAt' | 'running'>,
): Promise<ScheduledJob> {
  const res = await fetch('/api/scheduler/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job }),
  });
  const body = (await res.json()) as { job?: ScheduledJob; error?: string };
  if (!res.ok) {
    throw new Error(body.error ?? `Create failed (${res.status})`);
  }
  if (!body.job) {
    throw new Error('Create failed: missing job payload');
  }
  return body.job;
}

/** Update an existing job. */
export async function updateSchedulerJob(
  id: string,
  patch: Partial<ScheduledJob>,
): Promise<ScheduledJob> {
  const res = await fetch(`/api/scheduler/jobs/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job: patch }),
  });
  const body = (await res.json()) as { job?: ScheduledJob; error?: string };
  if (!res.ok) {
    throw new Error(body.error ?? `Update failed (${res.status})`);
  }
  if (!body.job) {
    throw new Error('Update failed: missing job payload');
  }
  return body.job;
}

/** Delete a job. */
export async function deleteSchedulerJob(id: string): Promise<void> {
  const res = await fetch(`/api/scheduler/jobs/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const body = (await res.json()) as { error?: string };
    throw new Error(body.error ?? `Delete failed (${res.status})`);
  }
}

/** Run a job immediately. */
export async function runSchedulerJobNow(id: string): Promise<unknown> {
  const res = await fetch(`/api/scheduler/jobs/${encodeURIComponent(id)}/run`, {
    method: 'POST',
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(
      typeof body === 'object' && body && 'error' in body
        ? String((body as { error?: string }).error)
        : `Run failed (${res.status})`,
    );
  }
  return body;
}

/** Recent run history for one job. */
export async function fetchSchedulerRuns(jobId: string): Promise<SchedulerRun[]> {
  const res = await fetch(`/api/scheduler/runs/${encodeURIComponent(jobId)}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`Failed to load run history (${res.status})`);
  }
  const body = (await res.json()) as { runs?: SchedulerRun[] };
  return body.runs ?? [];
}

/** Unacknowledged in-app reminders. */
export async function fetchSchedulerNotifications(): Promise<SchedulerNotification[]> {
  const res = await fetch('/api/scheduler/notifications', { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    return [];
  }
  const body = (await res.json()) as { notifications?: SchedulerNotification[] };
  return body.notifications ?? [];
}

/** Mark a reminder as delivered/read. */
export async function ackSchedulerNotification(id: string): Promise<void> {
  await fetch(`/api/scheduler/notifications/${encodeURIComponent(id)}/ack`, {
    method: 'POST',
  });
}

// ---------- Automations hub ----------

export interface AutomationRunStats {
  rounds: number;
  toolCalls: number;
  filesRead: number;
  filesEdited: number;
  commands: number;
}

export interface AutomationLiveState {
  lastDelta?: string;
  lastThinking?: string;
  reasoningFormat?: 'summary';
  currentTool?: string | null;
  phase?: string | null;
}

export interface AutomationFocus {
  kind: 'pr' | 'issue';
  number: number;
  title: string;
  url?: string;
  author?: string;
  phase?: string;
}

export interface AutomationLiveRun {
  runId: string;
  jobId: string;
  label: string;
  parentRunId?: string;
  role?: string;
  roleLabel?: string;
  chatId?: string;
  startedAt: string;
  finishedAt?: string;
  status: SchedulerRunStatus;
  step: string;
  headline?: string;
  /** First sentence of a prompt run's instructions. */
  brief?: string;
  focus?: AutomationFocus;
  stats: AutomationRunStats;
  result?: { assistantFinal?: string; error?: string | null; quiet?: boolean };
  live: AutomationLiveState | null;
  children: AutomationLiveRun[];
  messages?: import('../types').Message[];
}

export interface AutomationAttention {
  kind: 'run' | 'pr' | 'issue';
  text: string;
  runId?: string;
  number?: number;
  title?: string;
  url?: string;
}

export interface AutomationRunSummary {
  id: string;
  status: SchedulerRunStatus;
  quiet: boolean;
  startedAt: string;
  completedAt?: string;
  headline?: string;
  trigger?: 'schedule' | 'manual';
}

export interface AutomationJob extends Omit<ScheduledJob, 'prompt'> {
  recentRuns: AutomationRunSummary[];
  live: AutomationLiveRun | null;
  attention: AutomationAttention | null;
}

export interface AutomationActivity {
  id: string;
  at: string;
  jobId: string;
  label: string;
  text: string;
  tone: 'run' | 'ok' | 'fail' | 'warn' | 'skip';
  runId?: string;
  ref?: { kind: string; id: string; url?: string };
}

export interface AutomationsOverview {
  jobs: AutomationJob[];
  activity: AutomationActivity[];
  now: string;
}

export interface AutomationTranscriptChild {
  runId: string;
  role: string;
  roleLabel: string;
  status: SchedulerRunStatus;
  startedAt: string;
  finishedAt?: string;
  result?: { assistantFinal?: string; error?: string | null };
  stats: AutomationRunStats;
  messages: import('../types').Message[];
}

export interface AutomationTranscript {
  runId: string;
  jobId: string;
  label: string;
  startedAt: string;
  finishedAt: string;
  status: SchedulerRunStatus;
  headline?: string;
  focus?: AutomationFocus;
  stats: AutomationRunStats;
  messages: import('../types').Message[];
  children: AutomationTranscriptChild[];
}

export interface AutomationRunDetail {
  run: SchedulerRun | null;
  live: AutomationLiveRun | null;
  transcript: AutomationTranscript | null;
}

export interface PrReviewRow {
  number: number;
  title: string;
  url: string;
  author: string;
  headSha: string;
  phase: string;
  reason?: string;
  error?: string;
  runId?: string;
  verdict?: 'pass' | 'fail';
  findings?: { severity: string; file?: string; line?: number; note: string; reviewer?: string }[];
  reviewers?: { role: string; label: string; runId: string; status: string; verdict?: string }[];
  updatedAt?: string;
}

export interface PrReviewQueue {
  pulls: PrReviewRow[];
  queue: { number: number; title: string; author: string; url: string; createdAt: string; headSha: string }[];
  checkedAt: string | null;
}

export interface GithubRepositoryCheck {
  repository: string | null;
  pushMatches: boolean;
  ghReady: boolean;
  error: string | null;
}

async function readJson<T>(res: Response, fallback: string): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; reason?: string };
  if (!res.ok) throw new Error(body.error ?? body.reason ?? fallback);
  return body as T;
}

/** Everything the hub shows in one request. */
export async function fetchAutomationsOverview(): Promise<AutomationsOverview> {
  const res = await fetch('/api/scheduler/overview', { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  return readJson(res, `Could not load automations (${res.status})`);
}

/** A run with its live state or saved transcript. */
export async function fetchAutomationRun(jobId: string, runId: string): Promise<AutomationRunDetail> {
  const res = await fetch(`/api/scheduler/runs/${encodeURIComponent(jobId)}/${encodeURIComponent(runId)}`, {
    cache: 'no-store', signal: AbortSignal.timeout(10_000),
  });
  return readJson(res, 'Could not load this run');
}

/** Start a run now without waiting for it to finish. */
export async function startAutomation(jobId: string): Promise<{ started: boolean; runId?: string | null; reason?: string }> {
  const res = await fetch(`/api/scheduler/jobs/${encodeURIComponent(jobId)}/start`, { method: 'POST' });
  const body = (await res.json().catch(() => ({}))) as { started?: boolean; runId?: string | null; reason?: string; error?: string };
  if (res.status === 409) return { started: false, reason: body.reason };
  if (!res.ok) throw new Error(body.error ?? 'Could not start this automation');
  return { started: Boolean(body.started), runId: body.runId ?? null };
}

export async function stopAutomationRun(runId: string): Promise<void> {
  const res = await fetch(`/api/scheduler/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST' });
  if (!res.ok && res.status !== 409) throw new Error('Could not stop this run');
}

/** Server-validated schedule and its next run time. */
export async function previewAutomationSchedule(schedule: SchedulerSchedule): Promise<{ schedule: SchedulerSchedule; nextRunAt: string | null }> {
  const res = await fetch('/api/scheduler/schedule/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schedule }),
  });
  return readJson(res, 'Invalid schedule');
}

export async function fetchPrReviewQueue(jobId: string): Promise<PrReviewQueue> {
  const res = await fetch(`/api/scheduler/jobs/${encodeURIComponent(jobId)}/pulls`, { cache: 'no-store' });
  return readJson(res, 'Could not load the review queue');
}

export async function retryPrReviewPull(jobId: string, number: number): Promise<void> {
  const res = await fetch(`/api/scheduler/jobs/${encodeURIComponent(jobId)}/pulls/${number}/retry`, { method: 'POST' });
  await readJson(res, 'Could not retry this PR');
}

export async function detectGithubRepository(workspacePath: string): Promise<GithubRepositoryCheck> {
  const res = await fetch('/api/scheduler/github/detect', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspacePath }),
  });
  return readJson(res, 'Could not check this checkout');
}
