import { countPatchLineStats, type GitPatchFileEntry } from './git-patch-files';

export type CommitFileStatus = 'Added' | 'Modified' | 'Deleted' | 'Renamed';

export interface CommitReviewFile {
  path: string;
  oldPath?: string;
  status: CommitFileStatus;
  additions: number;
  deletions: number;
}

export interface GitCommitReview {
  sha: string;
  cwd?: string;
  files: readonly CommitReviewFile[];
  selectedPath: string | null;
}

let review: GitCommitReview | null = null;
const listeners = new Set<(next: GitCommitReview | null, previous: GitCommitReview | null) => void>();

export function normalizeReviewPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
}

export function commitReviewMatchesWorkspace(commit: GitCommitReview, workspace: string): boolean {
  if (!commit.cwd) return true;
  const normalize = (path: string) => {
    const value = normalizeReviewPath(path);
    return /^(?:[a-z]:|\/\/)/i.test(value) ? value.toLowerCase() : value;
  };
  return normalize(commit.cwd) === normalize(workspace);
}

export function getGitCommitReview(): GitCommitReview | null {
  return review;
}

export function subscribeGitCommitReview(
  listener: (next: GitCommitReview | null, previous: GitCommitReview | null) => void,
): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function publish(next: GitCommitReview | null): void {
  const previous = review;
  review = next;
  for (const listener of listeners) listener(next, previous);
}

export function setGitCommitReview(sha: string, cwd: string | undefined, entries: GitPatchFileEntry[]): void {
  const files = entries.map((entry): CommitReviewFile => ({
    path: normalizeReviewPath(entry.path),
    ...(entry.oldPath ? { oldPath: normalizeReviewPath(entry.oldPath) } : {}),
    status: entry.oldPath ? 'Renamed'
      : /^new file mode /m.test(entry.patch) ? 'Added'
      : /^deleted file mode /m.test(entry.patch) ? 'Deleted' : 'Modified',
    ...countPatchLineStats(entry.patch),
  }));
  publish({ sha, cwd, files, selectedPath: files[0]?.path ?? null });
}

/** Selecting an unchanged file is valid; the diff pane explains that it has no patch. */
export function selectGitCommitReviewFile(path: string): void {
  if (!review) return;
  const normalized = normalizeReviewPath(path);
  const selectedPath = review.files.find((file) => file.path === normalized || file.oldPath === normalized)?.path ?? normalized;
  if (selectedPath === review.selectedPath) return;
  publish({ ...review, selectedPath });
}

export function clearGitCommitReview(): void {
  if (review) publish(null);
}
