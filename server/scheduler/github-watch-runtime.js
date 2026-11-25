/**
 * GitHub Issue Watcher runtime — retired with Orchestrate boards.
 *
 * The watcher planned each labelled issue into a board and opened a PR when the
 * board finished. Boards are gone; the Maintenance factory
 * (documentation/plans/maintenance-factory.md) replaces this flow. Existing
 * watcher jobs stay in the Scheduler so their ledgers remain readable, but every
 * run reports that the engine is retired instead of claiming new issues.
 */

/** `owner/name` for a GitHub remote URL, or null for any other remote. */
export function githubRepositoryFromRemote(remote) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)\/?$/i.exec(remote.trim());
  return match ? match[1].replace(/\.git$/i, '').toLowerCase() : null;
}

export const GITHUB_WATCH_RETIRED_SUMMARY =
  'The Issue Watcher ran on Orchestrate boards, which Minnow no longer runs. Disable or delete this job; issues already claimed keep their history.';

/** Every run is a no-op that reports the retirement once per poll. */
export async function runGithubWatch() {
  return { blocked: true, changed: false, summary: GITHUB_WATCH_RETIRED_SUMMARY };
}
