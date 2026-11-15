import { prepareWorktreeEnvironment } from './local-environment.js';
import { ensureDependencyDirs } from './dep-symlinks.js';

/** Environment files must exist before package lifecycle scripts can run. */
export async function prepareWorktreeDependencies(source, target, options = {}) {
  const environment = await prepareWorktreeEnvironment(source, target, options);
  if (!environment.ok) {
    return { ok: false, linked: [], repaired: [], installed: [], environment,
      failed: environment.failed.map(item => ({ dir: item.file ?? 'environment', reason: item.reason })) };
  }
  return ensureDependencyDirs(source, target, options);
}
