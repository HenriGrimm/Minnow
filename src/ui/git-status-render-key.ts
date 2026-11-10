import type { GitOpResult } from '../state/git-api';

/** Only fields rendered in a change list; file contents are refreshed separately. */
export function gitStatusRenderKey(cwd: string | undefined, status: GitOpResult): string {
  return JSON.stringify([
    cwd ?? '',
    ...[status.staged, status.unstaged, status.untracked, status.conflicted].map((files) =>
      (files ?? []).map(({ path, status, additions, deletions }) => [path, status, additions ?? null, deletions ?? null]),
    ),
  ]);
}
