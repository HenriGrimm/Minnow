import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function codexSourceHome(options = {}) {
  return (options.env ?? process.env).CODEX_HOME?.trim()
    || path.join(options.homeDir ?? os.homedir(), '.codex');
}

/** Copy only login state; never inherit desktop config, model caches, or plugins. */
export async function prepareCodexAuth(home, options = {}) {
  const requestedAuth = options.codexAuthPath || '';
  const authPath = requestedAuth || path.join(codexSourceHome(options), 'auth.json');
  const destination = path.join(home, 'auth.json');
  let initialAuth;
  try {
    initialAuth = await fs.readFile(authPath);
    await fs.writeFile(destination, initialAuth, { mode: 0o600 });
    try { await fs.chmod(destination, 0o600); } catch { /* Windows */ }
  } catch (error) {
    if (requestedAuth) throw new Error(`Configured Codex auth file is unavailable: ${authPath}`);
    if (error.code !== 'ENOENT') throw error;
  }
  return async () => {
    if (!initialAuth) return;
    let refreshed, current;
    try {
      refreshed = await fs.readFile(destination);
      current = await fs.readFile(authPath);
    } catch { return; }
    if (Buffer.compare(refreshed, initialAuth) === 0 || Buffer.compare(current, initialAuth) !== 0) return;
    const temp = `${authPath}.minnow-sync-${process.pid}-${Date.now()}`;
    await fs.writeFile(temp, refreshed, { mode: 0o600 });
    try { await fs.chmod(temp, 0o600); } catch { /* Windows */ }
    await fs.rename(temp, authPath).catch(async () => { await fs.rm(temp, { force: true }); });
  };
}
