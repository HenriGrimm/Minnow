import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AGENT_CONVERSATIONS_CAPABILITY,
  CHAT_CONTRACT_VERSION,
  CHAT_COMMAND_KINDS,
  CHAT_ERROR_CODES,
  ChatContractError,
  resolveModelSelection,
  validateAgentConversationMeta,
  validateAgentConversationsFeature,
  validateAgentProfileReference,
  validateChatCommand,
  validateChatError,
  validateChatId,
  validateChatRequest,
  validateChatTaskResult,
  validateMessageProvenance,
  validateModelOptions,
  validateModelSelection,
  validateTaskCompletionPolicy,
} from '../../server/chats/contracts.js';
import {
  AGENT_CONVERSATIONS_RELEASED,
  getAgentConversationsFeature,
} from '../../server/chats/feature.js';

function accepted(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}
function rejected(result, code = 'invalid_request') {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, code);
  assert.equal(typeof result.error.message, 'string');
  return result.error;
}
const human = { version: 1, actor: 'human', source: 'composer', kind: 'human_message' };
const peer = {
  version: 1, actor: 'agent', source: 'agent_tool', kind: 'peer_message',
  sourceChatId: 'sender', sourceTurnId: 'sender-turn',
};
const local = { version: 1, kind: 'local_only' };
const wake = {
  version: 1, kind: 'wake_delegator', recipientChatId: 'parent',
  subscriptionId: 'subscription-1', cancellationEpoch: 2,
};
const relation = {
  version: 1, childChatId: 'child', parentChatId: 'parent', rootChatId: 'root',
  journalOwnerId: 'family', origin: 'delegated', createdAt: 1700000000000,
  profileReference: { profileId: 'explore', profileVersion: 2 },
};
const send = {
  version: 1, commandId: 'command-1', chatId: 'child', kind: 'send',
  requestedAt: 1700000000000, provenance: human, message: 'Continue from the saved result.',
};
const pendingRequest = {
  version: 1, requestId: 'request-1', chatId: 'child', executionId: 'execution-1',
  toolCallId: 'call:provider-native-1', kind: 'question', state: 'pending',
  createdAt: 100, title: 'Choose an implementation', presentation: {
    question: 'Which API should be used?', options: ['Existing', 'New'], allowCustom: true,
  },
};

it('preserves bounded resolved composer images and rejects remote or executable payloads', () => {
  const images = [{ name: 'screenshot.png', dataUrl: 'data:image/png;base64,YWJjZA==' }];
  const parsed = accepted(validateChatCommand({ ...send, images }));
  assert.deepEqual(parsed.images, images);
  assert.notEqual(parsed.images[0], images[0]);
  rejected(validateChatCommand({ ...send, images: [{ name: 'remote', dataUrl: 'https://example.com/a.png' }] }));
  rejected(validateChatCommand({ ...send, images: [{ name: 'svg', dataUrl: 'data:image/svg+xml;base64,YWJj' }] }));
  rejected(validateChatCommand({ ...send, kind: 'steer', images }));
  rejected(validateChatCommand({ ...send, images: Array(2) }));
  rejected(validateChatCommand({ ...send, images: Array(21).fill(images[0]) }));
});

describe('conversation identity and record versions', () => {
  it('uses the existing safe chat/run identity boundary without accepting path segments', () => {
    for (const value of ['chat-1', 'sa_123', 'A'.repeat(160)]) accepted(validateChatId(value));
    for (const value of ['', ' '.repeat(2), 'a'.repeat(161), '../chat', 'a/b', 'a\\b', 'a\n', 4, null]) {
      rejected(validateChatId(value));
    }
  });

  it('preserves stable lineage, journal ownership and a versioned profile after orphaning', () => {
    const parsed = accepted(validateAgentConversationMeta({ ...relation, missingParent: true }));
    assert.equal(parsed.parentChatId, 'parent');
    assert.equal(parsed.journalOwnerId, 'family');
    assert.equal(parsed.profileReference.profileVersion, 2);
    assert.notEqual(parsed.profileReference, relation.profileReference);
    accepted(validateAgentConversationMeta({ ...relation, parentChatId: null }));
    rejected(validateAgentConversationMeta({ ...relation, childChatId: 'parent' }));
    rejected(validateAgentProfileReference({ profileId: 'explore', profileVersion: 0 }));
  });

  it('rejects unknown record versions and unrecognized fields instead of guessing their meaning', () => {
    rejected(validateAgentConversationMeta({ ...relation, version: 2 }), 'unsupported_version');
    rejected(validateAgentConversationMeta({ ...relation, prompt: 'not a lightweight record' }));
    rejected(validateAgentConversationMeta({ ...relation, version: undefined }), 'unsupported_version');
  });

  it('keeps unsupported native children inspect-only', () => {
    accepted(validateAgentConversationMeta({
      ...relation, origin: 'native',
      capabilities: { canSend: false, canStop: true, canChooseModel: false },
    }));
    rejected(validateAgentConversationMeta({
      ...relation, origin: 'native',
      capabilities: { canSend: true, canStop: true, canChooseModel: true },
    }));
    rejected(validateAgentConversationMeta({
      ...relation, capabilities: { canSend: false, canStop: true, canChooseModel: true },
    }));
  });
});

