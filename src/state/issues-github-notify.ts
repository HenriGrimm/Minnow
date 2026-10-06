/**
 * Sync hook from issue writes to GitHub auto-sync.
 *
 * Lives in its own file so `issues-store` can notify without importing the
 * scheduler (and its GitHub/network module) at load time.
 */

type GithubSyncedFieldListener = (issueId: string) => void;

const listeners = new Set<GithubSyncedFieldListener>();

/** Called for new local issues and edits to GitHub-shaped fields. */
export function notifyGithubSyncedFieldWrite(issueId: string): void {
  const id = issueId.trim();
  if (!id) return;
  for (const listener of [...listeners]) {
    try {
      listener(id);
    } catch {}
  }
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
}
