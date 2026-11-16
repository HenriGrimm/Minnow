import { fork } from 'node:child_process';
import { applyNodeRuntimeEnv } from '../lsp/node-runtime.js';

/** Keep mapped I/O faults outside the Electron process. */
export function checkMappedSessionsIntegrity(filePath) {
  return new Promise((resolve) => {
    const child = fork(new URL('./sessions-integrity-child.js', import.meta.url), [filePath], {
      env: applyNodeRuntimeEnv(process.env, process.execPath),
      execArgv: [],
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let verified = false;
    child.once('message', (message) => { verified = message === true; });
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0 && verified));
  }).catch(() => false);
}
