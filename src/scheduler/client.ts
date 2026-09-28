/**
 * Browser client for scheduled jobs API (/api/scheduler/*).
 */

export type SchedulerScheduleKind = 'interval' | 'cron';

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
  channels: SchedulerChannel[];
  lastRunAt?: string;
  nextRunAt?: string;
  running?: boolean;
  createdAt: string;
  updatedAt: string;
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
}

export interface SchedulerNotification {
  id: string;
  jobId: string;
  label: string;
  message: string;
  createdAt: string;
  acked: boolean;
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
  const res = await fetch('/api/scheduler/jobs');
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
  const res = await fetch(`/api/scheduler/runs/${encodeURIComponent(jobId)}`);
  if (!res.ok) {
    throw new Error(`Failed to load run history (${res.status})`);
  }
  const body = (await res.json()) as { runs?: SchedulerRun[] };
  return body.runs ?? [];
}

/** Unacknowledged in-app reminders. */
export async function fetchSchedulerNotifications(): Promise<SchedulerNotification[]> {
  const res = await fetch('/api/scheduler/notifications');
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
