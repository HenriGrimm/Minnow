/**
 * Sync hook from issue writes to GitHub auto-sync.
 *
 * Lives in its own file so `issues-store` can notify without importing the
 * scheduler (and its GitHub/network module) at load time.
 */

type GithubSyncedFieldListener = (issueId: string) => void;

const listeners = new Set<GithubSyncedFieldListener>();
/** Issue id → whether a write arrived while its notifications were deferred. */
const deferred = new Map<string, boolean>();

/** Called for new local issues and edits to GitHub-shaped fields. */
export function notifyGithubSyncedFieldWrite(issueId: string): void {
  const id = issueId.trim();
  if (!id) return;
  if (deferred.has(id)) {
    deferred.set(id, true);
    return;
  }
  for (const listener of [...listeners]) {
    try {
      listener(id);
    } catch {}
  }
}

/**
 * Hold sync notifications for one issue (e.g. while a new issue is expanded)
 * so the first GitHub sync carries the finished content. Idempotent.
 */
export function deferGithubSyncedFieldWrites(issueId: string): void {
  const id = issueId.trim();
  if (id && !deferred.has(id)) deferred.set(id, false);
}

/** End a deferral; sends one notification when any write arrived meanwhile. */
export function releaseGithubSyncedFieldWrites(issueId: string): void {
  const id = issueId.trim();
  const pending = deferred.get(id);
  if (pending === undefined) return;
  deferred.delete(id);
  if (pending) notifyGithubSyncedFieldWrite(id);
}

export function isGithubSyncedFieldWriteDeferred(issueId: string): boolean {
  return deferred.has(issueId.trim());
}

/** Auto-sync registers here when its module loads. */
export function subscribeGithubSyncedFieldWrite(
  listener: GithubSyncedFieldListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tests: drop listeners so a leftover scheduler cannot leak across files. */
export function resetGithubSyncedFieldWriteForTests(): void {
  listeners.clear();
  deferred.clear();
}
