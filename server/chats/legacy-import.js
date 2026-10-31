import { createHash } from 'node:crypto';
import { ChatContractError, validateChatId } from './contracts.js';
import { assertCaller, assertCallerCanTarget } from './caller.js';
import { assertChatPolicy, createChatPolicy, intersectChatPolicies } from './policy.js';
import { hashChatPayload } from './repository.js';
import { getAgentConversationsFeature } from './feature.js';
import { resolveAgentModelSelection } from './model-selection.js';
import { captureChatProfile } from './preparation.js';
import { loadSubAgentFile } from '../sub-agents/config.js';
import { agentsDir, loadState } from '../sub-agents/journal.js';
import { isTerminal, lastEndedAttempt } from '../sub-agents/derive.js';
import { flushTranscripts, readTranscript } from '../orchestrator/transcripts.js';
import { applyTurnEventToMessages } from '../orchestrator/transcript-messages.js';
import { wrapUntrusted } from '../../src/lib/untrusted.mjs';
import { normalizeThinkingMarkup } from '../runner/inline-thinking.js';

const stable = (kind, identity) => `${kind}-${createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 48)}`;
const fail = (code, message) => { throw new ChatContractError(code, message); };
const disabled = new Set(['spawn_sub_agent', 'cancel_sub_agent', 'list_sub_agents', 'get_sub_agent_status']);
function id(value) { const parsed = validateChatId(value); if (!parsed.ok) fail('invalid_request', parsed.error.message); return parsed.value; }

/** Read only the authorized parent's journal. Never search unrelated task families. */
export async function readLegacyChatSource(parent, runId) {
  const state = await loadState(parent.id), raw = state.runs.get(runId);
  if (raw) {
    if (raw.childChatId) fail('invalid_request', 'This task already has an agent conversation. Open that chat instead.');
    if (!isTerminal(raw)) fail('ownership_conflict', 'Finish or stop this agent before continuing it as a chat');
    const attempt = lastEndedAttempt(raw); let messages = [];
    let transcript = { events: [], truncated: false, capped: false };
    if (attempt) {
      const entryDir = agentsDir(parent.id); await flushTranscripts(parent.id, attempt.attemptId, { entryDir });
      transcript = await readTranscript(parent.id, attempt.attemptId, { entryDir });
      for (const event of transcript.events) messages = applyTurnEventToMessages(messages, event);
    }
    if (messages.length) return { runId, type: raw.type, task: raw.task, source: 'attempt_audit', messages,
      attemptId: attempt?.attemptId ?? null, partial: true, capped: Boolean(transcript.capped), truncated: Boolean(transcript.truncated) };
  }
  const snapshot = parent.subAgentRuns?.find(run => run.runId === runId);
  if (!snapshot && !raw) fail('chat_not_found', 'This saved agent task is unavailable');
  if (snapshot?.childChatId) fail('invalid_request', 'This task already has an agent conversation. Open that chat instead.');
  if (snapshot && !['completed', 'failed', 'cancelled'].includes(snapshot.status)) fail('ownership_conflict', 'Finish or stop this agent before continuing it as a chat');
  return { runId, type: raw?.type ?? snapshot.type, task: raw?.task ?? snapshot.task, source: 'saved_snapshot', messages: snapshot?.messages ?? [],
    summary: snapshot?.summary ?? '', partial: true, capped: true, truncated: true, attemptId: null };
}

