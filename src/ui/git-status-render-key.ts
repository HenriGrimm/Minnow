import type { GitOpResult } from '../state/git-api';

/** Only fields rendered in a change list; file contents are refreshed separately. */
export function gitStatusRenderKey(cwd: string | undefined, status: GitOpResult): string {
  return JSON.stringify([
    cwd ?? '',
    ...[status.staged, status.unstaged, status.untracked].map((files) =>
      (files ?? []).map(({ path, status }) => [path, status]),
    ),
  ]);
}
