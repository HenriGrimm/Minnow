import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { admitAgentCli } from './admission.js';

export function codexSourceHome(options = {}) {
  return (options.env ?? process.env).CODEX_HOME?.trim()
    || path.join(options.homeDir ?? os.homedir(), '.codex');
}

/** Copy only login state; never inherit desktop config, model caches, or plugins. */
export async function prepareCodexAuth(home, options = {}) {
  const requestedAuth = options.codexAuthPath || '';
  const source = requestedAuth || path.join(codexSourceHome(options), 'auth.json');
  const authPath = await fs.realpath(source).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return path.resolve(source);
  });
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
    // Only serialize the compare-and-replace, never native inference. Every
    // adapter (including legacy exec and shutdown) shares this credential guard.
    const release = await admitAgentCli(`codex-auth-sync:${process.platform === 'win32' ? authPath.toLowerCase() : authPath}`, 1);
    try {
      let refreshed, current;
      try {
        refreshed = await fs.readFile(destination);
        current = await fs.readFile(authPath);
      } catch { return; }
      if (Buffer.compare(refreshed, initialAuth) === 0 || Buffer.compare(current, initialAuth) !== 0) return;
      const temp = `${authPath}.minnow-sync-${process.pid}-${randomUUID()}`;
      try {
        await fs.writeFile(temp, refreshed, { mode: 0o600 });
        try { await fs.chmod(temp, 0o600); } catch { /* Windows */ }
        await fs.rename(temp, authPath);
      } finally { await fs.rm(temp, { force: true }); }
    } finally { release(); }
  };
}
