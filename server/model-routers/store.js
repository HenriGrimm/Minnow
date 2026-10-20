import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getMinnowHome } from '../config/home.js';
import { getEffectiveWorkspaceRoot } from '../runtime/path-access.js';
import { normalizeWorkspacePathKey } from '../workspace/root.js';
import { RouterScheduler, validateRouters, entryKey } from './scheduler.js';
import { getAllowanceTracker } from '../generations/allowance.js';

const stores = new Map();
const digest = (value) => createHash('sha256').update(value).digest('hex');

async function atomicWrite(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

/** The retained sources are the recovery manifest until the atomic global commit. */
async function migrate(directory, file) {
  const saved = { version: 2, routers: [], defaultRouterId: null, revision: 0, assignments: {}, decisions: {}, aliases: {}, legacyDefaults: {} };
  const files = await fs.readdir(directory).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
  const definitions = new Map();
  for (const name of files.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort()) {
    const source = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
    const validated = validateRouters(source);
    const scope = name.slice(0, -5);
    for (const router of validated.routers) {
      const signature = JSON.stringify(router);
      let id = definitions.get(signature);
      if (!id) {
        id = `pool-${digest(signature).slice(0, 32)}`;
        definitions.set(signature, id);
        let name = router.name;
        let suffix = 2;
        while (saved.routers.some((row) => row.name === name)) name = `${router.name.slice(0, 90)} (${suffix++})`;
        saved.routers.push({ ...router, id, name });
      }
      saved.aliases[`${scope}:${router.id}`] = id;
    }
    if (source.defaultRouterId) saved.legacyDefaults[scope] = saved.aliases[`${scope}:${source.defaultRouterId}`];
    for (const [field, rows] of [['assignments', source.assignments], ['decisions', source.decisions]]) {
      for (const row of Object.values(rows || {})) {
        const routerId = saved.aliases[`${scope}:${row.routerId}`];
        if (!routerId || !row.chatId) continue;
        const key = JSON.stringify([routerId, row.chatId]);
        const value = { ...row, routerId };
        if (saved[field][key] && JSON.stringify(saved[field][key]) !== JSON.stringify(value)) throw new Error(`Conflicting legacy pool ${field} in ${name}; original files were preserved`);
        saved[field][key] = value;
      }
    }
  }
  await atomicWrite(file, saved);
  return saved;
}

async function openStore(home) {
  const directory = path.join(home, 'model-routers');
  const file = path.join(directory, 'global-v2.json');
  let saved;
  try { saved = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; saved = await migrate(directory, file); }
  if (saved.version !== 2) throw new Error('Unsupported global model pool version');
  let writes = Promise.resolve();
  const store = { ...validateRouters({ ...saved, defaultRouterId: null }, { maxRouters: Math.max(1000, saved.routers?.length || 0) }), revision: saved.revision || 0, aliases: saved.aliases || {}, legacyDefaults: saved.legacyDefaults || {}, scheduler: null };
  const persist = () => {
    const content = { version: 2, routers: store.routers, defaultRouterId: null, revision: store.revision, aliases: store.aliases, legacyDefaults: store.legacyDefaults, assignments: store.scheduler.assignments, decisions: Object.fromEntries(store.scheduler.decisions) };
    const snapshot = structuredClone(content);
    writes = writes.catch(() => {}).then(() => atomicWrite(file, snapshot));
    return writes;
  };
  store.flush = () => writes;
  store.scheduler = new RouterScheduler({ assignments: saved.assignments || {}, decisions: saved.decisions || {}, onAssignment: () => { void persist().catch((error) => console.error('[model-pools] save:', error.message)); } });
  store.scheduler.capacityLimit = (entry) => {
    const limits = store.routers.filter((router) => router.enabled).flatMap((router) => router.entries.filter((candidate) => candidate.enabled && entryKey(candidate) === entryKey(entry)).map((candidate) => candidate.concurrencyLimit));
    return limits.length ? Math.min(...limits) : entry.concurrencyLimit;
  };
  const allowances = await getAllowanceTracker();
  allowances.listeners.add(() => {
    // Invalidate waiters synchronously before the failing attempt releases its slot.
    // They recheck eligibility in generation.js, outside the admission queue.
    for (const request of [...store.scheduler.requests.values()]) {
      if (request.status === 'queued' && request.allowanceContext && !allowances.availability(request.allowanceContext).available) {
        store.scheduler.rejectQueued(request.requestId, 'Provider allowance changed; selecting an available model');
      }
    }
  });
  let saves = Promise.resolve();
  store.save = (value) => {
    const input = structuredClone(value);
    const save = saves.catch(() => {}).then(async () => {
      const value = input;
      if (value.revision !== store.revision) throw new Error('Model pools changed in another window. Reload before saving.');
      const validated = validateRouters({ ...value, defaultRouterId: null }, { maxRouters: Math.max(1000, store.routers.length) });
      const previous = store.routers;
      store.routers = validated.routers;
      store.revision++;
      try { await persist(); }
      catch (error) { store.routers = previous; store.revision--; throw error; }
    });
    saves = save;
    return save;
  };
  return store;
}

/** Compatibility name; definitions and admission now belong to the Minnow home. */
export async function getRouterWorkspace() {
  const home = path.resolve(getMinnowHome());
  if (!stores.has(home)) stores.set(home, openStore(home).catch((error) => { stores.delete(home); throw error; }));
  return stores.get(home);
}

export function routerWorkspaceDigest(root = getEffectiveWorkspaceRoot()) {
  return digest(normalizeWorkspacePathKey(path.resolve(root)));
}

/** Resolve old journal bindings using their originating workspace, never by name. */
export async function resolveRouterId(id, root = getEffectiveWorkspaceRoot(), chatId) {
  const store = await getRouterWorkspace();
  if (store.routers.some((router) => router.id === id)) return id;
  const direct = store.aliases[`${routerWorkspaceDigest(root)}:${id}`];
  if (direct) return direct;
  if (chatId) {
    const { readChatWorkspacePath } = await import('../config/sessions-repo.js');
    const origin = readChatWorkspacePath(chatId);
    const fromChat = origin && store.aliases[`${routerWorkspaceDigest(origin)}:${id}`];
    if (fromChat) return fromChat;
  }
  const candidates = [...new Set(Object.entries(store.aliases).filter(([key]) => key.endsWith(`:${id}`)).map(([, value]) => value))];
  return candidates.length === 1 ? candidates[0] : id;
}
