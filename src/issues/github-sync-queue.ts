/** Keep bulk sync bounded while parents acquire identities before children. */
export const GITHUB_SYNC_CONCURRENCY = 3;

export async function runGithubSyncQueue<T extends { parentId?: string }>(
  issues: readonly T[],
  sync: (issue: T) => Promise<void>,
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  // Issue hierarchy is one level. Finish the parent phase before starting children.
  for (const children of [false, true]) {
    const phase = issues.filter((issue) => Boolean(issue.parentId) === children);
    let next = 0;
    async function worker(): Promise<void> {
      while (next < phase.length && shouldContinue()) {
        const issue = phase[next++];
        await sync(issue);
      }
    }
    await Promise.all(Array.from({ length: Math.min(GITHUB_SYNC_CONCURRENCY, phase.length) }, worker));
  }
}
