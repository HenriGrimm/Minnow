import type { IssuesState } from '../types';
import { mergeIssuesState as merge } from '../lib/merge-issues-state.mjs';

/** Shared three-way merge used by renderer and server transactions. */
export function mergeIssuesState(base: IssuesState, local: IssuesState, remote: IssuesState): IssuesState {
  return merge(base, local, remote);
}
