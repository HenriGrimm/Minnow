/**
 * Child-process entry for Brain code reindex (keeps Electron main thread responsive).
 * The per-file results array is dropped here — it is large and unused across the process boundary.
 */

import { createInterface } from 'node:readline';
import { setAppRoot, setWorkspaceRoot } from '../../workspace/root.js';
import { resetMinnowHomeCache } from '../../config/home.js';
import { reindexCode } from './indexer.js';
import { reportIndexProgress, setIndexProgressForwarder } from './index-progress.js';

setIndexProgressForwarder((repo, snapshot) => {
  process.stdout.write(`${JSON.stringify({ type: 'progress', repo, ...snapshot })}\n`);
});

/**
 * Write one framed message and exit only once it has drained. `process.exit` does not
 * flush pending async pipe writes, so exiting straight after a write can truncate it.
 * @param {Record<string, unknown>} msg
 * @param {number} code
 */
function emitAndExit(msg, code) {
  const flushed = process.stdout.write(`${JSON.stringify(msg)}\n`);
  if (flushed) {
    process.exit(code);
    return;
  }
  process.stdout.once('drain', () => process.exit(code));
}

const rl = createInterface({ input: process.stdin, terminal: false });

rl.once('line', async (line) => {
  rl.close();
  try {
    const msg = JSON.parse(String(line ?? '{}'));
    // A desktop launch cwd can be unrelated to the install. Preserve the host's
    // bundle root so $minnow LSP tokens resolve without project-local installs.
    if (msg.appRoot) {
      setAppRoot(String(msg.appRoot), { packaged: msg.appRootPackaged === true });
    }
    if (msg.minnowHome) {
      process.env.MINNOW_HOME = String(msg.minnowHome);
      resetMinnowHomeCache();
    }
    if (msg.workspaceRoot) {
      await setWorkspaceRoot(String(msg.workspaceRoot));
    }
    const { results, ...summary } = await reindexCode(msg.opts ?? {});
    emitAndExit({ type: 'done', result: summary }, 0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitAndExit({ type: 'error', message }, 1);
  }
});