describe('captured model identity and semantic options', () => {
  const inherited = {
    providerId: 'minnow-router', modelId: 'my-pool',
    options: { reasoningEffort: 'high', thinkingMode: 'on', thinkingBudgetTokens: 2048 },
  };

  it('retains library/pool identity and requires complete provider/model pairs', () => {
    for (const value of [
      inherited, { providerId: 'minnow-library', modelId: 'gguf:org/model:Q4_K_M' },
      { providerId: 'custom-provider', modelId: 'organization/model-name' },
    ]) assert.deepEqual(accepted(validateModelSelection(value)), value);
    rejected(validateModelSelection({ modelId: 'model' }));
    rejected(validateModelSelection({ providerId: 'provider' }));
    rejected(validateModelSelection({ providerId: 'provider', modelId: 'model', temperature: 0.5 }));
  });

  it('inherits/merges only matching selections and keeps an explicit empty options object clear', () => {
    const target = { providerId: 'minnow-router', modelId: 'my-pool' };
    assert.deepEqual(accepted(resolveModelSelection(target, { inherited })), inherited);
    assert.deepEqual(
      accepted(resolveModelSelection({ ...target, options: { reasoningEffort: 'max' } }, { inherited })),
      { ...target, options: { ...inherited.options, reasoningEffort: 'max' } },
    );
    assert.deepEqual(
      accepted(resolveModelSelection({ ...target, options: {} }, { inherited })),
      { ...target, options: {} },
    );
    assert.equal(inherited.options.reasoningEffort, 'high', 'resolving a child must not mutate its parent');
  });

  it('does not transplant options when either model or provider changes', () => {
    for (const target of [
      { providerId: 'other-provider', modelId: inherited.modelId },
      { providerId: inherited.providerId, modelId: 'other-model' },
    ]) {
      assert.deepEqual(accepted(resolveModelSelection(target, { inherited })), target);
      assert.deepEqual(
        accepted(resolveModelSelection(target, { inherited, defaults: { thinkingMode: 'off' } })),
        { ...target, options: { thinkingMode: 'off' } },
      );
    }
  });

  it('rejects arbitrary provider JSON, invalid budgets and conflicting effective options', () => {
    for (const value of [
      { upstream: { reasoning: true } }, { reasoningEffort: '' },
      { thinkingBudgetTokens: -1 }, { thinkingBudgetTokens: 1.5 },
      { thinkingBudgetTokens: Infinity }, { thinkingBudgetTokens: Number.MAX_SAFE_INTEGER + 1 },
      { thinkingMode: 'sometimes' }, { thinkingMode: 'on', thinkingBudgetTokens: 0 },
      { thinkingMode: 'off', thinkingBudgetTokens: 2048 },
    ]) rejected(validateModelOptions(value));
    accepted(validateModelOptions({ thinkingBudgetTokens: null }));
    rejected(resolveModelSelection({
      providerId: inherited.providerId, modelId: inherited.modelId, options: { thinkingMode: 'off' },
    }, { inherited }));
    rejected(resolveModelSelection(inherited, null));
    rejected(resolveModelSelection(inherited, { injected: true }));
  });
});

describe('attribution and completion subscriptions', () => {
  it('distinguishes human inputs, peer source material and automatic task results', () => {
    accepted(validateMessageProvenance(human));
    accepted(validateMessageProvenance(peer));
    accepted(validateMessageProvenance({
      version: 1, actor: 'system', source: 'task_delivery', kind: 'delegation_result',
      runId: 'task-1', deliveryId: 'delivery-1',
    }));
    rejected(validateMessageProvenance({ ...human, actor: 'agent' }));
    rejected(validateMessageProvenance({ ...peer, sourceTurnId: undefined }));
    rejected(validateMessageProvenance({ ...peer, senderToken: 'not serialized authority' }));
    rejected(validateMessageProvenance({
      version: 1, actor: 'agent', source: 'task_delivery', kind: 'delegation_result',
      runId: 'task-1', deliveryId: 'delivery-1',
    }));
  });

  it('never manufactures a wake recipient for ordinary child follow-ups', () => {
    assert.deepEqual(accepted(validateTaskCompletionPolicy(local)), local);
    assert.deepEqual(accepted(validateTaskCompletionPolicy(wake)), wake);
    rejected(validateTaskCompletionPolicy({ ...local, recipientChatId: 'parent' }));
    rejected(validateTaskCompletionPolicy({ ...wake, cancellationEpoch: -1 }));
    rejected(validateTaskCompletionPolicy({ ...wake, subscriptionId: undefined }));
  });

  it('validates immutable terminal task results independently of runner outcomes', () => {
    const value = {
      version: 1, runId: 'task-1', childChatId: 'child', journalOwnerId: 'family',
      status: 'completed', summary: 'Saved a result.', settledAt: 200, completionPolicy: wake,
    };
    assert.deepEqual(accepted(validateChatTaskResult(value)), value);
    rejected(validateChatTaskResult({ ...value, status: 'no_report' }));
    rejected(validateChatTaskResult({
      ...value, completionPolicy: { ...wake, recipientChatId: 'child' },
    }));
  });
});

