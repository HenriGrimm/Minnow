import { createHash } from 'node:crypto';
import { createChatTaskRepository } from './task-repository.js';
import { ChatContractError } from './contracts.js';
import { readFactoryBranch, readFactoryCheckpoint, successfulFactoryChecks } from './factory-checkpoint.js';

const pending = ['accepted', 'queued', 'waiting_for_host', 'running'];
const quotaFailure = value => /usage limit|insufficient (?:funds|balance|credits)|quota|out of credits|payment required|\b402\b/i.test(value || '');
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 44);

function readRun(db, chatId) {
  const row = db.prepare("SELECT json_extract(meta_json,'$.factoryRun') AS run FROM chat_conversation_state WHERE chat_id=?").get(chatId);
  return row?.run ? JSON.parse(row.run) : null;
}

// Update the private journal cursor and the public /goal projection in one transaction.
function save(repository, chatId, run) {
  const db = repository.getDatabase();
  run.revision++;
  db.prepare("UPDATE chat_conversation_state SET meta_json=json_set(meta_json,'$.factoryRun',json(?)) WHERE chat_id=?").run(JSON.stringify(run), chatId);
  if (run.status === 'cleared') {
    db.prepare("UPDATE chats SET meta_json=json_remove(meta_json,'$.activeGoal') WHERE id=?").run(chatId);
  } else {
    const goal = { factoryRunId: run.id, skillId: 'factory', conditionText: run.condition, startedAt: run.startedAt,
      turnCount: run.turnCount, tokenBaseline: run.tokenBaseline, lastReason: run.reason,
      factoryProgress: { phase: run.stage || 'Preparing', completed: run.completed || 0, total: run.total || 0 },
      ...(run.status === 'achieved' ? { achieved: true } : {}), ...(run.status === 'paused' ? { paused: true } : {}) };
    db.prepare("UPDATE chats SET meta_json=json_set(meta_json,'$.activeGoal',json(?)) WHERE id=?").run(JSON.stringify(goal), chatId);
  }
}

function initialRun(record, condition, chat, epoch) {
  return { id: record.commandId, cursor: record.commandId, phase: 'build', status: 'active', revision: 0, epoch,
    condition, branch: record.captured.factoryBranch || null, startedAt: record.createdAt, turnCount: 0, tokenBaseline: chat.tokenLedgerTotals?.totalTokens ?? 0,
    failures: 0, reason: 'Factory started. Completed features are saved on the run branch.' };
}

/** Called inside the transaction admitting the explicit human slash command. */
export function armFactoryRun(repository, record, condition) {
  const command = record.command;
  if (!condition || command.provenance.actor !== 'human' || !command.intent?.goalDriven ||
      command.intent.skill?.id !== 'factory' || command.intent.skill.source !== 'slash') return;
  const chat = repository.getChat(command.chatId);
  if (chat.archivedAt || chat.archiveImport?.requiresHumanResume || chat.activeGoal || chat.followupChain?.remaining || chat.activeLoops?.length) return;
  save(repository, chat.id, initialRun(record, condition, chat, repository.getCancellationEpoch(chat.id)));
}

export function isCurrentFactoryCommand(repository, record) {
  if (!record.captured?.factoryRunId) return true;
  const chat = repository.getChat(record.chatId);
  const run = readRun(repository.getDatabase(), record.chatId);
  return !chat.archivedAt && !chat.archiveImport?.requiresHumanResume && run?.status === 'active' && run.id === record.captured.factoryRunId && run.cursor === record.commandId &&
    run.epoch === repository.getCancellationEpoch(record.chatId);
}

export function factoryDependenciesPending(repository, chatId, isBusy) {
  if (repository.listRequests(chatId, 'pending').length || repository.getTaskAttention(chatId)) return true;
  const tasks = createChatTaskRepository({ repository });
  return tasks.descendantChatIds(chatId).some(id => id !== chatId && (isBusy(id) ||
    repository.listCommands({ chatId: id, states: pending, limit: 1 }).length ||
    repository.getLatestExecution(id)?.status === 'recovery_required'));
}

