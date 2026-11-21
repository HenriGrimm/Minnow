import fs from 'node:fs/promises';
import path from 'node:path';
import { getBrainDir } from './paths.js';
import { rebuildCatalog } from './store.js';
import { keepEntryVectors } from './vector-store.js';

const MARKER = '.legacy-wiki-upgrade-v1';
const IN_PROGRESS = '.legacy-wiki-cleaning-v1';
const LEGACY_ENTRIES = ['sources', '.cleanup', 'proposals.json', 'index.md', 'log.md', 'schema.md'];
const BASE = '/api/brain/legacy-upgrade';

async function stat(file) {
  return fs.lstat(file).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
}

async function directory(dir) {
  const info = await stat(dir);
  if (!info) return false;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unexpected Brain data directory');
  return true;
}

async function list(dir) {
  return await directory(dir) ? fs.readdir(dir) : [];
}

async function hasContent(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name === '.gitkeep') continue;
    if (!entry.isDirectory() || await hasContent(path.join(dir, entry.name))) return true;
  }
  return false;
}

export function createLegacyBrainUpgrade({
  brainDir = getBrainDir,
  refreshCatalog = async () => {
    const catalog = await rebuildCatalog();
    await keepEntryVectors(new Set(catalog.pages.filter(page => page.path.startsWith('memory/')).map(page => page.id)));
  },
} = {}) {
  let pending = Promise.resolve();
  async function handle(action) {
    const root = brainDir();
    if (!await directory(root)) return { pending: false };
    const marker = path.join(root, MARKER);
    if (await stat(marker)) return { pending: false };
    const inProgress = path.join(root, IN_PROGRESS);
    const pages = path.join(root, 'pages');
    // Scoped Memories share this directory and catalog. Never remove pages/ itself.
    const retiredPages = (await list(pages)).filter(name => name.toLowerCase() !== 'memory');
    if (!action) {
      if (await stat(inProgress)) return { pending: true };
      for (const name of [...retiredPages.map(name => path.join(pages, name)),
        ...['sources', '.cleanup', 'proposals.json'].map(name => path.join(root, name))]) {
        const info = await stat(name);
        if (info && (!info.isDirectory() || await hasContent(name)) && path.basename(name) !== '.gitkeep') {
          return { pending: true };
        }
      }
      return { pending: false };
    }
    if (action === 'clean') {
      // Keep the prompt retryable if a later index update fails after files were removed.
      if (!await stat(inProgress)) await fs.writeFile(inProgress, '', { flag: 'wx', mode: 0o600 });
      for (const name of retiredPages) {
        await fs.rm(path.join(pages, name), { recursive: true, force: true });
      }
      for (const name of LEGACY_ENTRIES) {
        await fs.rm(path.join(root, name), { recursive: true, force: true });
      }
      await refreshCatalog();
    }
    await fs.writeFile(marker, action + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rm(inProgress, { force: true });
    return { pending: false };
  }

  return (action) => {
    const next = pending.then(() => handle(action));
    pending = next.catch(() => {});
    return next;
  };
}

export function createLegacyBrainUpgradeMiddleware(upgrade = createLegacyBrainUpgrade()) {
  return async (req, res, next) => {
    const url = req.url?.split('?')[0];
    const status = url === BASE && req.method === 'GET';
    const action = req.method === 'POST' && (url === BASE + '/clean' ? 'clean' : url === BASE + '/skip' ? 'skip' : null);
    if (!status && !action) return next();
    const send = (code, body) => {
      res.statusCode = code;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(body));
    };
    if (req.minnowAuth?.kind !== 'host') return send(403, { error: 'Local host required.' });
    if (action === 'clean' && req.headers['x-minnow-confirm-legacy-wiki'] !== 'delete') {
      return send(400, { error: 'Confirm deletion of legacy wiki data first.' });
    }
    try {
      return send(200, await upgrade(action || null));
    } catch {
      return send(500, { error: 'Could not finish the legacy Brain upgrade. Retry the cleanup or skip it.' });
    }
  };
}