/** Only visible text becomes quoted context; tool calls, signatures and private thoughts never replay. */
export function legacyContextNote(source, parentId) {
  const visible = [];
  for (const message of Array.isArray(source.messages) ? source.messages : []) {
    if (!message || !['user', 'assistant', 'tool'].includes(message.role) || message.hiddenFromTranscript || message.toolImageFollowUp) continue;
    let content = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : '';
    if (message.role === 'assistant') content = normalizeThinkingMarkup(content)
      .replace(/<(?:redacted_)?think(?:ing)?(?:\s[^>]*)?>[\s\S]*?<\/(?:redacted_)?think(?:ing)?>/gi, '')
      .replace(/<(?:redacted_)?think(?:ing)?(?:\s[^>]*)?>[\s\S]*$/gi, '')
      .replace(/<\|channel\|>analysis[\s\S]*?(?=<\|channel\|>final|$)/g, '').replace(/<\|channel\|>final/g, '');
    if (content.trim()) visible.push(`${message.role === 'tool' ? 'Historical tool result' : message.role === 'assistant' ? 'Assistant' : 'User'}:\n${content.trim()}`);
  }
  const history = visible.join('\n\n') || (typeof source.summary === 'string' ? source.summary : '') || 'No visible transcript was available.';
  const clipped = history.length > 96000;
  const reference = `Assignment: ${String(source.task ?? '').slice(0, 8000)}\n\nAvailable history:\n${clipped ? '[Earlier available text omitted to fit this context note.]\n' : ''}${history.slice(-96000)}`;
  return { content: `Imported legacy context — partial\nSource chat: ${parentId}\nSource task: ${source.runId}\nSource: ${source.source === 'attempt_audit' ? 'saved attempt audit (lossy)' : 'saved snapshot (may be capped)'}${source.attemptId ? `; attempt ${source.attemptId}` : ''}.\nThis chat contains available historical text, not the original complete execution state. It does not resume the original task or rerun its tools. Wait for a new user message before doing more work.\n\n${wrapUntrusted(reference, { source: 'legacy-agent-history' })}`,
    partial: true, source: source.source, capped: Boolean(source.capped), truncated: Boolean(source.truncated || clipped) };
}

