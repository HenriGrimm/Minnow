import fs from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from '../process-runner.js';

/** Delimiters for the managed block we own inside `.git/info/exclude`. */
const EXCLUDE_BEGIN = '# >>> minnow dependency links >>>';
const EXCLUDE_END = '# <<< minnow dependency links <<<';

export const ECOSYSTEM_ENTRIES = [
  {
    manifests: ['package.json'],
    lockfiles: ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb'],
    dirs: ['node_modules'],
    async resolveInstall(root) {
      if (!(await pathExists(path.join(root, 'package.json')))) return null;
      if (await pathExists(path.join(root, 'pnpm-lock.yaml'))) {
        return { command: 'pnpm', args: ['install'] };
      }
      if (await pathExists(path.join(root, 'yarn.lock'))) {
        return { command: 'yarn', args: ['install'] };
      }
      if (await pathExists(path.join(root, 'bun.lockb'))) {
        return { command: 'bun', args: ['install'] };
      }
      return { command: 'npm', args: ['install'] };
    },
  },
  {
    manifests: ['go.mod'],
    lockfiles: ['go.sum'],
    dirs: ['vendor'],
    async resolveInstall(root) {
      if (!(await pathExists(path.join(root, 'go.mod')))) return null;
      return { command: 'go', args: ['mod', 'download'] };
    },
  },
  {
    manifests: ['Cargo.toml'],
    lockfiles: ['Cargo.lock'],
    dirs: ['target'],
    async resolveInstall(root) {
      if (!(await pathExists(path.join(root, 'Cargo.toml')))) return null;
      return { command: 'cargo', args: ['fetch'] };
    },
  },
  {
    manifests: ['pyproject.toml', 'setup.py', 'requirements.txt'],
    lockfiles: ['poetry.lock', 'uv.lock', 'Pipfile.lock', 'requirements.txt'],
    dirs: ['.venv', 'venv'],
    async resolveInstall(root) {
      if (!(await pathExists(path.join(root, 'requirements.txt')))) return null;
      return { command: 'python', args: ['-m', 'pip', 'install', '-r', 'requirements.txt'] };
    },
  },
  {
    manifests: ['Gemfile'],
    lockfiles: ['Gemfile.lock'],
    dirs: ['vendor', '.bundle'],
    async resolveInstall(root) {
      if (!(await pathExists(path.join(root, 'Gemfile')))) return null;
      return { command: 'bundle', args: ['install'] };
    },
  },
  {
    manifests: ['composer.json'],
    lockfiles: ['composer.lock'],
    dirs: ['vendor'],
    async resolveInstall(root) {
      if (!(await pathExists(path.join(root, 'composer.json')))) return null;
      return { command: 'composer', args: ['install'] };
    },
  },
];

