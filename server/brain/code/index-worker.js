/**
 * Child-process entry for Brain code reindex (keeps Electron main thread responsive).
 * The per-file results array is dropped here — it is large and unused across the process boundary.
 */

import { createInterface } from 'node:readline';
import { setAppRoot, validateWorkspacePath } from '../../workspace/root.js';
import { runWithToolContext } from '../../runtime/path-access.js';
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
    // Indexing a board/chat worktree must not replace the user's cold-boot
    // workspace or auto-apply its profile. Bind only this worker's index run.
    const workspaceRoot = msg.workspaceRoot
      ? await validateWorkspacePath(String(msg.workspaceRoot))
      : undefined;
    const { results, ...summary } = await runWithToolContext(
      () => reindexCode(msg.opts ?? {}),
      { workspaceRoot },
    );
    emitAndExit({ type: 'done', result: summary }, 0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitAndExit({ type: 'error', message }, 1);
  }
});
