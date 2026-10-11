/**
 * Client wrappers for the forge layer of /api/git — pull requests and CI via `gh`.
 *
 * Every call can come back unavailable (no remote, non-GitHub remote, gh missing,
 * gh signed out). Callers render `ForgeStatus.reason` rather than an empty list.
 */

import { isLocalServerAvailable, setLocalServerAvailable } from '../tools/config.ts';
import { reportBackgroundError } from '../boot/report-background-error.ts';

export type ForgeHost =
  | 'github'
  | 'github-enterprise'
  | 'gitlab'
  | 'bitbucket'
  | 'other'
  | 'none';

/** Rolled-up check state for a branch or pull request. */
export type CheckState = 'success' | 'failure' | 'pending' | 'none';

export interface ForgeStatus {
  ok: boolean;
  host: ForgeHost;
  hostname: string;
  remoteUrl: string;
  /** `owner/name` when it could be parsed from the remote. */
  repo: string;
  /** True only when PR and CI operations will actually work. */
  supported: boolean;
  cliInstalled: boolean;
  cliVersion: string;
  authenticated: boolean;
  /** Plain-language explanation when `supported` is false. */
  reason: string;
}

export interface PullRequestSummary {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  author: string;
  headRef: string;
  baseRef: string;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  url: string;
  reviewDecision: string;
  mergeable: string;
  labels: { name: string; color: string }[];
  checks: CheckState;
  checkCount: number;
}

export interface PullRequestDetail extends PullRequestSummary {
  body: string;
  mergeStateStatus: string;
  crossRepository: boolean;
  files: { path: string; additions: number; deletions: number }[];
  commits: { sha: string; subject: string; author: string }[];
  reviews: { author: string; state: string; body: string }[];
  statusChecks: { name: string; status: string; conclusion: string; url: string }[];
}

export interface WorkflowRunSummary {
  id: number;
  number: number;
  title: string;
  /** Display name — basename when the workflow has no `name:` key. */
  workflow: string;
  /** Raw `workflowName` from gh, usually the file path. */
  workflowPath: string;
  status: string;
  conclusion: string;
  branch: string;
  sha: string;
  event: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  url: string;
}

export interface WorkflowJobStep {
  name: string;
  status: string;
  conclusion: string;
  number: number;
}

export interface WorkflowJob {
  id: number;
  name: string;
  status: string;
  conclusion: string;
  startedAt: string;
  completedAt: string;
  url: string;
  steps: WorkflowJobStep[];
}

export interface WorkflowRunDetail extends WorkflowRunSummary {
  jobs: WorkflowJob[];
}

export interface ForgeResult {
  hasMore?: boolean;
  ok: boolean;
  error?: string;
  status?: ForgeStatus;
  prs?: PullRequestSummary[];
  pr?: PullRequestDetail;
  runs?: WorkflowRunSummary[];
  run?: WorkflowRunDetail;
  patch?: string;
  log?: string;
  truncated?: boolean;
  totalLines?: number;
  url?: string;
  stdout?: string;
  note?: string;
}

// ── Transport ────────────────────────────────────────────────────────────────

async function postForge(
  op: string,
  args: Record<string, unknown> = {},
): Promise<ForgeResult> {
  if (!isLocalServerAvailable()) {
    return { ok: false, error: 'server_off' };
  }
  try {
    const res = await fetch('/api/git', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, ...args }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return (await res.json()) as ForgeResult;
  } catch (err) {
    setLocalServerAvailable(false);
    reportBackgroundError('forge-op', err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const UNAVAILABLE: ForgeStatus = {
  ok: false,
  host: 'none',
  hostname: '',
  remoteUrl: '',
  repo: '',
  supported: false,
  cliInstalled: false,
  cliVersion: '',
  authenticated: false,
  reason: 'The local server is not running.',
};

// ── Status ───────────────────────────────────────────────────────────────────

/** Probe what the forge layer can do for this worktree. Never rejects. */
export async function forgeStatus(cwd?: string): Promise<ForgeStatus> {
  const result = await postForge('forgeStatus', cwd ? { cwd } : {});
  return normalizeStatus(result);
}

/** Re-probe, skipping the server-side cache — use after `gh auth login`. */
export async function forgeRefresh(cwd?: string): Promise<ForgeStatus> {
  const result = await postForge('forgeRefresh', cwd ? { cwd } : {});
  return normalizeStatus(result);
}

function normalizeStatus(result: ForgeResult): ForgeStatus {
  const raw = result as unknown as Partial<ForgeStatus> & { error?: string };
  if (typeof raw?.supported !== 'boolean') {
    return { ...UNAVAILABLE, reason: raw?.error ?? UNAVAILABLE.reason };
  }
  return { ...UNAVAILABLE, ...raw } as ForgeStatus;
}

// ── Pull requests ────────────────────────────────────────────────────────────

export function prList(input?: {
  cwd?: string;
  state?: 'open' | 'closed' | 'merged' | 'all';
  limit?: number;
}): Promise<ForgeResult> {
  return postForge('prList', input ?? {});
}

export function prView(input: { cwd?: string; number: number }): Promise<ForgeResult> {
  return postForge('prView', input);
}

export function prDiff(input: { cwd?: string; number: number }): Promise<ForgeResult> {
  return postForge('prDiff', input);
}

export function prCreate(input: {
  cwd?: string;
  title?: string;
  body?: string;
  base?: string;
  draft?: boolean;
  web?: boolean;
}): Promise<ForgeResult> {
  return postForge('prCreate', input);
}

export function prMerge(input: {
  cwd?: string;
  number: number;
  method?: 'merge' | 'squash' | 'rebase';
  deleteBranch?: boolean;
  auto?: boolean;
}): Promise<ForgeResult> {
  return postForge('prMerge', input);
}

export function prCheckout(input: { cwd?: string; number: number }): Promise<ForgeResult> {
  return postForge('prCheckout', input);
}

export function prReady(input: { cwd?: string; number: number }): Promise<ForgeResult> {
  return postForge('prReady', input);
}

export function prClose(input: {
  cwd?: string;
  number: number;
  deleteBranch?: boolean;
}): Promise<ForgeResult> {
  return postForge('prClose', input);
}

// ── Workflow runs ────────────────────────────────────────────────────────────

export function runList(input?: {
  cwd?: string;
  branch?: string;
  workflow?: string;
  status?: string;
  page?: number;
  limit?: number;
}): Promise<ForgeResult> {
  return postForge('runList', input ?? {});
}

export function runView(input: { cwd?: string; id: number }): Promise<ForgeResult> {
  return postForge('runView', input);
}

export function runRerun(input: {
  cwd?: string;
  id: number;
  failedOnly?: boolean;
}): Promise<ForgeResult> {
  return postForge('runRerun', input);
}

export function runCancel(input: { cwd?: string; id: number }): Promise<ForgeResult> {
  return postForge('runCancel', input);
}

export function runLog(input: {
  cwd?: string;
  id: number;
  jobId?: number;
  failedOnly?: boolean;
  maxLines?: number;
}): Promise<ForgeResult> {
  return postForge('runLog', input);
}

/** Map a gh run's status + conclusion onto one renderable state. */
export function runState(run: {
  status: string;
  conclusion: string;
}): CheckState | 'cancelled' | 'skipped' {
  if (run.status && run.status !== 'completed') return 'pending';
  switch (run.conclusion) {
    case 'success':
      return 'success';
    case 'cancelled':
      return 'cancelled';
    case 'skipped':
    case 'neutral':
      return 'skipped';
    case '':
      return 'pending';
    default:
      return 'failure';
  }
}
