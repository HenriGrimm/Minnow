import { createHash } from 'node:crypto';
import { ChatContractError, validateChatCommand, validateModelSelection } from './contracts.js';
import { createChatPolicy, intersectChatPolicies, assertChatPolicyWithinCeiling } from './policy.js';
import { hashChatPayload } from './repository.js';
import { assertOrdinaryChatConsent, ordinaryChatConsentHash, ORDINARY_CONSENT_MS } from './ordinary-consent.js';
import { ordinaryChatScopeBlocker } from './ordinary-routing.js';
import { resolveProjectScope } from './caller.js';
import { readChatCheckoutIdentity } from './checkout-identity.js';

const id = (prefix, input) => prefix + '-' + createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 40);
const fail = (code, message) => { throw new ChatContractError(code, message); };
const checked = result => {
  if (!result.ok) fail(result.error.code, result.error.message);
  return result.value;
};

export function createOrdinaryRootAdmission({ repository, context, enabled, ordinaryFeature, now,
  requireCaller, producer, keyFor, provenance, selectionFor, captureProfile, captureNativeSelection, defaultOrdinaryModel,
  admitCausality, emit, announce, schedule }) {
  const reportId = (caller, chatId) => id('root-report', [producer(caller), chatId]);
  function saveReceipt(outboxId, chatId, kind, payload) {
    repository.putOutbox({ outboxId, chatId, kind, payload });
    repository.finishOutbox(outboxId, repository.claimOutbox(outboxId, 'ordinary-root-receipt'));
  }
  async function checkoutFor(source, workspaceId, ceiling) {
    if (!workspaceId || workspaceId === source.scope.workspaceId) return source;
    const entry = source.registry.entries.find(row => row.workspaceId === workspaceId
      && row.projectId === source.scope.projectId && !row.revoked);
    if (!entry || !ceiling.workspaceIds.includes(workspaceId) || typeof context.project !== 'function') {
      fail('workspace_denied', 'Choose an existing checkout authorized for the originating turn');
    }
    const project = await context.project(entry.canonicalKey);
    const scope = resolveProjectScope(project.registry, { projectId: source.scope.projectId, workspaceKey: entry.canonicalKey });
    if (scope.workspaceId !== workspaceId) fail('workspace_denied', 'The selected checkout registration changed');
    return { ...source, project, scope, checkoutIdentity: await readChatCheckoutIdentity(scope.canonicalKey) };
  }
  async function createOrdinary(caller, input, { confirm, signal, settleReceipt } = {}) {
    requireCaller(caller);
    const allowed = ['name', 'message', 'selection', 'workspaceId', 'reportBack', 'clientRequestId'];
    if (!input || Object.keys(input).some(key => !allowed.includes(key))
        || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 240
        || input.message !== undefined && (typeof input.message !== 'string' || !input.message.trim() || Buffer.byteLength(input.message) > 24_000)
        || input.reportBack && !input.message) fail('invalid_request', 'Choose a valid title and optional first message (up to 24 KB)');
    const key = keyFor(input), intentHash = hashChatPayload(input);
    const receiptId = id('root-create', [producer(caller), key]);
    const chatId = id('chat', receiptId);
    const previous = () => {
      const prior = repository.getOutbox(receiptId);
      if (!prior) return null;
      if (prior.kind !== 'conversation.created' || prior.payload.intentHash !== intentHash) fail('idempotency_conflict', 'Creation request was reused');
      repository.getChat(prior.chatId);
      return { ...prior.payload.receipt, replayed: true };
    };
    ordinaryChatConsentHash(repository, caller, null);
    const replayed = previous(); if (replayed) return replayed;
    enabled(caller);
    if (!ordinaryFeature()?.admissionEnabled || typeof captureProfile !== 'function') {
      fail('capability_unavailable', 'This execution cannot request creation of an ordinary chat');
    }
    const source = await context.resolveTarget(caller.chatId);
    if (source.chat.agentConversation || !source.chat.chatCommandVersion || !source.checkoutIdentity
        || source.chat.workspacePreparation?.intent?.source?.repos) {
      fail('workspace_denied', 'This originating chat does not have a reusable ordinary checkout');
    }
    const ceiling = intersectChatPolicies(caller.policy, source.policy);
    if (!ceiling.capabilities.includes('chat.send') || !ceiling.workspaceIds.includes(source.scope.workspaceId)) {
      fail('policy_denied', 'The calling turn cannot create a chat in this checkout');
    }
    // Full access (on both the turn and the live source policy) creates without
    // asking; Manual and Auto keep the exact one-time confirmation.
    const fullAccess = ceiling.permissionLevel === 'full';
    if (!fullAccess && typeof confirm !== 'function') {
      fail('capability_unavailable', 'This execution cannot request creation of an ordinary chat');
    }
    const destination = await checkoutFor(source, input.workspaceId, ceiling);
    const chat = { id: chatId, name: input.name, workspacePath: source.chat.workspacePath, modeId: ceiling.modeId };
    if (destination !== source) {
      const base = await context.project(source.chat.workspacePath);
      if (base.projectId !== destination.scope.projectId) fail('workspace_denied', 'The originating workspace no longer matches the chosen checkout');
      if (base.scope.workspaceId !== destination.scope.workspaceId) chat.worktreeRoot = destination.scope.canonicalKey;
    } else if (source.chat.worktreeRoot) {
      chat.worktreeRoot = source.chat.worktreeRoot;
      if (source.chat.gitBranch) chat.gitBranch = source.chat.gitBranch;
    }
    if (ordinaryChatScopeBlocker(chat)) fail('capability_unavailable', 'This configuration cannot use ordinary server execution');
    const binding = checked(validateModelSelection(input.selection ?? await defaultOrdinaryModel?.() ?? {
      providerId: source.chat.providerId, modelId: source.chat.modelId,
    }));
    const selection = await selectionFor({ ...destination, chat, profile: { snapshot: { modelSelection: binding } } }, caller, input);
    Object.assign(chat, { providerId: selection.providerId, modelId: selection.modelId });
    const nativeExecution = await captureNativeSelection?.(selection);
    if (nativeExecution?.requestedMode === 'native') fail('capability_unavailable', 'This model cannot enforce the originating turn’s policy');
    const captured = await captureProfile({ target: { ...destination, chat, currentPolicy: ceiling }, selection, caller, input });
    const policy = intersectChatPolicies(ceiling, createChatPolicy(captured.snapshot.policy));
    if (policy.modeId !== chat.modeId || !policy.workspaceIds.includes(destination.scope.workspaceId)) fail('policy_denied', 'The resulting chat policy does not match the requested scope');
    const profile = { ...captured, snapshot: { ...captured.snapshot, policy, modelSelection: selection } };
    const action = { operation: 'create', intentHash, chat, selection, checkoutIdentity: destination.checkoutIdentity, policyHash: hashChatPayload(policy) };
    const proof = fullAccess ? null : await confirm(action, { title: chat.name, model: selection, checkout: destination.scope.canonicalKey,
      ...(input.message !== undefined ? { firstMessage: input.message } : {}), reportBack: input.reportBack === true });
    signal?.throwIfAborted();
    const current = await context.resolveTarget(caller.chatId);
    const currentDestination = await checkoutFor(current, input.workspaceId, ceiling);
    const result = repository.atomic(() => {
      requireCaller(caller);
      enabled(caller);
      signal?.throwIfAborted();
      if (!ordinaryFeature()?.admissionEnabled || current.scope.projectId !== source.scope.projectId || current.scope.workspaceId !== source.scope.workspaceId
          || current.checkoutIdentity !== source.checkoutIdentity || hashChatPayload(source.policy) !== hashChatPayload(current.policy)
          || currentDestination.scope.workspaceId !== destination.scope.workspaceId
          || currentDestination.checkoutIdentity !== destination.checkoutIdentity) {
        fail('policy_denied', 'The originating chat policy or checkout changed while awaiting confirmation');
      }
      const replayed = previous(); if (replayed) return replayed;
      if (!fullAccess) assertOrdinaryChatConsent(repository, caller, action, proof, now());
      const created = repository.createOrdinaryRoot(chat, { projectId: source.scope.projectId, profile });
      let commandId;
      if (input.message !== undefined) {
        commandId = id('command', receiptId);
        const command = checked(validateChatCommand({ version: 1, commandId, chatId, requestedAt: now(), kind: 'send',
          mode: 'auto', provenance: provenance(caller, commandId, {}), message: input.message, modelSelection: selection,
          clientRequestId: key, profileReference: { profileId: profile.profileId, profileVersion: profile.profileVersion } }));
        const causal = admitCausality?.({ caller, command }) ?? { causalRootId: command.provenance.causalRootId, causalDepth: 0 };
        repository.admitCommand(command, { producerId: receiptId, requestKey: key, captured: {
          ...causal, policy, scope: currentDestination.scope, projectId: current.scope.projectId, checkoutIdentity: currentDestination.checkoutIdentity,
          cancellationEpoch: 0, profile: created.profile, ...(nativeExecution ? { nativeExecution } : {}),
        } });
        repository.updateCommand(commandId, { state: 'queued' });
      }
      const receipt = { chatId, link: '#/app/code/chat?chatId=' + encodeURIComponent(chatId),
        ...(commandId ? { commandId, disposition: 'queued' } : { disposition: 'created' }), replayed: false };
      saveReceipt(receiptId, chatId, 'conversation.created', { intentHash, receipt });
      if (input.reportBack) saveReceipt(reportId(caller, chatId), chatId, 'conversation.report', {
        commandId, expiresAt: now() + ORDINARY_CONSENT_MS, checkoutIdentity: currentDestination.checkoutIdentity, policy,
      });
      settleReceipt?.(receipt);
      return receipt;
    });
    if (!result.replayed) {
      emit({ type: 'configuration', chatId });
      if (result.commandId) { announce(repository.getCommand(result.commandId)); schedule(chatId); }
    }
    return result;
  }
  function ordinaryReport(caller, target) {
    requireCaller(caller);
    const grant = repository.getOutbox(reportId(caller, target.chat.id));
    if (grant?.kind !== 'conversation.report' || grant.payload.expiresAt <= now()
        || grant.payload.checkoutIdentity !== target.checkoutIdentity) return null;
    assertChatPolicyWithinCeiling(target.policy, createChatPolicy(grant.payload.policy));
    return grant.payload.commandId;
  }
  return { createOrdinary, ordinaryReport };
}