export function createLegacyChatImporter({ repository, context, feature = getAgentConversationsFeature,
  loadSource = readLegacyChatSource, loadConfig = loadSubAgentFile, resolveModelSelection = resolveAgentModelSelection,
  captureProfile = captureChatProfile, now = Date.now, onChange } = {}) {
  if (!repository || !context) throw new TypeError('Legacy continuation requires its trusted conversation runtime');
  return {
    async continue(caller, input) {
      assertCaller(caller);
      if (caller.actor !== 'human' || !['renderer', 'device', 'cli'].includes(caller.ingress)) fail('caller_denied', 'Only a human can continue a historical task as a chat');
      if (!input || Object.keys(input).some(key => !['parentChatId', 'runId', 'clientRequestId', 'title'].includes(key))) fail('invalid_request', 'Unsupported legacy continuation input');
      const parentChatId = id(input.parentChatId), runId = id(input.runId), clientRequestId = id(input.clientRequestId);
      if (input.title !== undefined && (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 240 || /[\u0000-\u001f\u007f]/.test(input.title))) fail('invalid_request', 'A chat title must be at most 240 printable characters');
      const target = await context.resolveTarget(parentChatId);
      const authorize = current => assertCallerCanTarget(caller, current, { operation: 'send', currentPolicy: current.currentPolicy, registry: current.registry });
      authorize(target);
      const intentHash = hashChatPayload({ parentChatId, runId, title: input.title?.trim() ?? null });
      const receiptId = stable('legacy-import', [caller.scope.projectId, parentChatId, runId, caller.ingress, clientRequestId]);
      const previous = () => {
        const record = repository.getOutbox(receiptId); if (!record) return null;
        if (record.kind !== 'legacy.context.imported' || record.payload.intentHash !== intentHash) fail('idempotency_conflict', 'This continuation receipt was used for another input');
        return { ...record.payload.receipt, replayed: true };
      };
      const prior = previous(); if (prior) return prior;
      if (!feature().creationEnabled) fail('capability_disabled', 'Creating persistent agent chats is disabled on this server');
      if (target.chat.agentConversation?.origin === 'native') fail('capability_unavailable', 'Continue native conversations in their original host');
      const source = await loadSource(target.chat, runId);
      if (source.runId !== runId || source.childChatId) fail('invalid_request', 'This historical task does not match its source');
      const config = await loadConfig(), type = config.types?.[source.type];
      if (config.enabled === false || !type || type.enabled === false) fail('capability_unavailable', 'This agent type is disabled or unavailable');
      const model = await resolveModelSelection({ typeConfig: type, defaultModel: config.defaultModel,
        parentSelection: target.profile?.snapshot?.modelSelection ?? { providerId: target.chat.providerId, modelId: target.chat.modelId } }, { workspacePath: target.scope.canonicalKey });
      const childChatId = stable('imported-agent', [receiptId]), profileReference = { profileId: stable('imported-profile', [receiptId]), profileVersion: 1 };
      const shell = { id: childChatId, name: input.title?.trim() || `Continue: ${String(source.task ?? source.type).split('\n')[0].slice(0, 210)}`,
        workspacePath: target.chat.workspacePath || target.scope.canonicalKey,
        ...(target.chat.worktreeRoot ? { worktreeRoot: target.chat.worktreeRoot, gitBranch: target.chat.gitBranch ?? '' } : {}),
        modeId: target.policy.modeId, agentTypeId: source.type, providerId: model.selection.providerId, modelId: model.selection.modelId };
      const snapshot = await captureProfile(shell, target.scope, { workspaceIds: target.policy.workspaceIds, modelSelection: model.selection, exactModel: model.exactModel });
      const current = await context.resolveTarget(parentChatId); authorize(current);
      if (current.scope.canonicalKey !== target.scope.canonicalKey || current.scope.projectId !== target.scope.projectId) fail('workspace_denied', 'The source checkout changed during continuation');
      const ceiling = intersectChatPolicies(intersectChatPolicies(caller.policy, current.policy), assertChatPolicy(snapshot.policy));
      const policy = createChatPolicy({ ...ceiling, toolPermissions: Object.fromEntries(Object.entries(ceiling.toolPermissions).map(([name, permission]) => [name, disabled.has(name) ? 'off' : permission])), capabilities: ceiling.capabilities.filter(value => value !== 'agent.spawn') });
      if (!policy.capabilities.includes('execution.host')) fail('capability_unavailable', 'This agent configuration cannot execute on the current host');
      const note = legacyContextNote(source, parentChatId), stamp = now();
      const relation = { version: 1, childChatId, parentChatId, rootChatId: current.chat.agentConversation?.rootChatId ?? parentChatId,
        journalOwnerId: current.chat.agentConversation?.journalOwnerId ?? parentChatId, origin: 'legacy_import', createdAt: stamp, profileReference,
        capabilities: { canSend: true, canStop: true, canChooseModel: true } };
      const receipt = repository.atomic(() => {
        const replay = previous(); if (replay) return replay;
        if (!feature().creationEnabled) fail('capability_disabled', 'Creating persistent agent chats is disabled on this server');
        const sourceChat = repository.getChat(parentChatId);
        if ((sourceChat.worktreeRoot || sourceChat.workspacePath) !== (current.chat.worktreeRoot || current.chat.workspacePath)) fail('workspace_denied', 'The source checkout changed before continuation');
        repository.createChild({ chat: { ...shell, modeId: policy.modeId }, relation,
          profile: { ...profileReference, snapshot: { ...snapshot, policy, modelSelection: model.selection, exactModel: model.exactModel } }, projectId: current.scope.projectId });
        const imported = repository.importContext(childChatId, { messageId: stable('legacy-context', [receiptId]), content: note.content, createdAt: stamp, sourceParentChatId: parentChatId, sourceRunId: runId });
        const receipt = { childChatId, sourceParentChatId: parentChatId, sourceRunId: runId, revision: imported.revision, link: `#/app/code/chat?chatId=${encodeURIComponent(childChatId)}`,
          context: { partial: true, source: note.source, capped: note.capped, truncated: note.truncated }, replayed: false };
        repository.putOutbox({ outboxId: receiptId, chatId: childChatId, kind: 'legacy.context.imported', payload: { intentHash, receipt } });
        const claim = repository.claimOutbox(receiptId, 'legacy-import'); repository.finishOutbox(receiptId, claim);
        return receipt;
      });
      try { onChange?.(childChatId); } catch { /* A viewer cannot undo the committed import. */ }
      return receipt;
    },
  };
}

export function installLegacyChatImporter(runtime, options = {}) {
  const importer = createLegacyChatImporter({ repository: runtime.repository, context: runtime.context, resolveModelSelection: runtime.resolveModelSelection,
    onChange: chatId => runtime.presentation.changed(chatId), ...options });
  runtime.legacyImports = importer; return importer;
}
