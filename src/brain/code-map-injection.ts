/**
 * Fetch token-budgeted repo map text for system prompt injection.
 */

import { brainWorkspaceKeyFromPath } from '../lib/brain-workspace-key';
import { wrapUntrusted } from '../lib/untrusted.mjs';
import { fetchBrainCodeConfig, fetchBrainCodeRepoMap } from './client';

export interface RetrieveCodeMapBlockOptions {
  /** Absolute workspace or worktree root for repo key resolution. */
  repoPath: string;
  /** One substring, or several matched as OR. */
  focus?: string | string[];
  tokenBudget?: number;
  ensureIndexed?: boolean;
  /** Injection uses a higher-signal profile on the server (default for this helper). */
  profile?: 'default' | 'injection';
}

/** Ranked repo map wrapped for untrusted prompt injection; empty when unavailable. */
export async function retrieveCodeMapBlock(
  options: RetrieveCodeMapBlockOptions,
): Promise<string> {
  const config = await fetchBrainCodeConfig();
  if (!config?.enabled) return '';

  const repoPath = options.repoPath.trim();
  if (!repoPath) return '';

  const repo = brainWorkspaceKeyFromPath(repoPath);
  const profile = options.profile ?? 'injection';
  const defaultBudget =
    profile === 'injection'
      ? config.repoMapInjectionTokenBudget ?? config.repoMapTokenBudget
      : config.repoMapTokenBudget;

  const map = await fetchBrainCodeRepoMap({
    repo,
    focus: options.focus,
    tokenBudget: options.tokenBudget ?? defaultBudget,
    ensureIndexed: options.ensureIndexed === true,
    profile,
  });

  const text = map?.text?.trim() ?? '';
  if (!text) return '';
  return wrapUntrusted(text, { source: 'code-map' });
}