function adoptPreviousFactoryGoals(repository) {
  const db = repository.getDatabase();
  const rows = db.prepare(`SELECT c.id,c.meta_json FROM chats c JOIN chat_conversation_state s ON s.chat_id=c.id
    WHERE json_extract(c.meta_json,'$.activeGoal.skillId')='factory' AND json_type(s.meta_json,'$.factoryRun') IS NULL
    AND json_type(s.meta_json,'$.archiveImport') IS NULL`).all();
  for (const row of rows) repository.atomic(() => {
    const goal = JSON.parse(row.meta_json).activeGoal;
    if (!Number.isFinite(goal.startedAt) || goal.achieved || goal.factoryRunId || readRun(db, row.id)) return;
    const origin = db.prepare(`SELECT command_id FROM chat_commands WHERE chat_id=? AND created_at<=?
      AND json_extract(payload_json,'$.intent.goalDriven')=1 AND json_extract(payload_json,'$.intent.skill.id')='factory'
      AND json_extract(payload_json,'$.intent.skill.source')='slash' AND json_extract(payload_json,'$.provenance.actor')='human'
      AND json_extract(payload_json,'$.intent.skill.input') NOT LIKE 'Continue working toward the active goal.%'
      ORDER BY position DESC LIMIT 1`).get(row.id, goal.startedAt + 1000);
    if (!origin) return;
    const record = repository.getCommand(origin.command_id);
    if (!record?.captured.scope?.canonicalKey || !record.captured.projectId || !record.captured.policy || !record.captured.turnIntent?.skillBody) return;
    const run = initialRun(record, goal.conditionText, repository.getChat(row.id), record.captured.cancellationEpoch);
    const last = db.prepare(`SELECT command_id FROM chat_commands WHERE chat_id=? AND position>?
      AND json_extract(payload_json,'$.intent.skill.id')='factory' AND json_extract(payload_json,'$.intent.goalDriven')=1
      AND json_extract(payload_json,'$.intent.skill.input') LIKE 'Continue working toward the active goal.%' ORDER BY position DESC LIMIT 1`).get(row.id, record.position);
    run.cursor = last?.command_id ?? run.id;
    run.turnCount = goal.turnCount ?? 0;
    run.startedAt = goal.startedAt;
    run.tokenBaseline = goal.tokenBaseline ?? run.tokenBaseline;
    if (goal.paused) { run.status = 'paused'; run.reason = goal.lastReason; }
    save(repository, row.id, run);
  });
}