describe('durable command envelopes', () => {
  it('normalizes idle/queued sends without changing their message or provenance', () => {
    const parsed = accepted(validateChatCommand(send));
    assert.equal(parsed.mode, 'auto');
    assert.equal(parsed.message, send.message);
    assert.notEqual(parsed.provenance, send.provenance);
    accepted(validateChatCommand({ ...send, mode: 'queue', clientRequestId: 'retry:round/one' }));
    accepted(validateChatCommand({ ...send, kind: 'steer' }));
  });

  it('rejects cross-kind fields, restart fallbacks, forged receipts and self-peer sends', () => {
    rejected(validateChatCommand({ ...send, mode: 'restart' }));
    rejected(validateChatCommand({ ...send, kind: 'steer', mode: 'auto' }));
    rejected(validateChatCommand({ ...send, scope: 'tree' }));
    rejected(validateChatCommand({ ...send, provenance: { ...human, commandId: 'other' } }));
    rejected(validateChatCommand({ ...send, provenance: peer, chatId: 'sender' }), 'self_target');
    rejected(validateChatCommand({ ...send, ownershipEpoch: 7 }));
    rejected(validateChatCommand({ ...send, message: '   ' }));
  });

  it('pins stop and queue controls without rewriting the accepted command identity', () => {
    const base = { ...send };
    delete base.message;
    const stop = accepted(validateChatCommand({ ...base, kind: 'stop', scope: 'turn', executionId: 'old-execution' }));
    assert.equal(stop.executionId, 'old-execution');
    rejected(validateChatCommand({ ...stop, runId: 'another-task' }));
    for (const kind of ['edit_queued', 'remove_queued', 'push_queued']) {
      const input = {
        ...base, kind, targetCommandId: 'original-input', expectedRevision: 1,
        ...(kind === 'edit_queued' ? { message: 'Revised instruction' } : {}),
      };
      assert.equal(accepted(validateChatCommand(input)).targetCommandId, 'original-input');
      rejected(validateChatCommand({ ...input, expectedRevision: undefined }));
      rejected(validateChatCommand({ ...input, targetCommandId: input.commandId }));
    }
    assert.equal(CHAT_COMMAND_KINDS.length, 6);
  });
});

describe('durable human request records', () => {
  it('keeps simultaneous request identities separate and returns detached JSON presentation', () => {
    const first = accepted(validateChatRequest(pendingRequest));
    const second = accepted(validateChatRequest({
      ...pendingRequest, requestId: 'request-2', chatId: 'another-child', kind: 'approval',
      presentation: { command: 'npm test', cwd: 'C:/workspace', choices: ['Allow once', 'Deny'] },
    }));
    assert.notEqual(first.requestId, second.requestId);
    first.presentation.options.push('A local view change');
    assert.equal(pendingRequest.presentation.options.length, 2);
  });

  it('requires settlement/answer receipts and keeps expired callbacks visibly expired', () => {
    accepted(validateChatRequest({
      ...pendingRequest, state: 'answered', settledAt: 110, answerCommandId: 'answer-1',
    }));
    accepted(validateChatRequest({ ...pendingRequest, state: 'expired', settledAt: 110 }));
    rejected(validateChatRequest({ ...pendingRequest, answerCommandId: 'answer-1' }));
    rejected(validateChatRequest({ ...pendingRequest, state: 'answered', settledAt: 110 }));
    rejected(validateChatRequest({ ...pendingRequest, state: 'expired', settledAt: 110, answerCommandId: 'answer-1' }));
    rejected(validateChatRequest({ ...pendingRequest, state: 'cancelled', settledAt: 99 }));
    rejected(validateChatRequest({ ...pendingRequest, expiresAt: 90 }));
  });

  it('rejects callbacks, cyclic/oversized payloads and unsafe data objects', () => {
    rejected(validateChatRequest({ ...pendingRequest, callback: () => true }));
    rejected(validateChatRequest({ ...pendingRequest, presentation: { callback() {} } }));
    rejected(validateChatRequest({ ...pendingRequest, presentation: { secret: undefined } }));
    rejected(validateChatRequest({ ...pendingRequest, presentation: JSON.parse('{"__proto__":{"polluted":true}}') }));
    rejected(validateChatRequest({ ...pendingRequest, presentation: { value: 'x'.repeat(128001) } }));
    const cycle = {}; cycle.self = cycle;
    rejected(validateChatRequest({ ...pendingRequest, presentation: cycle }));
    let invoked = false;
    const accessor = { get question() { invoked = true; return 'wrong'; } };
    rejected(validateChatRequest({ ...pendingRequest, presentation: accessor }));
    const arrayAccessor = [];
    Object.defineProperty(arrayAccessor, '0', {
      enumerable: true, get() { invoked = true; return 'wrong'; },
    });
    rejected(validateChatRequest({ ...pendingRequest, presentation: { options: arrayAccessor } }));
    rejected(validateChatRequest({ ...pendingRequest, presentation: { options: new Array(2) } }));
    assert.equal(invoked, false);
    assert.equal({}.polluted, undefined);
  });
});

