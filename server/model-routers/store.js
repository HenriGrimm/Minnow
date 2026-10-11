import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getMinnowHome } from '../config/home.js';
import { getEffectiveWorkspaceRoot } from '../runtime/path-access.js';
import { normalizeWorkspacePathKey } from '../workspace/root.js';
import { RouterScheduler, validateRouters } from './scheduler.js';

const workspaces = new Map();

export async function getRouterWorkspace() {
  const root = path.resolve(getEffectiveWorkspaceRoot());
  const key = normalizeWorkspacePathKey(root);
  if (!workspaces.has(key)) {
    workspaces.set(key, (async () => {
      const file = path.join(getMinnowHome(), 'model-routers', `${createHash('sha256').update(key).digest('hex')}.json`);
      let saved = { routers: [], defaultRouterId: null, assignments: {} };
      try { saved = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      let writes = Promise.resolve();
      const workspace = { ...validateRouters(saved), revision: saved.revision || 0, scheduler: null, flush: () => writes };
      const persist = () => {
        const content = JSON.stringify({ routers: workspace.routers, defaultRouterId: workspace.defaultRouterId, revision: workspace.revision, assignments: workspace.scheduler.assignments, decisions: Object.fromEntries(workspace.scheduler.decisions) });
        writes = writes.catch(() => {}).then(async () => {
          await fs.mkdir(path.dirname(file), { recursive: true });
          const temporary = `${file}.tmp`;
          await fs.writeFile(temporary, content, { mode: 0o600 });
          await fs.rename(temporary, file);
        });
        return writes;
      };
      workspace.scheduler = new RouterScheduler({ assignments: saved.assignments || {}, decisions: saved.decisions || {}, onAssignment: () => { void persist().catch((error) => console.error('[model-routers] assignment save:', error.message)); } });
      workspace.save = async (value) => {
        if (value.revision !== workspace.revision) throw new Error('Routers changed in another window. Reload before saving.');
        const validated = validateRouters(value);
        workspace.routers = validated.routers;
        workspace.defaultRouterId = validated.defaultRouterId;
        workspace.revision++;
        await persist();
      };
      return workspace;
    })().catch((error) => { workspaces.delete(key); throw error; }));
  }
  return workspaces.get(key);
}
