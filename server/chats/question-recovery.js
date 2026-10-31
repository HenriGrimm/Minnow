import { ChatContractError } from './contracts.js';
import { stringifyAskAnswer } from '../runner/ask-question-tool.js';

const terminal = new Set(['completed', 'failed', 'stopped', 'recovery_required']);

/** Resume only a canonical question boundary, never an uncertain native callback. */
export function createChatQuestionRecovery({ repository, requests, verifyQuiescence, validateBoundary = async () => true, onChange = () => {} }) {
  function pendingCalls(chatId) {
    const rows = repository.readTranscript(chatId).messages;
    const answered = new Set(rows.filter(row => row.role === 'tool').map(row => row.tool_call_id));
    return rows.flatMap(row => row.role === 'assistant' ? row.tool_calls ?? [] : []).filter(call => !answered.has(call.id));
  }
  function bindings(execution) {
    const calls = pendingCalls(execution.chatId);
    const saved = repository.listRequests(execution.chatId, null).filter(row => row.executionId === execution.executionId);
    if (!calls.length || new Set(calls.map(call => call.id)).size !== calls.length || calls.some(call => call.function?.name !== 'ask_question')) return null;
    const bound = calls.map(call => saved.find(request => request.kind === 'question' && request.toolCallId === call.id &&
      ['pending', 'answered'].includes(request.state) && (request.expiresAt === undefined || request.expiresAt > Date.now())));
    return bound.every(Boolean) ? bound : null;
  }
  function canResume(execution) {
    if (!execution || terminal.has(execution.status) || execution.captured?.questionResume?.version !== 1) return false;
    const bound = bindings(execution);
    return Boolean(bound && JSON.stringify(bound.map(row => row.requestId)) === JSON.stringify(execution.captured.questionResume.requestIds) &&
      !repository.listUnsettledToolInvocations(execution.executionId).length);
  }
  return {
    canResume,
    async beforeExecutionRecovery({ reason, chatIds } = {}) {
      const heldExecutionIds = new Set();
      if (reason === 'import') return { heldExecutionIds };
      for (const execution of repository.listExecutions({ statuses: ['waiting_for_input', 'running'], limit: 1000 })) {
        if (chatIds && !chatIds.includes(execution.chatId)) continue;
        if (execution.status !== 'waiting_for_input' && !execution.captured?.questionResume) continue;
        const command = execution.commandId && repository.getCommand(execution.commandId);
        const lease = repository.getLease(execution.chatId);
        const proof = await verifyQuiescence(execution, lease);
        if (proof?.verified !== true || typeof proof.source !== 'string' || !proof.source.trim() || !Number.isSafeInteger(proof.checkedAt) || proof.checkedAt < 0 ||
          !lease || lease.executionId !== execution.executionId || !command || command.held ||
          ['settled', 'failed', 'cancelled'].includes(command.state)) continue;
        const bound = bindings(execution);
        let permitted = false;
        try { permitted = await validateBoundary(execution) !== false; } catch { /* A moved checkout or revoked policy cannot revive a saved question. */ }
        if (!bound || !permitted || repository.listUnsettledToolInvocations(execution.executionId).length ||
          execution.captured?.cancellationEpoch !== undefined && execution.captured.cancellationEpoch !== repository.getCancellationEpoch(execution.chatId)) {
          requests.expireExecution(execution.executionId, execution.chatId);
          continue;
        }
        repository.atomic(() => {
          const current = repository.getLease(execution.chatId);
          if (!current || current.executionId !== lease.executionId || current.epoch !== lease.epoch || current.ownerId !== lease.ownerId) {
            throw new ChatContractError('ownership_conflict', 'Question recovery ownership changed');
          }
          const captured = { ...execution.captured, questionResume: { version: 1, requestIds: bound.map(row => row.requestId), quiescence: proof } };
          const db = repository.getDatabase();
          db.prepare("UPDATE chat_execution_leases SET state='released',expires_at=? WHERE chat_id=?").run(Date.now(), execution.chatId);
          db.prepare("UPDATE chat_executions SET status='waiting_for_input',captured_json=?,updated_at=? WHERE execution_id=?")
            .run(JSON.stringify(captured), Date.now(), execution.executionId);
          repository.updateCommand(command.commandId, { state: 'queued', error: null });
        });
        heldExecutionIds.add(execution.executionId); onChange(execution.chatId);
      }
      return { heldExecutionIds };
    },
    async hydrate({ execution, fence, transcript, signal, assertAllowed, status }) {
      if (!execution.captured?.questionResume) return;
      if (!canResume(execution)) throw new ChatContractError('recovery_required', 'The saved question boundary cannot be resumed safely');
      for (const requestId of execution.captured.questionResume.requestIds) {
        await assertAllowed();
        status('waiting_for_input');
        const answer = await requests.wait(requestId, { signal });
        signal.throwIfAborted(); await assertAllowed();
        const request = repository.getRequest(requestId);
        transcript.append(execution.chatId, { role: 'tool', tool_call_id: request.toolCallId, content: stringifyAskAnswer(answer) });
      }
      repository.assertFence(execution.chatId, fence);
      const current = repository.getExecution(execution.executionId);
      const captured = { ...current.captured }; delete captured.questionResume;
      repository.getDatabase().prepare('UPDATE chat_executions SET captured_json=? WHERE execution_id=?').run(JSON.stringify(captured), execution.executionId);
      status('running');
    },
  };
}