describe('serialized errors and released feature advertisement', () => {
  it('explicitly disabling new creation retains recovery independently of release activation', () => {
    for (const NODE_ENV of ['test', 'production']) {
      const snapshot = getAgentConversationsFeature({ NODE_ENV, MINNOW_DEBUG: '1', MINNOW_AGENT_CONVERSATIONS: '0' });
      assert.equal(snapshot.creationEnabled, false); assert.equal(snapshot.recoveryEnabled, true);
      assert.equal(snapshot.reason, 'disabled'); accepted(validateAgentConversationsFeature(snapshot));
    }
  });
  it('returns stable typed failures without stacks or unknown server fields', () => {
    const error = new ChatContractError('ownership_conflict', 'Another execution owns this chat.', {
      path: 'executionId', retryable: true,
    });
    assert.equal(error.statusCode, 409);
    assert.deepEqual(accepted(validateChatError(error.toJSON())), error.toJSON());
    assert.equal(JSON.stringify(error).includes('stack'), false);
    rejected(validateChatError({ code: 'unknown_future_error', message: 'No.' }));
    rejected(validateChatError({ code: 'invalid_request', message: 'No.', stack: 'internal data' }));
    assert.throws(() => new ChatContractError('__proto__', 'No.'), TypeError);
    assert.equal(new Set(CHAT_ERROR_CODES).size, CHAT_ERROR_CODES.length);
  });

  it('is released by default in ordinary production without an environment opt-in', () => {
    assert.equal(AGENT_CONVERSATIONS_RELEASED, true);
    for (const env of [
      {}, { NODE_ENV: 'production' }, { MINNOW_AGENT_CONVERSATIONS: '1' }, { MINNOW_DEBUG: '1' },
      { MINNOW_AGENT_CONVERSATIONS: '1', MINNOW_DEBUG: '1', NODE_ENV: 'production' },
      { MINNOW_AGENT_CONVERSATIONS: 'true', NODE_ENV: 'test' },
    ]) {
      const snapshot = getAgentConversationsFeature(env);
      assert.equal(snapshot.creationEnabled, true);
      assert.equal(snapshot.reason, 'released');
      assert.equal(snapshot.recoveryEnabled, true, 'disabling creation cannot strand stored work');
      assert.equal(Object.isFrozen(snapshot), true);
      accepted(validateAgentConversationsFeature(snapshot));
    }
  });

  it('advertises the same released versioned capability in debug and test environments', () => {
    for (const env of [
      { MINNOW_AGENT_CONVERSATIONS: '1', MINNOW_DEBUG: '1' },
      { MINNOW_AGENT_CONVERSATIONS: '1', NODE_ENV: 'test' },
    ]) {
      const snapshot = getAgentConversationsFeature(env);
      assert.equal(snapshot.version, CHAT_CONTRACT_VERSION);
      assert.equal(snapshot.capability, AGENT_CONVERSATIONS_CAPABILITY);
      assert.equal(snapshot.creationEnabled, true);
      assert.equal(snapshot.reason, 'released');
      assert.equal(Object.isFrozen(snapshot), true);
      accepted(validateAgentConversationsFeature(snapshot));
      rejected(validateAgentConversationsFeature({ ...snapshot, reason: 'not_released' }));
      rejected(validateAgentConversationsFeature({ ...snapshot, version: 2 }), 'unsupported_version');
      rejected(validateAgentConversationsFeature({ ...snapshot, localOverride: true }));
    }
  });
});
