import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import path from 'node:path';

const epoch = randomUUID();
let version = 0;
const listeners = new Set();
let watchedHome;
let watchers = [];

/** Legacy files can be edited outside Settings. No directory scan on warm reads. */
export function watchPluginCatalog(home) {
  if (watchedHome === home) return;
  for (const watcher of watchers) watcher.close();
  watchers = [];
  watchedHome = home;
  const add = (directory, recursive, relevant) => {
    try {
      const watcher = watch(directory, { recursive, persistent: false }, (_event, filename) => {
        if (!filename || relevant(String(filename).replaceAll('\\', '/'))) invalidatePluginCatalog();
      });
      watcher.on('error', () => { watcher.close(); invalidatePluginCatalog(); });
      watchers.push(watcher);
    } catch {
      // A failed watcher never grants authority. Explicit reload is the fallback.
      invalidatePluginCatalog();
    }
  };
  add(path.join(home, 'tools'), true, file => /(^|\/)(tool\.json|handler\.mjs)$/.test(file) || !path.extname(file));
  add(home, false, file => file === 'tools.json');
  add(path.join(home, 'plugins'), false, file => file === 'registry.json');
}

/** Discovery revisions are not authorization grants. Dispatch still reads policy. */
export function getPluginCatalogRevision() { return `${epoch}:${version}`; }

export function subscribePluginCatalogChanges(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function invalidatePluginCatalog() {
  version++;
  for (const listener of listeners) {
    try { listener(getPluginCatalogRevision()); } catch { /* observers cannot break mutations */ }
  }
}
