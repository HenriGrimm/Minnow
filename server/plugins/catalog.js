import { randomUUID } from 'node:crypto';
import { statSync, watch } from 'node:fs';
import path from 'node:path';

const epoch = randomUUID();
let version = 0;
const listeners = new Set();
let watchedHome;
let watchers = [];

function watchConfigFile(directory, filename) {
  const target = path.join(directory, filename);
  const stamp = () => {
    const stat = statSync(target, { bigint: true, throwIfNoEntry: false });
    return stat ? [stat.dev, stat.ino, stat.mtimeNs, stat.ctimeNs, stat.size].join(':') : null;
  };
  let current;
  try { current = stamp(); } catch { /* Handle an unreadable stamp as a change. */ }
  return (file) => {
    if (file !== filename) return false;
    try {
      const next = stamp();
      if (current === next) return false;
      current = next;
    } catch { return true; }
    return true;
  };
}

/** Legacy files can be edited outside Settings. No directory scan on warm reads. */
export function watchPluginCatalog(home) {
  if (watchedHome === home) return;
  for (const watcher of watchers) watcher.close();
  watchers = [];
  watchedHome = home;
  const add = (directory, recursive, relevant) => {
    try {
      const watcher = watch(directory, { recursive, persistent: false }, (event, filename) => {
        if (!filename || relevant(String(filename).replaceAll('\\', '/'), event)) invalidatePluginCatalog();
      });
      watcher.on('error', () => { watcher.close(); invalidatePluginCatalog(); });
      watchers.push(watcher);
    } catch {
      // A failed watcher never grants authority. Explicit reload is the fallback.
      invalidatePluginCatalog();
    }
  };
  const plugins = path.join(home, 'plugins');
  add(path.join(home, 'tools'), true, (file, event) => /(^|\/)(tool\.json|handler\.mjs)$/.test(file)
    || event === 'rename' && !path.extname(file) && path.basename(file) !== '.gitkeep');
  // macOS can deliver events from immediately before watch() started. The
  // initial scan already sees those config files; only a new state is relevant.
  add(home, false, watchConfigFile(home, 'tools.json'));
  add(plugins, false, watchConfigFile(plugins, 'registry.json'));
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
