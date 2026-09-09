/**
 * Browser client for /api/brain/* when npm start is running.
 */

import { isLocalServerAvailable } from '../tools/config';
import type {
  BrainCodeCallsOfResult,
  BrainCodeConfig,
  BrainCodeExplainResult,
  BrainCodeFindResult,
  BrainCodeGitHookInstallResult,
  BrainCodeGitHookStatus,
  BrainCodeReadSymbolResult,
  BrainCodeReindexResult,
  BrainCodeRepoMap,
  BrainCodeStatus,
  BrainCodeWhoCallsResult,
  BrainIngestResult,
  BrainCleanupExecuteResult,
  BrainCleanupPlanResponse,
  BrainCleanupPlanResult,
  BrainLintReport,
  BrainPruneLinksReport,
  BrainUsageReport,
  BrainPage,
  BrainStatus,
  BrainTreeNode,
} from './types';

const API_BASE = '';

/** Default timeout for Brain API calls (ms). */
const BRAIN_FETCH_TIMEOUT_MS = 120_000;

async function brainFetch<T>(
  path: string,
  init?: RequestInit,
  timeoutMs: number = BRAIN_FETCH_TIMEOUT_MS,
): Promise<T | null> {
  if (!isLocalServerAvailable()) return null;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal;
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── Wiki ─────────────────────────────────────────────────────────────────────

/** Ping brain API. */
export async function pingBrainApi(): Promise<boolean> {
  const data = await brainFetch<{ ok: boolean }>('/api/brain/ping');
  return data?.ok === true;
}

/** Wiki store status. */
export async function fetchBrainStatus(): Promise<BrainStatus | null> {
  return brainFetch<BrainStatus>('/api/brain/status');
}

/** Brain embeddings health (archive policy gate). */
export async function fetchBrainEmbeddingsStatus(): Promise<{
  enabled: boolean;
  healthy: boolean;
  model?: string;
  backend?: string;
} | null> {
  return brainFetch('/api/brain/embeddings/status');
}

/** Nested folder tree of wiki pages. */
export async function fetchBrainTree(): Promise<BrainTreeNode | null> {
  const data = await brainFetch<{ tree: BrainTreeNode }>('/api/brain/tree');
  return data?.tree ?? null;
}

/** Read one wiki page by relative path (e.g. facts/slug.md). */
export async function fetchBrainPage(relPath: string): Promise<BrainPage | null> {
  const qs = new URLSearchParams({ path: relPath });
  return brainFetch<BrainPage>(`/api/brain/page?${qs}`);
}

/** Create or update a wiki page. */
export async function saveBrainPage(input: {
  path: string;
  title?: string;
  body?: string;
  tags?: string[];
  source?: string;
  summary?: string;
  pinned?: boolean;
}): Promise<BrainPage | null> {
  return brainFetch<BrainPage>('/api/brain/page', {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

/** Read log.md changelog. */
export async function fetchBrainLog(): Promise<string | null> {
  const data = await brainFetch<{ log: string }>('/api/brain/log');
  if (!data) return null;
  return data.log ?? '';
}

/** Read schema.md. */
export async function fetchBrainSchema(): Promise<string | null> {
  const data = await brainFetch<{ schema: string }>('/api/brain/schema');
  if (!data) return null;
  return data.schema ?? '';
}

/** Write schema.md. */
export async function saveBrainSchema(schema: string): Promise<boolean> {
  const data = await brainFetch<{ ok: boolean }>('/api/brain/schema', {
    method: 'PUT',
    body: JSON.stringify({ schema }),
  });
  return data?.ok === true;
}

/** Ingest raw source text into synthesized wiki pages. */
export async function ingestBrainSource(input: {
  content: string;
  filename?: string;
  title?: string;
}): Promise<BrainIngestResult | null> {
  return brainFetch<BrainIngestResult>('/api/brain/ingest', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** Run wiki health lint (orphans, stale, broken links). */
export async function lintBrainWiki(options?: {
  includeLlm?: boolean;
  apply?: boolean;
}): Promise<BrainLintReport | null> {
  return brainFetch<BrainLintReport>('/api/brain/lint', {
    method: 'POST',
    body: JSON.stringify({
      includeLlm: options?.includeLlm !== false,
      apply: options?.apply === true,
    }),
  });
}

/**
 * Re-score existing `similarTo` edges against the current linking floors.
 * Reports without writing unless `apply` is true.
 */
export async function pruneBrainWeakLinks(options?: {
  apply?: boolean;
}): Promise<BrainPruneLinksReport | null> {
  return brainFetch<BrainPruneLinksReport>('/api/brain/prune-links', {
    method: 'POST',
    body: JSON.stringify({ apply: options?.apply === true }),
  });
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

function summarizeCleanupPlan(
  summary: BrainCleanupPlanResult['plan']['summary'],
): BrainCleanupPlanResponse['summary'] {
  return {
    deletes: summary.deletes?.length ?? 0,
    merges: summary.merges?.length ?? 0,
    linkFixes: summary.linkFixes?.length ?? 0,
    staleActions: summary.staleActions?.length ?? 0,
    anchorDrift: summary.anchorDrift?.length ?? 0,
    risks: summary.risks?.length ?? 0,
  };
}

/** Read-only diagnostics + LLM cleanup plan (top-bar model). */
export async function planBrainWikiCleanup(input: {
  providerId: string;
  modelId: string;
}): Promise<BrainCleanupPlanResponse | null> {
  const data = await brainFetch<BrainCleanupPlanResult>('/api/brain/cleanup/plan', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!data?.plan) return null;
  return {
    planId: data.planId,
    createdAt: data.createdAt,
    snapshotHash: data.snapshotHash,
    planMarkdown: data.plan.planMarkdown,
    planVersion: data.plan.planVersion,
    summary: summarizeCleanupPlan(data.plan.summary),
  };
}

/** Server-shaped cleanup plan (includes diagnostics + nested plan). */
export async function fetchBrainCleanupPlanRaw(input: {
  providerId: string;
  modelId: string;
}): Promise<BrainCleanupPlanResult | null> {
  return brainFetch<BrainCleanupPlanResult>('/api/brain/cleanup/plan', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** Alias for planBrainWikiCleanup. */
export const generateBrainCleanupPlan = planBrainWikiCleanup;

/** Execute a persisted cleanup plan via the trusted server agent. */
export async function executeBrainWikiCleanup(input: {
  planId: string;
  providerId: string;
  modelId: string;
}): Promise<BrainCleanupExecuteResult | null> {
  return brainFetch<BrainCleanupExecuteResult>('/api/brain/cleanup/execute', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** Weekly Brain read/write counters. */
export async function fetchBrainUsage(): Promise<BrainUsageReport | null> {
  return brainFetch<BrainUsageReport>('/api/brain/usage');
}

// ── Code index ───────────────────────────────────────────────────────────────

/** Code index status for the active workspace. */
export async function fetchBrainCodeStatus(options?: {
  workspaceRoot?: string;
}): Promise<BrainCodeStatus | null> {
  const qs = new URLSearchParams();
  if (options?.workspaceRoot?.trim()) {
    qs.set('workspaceRoot', options.workspaceRoot.trim());
  }
  const suffix = qs.toString() ? `?${qs}` : '';
  return brainFetch<BrainCodeStatus>(`/api/brain/code/status${suffix}`);
}

/** Load config.brain.code settings. */
export async function fetchBrainCodeConfig(): Promise<BrainCodeConfig | null> {
  const data = await brainFetch<{ code: BrainCodeConfig }>('/api/brain/code/config');
  return data?.code ?? null;
}

/** Persist partial config.brain.code settings. */
export async function saveBrainCodeConfig(
  partial: Partial<BrainCodeConfig>,
): Promise<BrainCodeConfig | null> {
  if (!isLocalServerAvailable()) return null;
  try {
    const res = await fetch(`${API_BASE}/api/brain/code/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { code: BrainCodeConfig };
    return data.code ?? null;
  } catch {
    return null;
  }
}

/** Reindex the workspace code graph through the cascade engine. */
export async function reindexBrainCode(options?: {
  workspaceRoot?: string;
}): Promise<BrainCodeReindexResult | null> {
  return brainFetch<BrainCodeReindexResult>('/api/brain/code/reindex', {
    method: 'POST',
    body: JSON.stringify({
      ...(options?.workspaceRoot?.trim()
        ? { workspaceRoot: options.workspaceRoot.trim() }
        : {}),
    }),
  });
}

/** Install the optional git post-commit cascade hook in the active workspace. */
export async function installBrainGitHook(): Promise<BrainCodeGitHookInstallResult | null> {
  if (!isLocalServerAvailable()) return null;
  try {
    const res = await fetch(`${API_BASE}/api/brain/code/git-hook/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as BrainCodeGitHookInstallResult;
    if (!res.ok) {
      return { installed: false, error: body.error ?? `Install failed (${res.status})` };
    }
    return body;
  } catch {
    return null;
  }
}

/** Remove the Minnow block from the workspace post-commit hook. */
export async function uninstallBrainGitHook(): Promise<{ ok: boolean; removed: boolean } | null> {
  return brainFetch<{ ok: boolean; removed: boolean }>('/api/brain/code/git-hook/uninstall', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/** Report whether the git post-commit hook is installed. */
export async function fetchBrainGitHookStatus(): Promise<BrainCodeGitHookStatus | null> {
  return brainFetch<BrainCodeGitHookStatus>('/api/brain/code/git-hook/status');
}

/** Token-budgeted signature repo map. */
export async function fetchBrainCodeRepoMap(options?: {
  repo?: string;
  /** One substring, or several matched as OR. */
  focus?: string | string[];
  tokenBudget?: number;
  ensureIndexed?: boolean;
  profile?: 'default' | 'injection';
  workspaceRoot?: string;
}): Promise<BrainCodeRepoMap | null> {
  const focusList = Array.isArray(options?.focus)
    ? options.focus.map((f) => f.trim()).filter(Boolean)
    : options?.focus?.trim()
      ? [options.focus.trim()]
      : [];
  const postBody =
    options &&
    (options.repo?.trim() ||
      options.ensureIndexed === true ||
      options.profile === 'injection' ||
      focusList.length > 1 ||
      options.workspaceRoot?.trim());
  if (postBody) {
    const opts = options;
    return brainFetch<BrainCodeRepoMap>('/api/brain/code/repo-map', {
      method: 'POST',
      body: JSON.stringify({
        ...(opts.repo?.trim() ? { repo: opts.repo.trim() } : {}),
        ...(focusList.length ? { focus: focusList } : {}),
        ...(opts.tokenBudget && opts.tokenBudget > 0
          ? { tokenBudget: opts.tokenBudget }
          : {}),
        ...(opts.ensureIndexed === true ? { ensureIndexed: true } : {}),
        ...(opts.profile === 'injection' ? { profile: 'injection' } : {}),
        ...(opts.workspaceRoot?.trim()
          ? { workspaceRoot: opts.workspaceRoot.trim() }
          : {}),
      }),
    });
  }
  const qs = new URLSearchParams();
  if (focusList.length) qs.set('focus', focusList[0]);
  if (options?.tokenBudget && options.tokenBudget > 0) {
    qs.set('tokenBudget', String(options.tokenBudget));
  }
  if (options?.workspaceRoot?.trim()) {
    qs.set('workspaceRoot', options.workspaceRoot.trim());
  }
  const suffix = qs.toString() ? `?${qs}` : '';
  return brainFetch<BrainCodeRepoMap>(`/api/brain/code/repo-map${suffix}`);
}

/** FTS5 + LSP symbol search. */
export async function findBrainCodeSymbol(
  query: string,
  limit = 20,
  options?: { workspaceRoot?: string },
): Promise<BrainCodeFindResult | null> {
  const qs = new URLSearchParams({
    query: query.trim(),
    limit: String(limit),
  });
  if (options?.workspaceRoot?.trim()) {
    qs.set('workspaceRoot', options.workspaceRoot.trim());
  }
  return brainFetch<BrainCodeFindResult>(`/api/brain/code/find-symbol?${qs}`);
}

/** Incoming call edges for a symbol. */
export async function fetchBrainCodeWhoCalls(
  symbol: string,
  options?: { workspaceRoot?: string },
): Promise<BrainCodeWhoCallsResult | null> {
  const qs = new URLSearchParams({ symbol });
  if (options?.workspaceRoot?.trim()) {
    qs.set('workspaceRoot', options.workspaceRoot.trim());
  }
  return brainFetch<BrainCodeWhoCallsResult>(`/api/brain/code/who-calls?${qs}`);
}

/** Outgoing call edges for a symbol. */
export async function fetchBrainCodeCallsOf(
  symbol: string,
  options?: { workspaceRoot?: string },
): Promise<BrainCodeCallsOfResult | null> {
  const qs = new URLSearchParams({ symbol });
  if (options?.workspaceRoot?.trim()) {
    qs.set('workspaceRoot', options.workspaceRoot.trim());
  }
  return brainFetch<BrainCodeCallsOfResult>(`/api/brain/code/calls-of?${qs}`);
}

/** Read the live source span for a symbol. */
export async function fetchBrainCodeReadSymbol(
  symbol: string,
  options?: { workspaceRoot?: string },
): Promise<BrainCodeReadSymbolResult | null> {
  const qs = new URLSearchParams({ symbol });
  if (options?.workspaceRoot?.trim()) {
    qs.set('workspaceRoot', options.workspaceRoot.trim());
  }
  return brainFetch<BrainCodeReadSymbolResult>(`/api/brain/code/read-symbol?${qs}`);
}

/** Wiki pages that anchor a symbol (code → meaning). */
export async function fetchBrainCodeExplain(
  symbol: string,
  options?: { workspaceRoot?: string },
): Promise<BrainCodeExplainResult | null> {
  const qs = new URLSearchParams({ symbol });
  if (options?.workspaceRoot?.trim()) {
    qs.set('workspaceRoot', options.workspaceRoot.trim());
  }
  return brainFetch<BrainCodeExplainResult>(`/api/brain/code/explain?${qs}`);
}

export type BrainMutationResult = {
  ok: boolean;
  error?: string;
  removed?: number;
  archivePath?: string;
  workspaceKeys?: string[];
};

// ── Mutations ────────────────────────────────────────────────────────────────

/** POST helper for destructive Brain APIs — surfaces server errors instead of silent null. */
async function brainMutate<T extends Record<string, unknown>>(
  path: string,
  body: Record<string, unknown>,
): Promise<BrainMutationResult & T> {
  if (!isLocalServerAvailable()) {
    return { ok: false, error: 'Offline — open Minnow.' } as BrainMutationResult & T;
  }
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) {
      return {
        ok: false,
        error: typeof data.error === 'string' ? data.error : `Request failed (${res.status})`,
      } as BrainMutationResult & T;
    }
    return { ok: true, ...data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message } as BrainMutationResult & T;
  }
}

/** Delete one wiki page by relative path. */
export async function deleteBrainPage(relPath: string): Promise<BrainMutationResult> {
  if (!isLocalServerAvailable()) {
    return { ok: false, error: 'Offline — open Minnow.' };
  }
  try {
    const qs = new URLSearchParams({ path: relPath });
    const res = await fetch(`${API_BASE}/api/brain/page?${qs}`, { method: 'DELETE' });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      return {
        ok: false,
        error: typeof data.error === 'string' ? data.error : `Request failed (${res.status})`,
      };
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/** Clear all wiki pages (optional backup first). */
export async function clearBrainWiki(archive = false): Promise<BrainMutationResult> {
  return brainMutate('/api/brain/clear', { archive, confirmed: true });
}

/** Delete an entire chat archive folder. */
export async function deleteBrainArchive(
  chatId: string,
  workspaceKey?: string,
): Promise<BrainMutationResult> {
  if (!isLocalServerAvailable()) {
    return { ok: false, error: 'Offline — open Minnow.' };
  }
  try {
    const qs = workspaceKey
      ? `?workspaceKey=${encodeURIComponent(workspaceKey)}`
      : '';
    const res = await fetch(`${API_BASE}/api/brain/archive/chat/${encodeURIComponent(chatId)}${qs}`, {
      method: 'DELETE',
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; removed?: number };
    if (!res.ok) {
      return {
        ok: false,
        error: typeof data.error === 'string' ? data.error : `Request failed (${res.status})`,
      };
    }
    return { ok: true, removed: data.removed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/** Clear pending or all memory proposals. */
export async function clearBrainProposals(
  scope: 'pending' | 'all' = 'pending',
): Promise<BrainMutationResult> {
  return brainMutate('/api/brain/proposals/clear', { scope, confirmed: true });
}

/** Reset the code index for the current workspace or all workspaces. */
export async function clearBrainCodeIndex(opts?: {
  all?: boolean;
  workspaceRoot?: string;
}): Promise<BrainMutationResult> {
  return brainMutate('/api/brain/code/clear', {
    all: opts?.all === true,
    confirmed: true,
    ...(opts?.workspaceRoot?.trim() ? { workspaceRoot: opts.workspaceRoot.trim() } : {}),
  });
}

/** Delete raw ingest source files (optional backup first). */
export async function clearBrainSources(archive = false): Promise<BrainMutationResult> {
  return brainMutate('/api/brain/sources/clear', { archive, confirmed: true });
}

/** Snapshot ~/.minnow/brain/ to ~/.minnow/backups/. */
export async function backupBrain(): Promise<{ ok: boolean; path?: string; error?: string }> {
  const data = await brainMutate<{ path?: string }>('/api/brain/backup', {});
  if (!data.ok) return data;
  return { ok: true, path: data.path };
}
