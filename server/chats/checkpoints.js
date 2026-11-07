import fs from 'node:fs/promises';
import { snapshotCreate } from '../git/git-ops.js';
import { canonicalWorktreeMutationKey, withCoordinatedWorktreeMutation } from '../git/action-run-lock.js';
import { readChatCheckoutIdentity } from './context.js';
import { ChatContractError } from './contracts.js';

// These durable coordination operations can wait for another chat in this same
// checkout. They never hold its filesystem boundary while that child runs.
export const CHECKPOINT_COORDINATION_TOOLS = new Set([
  'spawn_sub_agent', 'chat_send', 'chat_wait', 'chat_stop', 'cancel_sub_agent',
  'ask_question', 'wait', 'todo_write', 'set_chat_mode', 'propose_mode_switch', 'create_chat_with_mode',
]);

async function waitForCapture(pending, signal) {
  signal?.throwIfAborted();
  if (!signal) return pending;
  let cancel;
  try {
    return await Promise.race([pending, new Promise((_, reject) => {
      cancel = () => reject(signal.reason ?? new DOMException('Stopped', 'AbortError'));
      signal.addEventListener('abort', cancel, { once: true });
    })]);
  } finally { if (cancel) signal.removeEventListener('abort', cancel); }
}

/** One canonical journal, in sessions.db. Baselines may overlap model work, but
 * every effect recaptures under the checkout lock: neither watchers nor an old
 * baseline certify that another chat/user has not changed the files.
 * Segments are observations for explicit recovery, not an automatic whole-tree undo.
 */
export function createChatCheckpointCoordinator({ repository, capture = snapshotCreate } = {}) {
  const db = repository.getDatabase();
  const read = (executionId, id) => {
    const row = db.prepare('SELECT state,payload_json FROM chat_workspace_checkpoints WHERE execution_id=? AND checkpoint_id=?').get(executionId, id);
    return row ? { ...JSON.parse(row.payload_json), state: row.state } : null;
  };
  return {
    read,
    async prepare({ chatId, executionId, cwd, fence, signal, onTiming }) {
      const canonical = await fs.realpath(cwd);
      const workspaceKey = canonicalWorktreeMutationKey(cwd);
      const identity = await readChatCheckoutIdentity(cwd);
      const assertCurrent = async (activeId = '') => {
        repository.assertFence(chatId, fence);
        if (await readChatCheckoutIdentity(cwd) !== identity) throw new ChatContractError('workspace_denied', 'The checkpoint checkout changed identity');
        const uncertain = db.prepare("SELECT execution_id FROM chat_workspace_checkpoints WHERE workspace_key=? AND state IN ('executing','uncertain') AND NOT (execution_id=? AND checkpoint_id=? AND state='executing') LIMIT 1")
          .get(workspaceKey, executionId, activeId);
        if (uncertain) throw new ChatContractError('recovery_required', 'An interrupted checkout mutation needs explicit recovery before another write');
      };
      const write = (id, state, payload) => {
        repository.assertFence(chatId, fence);
        db.prepare('INSERT INTO chat_workspace_checkpoints(execution_id,checkpoint_id,chat_id,workspace_key,state,payload_json) VALUES(?,?,?,?,?,?) ON CONFLICT(execution_id,checkpoint_id) DO UPDATE SET state=excluded.state,payload_json=excluded.payload_json')
          .run(executionId, id, chatId, workspaceKey, state, JSON.stringify({ version: 1, cwd: canonical, ...payload }));
      };
      const snapshot = async stage => {
        const started = performance.now();
        try {
          const result = await capture({ cwd, message: `minnow ${stage} ${executionId}` });
          if (!result?.ok || !result.sha) {
            if (result?.error === 'Not a git repository') return { skipped: 'not_git' };
            throw new ChatContractError('capability_unavailable', 'Could not capture a safety checkpoint; no new mutation was admitted');
          }
          return { sha: result.sha, ...(result.headSha ? { headSha: result.headSha } : {}) };
        } finally { try { onTiming?.(stage, performance.now() - started); } catch { /* diagnostics */ } }
      };
      let baselineSettled = false;
      const baseline = withCoordinatedWorktreeMutation(cwd, async () => {
        await assertCurrent();
        const prior = read(executionId, '$baseline');
        if (prior) return prior;
        signal?.throwIfAborted();
        const value = await snapshot('baseline');
        write('$baseline', 'settled', value);
        return value;
      }, { signal });
      // A slow capture failure is surfaced at mutation/finalization, never an
      // unhandled rejection while model request preparation proceeds.
      baseline.then(() => { baselineSettled = true; }, () => {});
      return {
        baseline,
        async effect(toolCallId, operation) {
          await waitForCapture(baseline, signal);
          return withCoordinatedWorktreeMutation(cwd, async () => {
            signal?.throwIfAborted();
            await assertCurrent();
            if (read(executionId, toolCallId)) throw new ChatContractError('recovery_required', 'A checkpointed mutation cannot be automatically repeated');
            const pre = await snapshot('pre_effect');
            signal?.throwIfAborted();
            await assertCurrent();
            write(toolCallId, 'executing', { pre });
            try {
              const result = await operation();
              const post = await snapshot('post_effect');
              await assertCurrent(toolCallId);
              write(toolCallId, 'settled', { pre, post, divergentHead: pre.headSha !== post.headSha });
              return result;
            } catch (error) {
              try { write(toolCallId, 'uncertain', { pre }); } catch { /* Original intent also holds recovery. */ }
              const failure = new ChatContractError('recovery_required', 'A checkpointed effect requires explicit reconciliation');
              failure.checkpointUncertain = true;
              failure.cause = error;
              throw failure;
            }
          }, { signal });
        },
        // Finalization is a required durable barrier, not fire-and-forget.
        async finalize() {
          // Stop after a durably settled effect is not uncertainty. Only a still
          // pending capture needs the caller-cancellable wait.
          if (!baselineSettled) await waitForCapture(baseline, signal);
          else await baseline;
          await assertCurrent();
        },
      };
    },
    recoverInterrupted() {
      // Restart is not proof of whether a launched effect completed.
      db.prepare("UPDATE chat_workspace_checkpoints SET state='uncertain' WHERE state='executing'").run();
    },
  };
}
