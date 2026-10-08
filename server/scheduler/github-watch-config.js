/** Scheduler watcher configuration; runtime state is never accepted from the client. */
export function normalizeGithubWatch(value, workspacePath) {
  if (value == null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('githubWatch must be an object');
  }
  const repository = String(value.repository ?? '').trim();
  if (!/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i.test(repository) || repository.endsWith('/..')) {
    throw new Error('GitHub repository must be owner/repository');
  }
  if (!String(workspacePath ?? '').trim()) throw new Error('Choose a repository workspace for the GitHub watcher');
  return { repository: repository.toLowerCase(), label: 'minnow' };
}