async function pathExists(targetPath) {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

const errMessage = (err) => (err instanceof Error ? err.message : String(err));

function samePath(a, b) {
  return path.relative(a, b) === '';
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * @param {string} linkPath
 * @returns {Promise<'missing' | 'real-dir' | 'link-ok' | 'broken'>}
 */
export async function inspectDepDir(linkPath) {
  let st;
  try {
    st = await fs.lstat(linkPath);
  } catch {
    return 'missing';
  }
  if (!st.isSymbolicLink()) {
    return st.isDirectory() ? 'real-dir' : 'broken';
  }
  try {
    const target = await fs.stat(linkPath);
    return target.isDirectory() ? 'link-ok' : 'broken';
  } catch {
    return 'broken';
  }
}

/**
 * @returns {Promise<boolean>}
 */
async function removeDepLink(target) {
  try {
    await fs.rm(target, { force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
  }
  if (!(await pathExists(target))) return true;

  for (const remove of [() => fs.unlink(target), () => fs.rmdir(target)]) {
    try {
      await remove();
    } catch {
    }
    if (!(await pathExists(target))) return true;
  }
  return false;
}

/**
 * Resolve `info/exclude` for a worktree. `--git-path` follows the common-dir
 * indirection, so linked worktrees land on the main repo's exclude file — the
 * only one git actually reads.
 * @param {string} wtPath
 * @returns {Promise<string | null>}
 */
async function resolveExcludePath(wtPath) {
  try {
    const r = await runProcess('git', ['rev-parse', '--git-path', 'info/exclude'], {
      cwd: wtPath,
      timeout: 30_000,
    });
    if (r.code !== 0) return null;
    const p = `${r.stdout ?? ''}`.trim();
    if (!p) return null;
    return path.isAbsolute(p) ? p : path.resolve(wtPath, p);
  } catch {
    return null;
  }
}

/**
 * Exclude the dependency dirs we link so they never show up as untracked.
 *
 * These are symlinks, not directories. A repo `.gitignore` almost always spells
 * them with a trailing slash (`node_modules/`), which matches directories only —
 * so the symlink stays untracked and every `git status --porcelain` reads dirty.
 * We write unanchored-at-root, slashless patterns into `.git/info/exclude`, which
 * match a symlink, a file, or a directory alike, and don't touch the repo's own
 * ignore rules. Tracked paths are unaffected: git ignores exclude rules for those.
 *
 * @param {string} wtPath
 * @param {Iterable<string>} dirs
 * @returns {Promise<{ ok: boolean, excludePath?: string, dirs: string[], reason?: string }>}
 */
export async function ensureDepDirsExcluded(wtPath, dirs) {
  const wanted = [...new Set([...dirs].filter(Boolean))].sort();
  if (wanted.length === 0) return { ok: true, dirs: [] };

  const excludePath = await resolveExcludePath(wtPath);
  if (!excludePath) return { ok: false, dirs: wanted, reason: 'could not resolve info/exclude' };

  let existing = '';
  try {
    existing = await fs.readFile(excludePath, 'utf8');
  } catch {
    existing = '';
  }

  // Drop any block we wrote before, so repeated runs stay idempotent.
  const begin = existing.indexOf(EXCLUDE_BEGIN);
  const end = existing.indexOf(EXCLUDE_END);
  let preserved = existing;
  if (begin !== -1 && end !== -1 && end > begin) {
    preserved = existing.slice(0, begin) + existing.slice(end + EXCLUDE_END.length);
  }
  preserved = preserved.replace(/\n{3,}/g, '\n\n').replace(/^\s*\n/, '').trimEnd();

  const block = [EXCLUDE_BEGIN, ...wanted.map((dir) => `/${dir}`), EXCLUDE_END].join('\n');
  const next = preserved ? `${preserved}\n\n${block}\n` : `${block}\n`;

  if (next === existing) return { ok: true, excludePath, dirs: wanted };

  try {
    await fs.mkdir(path.dirname(excludePath), { recursive: true });
    await fs.writeFile(excludePath, next, 'utf8');
  } catch (err) {
    return { ok: false, excludePath, dirs: wanted, reason: errMessage(err) };
  }
  return { ok: true, excludePath, dirs: wanted };
}

/**
 * @param {string} sourceRoot
 * @param {string} wtPath
 * @returns {Promise<{ ok: boolean, linked: string[], repaired: string[], failed: Array<{ dir: string, reason: string }> }>}
 */
export async function ensureDependencyDirs(sourceRoot, wtPath) {
  const linked = [];
  const repaired = [];
  const failed = [];
  const seen = new Set();
  const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';

  for (const entry of ECOSYSTEM_ENTRIES) {
    const hasManifest = await Promise.all(
      entry.manifests.map((manifest) => pathExists(path.join(sourceRoot, manifest))),
    );
    if (!hasManifest.some(Boolean)) continue;

    for (const dir of entry.dirs) {
      if (seen.has(dir)) continue;
      seen.add(dir);

      const sourceDir = path.join(sourceRoot, dir);
      const targetLink = path.join(wtPath, dir);

      const sourceState = await inspectDepDir(sourceDir);
      if (sourceState === 'missing' || sourceState === 'broken') {
        const targetState = await inspectDepDir(targetLink);
        if (targetState === 'broken' && !(await removeDepLink(targetLink))) {
          failed.push({
            dir,
            reason: `existing ${dir} link could not be removed (${targetLink})`,
          });
        } else if (sourceState === 'broken') {
          failed.push({ dir, reason: `dependency source ${sourceDir} does not resolve` });
        }
        continue;
      }

      if (samePath(sourceDir, targetLink)) {
        failed.push({ dir, reason: `refusing to link ${dir} to itself (${targetLink})` });
        continue;
      }

      const state = await inspectDepDir(targetLink);
      if (state === 'real-dir') continue;

      let realSource;
      try {
        realSource = await fs.realpath(sourceDir);
      } catch (err) {
        failed.push({ dir, reason: `source ${sourceDir} does not resolve: ${errMessage(err)}` });
        continue;
      }

      const resolvedTarget = path.resolve(targetLink);
      if (samePath(resolvedTarget, realSource)) {
        failed.push({ dir, reason: `refusing to link ${dir} to itself (${realSource})` });
        continue;
      }
      if (isInside(resolvedTarget, realSource) || isInside(realSource, resolvedTarget)) {
        failed.push({
          dir,
          reason: `refusing to create a self-nested ${dir} link (${resolvedTarget} / ${realSource})`,
        });
        continue;
      }

      if (state === 'link-ok') {
        let current = null;
        try {
          current = await fs.realpath(targetLink);
        } catch {
          current = null;
        }
        if (current && samePath(current, realSource)) continue;
      }

      if (state !== 'missing' && !(await removeDepLink(targetLink))) {
        failed.push({
          dir,
          reason: `existing ${dir} link could not be removed (${targetLink})`,
        });
        continue;
      }

      try {
        await fs.symlink(realSource, targetLink, symlinkType);
      } catch (err) {
        failed.push({ dir, reason: `failed to link ${dir}: ${errMessage(err)}` });
        continue;
      }

      if ((await inspectDepDir(targetLink)) !== 'link-ok') {
        await removeDepLink(targetLink);
        failed.push({ dir, reason: `created ${dir} link does not resolve (${realSource})` });
        continue;
      }

      if (state === 'missing') linked.push(dir);
      else repaired.push(dir);
    }
  }

  // Exclude every dep dir of a matched ecosystem, whether or not we linked it
  // this pass: a link from an earlier run is exactly the case that needs it.
  const excluded = await ensureDepDirsExcluded(wtPath, seen);
  if (!excluded.ok && excluded.reason) {
    console.warn(`[dep-symlinks] ${wtPath}: could not exclude dep dirs: ${excluded.reason}`);
  }

  for (const { reason } of failed) {
    console.warn(`[dep-symlinks] ${wtPath}: ${reason}`);
  }

  return { ok: failed.length === 0, linked, repaired, failed };
}

/**
 * @param {string} root
 * @returns {Promise<boolean>}
 */
export async function hasBrokenDepDir(root) {
  const seen = new Set();
  for (const entry of ECOSYSTEM_ENTRIES) {
    for (const dir of entry.dirs) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      if ((await inspectDepDir(path.join(root, dir))) === 'broken') return true;
    }
  }
  return false;
}

/**
 * @param {string} sourceRoot
 * @param {string} wtPath
 */
export async function symlinkDependencyDirs(sourceRoot, wtPath) {
  return ensureDependencyDirs(sourceRoot, wtPath);
}

/**
 * @param {string} root
 * @param {string[]} dirs
 * @returns {Promise<{ removed: string[], failed: string[] }>}
 */
export async function materializeDepDirs(root, dirs) {
  const removed = [];
  const failed = [];

  for (const dir of dirs) {
    const depPath = path.join(root, dir);
    let st;
    try {
      st = await fs.lstat(depPath);
    } catch {
      continue; 
    }
    if (!st.isSymbolicLink()) continue;

    if (await removeDepLink(depPath)) {
      removed.push(dir);
    } else {
      failed.push(dir);
      console.warn(`[dep-symlinks] ${root}: could not remove ${dir} link before install`);
    }
  }

  return { removed, failed };
}
