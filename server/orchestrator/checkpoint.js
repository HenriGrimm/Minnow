/** Recoverable Git snapshots without touching the checkout's index or HEAD. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { boardDir } from './journal.js';
import { safeSegment } from './journal-store.js';
import { isPathUnderWorktreesRoot, getBoardWorktreesDir } from '../worktree/paths.js';

const exec = promisify(execFile);
async function git(cwd, args, env = {}) {
  const result = await exec('git', ['-c', 'core.longpaths=true', ...args], {
    cwd, env: { ...process.env, ...env }, windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout.trim();
}
async function sync(file) {
  const handle = await fs.open(file, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function writeRecoveryJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await sync(temporary);
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function checkedPath(root, name) {
  const resolved = path.resolve(root, name);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep)[0].toLowerCase() === '.git') throw new Error('Invalid checkpoint path');
  return resolved;
}
function ownedWorktree(boardId, worktree) {
  const relative = path.relative(getBoardWorktreesDir(boardId), path.resolve(worktree));
  return isPathUnderWorktreesRoot(worktree) && relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export async function checkpointAttempt({ boardId, attemptId, worktree, previousAttemptId }) {
  // An explicit nonisolated cwd can contain user work. Never stage it, even in
  // a temporary index, or treat its contents as owned by board recovery.
  if (!ownedWorktree(boardId, worktree)) throw new Error('Checkpoint requires a managed isolated worktree owned by this board');
  const directory = path.join(boardDir(boardId), 'recovery', safeSegment(attemptId));
  await fs.mkdir(directory, { recursive: true });
  const manifestPath = path.join(directory, 'manifest.json');
  try {
    const existing = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    if (existing.version === 1) return existing;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const head = await git(worktree, ['rev-parse', 'HEAD']);
  const indexTree = await git(worktree, ['write-tree']);
  const temporaryIndex = path.join(directory, 'index.tmp');
  const env = { GIT_INDEX_FILE: temporaryIndex };
  try {
    await fs.rm(temporaryIndex, { force: true });
    await git(worktree, ['read-tree', 'HEAD'], env);
    await git(worktree, ['add', '-A', '--', '.'], env);
    const tree = await git(worktree, ['write-tree'], env);
    if (previousAttemptId && previousAttemptId !== attemptId) {
      const previous = JSON.parse(await fs.readFile(path.join(boardDir(boardId), 'recovery', safeSegment(previousAttemptId), 'manifest.json'), 'utf8'));
      if (previous.head === head && previous.indexTree === indexTree && previous.tree === tree && Array.isArray(previous.files)) {
        const currentNames = new Set((await git(worktree, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean));
        let unchanged = currentNames.size === previous.files.length;
        for (const file of previous.files) {
          if (!unchanged || !currentNames.has(file.name)) { unchanged = false; break; }
          const source = checkedPath(worktree, file.name);
          try {
            const stat = await fs.lstat(source);
            unchanged = file.deleted ? false : file.link !== undefined ? stat.isSymbolicLink() && await fs.readlink(source) === file.link : stat.isFile() && await digest(source) === file.sha256 && stat.mode === file.mode;
          } catch (error) { if (error.code !== 'ENOENT') throw error; unchanged = file.deleted === true; }
        }
        if (unchanged) return { ...previous, attemptId: previousAttemptId };
      }
    }
    const author = { GIT_AUTHOR_NAME: 'Minnow Recovery', GIT_AUTHOR_EMAIL: 'recovery@minnow.local', GIT_COMMITTER_NAME: 'Minnow Recovery', GIT_COMMITTER_EMAIL: 'recovery@minnow.local' };
    const commit = await git(worktree, ['commit-tree', tree, '-p', head, '-m', 'Minnow recovery checkpoint'], author);
    const indexCommit = await git(worktree, ['commit-tree', indexTree, '-p', head, '-m', 'Minnow recovery index'], author);
    const ref = `refs/minnow/recovery/${safeSegment(boardId)}/${safeSegment(attemptId)}`;
    await git(worktree, ['update-ref', ref, commit]);
    await git(worktree, ['update-ref', `${ref}-index`, indexCommit]);
    const bundle = path.join(directory, 'checkpoint.bundle');
    const temporaryBundle = `${bundle}.tmp`;
    await fs.rm(temporaryBundle, { force: true });
    await git(worktree, ['bundle', 'create', temporaryBundle, ref, `${ref}-index`]);
    await git(worktree, ['bundle', 'verify', temporaryBundle]);
    await sync(temporaryBundle);
    await fs.rename(temporaryBundle, bundle);
    const hash = await digest(bundle);
    // Git clean/smudge filters and core.autocrlf can change bytes. Keep the raw
    // checkout too, so restoring a checkpoint does not rewrite source contents.
    const names = (await git(worktree, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
    const files = [];
    const contents = path.join(directory, 'files');
    await fs.mkdir(contents, { recursive: true });
    for (const name of new Set(names)) {
      const source = checkedPath(worktree, name);
      let stat;
      try { stat = await fs.lstat(source); }
      catch (error) { if (error.code === 'ENOENT') { files.push({ name, deleted: true }); continue; } throw error; }
      if (stat.isSymbolicLink()) { files.push({ name, link: await fs.readlink(source) }); continue; }
      if (!stat.isFile()) throw new Error(`Unsupported checkpoint entry: ${name}. Original checkout retained.`);
      const stored = String(files.length);
      const target = path.join(contents, stored);
      await fs.copyFile(source, target);
      await sync(target);
      files.push({ name, stored, mode: stat.mode, sha256: await digest(target) });
    }
    const manifest = { version: 1, attemptId, head, indexTree, tree, commit, indexCommit, ref, bundle: 'checkpoint.bundle', sha256: hash, worktree, files };
    const temporaryManifest = `${manifestPath}.tmp`;
    await fs.writeFile(temporaryManifest, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
    await sync(temporaryManifest);
    await fs.rename(temporaryManifest, manifestPath);
    return manifest;
  } finally { await fs.rm(temporaryIndex, { force: true }); }
}

export async function restoreCheckpoint({ boardId, attemptId, worktree, transaction, afterGitRestore }) {
  if (!ownedWorktree(boardId, worktree)) throw new Error('Restore requires a managed isolated worktree owned by this board');
  const directory = path.join(boardDir(boardId), 'recovery', safeSegment(attemptId));
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  const bundle = path.join(directory, 'checkpoint.bundle');
  const hash = await digest(bundle);
  if (manifest.version !== 1 || hash !== manifest.sha256 || manifest.worktree !== worktree) throw new Error('Recovery checkpoint failed validation');
  if (!Array.isArray(manifest.files)) throw new Error('Recovery checkpoint lacks original file contents');
  for (const file of manifest.files) {
    checkedPath(worktree, file.name);
    if (file.stored !== undefined) {
      if (!/^\d+$/.test(file.stored) || await digest(path.join(directory, 'files', file.stored)) !== file.sha256) throw new Error('Recovery file failed validation');
    }
  }
  // A failed restore remains owned by the same durable allocation transaction.
  // It must finish before any agent can use the checkout, including after boot.
  const marker = path.join(directory, 'restore.json');
  let previous;
  try { previous = JSON.parse(await fs.readFile(marker, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const resuming = transaction && previous?.transaction === transaction && previous.worktree === worktree;
  if (!resuming && await git(worktree, ['status', '--porcelain'])) throw new Error('Refusing to restore over existing work');
  if (resuming && previous.completed) {
    let complete = await git(worktree, ['rev-parse', 'HEAD']) === manifest.head && await git(worktree, ['write-tree']) === manifest.indexTree;
    for (const file of manifest.files) {
      if (!complete) break;
      const target = checkedPath(worktree, file.name);
      try {
        const stat = await fs.lstat(target);
        complete = file.deleted ? false : file.link !== undefined ? stat.isSymbolicLink() && await fs.readlink(target) === file.link : stat.isFile() && await digest(target) === file.sha256;
      } catch (error) { if (error.code !== 'ENOENT') throw error; complete = file.deleted === true; }
    }
    if (complete) return manifest;
  }
  if (transaction && !resuming) {
    await writeRecoveryJson(marker, { transaction, worktree });
  }
  await git(worktree, ['fetch', bundle, `${manifest.ref}:${manifest.ref}`, `${manifest.ref}-index:${manifest.ref}-index`]);
  await git(worktree, ['read-tree', '--reset', '-u', manifest.commit]);
  await git(worktree, ['update-ref', 'HEAD', manifest.head]);
  await git(worktree, ['read-tree', manifest.indexTree]);
  await afterGitRestore?.();
  for (const file of manifest.files) {
    const target = checkedPath(worktree, file.name);
    // Never follow a parent symlink while restoring an archived path.
    const relativeParent = path.relative(worktree, path.dirname(target));
    let parent = worktree;
    for (const part of relativeParent.split(path.sep).filter(Boolean)) {
      parent = path.join(parent, part);
      try { if ((await fs.lstat(parent)).isSymbolicLink()) throw new Error('Recovery path crosses a symlink'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rm(target, { force: true });
    if (file.link !== undefined) await fs.symlink(file.link, target);
    else if (!file.deleted) {
      await fs.copyFile(path.join(directory, 'files', file.stored), target);
      await fs.chmod(target, file.mode);
      await sync(target);
    }
  }
  if (transaction) {
    await writeRecoveryJson(marker, { transaction, worktree, completed: true });
  }
  return manifest;
}

/** Once completion is journaled, merged source is retained by integration Git.
 * Never reclaim unresolved/waived tasks or checkouts with subsequent user edits. */
