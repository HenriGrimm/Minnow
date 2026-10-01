import fs from 'node:fs/promises';

/** Windows readers/AV can briefly lock the destination of an atomic replace. */
export async function renameSchedulerFile(source, destination, options = {}) {
  const rename = options.rename ?? fs.rename;
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code) || attempt === 6) throw error;
      await wait(25 * attempt);
    }
  }
}
