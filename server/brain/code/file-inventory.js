import path from 'node:path';
import { Minimatch } from 'minimatch';
import { getRipgrepPath } from '../../lib/ripgrep-path.js';
import { runRipgrep } from '../../lib/ripgrep-run.js';
import { brainWorkspaceKeyFromPath } from '../paths.js';
import { getCodeDb } from './schema.js';

const MAX_AGE_MS = 5_000;
const pending = new Map();
const SKIP_DIRS = ['.git', '.godot', 'node_modules', 'dist', 'build', '.minnow'];

/** Full file catalog in the code-map DB, independent of LSP availability. */
export async function workspaceFileInventory(root, { refresh = false } = {}) {
  const absoluteRoot = path.resolve(root);
  const repo = brainWorkspaceKeyFromPath(absoluteRoot);
  if (pending.has(absoluteRoot)) return pending.get(absoluteRoot);
  const db = getCodeDb(repo);
  const meta = db.prepare('SELECT workspace_root, scanned_at FROM workspace_files_meta WHERE id = 1').get();
  if (!refresh && meta?.workspace_root === absoluteRoot && Date.now() - meta.scanned_at < MAX_AGE_MS) {
    return db.prepare('SELECT file FROM workspace_files ORDER BY file').all().map((row) => row.file);
  }
  const job = (async () => {
    // Match the explorer's full tree, including ignored config/source files.
    const args = ['--files', '--hidden', '--no-ignore', '--path-separator', '/', '--no-messages',
      ...SKIP_DIRS.flatMap((dir) => ['--glob', `!**/${dir}/**`]), '.'];
    const result = await runRipgrep(getRipgrepPath(), args, { cwd: absoluteRoot, timeoutMs: 10_000 });
    // Never replace the complete catalog with a timed-out or truncated walk.
    if (result.stopped || (result.code !== 0 && result.code !== 1)) {
      throw new Error(result.stderr || `File discovery failed (${result.stopped ?? result.code})`);
    }
    const files = [...new Set(result.stdout.split(/\r?\n/).filter(Boolean)
      .map((file) => file.replace(/^\.\//, '')))].sort();
    // Another workspace may evict the handle while discovery runs.
    const currentDb = getCodeDb(repo);
    currentDb.transaction(() => {
      currentDb.prepare('DELETE FROM workspace_files').run();
      const insert = currentDb.prepare('INSERT INTO workspace_files(file) VALUES (?)');
      for (const file of files) insert.run(file);
      currentDb.prepare('INSERT OR REPLACE INTO workspace_files_meta(id, workspace_root, scanned_at) VALUES (1, ?, ?)').run(absoluteRoot, Date.now());
    })();
    return files;
  })();
  pending.set(absoluteRoot, job);
  try { return await job; } finally { pending.delete(absoluteRoot); }
}

/** Language/config filters for symbol indexing over the shared catalog. */
export function filterIndexableFiles(files, includeGlobs = [], excludeGlobs = []) {
  const options = { dot: true, matchBase: true };
  const include = includeGlobs.map((glob) => new Minimatch(glob, options));
  const exclude = excludeGlobs.map((glob) => new Minimatch(glob.replace(/^!/, ''), options));
  return files.filter((file) =>
    (!include.length || include.some((glob) => glob.match(file))) &&
    !exclude.some((glob) => glob.match(file)));
}
