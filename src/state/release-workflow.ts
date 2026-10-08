import type { ActionWorkflow } from './actions-api';

export type ReleaseWorkflow = Pick<ActionWorkflow, 'id' | 'path' | 'name'>;
const key = (repo: string) => `minnow.scc.releaseWorkflow.${repo.toLowerCase()}`;

export function getReleaseWorkflow(repo: string): ReleaseWorkflow | null {
  if (!repo) return null;
  try {
    const value = JSON.parse(localStorage.getItem(key(repo)) || 'null');
    return value && (typeof value.id === 'string' || typeof value.id === 'number') &&
      typeof value.path === 'string' && typeof value.name === 'string' ? value : null;
  } catch {
    return null;
  }
}

export function setReleaseWorkflow(repo: string, workflow: ReleaseWorkflow | null): void {
  if (!repo) throw new Error('Repository identity is unavailable. Reload Workflows and try again.');
  if (workflow) localStorage.setItem(key(repo), JSON.stringify({
    id: workflow.id, path: workflow.path, name: workflow.name,
  }));
  else localStorage.removeItem(key(repo));
}