export async function cleanupCompletedRecovery(boardId, state) {
  if (!state.recoveryVersion || !state.finished || state.finalTest?.outcome !== 'pass' || Object.keys(state.recoveryHolds).length) return;
  const revision = state.recoveryRevision;
  for (const task of state.tasks.values()) {
    if (task.phase !== 'merged' || task.waived) continue;
    const paths = new Set(task.attempts.map((attempt) => attempt.worktree).filter(Boolean));
    let safe = true;
    for (const worktree of paths) {
      if (!state.finished || state.recoveryRevision !== revision) return;
      if (!ownedWorktree(boardId, worktree)) { safe = false; continue; }
      try {
        await fs.access(worktree);
        if (await git(worktree, ['status', '--porcelain'])) { safe = false; continue; }
        await git(worktree, ['merge-base', '--is-ancestor', 'HEAD', state.integrationSha]);
        if (!state.finished || state.recoveryRevision !== revision) return;
        // Git refuses a dirty/locked checkout; never fall back to forced delete.
        await git(state.workspacePath, ['worktree', 'remove', worktree]);
      } catch (error) { if (error.code !== 'ENOENT') safe = false; }
    }
    if (!safe) continue;
    for (const attempt of task.attempts) {
      const checkpointId = attempt.evidence?.checkpoint?.attemptId;
      if (!checkpointId || !state.finished || state.recoveryRevision !== revision) continue;
      const directory = path.join(boardDir(boardId), 'recovery', safeSegment(checkpointId));
      try {
        const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
        if (!manifest.ref?.startsWith(`refs/minnow/recovery/${safeSegment(boardId)}/`)) continue;
        await git(state.workspacePath, ['update-ref', '-d', manifest.ref]);
        await git(state.workspacePath, ['update-ref', '-d', `${manifest.ref}-index`]);
        await fs.rm(directory, { recursive: true, force: true });
      } catch (error) { if (error.code !== 'ENOENT') console.warn('[orchestrator] Completed checkpoint cleanup deferred:', error.code || error.message); }
    }
  }
}
