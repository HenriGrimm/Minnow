import { readConfigJson, updateConfigJson } from './store.js';
import { getRouterWorkspace } from '../model-routers/store.js';

/** Resolve a legacy global selection only when its pool identity is unambiguous. */
export async function readRememberedModel() {
  const saved = await readConfigJson('default-model.json');
  let value = typeof saved?.value === 'string' ? saved.value.trim() : null;
  if (typeof value === 'string' && !value.startsWith('minnow-router\u001f')) return { value, revision: Number(saved?.revision) || 0 };
  const pools = await getRouterWorkspace();
  if (!value && typeof saved?.value !== 'string') {
    const defaults = [...new Set(Object.values(pools.legacyDefaults))].filter((id) => pools.routers.some((pool) => pool.id === id && pool.enabled));
    if (defaults.length === 1) value = `minnow-router\u001f${defaults[0]}`;
  } else if (value.startsWith('minnow-router\u001f')) {
    const id = value.slice('minnow-router\u001f'.length);
    if (!pools.routers.some((pool) => pool.id === id)) {
      const matches = [...new Set(Object.entries(pools.aliases).filter(([key]) => key.endsWith(`:${id}`)).map(([, id]) => id))];
      if (matches.length === 1) value = `minnow-router\u001f${matches[0]}`;
    }
  }
  if (value && value !== saved?.value) {
    return updateConfigJson('default-model.json', (current) => current?.value === saved?.value || !current?.value
      ? { value, revision: (Number(current?.revision) || 0) + 1 } : current);
  }
  return { value, revision: Number(saved?.revision) || 0 };
}
