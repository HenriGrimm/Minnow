import { createHash } from 'node:crypto';
import { ChatContractError, validateChatCommand, validateModelSelection } from './contracts.js';
import { createChatPolicy, intersectChatPolicies, assertChatPolicyWithinCeiling, withOrdinaryWorktreeRetry } from './policy.js';
import { hashChatPayload } from './repository.js';
import { assertOrdinaryChatConsent, ordinaryChatConsentHash } from './ordinary-consent.js';
import { ordinaryChatScopeBlocker } from './ordinary-routing.js';
import { assertCallerCanTarget, resolveProjectScope } from './caller.js';
import { checkoutKey, readChatCheckoutIdentity } from './checkout-identity.js';
import { rebindChatWorkspacePolicy } from './workspace-preparation.js';

const id = (prefix, input) => prefix + '-' + createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 40);
const fail = (code, message) => { throw new ChatContractError(code, message); };
const checked = result => {
  if (!result.ok) fail(result.error.code, result.error.message);
  return result.value;
};

export function createOrdinaryRootAdmission({ repository, context, enabled, ordinaryFeature, now,
  requireCaller, producer, keyFor, provenance, selectionFor, captureProfile, captureNativeSelection, defaultOrdinaryModel,
  captureWorkspacePreparation, admitWorkspacePreparation,
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
    const allowed = ['name', 'message', 'selection', 'reasoningEffort', 'workspaceId', 'enableWorktree', 'reportBack', 'clientRequestId'];
    if (!input || Object.keys(input).some(key => !allowed.includes(key))
        || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 240
        || input.message !== undefined && (typeof input.message !== 'string' || !input.message.trim() || Buffer.byteLength(input.message) > 24_000)
        || input.reportBack && !input.message) fail('invalid_request', 'Choose a valid title and optional first message (up to 24 KB)');
    if (input.enableWorktree !== undefined && typeof input.enableWorktree !== 'boolean') fail('invalid_request', 'enable_worktree must be boolean');
    if (input.enableWorktree && input.workspaceId !== undefined) fail('invalid_request', 'Choose enable_worktree or workspace_id, not both');
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
    if (input.enableWorktree) {
      if (source.chat.worktreeRoot || !chat.workspacePath || checkoutKey(chat.workspacePath) !== source.scope.canonicalKey) {
        fail('workspace_denied', 'Enable a new worktree from a chat running in the Local workspace');
      }
      if (typeof captureWorkspacePreparation !== 'function' || typeof admitWorkspacePreparation !== 'function') {
        fail('capability_unavailable', 'Automatic worktree setup is not available on this host');
      }
      chat.worktreeEnabled = true;
    }
    if (destination !== source) {
      const base = await context.project(source.chat.workspacePath);
      if (base.projectId !== destination.scope.projectId) fail('workspace_denied', 'The originating workspace no longer matches the chosen checkout');
      if (base.scope.workspaceId !== destination.scope.workspaceId) chat.worktreeRoot = destination.scope.canonicalKey;
    } else if (source.chat.worktreeRoot) {
      chat.worktreeRoot = source.chat.worktreeRoot;
      if (source.chat.gitBranch) chat.gitBranch = source.chat.gitBranch;
    }
    if (ordinaryChatScopeBlocker(chat)) fail('capability_unavailable', 'This configuration cannot use ordinary server execution');
    const defaults = input.selection ?? await defaultOrdinaryModel?.() ?? {
      providerId: source.chat.providerId, modelId: source.chat.modelId,
    };
    const binding = checked(validateModelSelection({ ...defaults, ...(input.reasoningEffort !== undefined
      ? { options: { ...defaults.options, reasoningEffort: input.reasoningEffort } } : {}) }));
    const selection = await selectionFor({ ...destination, chat, profile: { snapshot: { modelSelection: binding } } }, caller, input);
    Object.assign(chat, { providerId: selection.providerId, modelId: selection.modelId,
      ...(input.reasoningEffort !== undefined ? { reasoningEffort: selection.options?.reasoningEffort } : {}) });
    if (input.reasoningEffort !== undefined && selection.options?.reasoningEffort !== input.reasoningEffort) {
      fail('options_unsupported', 'The selected model did not retain the requested reasoning effort');
    }
    const nativeExecution = await captureNativeSelection?.(selection);
    if (nativeExecution?.requestedMode === 'native') fail('capability_unavailable', 'This model cannot enforce the originating turn’s policy');
    const captured = await captureProfile({ target: { ...destination, chat, currentPolicy: ceiling }, selection, caller, input });
    const policy = intersectChatPolicies(ceiling, createChatPolicy(captured.snapshot.policy));
    if (policy.modeId !== chat.modeId || !policy.workspaceIds.includes(destination.scope.workspaceId)) fail('policy_denied', 'The resulting chat policy does not match the requested scope');
    const profile = { ...captured, snapshot: { ...captured.snapshot, policy, modelSelection: selection } };
    const worktree = input.enableWorktree
      ? await captureWorkspacePreparation({ ...destination, chat }, { newChat: true }) : null;
    if (input.enableWorktree && !worktree) fail('capability_unavailable', 'Could not capture automatic worktree setup');
    // Like the composer toggle, a blank chat captures the eventual source HEAD
    // on send, not when the user enables the worktree.
    const workspacePreparation = input.message !== undefined ? worktree : null;
    const action = { operation: 'create', intentHash, chat, selection, checkoutIdentity: destination.checkoutIdentity, policyHash: hashChatPayload(policy),
      ...(workspacePreparation ? { worktreeSource: workspacePreparation.source } : {}) };
    const proof = fullAccess ? null : await confirm(action, { title: chat.name, model: selection,
      checkout: worktree ? `New isolated worktree from ${destination.scope.canonicalKey}` : destination.scope.canonicalKey,
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
      if (workspacePreparation) admitWorkspacePreparation(chatId, workspacePreparation);
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
          ...(workspacePreparation ? { workspacePreparation } : {}),
        } });
        repository.updateCommand(commandId, { state: 'queued' });
      }
      const receipt = { chatId, link: '#/app/code/chat?chatId=' + encodeURIComponent(chatId),
        ...(commandId ? { commandId, disposition: 'queued' } : { disposition: 'created' }), modelSelection: selection, replayed: false };
      saveReceipt(receiptId, chatId, 'conversation.created', { intentHash, receipt });
      if (input.reportBack) saveReceipt(reportId(caller, chatId), chatId, 'conversation.report', {
        // The report is bound to the originating execution by reportId and
        // requireCaller, not the approval dialog's response deadline.
        commandId, checkoutIdentity: currentDestination.checkoutIdentity, policy,
        ...(workspacePreparation ? { workspaceIntentId: workspacePreparation.id } : {}),
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
    if (grant?.kind !== 'conversation.report' || target.scope.projectId !== caller.scope.projectId) return null;
    let policy = createChatPolicy(grant.payload.policy);
    if (grant.payload.workspaceIntentId) {
      const setup = target.chat.workspacePreparation;
      if (setup?.intent?.id !== grant.payload.workspaceIntentId || setup.status === 'local') return null;
      if (setup.status === 'ready') {
        if (setup.binding?.checkoutIdentity !== target.checkoutIdentity) return null;
        policy = rebindChatWorkspacePolicy(policy, { sourceWorkspaceId: setup.intent.sourceWorkspaceId, workspaceId: target.scope.workspaceId });
      } else if (grant.payload.checkoutIdentity !== target.checkoutIdentity) return null;
    } else if (grant.payload.checkoutIdentity !== target.checkoutIdentity) return null;
    assertChatPolicyWithinCeiling(target.policy, policy);
    return grant.payload.commandId;
  }
  // The first-reply receipt also proves which manager created a worktree.
  // Only human-started Full access turns can use it for ongoing coordination.
  // This does not add the checkout to the caller's file or shell policy.
  function ordinaryAssignment(caller, source, target, operation) {
    const setup = target.chat.workspacePreparation;
    if (caller.actor !== 'agent' || caller.policy.permissionLevel !== 'full' ||
        source?.policy.permissionLevel !== 'full' || source.chat.id !== caller.chatId ||
        source.chat.agentConversation || target.chat.agentConversation || target.chat.id === caller.chatId ||
        !target.chat.explicitOrdinaryRoot || target.chat.chatCommandVersion !== 1 ||
        target.scope.projectId !== source.scope.projectId) return null;

    const row = repository.getDatabase().prepare(`
      SELECT o.outbox_id FROM chat_outbox o JOIN chat_commands c
        ON c.command_id=json_extract(o.payload_json,'$.commandId') AND c.chat_id=o.chat_id
      WHERE o.kind='conversation.report' AND o.chat_id=? AND o.state='applied'
        AND json_type(o.payload_json,'$.workspaceIntentId')='text'
        AND json_extract(c.payload_json,'$.provenance.sourceChatId')=?
      LIMIT 1`).get(target.chat.id, caller.chatId);
    const grant = row && repository.getOutbox(row.outbox_id)?.payload;
    if (!grant || grant.policy?.permissionLevel !== 'full') return null;
    const ready = setup?.status === 'ready';
    const bound = ready ? setup.binding && target.chat.worktreeRoot &&
      setup.binding.checkoutIdentity === target.checkoutIdentity &&
      checkoutKey(setup.binding.path) === target.scope.canonicalKey
      : !target.chat.worktreeRoot && target.scope.workspaceId === source.scope.workspaceId &&
        target.checkoutIdentity === source.checkoutIdentity && ['read', 'retry'].includes(operation);
    if (!bound || setup?.status === 'local' || setup?.intent?.id !== grant.workspaceIntentId ||
        setup.intent.sourceWorkspaceId !== source.scope.workspaceId ||
        setup.intent.source.checkoutIdentity !== source.checkoutIdentity || grant.checkoutIdentity !== source.checkoutIdentity) {
      if (operation === 'send' || operation === 'stop') {
        fail('workspace_denied', 'The assignment no longer has its verified worktree. No action was sent to Local.');
      }
      return null;
    }

    ordinaryChatConsentHash(repository, caller, null);
    const authorized = assertCallerCanTarget(caller, source, {
      operation: operation === 'retry' ? 'send' : operation, currentPolicy: source.currentPolicy, registry: source.registry,
    });
    if (operation !== 'read' && operation !== 'retry') {
      const binding = { sourceWorkspaceId: source.scope.workspaceId, workspaceId: target.scope.workspaceId };
      const ceiling = intersectChatPolicies(rebindChatWorkspacePolicy(authorized.policy, binding),
        rebindChatWorkspacePolicy(withOrdinaryWorktreeRetry(grant.policy, authorized.policy), binding));
      assertChatPolicyWithinCeiling(target.policy, ceiling);
    }
    return { commandId: grant.commandId, setup };
  }
  return { createOrdinary, ordinaryReport, ordinaryAssignment };
}
