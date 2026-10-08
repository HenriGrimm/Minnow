/** Durable issue → planner → board → PR state machine. One active issue per repository. */
import { readWatchLedger, writeWatchLedger, watcherKey, withWatchLock } from './github-watch-store.js';

function needsAttention(message) {
  return Object.assign(new Error(message), { watcherBlocked: true });
}

export function boardReadyForPullRequest(state) {
  const tasks = [...state.tasks.values()];
  return state.finished === true && state.finalTest?.outcome === 'pass'
    && tasks.length > 0 && tasks.every(task => task.phase === 'merged');
}

/** Dependencies contain external effects so recovery can be tested without a model or GitHub writes. */
export async function pollGithubWatch(job, deps) {
  const repository = job.githubWatch.repository;
  return withWatchLock(repository, async () => {
    const ledger = await (deps.readLedger ?? readWatchLedger)(repository);
    const save = () => (deps.writeLedger ?? writeWatchLedger)(repository, ledger);
    let changed = false;
    // Deliver durable updates before taking more work. A marker makes retries idempotent.
    for (const row of ledger.issues.filter(row => row.pendingComment)) {
      await deps.comment(row, row.pendingComment);
      delete row.pendingComment;
      await save();
      changed = true;
    }
    let row = ledger.issues.find(row => !['complete', 'blocked'].includes(row.phase));
    if (!row) {
      const issues = await deps.listIssues();
      const issue = issues.find(issue => Number.isSafeInteger(issue.number) && issue.number > 0
        && !ledger.issues.some(row => row.number === issue.number));
      if (!issue) return { changed, summary: 'No new issues labeled minnow.' };
      row = {
        number: issue.number, title: issue.title, url: issue.url, phase: 'claimed',
        boardId: `gh-${watcherKey(repository)}-${issue.number}`,
        jobId: job.id, workspacePath: job.workspacePath,
        ownerPid: process.pid,
        createdAt: new Date().toISOString(),
      };
      ledger.issues.push(row);
      await save(); // Claim before any external side effect.
      changed = true;
    }
    // A second configured watcher must never move an existing board into another workspace.
    if (row.jobId !== job.id) return { changed, summary: `Issue #${row.number} is owned by another watcher.` };
    if (row.ownerPid && row.ownerPid !== process.pid) {
      try {
        process.kill(row.ownerPid, 0);
        return { changed: false, summary: `Issue #${row.number} is running in another Minnow process.` };
      } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    row.ownerPid = process.pid;
    delete row.error;
    await save();
    try {
      const issue = await deps.getIssue(row);
      if (issue.state !== 'OPEN' || !issue.labels.some(label => label.name.toLowerCase() === 'minnow')) {
        if (row.phase === 'board' || (row.phase === 'starting' && row.boardCreated)) {
          try { await deps.stopBoard(row); }
          catch (error) {
            // A failed stop must remain pollable until the board acknowledges it.
            row.error = `Could not stop the board; the next poll will retry: ${String(error.message ?? error).slice(0, 1000)}`;
            await save();
            return { changed: true, blocked: true, summary: row.error };
          }
        }
        throw needsAttention('Issue was closed or its minnow label was removed. Automatic work stopped.');
      }
      if (row.phase === 'planning') {
        throw new Error('Planning was interrupted. Review the planning chat and retry this issue.');
      }
      if (row.phase === 'claimed') {
        await deps.prepare(row);
        row.phase = 'planning';
        row.pendingComment = { stage: 'planning', body: 'Minnow is triaging this issue and preparing an implementation plan.' };
        await save();
        await deps.comment(row, row.pendingComment);
        delete row.pendingComment;
        await save();
        await deps.plan(row, issue);
        // Board creation is keyed by boardId and can be repeated after a lost response.
        row.phase = 'starting';
        await save();
      }
      if (row.phase === 'starting') {
        await deps.createBoard(row);
        row.boardCreated = true;
        await save();
        await deps.startBoard(row);
        row.phase = 'board';
        row.pendingComment = { stage: 'board', body: `Planning is complete. Minnow board \`${row.boardId}\` is implementing and testing the fix.` };
        await save();
        changed = true;
      } else if (row.phase === 'board') {
        const state = await deps.boardState(row);
        if (boardReadyForPullRequest(state)) {
          row.phase = 'publishing';
          await save();
        } else if (state.finished || state.status === 'stopped') {
          throw needsAttention('The board needs attention. All tasks must merge and the final test must pass before a PR is published. Review the board, rerun failed work, then retry here.');
        } else {
          await deps.resumeBoard(row);
        }
      }
      if (row.phase === 'publishing') {
        // Recheck after restart or manual board changes; never publish an old successful snapshot.
        if (!boardReadyForPullRequest(await deps.boardState(row))) throw new Error('Board is no longer ready for a pull request.');
        row.prUrl = await deps.publish(row);
        row.phase = 'complete';
        row.pendingComment = { stage: 'complete', body: `The fix is ready for review: ${row.prUrl}\n\nAll board tasks merged and the final test passed.\n\n${row.fixSummary || 'The PR contains the implementation and validation report.'}` };
        await save();
        changed = true;
      }
    } catch (error) {
      if (!error.watcherBlocked && (row.phase === 'board' || (row.phase === 'starting' && row.boardCreated))) {
        // An unreachable API is not evidence that the board stopped. Keep its slot
        // and retry the same board next poll rather than launching another issue.
        row.error = String(error.message ?? error).slice(0, 2000);
        await save();
        return { changed: true, blocked: true, summary: `Issue #${row.number}: ${row.error}. Retrying on the next poll.`, chatId: row.chatId };
      }
      row.failedPhase = row.phase === 'complete' ? 'publishing' : row.phase;
      row.phase = 'blocked';
      row.error = String(error.message ?? error).slice(0, 2000);
      // Do not copy local paths, CLI output, or possible credentials to GitHub.
      row.pendingComment = { stage: 'blocked', body: `Minnow needs attention while processing this issue (stage: ${row.failedPhase}). See Scheduler and board \`${row.boardId}\` for details. No automatic retry is scheduled.` };
      await save();
      changed = true;
    }
    if (row.pendingComment) {
      await deps.comment(row, row.pendingComment);
      delete row.pendingComment;
      await save();
    }
    return { changed, summary: `Issue #${row.number}: ${row.phase}${row.prUrl ? ` · ${row.prUrl}` : ''}${row.error ? ` · ${row.error}` : ''}`, blocked: row.phase === 'blocked', chatId: row.chatId };
  });
}

export async function retryGithubWatchIssue(job, number) {
  return withWatchLock(job.githubWatch.repository, async () => {
    const ledger = await readWatchLedger(job.githubWatch.repository);
    const row = ledger.issues.find(row => row.number === number && row.jobId === job.id);
    if (!row || row.phase !== 'blocked') throw new Error('No blocked issue to retry');
    row.phase = ['board', 'publishing', 'starting'].includes(row.failedPhase) ? row.failedPhase : 'claimed';
    delete row.error;
    delete row.pendingComment;
    await writeWatchLedger(job.githubWatch.repository, ledger);
    return { ok: true };
  });
}