/** Normal command execution supplies policy, approvals, checkpoint fences, and the model/tool transport. */
export function createFactoryContinuation({ repository, kick, resolveTarget, isBusy, changed, now = Date.now,
  checkpoint = readFactoryCheckpoint, pollMs = 15000 }) {
  const db = repository.getDatabase(), working = new Map();
  const pendingWake = new Set();
  let timer, started = false;
  function update(chatId, run, action) {
    return repository.atomic(() => {
      if (!started) return false;
      const current = readRun(db, chatId);
      if (current?.id !== run.id || current.revision !== run.revision) return false;
      action();
      save(repository, chatId, run);
      changed(chatId);
      return true;
    });
  }
  function selectedModel(chatId, fallback) {
    const stored = repository.getLatestProfile(chatId)?.snapshot?.modelSelection;
    if (stored) return stored;
    const chat = repository.getChat(chatId);
    if (!chat.providerId || !chat.modelId || chat.providerId === fallback?.providerId && chat.modelId === fallback?.modelId) return fallback;
    return { providerId: chat.providerId, modelId: chat.modelId };
  }
  function enqueue(chatId, run, origin, phase, message, snapshot) {
    const commandId = 'factory-' + digest(run.id + '/' + run.revision + '/' + phase);
    const verify = phase === 'verify';
    const branch = run.branch || (['main', 'master'].includes(snapshot.branch) ? null : snapshot.branch);
    const intent = { version: 1, goalDriven: true, suppressUserEcho: true, skill: verify ? null : { id: 'factory', source: 'slash', input: message.slice(0, 24000) } };
    const command = { version: 1, chatId, commandId, kind: 'send', mode: 'queue', requestedAt: now(),
      clientRequestId: commandId, message, intent, modelSelection: selectedModel(chatId, origin.command.modelSelection),
      profileReference: origin.command.profileReference, provenance: { version: 1, actor: 'system', source: 'factory',
        kind: 'goal_continuation', commandId, causalRootId: run.id, replyToCommandId: run.cursor } };
    const { policy, scope, projectId, checkoutIdentity, profile, turnSettings, workspacePolicyBinding } = origin.captured;
    const captured = { policy, scope, projectId, checkoutIdentity, profile, turnSettings, workspacePolicyBinding, cancellationEpoch: run.epoch,
      ...(origin.captured.workspacePreparation && !workspacePolicyBinding ? { workspacePreparation: origin.captured.workspacePreparation } : {}),
      causalRootId: run.id, causalDepth: 0, factoryRunId: run.id, factoryPhase: phase, factoryBranch: branch,
      factoryHead: snapshot.head,
      ...(phase === 'build' && snapshot.assignment ? { factoryAssignment: snapshot.assignment } : {}),
      nativeExecution: { version: 1, requestedMode: 'minnow', effectiveMode: 'minnow' },
      turnIntent: verify ? { intent: { ...intent, context: origin.captured.turnIntent?.intent?.context }, skillBody: 'Independently verify the factory contract. Inspect the committed report, specification and frozen check history against the original request. Minnow runs the contract checks before your review. Finish with YES or NO and your evidence.' }
        : { ...origin.captured.turnIntent, intent: { ...intent, context: origin.captured.turnIntent?.intent?.context } } };
    repository.admitCommand(command, { producerId: 'factory-' + run.id, requestKey: commandId, captured });
    repository.updateCommand(commandId, { state: 'queued' });
    run.cursor = commandId; run.phase = phase; run.turnCount++; run.branch = branch;
    run.verifyHead = verify ? snapshot.head : null;
    run.retryAt = null;
  }
  function waitReason(chatId, run, reason) {
    if (run.reason !== reason) update(chatId, run, () => { run.reason = reason; });
  }
  function occupied(chatId) {
    return isBusy(chatId) || repository.listCommands({ chatId, states: pending, limit: 1 }).length ||
      factoryDependenciesPending(repository, chatId, isBusy);
  }
  async function advance(chatId) {
    const run = readRun(db, chatId);
    if (!run) return;
    const restoreReport = run.status === 'achieved' && !run.reportPublishedAt;
    if (!restoreReport && !(run.status === 'active' || run.status === 'paused' && quotaFailure(run.reason))) return;
    const chat = repository.getChat(chatId);
    if (chat.archivedAt || chat.archiveImport?.requiresHumanResume || repository.getCancellationEpoch(chatId) !== run.epoch) {
      if (restoreReport) return;
      update(chatId, run, () => { run.status = 'paused'; run.reason = 'Factory paused. Resume factory continues from the checkpoint.'; });
      return;
    }
    const record = repository.getCommand(run.cursor), origin = repository.getCommand(run.id);
    if (!record || !origin || origin.chatId !== chatId || record.chatId !== chatId) {
      waitReason(chatId, run, 'The original factory command is unavailable. Restore the conversation backup.'); return;
    }
    if (restoreReport && db.prepare('SELECT 1 FROM chat_commands WHERE chat_id=? AND position>? LIMIT 1').get(chatId, record.position)) return;
    const selected = selectedModel(chatId, record.command.modelSelection);
    const switched = selected?.providerId !== record.command.modelSelection?.providerId || selected?.modelId !== record.command.modelSelection?.modelId;
    if (!switched && (run.status === 'paused' || run.retryAt > now())) return;
    const execution = record.executionId && repository.getExecution(record.executionId);
    if (execution?.status === 'recovery_required') {
      waitReason(chatId, run, 'Waiting for Minnow to reconcile the interrupted tool. Review the recovery card if requested.'); return;
    }
    if (pending.includes(record.state)) {
      if (!run.branch && record.state === 'running' && (!record.captured.workspacePreparation || record.captured.workspacePolicyBinding) && execution?.captured?.scope) {
        const branch = await readFactoryBranch(execution.captured.scope.canonicalKey);
        if (branch && !['main', 'master'].includes(branch)) update(chatId, run, () => { run.branch = branch; });
      }
      if (record.state === 'waiting_for_host' && !record.held) {
        waitReason(chatId, run, record.error?.message || 'Waiting for the configured execution host.');
      }
      if (record.held) waitReason(chatId, run, record.error?.message || 'Waiting for the held command in this chat.');
      else if (!isBusy(chatId) && record.state !== 'running') void kick(chatId).catch(() => {});
      return;
    }
    if (occupied(chatId)) return;
    const target = await resolveTarget(chatId);
    const bound = origin.captured;
    if (target.scope.projectId !== bound.projectId || target.scope.workspaceId !== bound.scope.workspaceId ||
        target.scope.canonicalKey !== bound.scope.canonicalKey || bound.checkoutIdentity && target.checkoutIdentity !== bound.checkoutIdentity) {
      if (restoreReport) return;
      waitReason(chatId, run, 'Waiting for the original factory checkout to be restored.'); return;
    }
    const snapshot = bound.workspacePreparation && !bound.workspacePolicyBinding
      ? { branch: null, ready: false, reason: 'Finish preparing the thread worktree, then resume factory setup.' }
      : await checkpoint(target.scope.canonicalKey);
    if (snapshot.blocked || run.branch && run.branch !== snapshot.branch) {
      if (restoreReport) return;
      waitReason(chatId, run, snapshot.blocked || 'Restore the factory branch ' + run.branch + ' to continue.'); return;
    }
    if (!started || occupied(chatId) || repository.getCancellationEpoch(chatId) !== run.epoch) return;
    const interrupted = execution?.result?.failure?.quiescence || execution?.result?.automaticRecovery || execution?.result?.humanRecovery ||
      execution?.result?.failure?.stopped && record.state === 'cancelled' && !record.result?.removedByCommandId;
    const failed = !interrupted && record.state !== 'settled';
    const verified = execution?.status === 'completed' && snapshot.ready && run.phase === 'verify' && record.state === 'settled' && run.verifyHead === snapshot.head &&
      /^YES\b/i.test(repository.readExecutionFinalAssistant(execution.executionId).trim().split(/\r?\n/).at(-1)) &&
      successfulFactoryChecks(db, execution.executionId, snapshot.checks);
    if (restoreReport && !verified) return;
    const queued = update(chatId, run, () => {
      if (restoreReport && db.prepare('SELECT 1 FROM chat_commands WHERE chat_id=? AND position>? LIMIT 1').get(chatId, record.position)) return;
      run.completed = snapshot.completed; run.total = snapshot.total;
      if (switched && failed) {
        run.status = 'active'; run.retryCursor = run.cursor; run.failures = 0; run.retryAt = null;
      }
      if (verified) {
        repository.appendFactoryReport(record.commandId, '## Factory complete\n\n' +
          snapshot.completed + ' of ' + snapshot.total + ' features passed. ' + snapshot.checks.length +
          ' distinct checks passed on ' + snapshot.branch + ' at ' + snapshot.head.slice(0, 12) +
          '.\n\nWorking directory: ' + target.scope.canonicalKey + '\n\n' + snapshot.report);
        run.reportPublishedAt = now(); run.status = 'achieved'; run.reason = 'Verified the feature checks, project gates and committed report.'; return; }
      if (failed && run.retryCursor !== run.cursor) {
        run.failures++; run.retryCursor = run.cursor;
        run.reason = String(record.error?.message || execution?.result?.error || 'The factory turn failed.').slice(0, 500);
        if (execution?.result?.failure?.code === 'factory_blocked') { run.status = 'paused'; return; }
        if (quotaFailure(run.reason) || execution?.result?.quotaExceeded || execution?.result?.failure?.kind === 'quota') {
          run.status = 'paused'; run.reason = 'Provider usage limit reached. Select another model in this thread to resume automatically.'; return;
        }
        const unavailable = /(?:unavailable|not running|temporarily|connection refused|fetch failed|ECONNREFUSED|ETIMEDOUT|rate limit|\b(?:429|50[234])\b)/i
          .test([record.error?.code, run.reason].join(' '));
        if (record.state === 'cancelled' || run.failures >= 4 && !unavailable) { run.status = 'paused'; return; }
        run.retryAt = now() + Math.min(300000, 15000 * 2 ** Math.min(run.failures - 1, 5));
        run.reason += ' Retrying automatically.';
        return;
      }
      if (!failed) run.failures = 0;
      if (run.phase === 'build' && !failed && !interrupted && !snapshot.ready) {
        const progress = digest(JSON.stringify([snapshot.reason, snapshot.completed, snapshot.total, snapshot.assignment,
          snapshot.total ? null : snapshot.head]));
        run.stalledTurns = run.lastProgress === progress ? run.stalledTurns + 1 : 0;
        run.lastProgress = progress;
        if (run.stalledTurns >= 2) {
          run.status = 'paused'; run.reason = 'Factory paused after repeated attempts at the same checkpoint. Inspect the last result and choose Resume factory.'; return;
        }
      }
      if (run.phase === 'verify' && !failed && !interrupted && run.verifyHead === snapshot.head) {
        run.verificationMisses = run.missedHead === snapshot.head ? run.verificationMisses + 1 : 1;
        run.missedHead = snapshot.head;
        if (run.verificationMisses >= 3) {
          run.status = 'paused'; run.reason = 'Verification could not confirm the checks on this commit after three attempts. Review the last verification turn and choose Resume factory.'; return;
        }
      }
      const verify = snapshot.ready && (run.phase !== 'verify' || interrupted || failed);
      const reason = verify ? 'Verify the completed factory contract on this commit.' : snapshot.reason ||
        'The final verification did not pass. Inspect the verification turn, fix the remaining checks and update the report.';
      const request = (origin.command.intent.skill.input || origin.command.message).slice(0, 24000);
      const checks = verify ? JSON.stringify(snapshot.checks) : '';
      const message = verify
        ? [reason, run.condition, 'Confirm the saved specification and report cover the original request: ' + request, 'Minnow executes the committed checks before this review. Inspect the saved specification, report, approved check paths and amendments. Finish with a final line YES or NO and the reason.', checks.length <= 60000 ? checks : 'Read every feature check, gate and full command from the committed factory/progress.json and factory/factory.json.'].join('\n\n')
        : [reason, 'Use only the bound checkout. Keep its current branch. End this turn after recording this checkpoint.', 'Recover from the current branch, factory/spec.md, factory/decisions.md, factory/progress.json and git history. Inspect partial edits and outstanding delegated work before starting a writer. Preserve completed steps. Original request:', request,
          run.phase === 'verify' && execution ? repository.readExecutionFinalAssistant(execution.executionId).slice(-3500) : ''].filter(Boolean).join('\n\n');
      run.stage = verify ? 'Verifying' : snapshot.assignment?.role === 'reviewer' ? 'Reviewing ' + snapshot.assignment.id : snapshot.assignment ? 'Building ' + snapshot.assignment.id : snapshot.total ? 'Finishing' : 'Preparing';
      run.reason = reason;
      enqueue(chatId, run, origin, verify ? 'verify' : 'build', message, snapshot);
    });
    if (queued && run.status === 'active' && !run.retryAt) void kick(chatId).catch(() => {});
  }
  function notify(chatId) {
    if (!started) return;
    if (working.has(chatId)) {
      pendingWake.add(chatId);
      return working.get(chatId);
    }
    const task = Promise.resolve().then(async () => {
      do { pendingWake.delete(chatId); await advance(chatId); } while (started && pendingWake.has(chatId));
    }).catch(error => {
      if (!started) return;
      const run = readRun(db, chatId);
      if (run?.status === 'active') waitReason(chatId, run, 'Factory is waiting to recover: ' + error.message.slice(0, 340));
    }).finally(() => { pendingWake.delete(chatId); working.delete(chatId); });
    working.set(chatId, task); return task;
  }
  function sweep() {
    for (const row of db.prepare("SELECT chat_id FROM chat_conversation_state WHERE json_extract(meta_json,'$.factoryRun.status') IN ('active','paused')").all()) notify(row.chat_id);
  }
  return {
    notify,
    start() {
      if (started) return;
      started = true; adoptPreviousFactoryGoals(repository); sweep();
      // Older successful runs ended on the evaluator verdict. Restore the report only if
      // this is still the end of the conversation and the original verified checkout matches.
      for (const row of db.prepare("SELECT chat_id FROM chat_conversation_state WHERE json_extract(meta_json,'$.factoryRun.status')='achieved' AND json_extract(meta_json,'$.factoryRun.reportPublishedAt') IS NULL").all()) notify(row.chat_id);
      timer = setInterval(sweep, pollMs); timer.unref?.();
    },
    async dispose() { started = false; clearInterval(timer); await Promise.allSettled(working.values()); },
    control(chatId, runId, action) {
      if (!started) throw new ChatContractError('capability_unavailable', 'The chat server is starting.');
      const run = readRun(db, chatId);
      if (!run || run.id !== runId) throw new ChatContractError('stale_revision', 'The factory run changed. Refresh this chat.');
      if (!['clear', 'resume'].includes(action)) throw new ChatContractError('invalid_request', 'Unknown factory action.');
      if (action === 'clear' && run.status !== 'cleared') {
        update(chatId, run, () => {
          run.status = 'cleared';
          const current = repository.getCommand(run.cursor);
          if (current?.captured.factoryRunId === run.id && ['accepted', 'queued', 'waiting_for_host'].includes(current.state)) {
            repository.updateCommand(current.commandId, { state: 'cancelled', held: false, result: { disposition: 'factory_cleared' } });
          }
        });
        void kick(chatId).catch(() => {});
      }
      if (action === 'resume' && run.status === 'paused') {
        const chat = repository.getChat(chatId);
        if (chat.archivedAt || chat.archiveImport?.requiresHumanResume) throw new ChatContractError('ownership_conflict', 'Restore this chat and its checkout before resuming.');
        update(chatId, run, () => {
          run.status = 'active'; run.epoch = repository.getCancellationEpoch(chatId); run.retryAt = null; run.failures = 0; run.verificationMisses = 0; run.stalledTurns = 0; run.reason = 'Resuming from the committed checkpoint.'; run.retryCursor = run.cursor;
          const current = repository.getCommand(run.cursor);
          if (current?.held && pending.includes(current.state) && repository.getLease(chatId)?.state !== 'active') repository.updateCommand(current.commandId, { state: 'cancelled', held: false });
        });
        notify(chatId);
      }
      return repository.getChat(chatId).activeGoal ?? null;
    },
  };
}
