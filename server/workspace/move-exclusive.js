import fs from 'node:fs/promises';
import path from 'node:path';
import { isResolvedPathUnderRoot } from './safe-path.js';

/** File-tree moves must retain both files if the destination is already taken. */
export async function moveExclusive(source, destination) {
  const sourceStat = await fs.lstat(source);
  let existing;
  try {
    existing = await fs.lstat(destination);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (existing) {
    // A case-only rename on a case-insensitive volume names one directory entry twice.
    if (path.dirname(source) === path.dirname(destination) && source !== destination &&
        path.basename(source).toLowerCase() === path.basename(destination).toLowerCase() &&
        existing.dev === sourceStat.dev && existing.ino === sourceStat.ino &&
        !(await fs.readdir(path.dirname(source))).includes(path.basename(destination))) {
      await fs.rename(source, destination);
      return;
    }
    throw Object.assign(new Error('Destination already exists. Choose another name.'), { code: 'EEXIST' });
  }

  if (!sourceStat.isDirectory()) {
    try {
      await fs.link(source, destination);
    } catch (err) {
      if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EMLINK', 'EOPNOTSUPP'].includes(err.code)) throw err;
      if (sourceStat.isSymbolicLink()) {
        const target = await fs.readlink(source);
        const targetStat = await fs.stat(source).catch(() => null);
        await fs.symlink(target, destination, targetStat?.isDirectory() ? 'dir' : 'file');
      } else {
        if (!sourceStat.isFile()) throw err;
        await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
      }
    }
    await fs.unlink(source);
    return;
  }

  if (isResolvedPathUnderRoot(destination, source)) throw new Error('Cannot move a directory into itself.');
  // Windows refuses to replace an existing directory. POSIX rename can replace
  // an empty one, so first reserve our own empty destination on those systems.
  if (process.platform !== 'win32') await fs.mkdir(destination);
  try {
    await fs.rename(source, destination);
    return;
  } catch (err) {
    if (err.code !== 'EXDEV') {
      if (process.platform !== 'win32') await fs.rmdir(destination).catch(() => {});
      throw err;
    }
  }
  if (process.platform === 'win32') await fs.mkdir(destination);
  await fs.cp(source, destination, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
  await fs.rm(source, { recursive: true });
}
