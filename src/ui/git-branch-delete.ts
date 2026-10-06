import type { GitOpResult } from '../state/git-api';

/** Only an unmerged-branch refusal can be resolved by deleting with -D. */
export function isUnmergedBranchDelete(result: Pick<GitOpResult, 'ok' | 'error'>): boolean {
  return !result.ok && /\bnot fully merged\b/i.test(result.error ?? '');
}
