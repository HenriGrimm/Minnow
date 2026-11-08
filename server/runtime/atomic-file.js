import fs from 'node:fs/promises';

/** Replace atomically despite brief Windows reader/scanner sharing locks. */
export async function renameFileWithRetry(source, destination, options = {}) {
  const rename = options.rename ?? fs.rename;
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code) || attempt === 10) throw error;
      // Never unlink the previous durable file to bypass a sharing violation.
      await wait(Math.min(250, 25 * 2 ** (attempt - 1)));
    }
  }
}
