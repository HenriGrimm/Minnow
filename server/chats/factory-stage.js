import { wrapUntrusted } from '../../src/lib/untrusted.mjs';
import { createHash } from 'node:crypto';
import { readFactoryCheckpoint, factoryCheckPassed } from './factory-checkpoint.js';
import { createChatTaskRepository } from './task-repository.js';

const blocked = error => ({ outcome: 'crashed', error, failure: { code: 'factory_blocked' } });

/** Drive scheduled work through the same permission gate, journal and checkout fence as a model tool call. */
export async function runFactoryStage({ repository, chatId, command, execution, prepared, transcript, execute, signal }) {
  const captured = execution.captured;
  const verify = captured.factoryPhase === 'verify';
  const assignment = captured.factoryAssignment;
  if (!verify && !assignment) return;
  const snapshot = await readFactoryCheckpoint(prepared.cwd);
  if (snapshot.blocked || captured.factoryHead && snapshot.head !== captured.factoryHead) {
    return { outcome: 'no_report' }; // The controller re-reads the changed checkpoint.
  }
  if (verify) {
    if (!snapshot.ready) return { outcome: 'no_report' };
    for (const [index, check] of snapshot.checks.entries()) {
      const result = await execute('execute_command', check, { toolCallId: 'factory-check-' + index, signal });
      if (!factoryCheckPassed(result, check.command)) {
        const message = 'Factory verification stopped in ' + check.cwd + ' at ' + check.command + '\n\n' +
          String(result?.content || 'The command returned no exit receipt.').slice(-3000);
        transcript.append(chatId, { role: 'assistant', content: message });
        if (result?.isError) return blocked(message);
        return { outcome: 'no_report' };
      }
    }
    prepared.tools = prepared.tools.filter(tool => tool.function.name !== 'execute_command');
    const evidence = '\n\nMinnow recorded successful exit codes for all ' + snapshot.checks.length +
      ' distinct committed check commands. Review the specification and the report for completeness. End your assessment with YES or NO on its own line. Read the full committed files if an excerpt is incomplete.\n' +
      wrapUntrusted(JSON.stringify({ specification: snapshot.spec.slice(0, 24000), deliveryReport: snapshot.report.slice(0, 18000) }), { source: 'factory-commit' });
    prepared.systemPrompt += evidence;
    if (prepared.cliTurnContext) prepared.cliTurnContext += evidence;
    return;
  }
  if (snapshot.assignment?.id !== assignment.id || snapshot.assignment?.role !== assignment.role) return { outcome: 'no_report' };
  const reviewer = assignment.role === 'reviewer';
  const requestId = 'factory-' + createHash('sha256').update(JSON.stringify([captured.factoryRunId, captured.factoryHead,
    assignment.role, assignment.id, assignment.attempt])).digest('hex').slice(0, 40);
  // The child admission is durable even if the lead crashes before its spawn tool returns.
  const previous = repository.getDatabase().prepare(
    "SELECT run_id, payload_json FROM chat_commands WHERE request_key=? AND json_extract(captured_json,'$.factoryParentRunId')=? AND json_extract(payload_json,'$.provenance.sourceChatId')=? ORDER BY position DESC LIMIT 1"
  ).get(requestId, captured.factoryRunId, chatId);
  let receipt;
  if (previous?.run_id) {
    receipt = createChatTaskRepository({ repository }).getResult(previous.run_id);
    if (!receipt) return { outcome: 'no_report' };
    const earlier = JSON.parse(previous.payload_json).modelSelection;
    if (receipt.status !== 'completed' && (earlier.providerId !== command.modelSelection.providerId || earlier.modelId !== command.modelSelection.modelId)) receipt = null;
  }
  if (!receipt?.runId) {
    const task = reviewer
      ? 'Review the committed changes through ' + assignment.id + ' against factory/spec.md and the frozen contract. Read only. Report blocking findings with a failing command or specific spec line. List other observations as follow-ups.'
      : 'Implement only feature ' + assignment.id + ' (' + assignment.title + ') from factory/spec.md and factory/progress.json in this checkout. Inspect partial edits first. Preserve frozen checks. Run its checks and project gates. Leave the changes for the lead to verify and commit. Report files, commands, results and remaining issues.';
    const result = await execute('spawn_sub_agent', { title: (reviewer ? 'Reviewer' : 'Builder') + ' · ' + assignment.id,
      task, target: command.modelSelection, wait: true, workspace_strategy: 'shared', client_request_id: requestId }, { toolCallId: requestId, signal });
    try { receipt = JSON.parse(result.content); } catch { return blocked(String(result?.content || 'Factory could not start the assigned agent.').slice(0, 1200)); }
    if (!receipt?.runId) return blocked('Factory could not obtain an agent assignment receipt.');
  }
  if (receipt.status === 'running') return { outcome: 'no_report' };
  if (receipt.status === 'failed' && /usage limit|quota|insufficient (?:balance|credits)|payment required|\b402\b/i.test(receipt.summary || '')) {
    return { outcome: 'crashed', error: 'Provider usage limit reached in the assigned ' + assignment.role, failure: { kind: 'quota' } };
  }
  let evidence = '';
  if (!reviewer && receipt.status === 'completed') {
    for (const [index, check] of snapshot.featureChecks.entries()) {
      const result = await execute('execute_command', check, { toolCallId: 'factory-feature-check-' + index, signal });
      if (factoryCheckPassed(result, check.command)) continue;
      evidence = 'A feature check failed in ' + check.cwd + ': ' + check.command + '\n' + String(result?.content || '').slice(-3000);
      if (result?.isError) return blocked(evidence);
      break;
    }
    evidence ||= 'Minnow independently ran all ' + snapshot.featureChecks.length + ' feature and project checks successfully.';
  }
  transcript.append(chatId, { role: 'user', hiddenFromTranscript: true, content:
    'Factory received the assigned ' + assignment.role + ' result for ' + assignment.id + '. Status: ' + receipt.status +
    '. ' + evidence + ' Inspect the checkout and verify the result. Record this checkpoint and end the turn before the next assignment. Do not spawn another agent for this assignment.\n\nAgent report:\n' +
    String(receipt.summary || '').slice(0, 12000) });
}
