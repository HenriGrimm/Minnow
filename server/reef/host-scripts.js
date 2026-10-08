import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { reefRoot, safePath } from './store.js';

/** Managed Node cannot read app.asar. Materialize only these trusted host scripts. */
export async function hostScript(name) {
  if (!['runtime-host.mjs', 'verify-browser.mjs'].includes(name)) throw new Error('Unknown Reef host script');
  const source = await fs.readFile(new URL(`./${name}`, import.meta.url));
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const destination = await safePath(reefRoot(), 'cache', 'host', `${digest}-${name}`);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try { await fs.writeFile(destination, source, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return destination;
}
