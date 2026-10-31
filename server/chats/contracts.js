/**
 * Versioned, transport-neutral conversation records. These parsers validate
 * shape, not authority: caller identity and live capabilities are server policy.
 * No filesystem, process, provider or renderer dependencies belong here.
 */
export const CHAT_CONTRACT_VERSION = 1;
export const CHAT_MIN_CLIENT_VERSION = 1;
export const AGENT_CONVERSATIONS_CAPABILITY = 'agentConversationsV1';

export const CHAT_ACTORS = Object.freeze(['human', 'agent', 'system']);
export const CHAT_MESSAGE_SOURCES = Object.freeze([
  'composer', 'agent_tool', 'task_delivery', 'scheduler', 'cli', 'device', 'migration',
]);
export const CHAT_MESSAGE_KINDS = Object.freeze([
  'human_message', 'peer_message', 'delegation_result',
]);
export const CHAT_COMMAND_KINDS = Object.freeze([
  'send', 'steer', 'stop', 'edit_queued', 'remove_queued', 'push_queued',
]);
export const CHAT_COMMAND_STATES = Object.freeze([
  'accepted', 'queued', 'waiting_for_host', 'running', 'settled', 'failed', 'cancelled',
]);
export const CHAT_EXECUTION_STATES = Object.freeze([
  'queued', 'waiting_for_host', 'waiting_for_model', 'loading_model', 'running', 'waiting',
  'waiting_for_agents', 'waiting_for_input', 'waiting_for_approval',
  'stopping', 'completed', 'failed', 'stopped', 'recovery_required',
]);
export const CHAT_DISPOSITIONS = Object.freeze([
  'accepted', 'queued', 'started', 'steered', 'stopping', 'settled', 'waiting_for_host',
]);
export const CHAT_REQUEST_KINDS = Object.freeze(['question', 'approval']);
export const CHAT_REQUEST_STATES = Object.freeze(['pending', 'answered', 'expired', 'cancelled']);
export const CHAT_TASK_TERMINAL_STATUSES = Object.freeze([
  'completed', 'failed', 'cancelled', 'interrupted',
]);
export const CHAT_ERROR_HTTP_STATUS = Object.freeze({
  invalid_request: 400,
  unsupported_version: 409,
  capability_disabled: 409,
  capability_unavailable: 409,
  caller_not_active: 409,
  caller_denied: 403,
  policy_denied: 403,
  workspace_denied: 403,
  cross_project_denied: 403,
  chat_not_found: 404,
  task_not_found: 404,
  command_not_found: 404,
  request_not_found: 404,
  model_unavailable: 409,
  options_unsupported: 400,
  idempotency_conflict: 409,
  ownership_conflict: 409,
  stale_revision: 409,
  request_expired: 409,
  queue_full: 429,
  causal_limit: 429,
  wait_cycle: 409,
  self_target: 400,
  steer_unsupported: 409,
  recovery_required: 409,
  internal_error: 500,
});
export const CHAT_ERROR_CODES = Object.freeze(Object.keys(CHAT_ERROR_HTTP_STATUS));

const ID_RE = /^[a-zA-Z0-9_-]{1,160}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export class ChatContractError extends Error {
  constructor(code, message, options = {}) {
    if (!has(CHAT_ERROR_HTTP_STATUS, code)) throw new TypeError('Unknown chat error code');
    super(message);
    this.name = 'ChatContractError';
    this.code = code;
    this.statusCode = CHAT_ERROR_HTTP_STATUS[code];
    if (options.path) this.path = options.path;
    this.retryable = options.retryable === true;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.path ? { path: this.path } : {}),
      retryable: this.retryable,
    };
  }
}

function invalid(path, message, code = 'invalid_request') {
  throw new ChatContractError(code, message, { path });
}

function result(parse, value) {
  try {
    return { ok: true, value: parse(value, '') };
  } catch (error) {
    if (!(error instanceof ChatContractError)) throw error;
    return { ok: false, error: error.toJSON() };
  }
}

function at(path, key) {
  return path ? path + '.' + key : key;
}

function object(value, path, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    invalid(path, 'Expected a plain object');
  }
  if (Object.getOwnPropertySymbols(value).length) invalid(path, 'Symbol fields are not supported');
  const allowed = keys ? new Set(keys) : null;
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !has(descriptor, 'value')) {
      invalid(at(path, key), 'Expected an enumerable data field');
    }
    if (FORBIDDEN_KEYS.has(key) || (allowed && !allowed.has(key))) {
      invalid(at(path, key), 'Unsupported field');
    }
  }
  return value;
}

function text(value, path, max, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) {
    invalid(path, 'Expected ' + (empty ? 'a' : 'a nonempty') + ' string of at most ' + max + ' characters');
  }
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid(path, 'Unpaired Unicode surrogate');
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      invalid(path, 'Unpaired Unicode surrogate');
    }
  }
  return value;
}

function label(value, path, max = 512) {
  const output = text(value, path, max).trim();
  if (CONTROL_RE.test(output)) invalid(path, 'Control characters are not supported');
  return output;
}

function id(value, path) {
  if (typeof value !== 'string' || !ID_RE.test(value)) invalid(path, 'Invalid conversation identity');
  return value;
}

function integer(value, path, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) invalid(path, 'Expected a safe integer at least ' + min);
  return value;
}

function bool(value, path) {
  if (typeof value !== 'boolean') invalid(path, 'Expected a boolean');
  return value;
}

function member(value, path, choices) {
  if (!choices.includes(value)) invalid(path, 'Unsupported value');
  return value;
}

function version(row, path) {
  if (row.version !== CHAT_CONTRACT_VERSION) {
    invalid(at(path, 'version'), 'Unsupported conversation record version', 'unsupported_version');
  }
  return CHAT_CONTRACT_VERSION;
}

function optional(row, key, path, parse, output) {
  if (has(row, key) && row[key] !== undefined) output[key] = parse(row[key], at(path, key));
}

function modelOptions(value, path) {
  const row = object(value, path, ['reasoningEffort', 'thinkingMode', 'thinkingBudgetTokens']);
  const output = {};
  optional(row, 'reasoningEffort', path, (v, p) => label(v, p, 64), output);
  optional(row, 'thinkingMode', path, (v, p) => member(v, p, ['inherit', 'on', 'off']), output);
  optional(row, 'thinkingBudgetTokens', path, (v, p) => v === null ? null : integer(v, p), output);
  if (output.thinkingMode === 'off' && output.thinkingBudgetTokens > 0) {
    invalid(path, 'Thinking off cannot have a positive thinking budget');
  }
  if (output.thinkingMode === 'on' && output.thinkingBudgetTokens === 0) {
    invalid(path, 'Thinking on cannot have a zero thinking budget');
  }
  return output;
}

function modelSelection(value, path) {
  const row = object(value, path, ['providerId', 'modelId', 'options']);
  const output = {
    providerId: label(row.providerId, at(path, 'providerId'), 256),
    modelId: label(row.modelId, at(path, 'modelId'), 1024),
  };
  optional(row, 'options', path, modelOptions, output);
  return output;
}

function profileReference(value, path) {
  const row = object(value, path, ['profileId', 'profileVersion']);
  return {
    profileId: id(row.profileId, at(path, 'profileId')),
    profileVersion: integer(row.profileVersion, at(path, 'profileVersion'), 1),
  };
}

function provenance(value, path) {
  const keys = [
    'version', 'actor', 'source', 'kind', 'sourceChatId', 'sourceTurnId',
    'commandId', 'causalRootId', 'replyToCommandId', 'runId', 'deliveryId',
  ];
  const row = object(value, path, keys);
  const output = {
    version: version(row, path),
    actor: member(row.actor, at(path, 'actor'), CHAT_ACTORS),
    source: member(row.source, at(path, 'source'), CHAT_MESSAGE_SOURCES),
    kind: member(row.kind, at(path, 'kind'), CHAT_MESSAGE_KINDS),
  };
  for (const key of keys.slice(4)) optional(row, key, path, id, output);
  if (output.kind === 'human_message' && output.actor !== 'human') {
    invalid(path, 'A human message must have a human actor');
  }
  if (output.kind === 'peer_message') {
    if (output.actor !== 'agent' || !output.sourceChatId || !output.sourceTurnId) {
      invalid(path, 'A peer message requires an agent and originating chat and turn');
    }
  }
  if (output.kind === 'delegation_result') {
    if (output.actor !== 'system' || output.source !== 'task_delivery'
      || !output.runId || !output.deliveryId) {
      invalid(path, 'A delegation result requires system delivery and task/delivery identities');
    }
  }
  return output;
}

function relation(value, path) {
  const row = object(value, path, [
    'version', 'childChatId', 'parentChatId', 'rootChatId', 'journalOwnerId', 'origin',
    'createdAt', 'missingParent', 'initialRunId', 'profileReference', 'capabilities',
  ]);
  const output = {
    version: version(row, path),
    childChatId: id(row.childChatId, at(path, 'childChatId')),
    parentChatId: row.parentChatId === null ? null : id(row.parentChatId, at(path, 'parentChatId')),
    rootChatId: id(row.rootChatId, at(path, 'rootChatId')),
    journalOwnerId: id(row.journalOwnerId, at(path, 'journalOwnerId')),
    origin: member(row.origin, at(path, 'origin'), ['delegated', 'legacy_import', 'native']),
    createdAt: integer(row.createdAt, at(path, 'createdAt')),
  };
  if (output.childChatId === output.parentChatId) invalid(path, 'A child cannot be its own parent');
  optional(row, 'missingParent', path, bool, output);
  optional(row, 'initialRunId', path, id, output);
  optional(row, 'profileReference', path, profileReference, output);
  optional(row, 'capabilities', path, (v, p) => {
    const caps = object(v, p, ['canSend', 'canStop', 'canChooseModel']);
    const parsed = {
      canSend: bool(caps.canSend, at(p, 'canSend')),
      canStop: bool(caps.canStop, at(p, 'canStop')),
      canChooseModel: bool(caps.canChooseModel, at(p, 'canChooseModel')),
    };
    if (parsed.canChooseModel && !parsed.canSend) invalid(p, 'An inspect-only child cannot change its model');
    if (output.origin === 'native' && (parsed.canSend || parsed.canChooseModel)) {
      invalid(p, 'Native children remain inspect-only in this contract version');
    }
    return parsed;
  }, output);
  return output;
}

function completionPolicy(value, path) {
  const row = object(value, path, [
    'version', 'kind', 'recipientChatId', 'subscriptionId', 'cancellationEpoch',
  ]);
  const output = {
    version: version(row, path),
    kind: member(row.kind, at(path, 'kind'), ['local_only', 'wake_delegator']),
  };
  if (output.kind === 'wake_delegator') {
    output.recipientChatId = id(row.recipientChatId, at(path, 'recipientChatId'));
    output.subscriptionId = id(row.subscriptionId, at(path, 'subscriptionId'));
    output.cancellationEpoch = integer(row.cancellationEpoch, at(path, 'cancellationEpoch'));
  } else if (['recipientChatId', 'subscriptionId', 'cancellationEpoch'].some((key) => has(row, key))) {
    invalid(path, 'Local task completion cannot carry a wake subscription');
  }
  return output;
}

function taskResult(value, path) {
  const row = object(value, path, [
    'version', 'runId', 'childChatId', 'journalOwnerId', 'executionId', 'attemptId',
    'status', 'summary', 'settledAt', 'resultMessageId', 'completionPolicy',
  ]);
  const output = {
    version: version(row, path),
    runId: id(row.runId, at(path, 'runId')),
    childChatId: id(row.childChatId, at(path, 'childChatId')),
    journalOwnerId: id(row.journalOwnerId, at(path, 'journalOwnerId')),
    status: member(row.status, at(path, 'status'), CHAT_TASK_TERMINAL_STATUSES),
    summary: text(row.summary, at(path, 'summary'), 120_000, true),
    settledAt: integer(row.settledAt, at(path, 'settledAt')),
    completionPolicy: completionPolicy(row.completionPolicy, at(path, 'completionPolicy')),
  };
  for (const key of ['executionId', 'attemptId', 'resultMessageId']) optional(row, key, path, id, output);
  if (output.completionPolicy.kind === 'wake_delegator'
    && output.completionPolicy.recipientChatId === output.childChatId) {
    invalid(at(path, 'completionPolicy'), 'A task cannot wake its own child conversation');
  }
  return output;
}

function userImages(value, path) {
  if (!Array.isArray(value) || value.length > 20) invalid(path, 'Expected at most 20 attached images');
  let bytes = 0;
  const output = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !has(descriptor, 'value')) invalid(at(path, index), 'Expected an image data element');
    const row = object(descriptor.value, at(path, index), ['name', 'dataUrl']);
    const name = label(row.name, at(at(path, index), 'name'), 512);
    const dataUrl = text(row.dataUrl, at(at(path, index), 'dataUrl'), 6 * 1024 * 1024);
    bytes += dataUrl.length;
    if (bytes > 6 * 1024 * 1024 || !/^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)) {
      invalid(at(path, index), 'Images must be bounded image data URLs');
    }
    output.push({ name, dataUrl });
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key !== 'length' && !/^(?:0|[1-9]\d*)$/.test(key)) invalid(at(path, key), 'Unexpected image array field');
  }
  if (Object.getOwnPropertySymbols(value).length) invalid(path, 'Symbol fields are not supported');
  return output;
}

function command(value, path) {
  const row = object(value, path, [
    'version', 'commandId', 'chatId', 'kind', 'requestedAt', 'provenance',
    'clientRequestId', 'message', 'mode', 'modelSelection', 'profileReference',
    'scope', 'executionId', 'runId', 'targetCommandId', 'expectedRevision', 'images',
  ]);
  const output = {
    version: version(row, path),
    commandId: id(row.commandId, at(path, 'commandId')),
    chatId: id(row.chatId, at(path, 'chatId')),
    kind: member(row.kind, at(path, 'kind'), CHAT_COMMAND_KINDS),
    requestedAt: integer(row.requestedAt, at(path, 'requestedAt')),
    provenance: provenance(row.provenance, at(path, 'provenance')),
  };
  optional(row, 'clientRequestId', path, (v, p) => label(v, p, 256), output);
  if (output.provenance.commandId && output.provenance.commandId !== output.commandId) {
    invalid(at(path, 'provenance.commandId'), 'Provenance command identity does not match');
  }
  const allowed = new Set(['version', 'commandId', 'chatId', 'kind', 'requestedAt', 'provenance', 'clientRequestId']);
  if (output.kind === 'send' || output.kind === 'steer') {
    allowed.add('message'); allowed.add('modelSelection'); allowed.add('profileReference');
    output.message = text(row.message, at(path, 'message'), 120_000);
    optional(row, 'modelSelection', path, modelSelection, output);
    optional(row, 'profileReference', path, profileReference, output);
    if (output.kind === 'send') {
      allowed.add('mode');
      allowed.add('images');
      optional(row, 'images', path, userImages, output);
      output.mode = row.mode === undefined ? 'auto' : member(row.mode, at(path, 'mode'), ['auto', 'queue']);
    }
    if (output.provenance.kind === 'peer_message' && output.provenance.sourceChatId === output.chatId) {
      invalid(at(path, 'chatId'), 'Peer messages cannot target their source chat', 'self_target');
    }
  } else if (output.kind === 'stop') {
    for (const key of ['scope', 'executionId', 'runId']) allowed.add(key);
    output.scope = member(row.scope, at(path, 'scope'), ['turn', 'tree', 'agents']);
    if (output.scope === 'agents' && output.provenance.actor !== 'human') invalid(path, 'Only a human control may stop delegated agents separately');
    optional(row, 'executionId', path, id, output);
    optional(row, 'runId', path, id, output);
    if (output.executionId && output.runId) invalid(path, 'Pin a stop to an execution or task, not both');
  } else {
    allowed.add('targetCommandId'); allowed.add('expectedRevision');
    output.targetCommandId = id(row.targetCommandId, at(path, 'targetCommandId'));
    output.expectedRevision = integer(row.expectedRevision, at(path, 'expectedRevision'));
    if (output.targetCommandId === output.commandId) invalid(path, 'A queue control cannot target itself');
    if (output.kind === 'edit_queued') {
      allowed.add('message');
      output.message = text(row.message, at(path, 'message'), 120_000);
    }
  }
  for (const key of Object.keys(row)) {
    if (!allowed.has(key)) invalid(at(path, key), 'Field does not belong to this command kind');
  }
  return output;
}

function jsonPayload(value, path) {
  let nodes = 0;
  function clone(input, p, depth) {
    if (++nodes > 5000 || depth > 12) invalid(p, 'Request payload is too complex');
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'string') return text(input, p, 120_000, true);
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (Array.isArray(input)) {
      if (input.length > 1000) invalid(p, 'Request array is too large');
      if (Object.getOwnPropertySymbols(input).length) invalid(p, 'Symbol fields are not supported');
      for (const key of Object.getOwnPropertyNames(input)) {
        if (key === 'length') continue;
        const index = Number(key);
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!Number.isSafeInteger(index) || index < 0 || index >= input.length
          || String(index) !== key || !descriptor?.enumerable || !has(descriptor, 'value')) {
          invalid(at(p, key), 'Expected an array data element');
        }
      }
      const output = [];
      for (let index = 0; index < input.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (!descriptor) invalid(at(p, index), 'Sparse request arrays are not supported');
        output.push(clone(descriptor.value, at(p, index), depth + 1));
      }
      return output;
    }
    const row = object(input, p);
    if (Object.keys(row).length > 256) invalid(p, 'Request object is too large');
    const output = {};
    for (const key of Object.keys(row)) output[key] = clone(row[key], at(p, key), depth + 1);
    return output;
  }
  const output = clone(object(value, path), path, 0);
  if (new TextEncoder().encode(JSON.stringify(output)).byteLength > 128_000) invalid(path, 'Request payload is too large');
  return output;
}

function request(value, path) {
  const row = object(value, path, [
    'version', 'requestId', 'chatId', 'executionId', 'toolCallId', 'kind', 'state',
    'createdAt', 'title', 'presentation', 'expiresAt', 'settledAt', 'answerCommandId',
  ]);
  const output = {
    version: version(row, path),
    requestId: id(row.requestId, at(path, 'requestId')),
    chatId: id(row.chatId, at(path, 'chatId')),
    executionId: id(row.executionId, at(path, 'executionId')),
    toolCallId: label(row.toolCallId, at(path, 'toolCallId'), 256),
    kind: member(row.kind, at(path, 'kind'), CHAT_REQUEST_KINDS),
    state: member(row.state, at(path, 'state'), CHAT_REQUEST_STATES),
    createdAt: integer(row.createdAt, at(path, 'createdAt')),
    title: label(row.title, at(path, 'title')),
    presentation: jsonPayload(row.presentation, at(path, 'presentation')),
  };
  for (const key of ['expiresAt', 'settledAt']) optional(row, key, path, integer, output);
  optional(row, 'answerCommandId', path, id, output);
  if (output.expiresAt !== undefined && output.expiresAt < output.createdAt) invalid(path, 'Request expires before creation');
  if (output.state === 'pending' && (output.settledAt !== undefined || output.answerCommandId)) {
    invalid(path, 'A pending request cannot have a settlement receipt');
  }
  if (output.state !== 'pending' && (output.settledAt === undefined || output.settledAt < output.createdAt)) {
    invalid(path, 'A settled request needs a valid settlement time');
  }
  if ((output.state === 'answered') !== Boolean(output.answerCommandId)) {
    invalid(path, 'Only an answered request carries an answer command receipt');
  }
  return output;
}

function errorRecord(value, path) {
  const row = object(value, path, ['code', 'message', 'path', 'retryable']);
  const output = {
    code: member(row.code, at(path, 'code'), CHAT_ERROR_CODES),
    message: text(row.message, at(path, 'message'), 4000),
    retryable: row.retryable === undefined ? false : bool(row.retryable, at(path, 'retryable')),
  };
  optional(row, 'path', path, (v, p) => label(v, p, 512), output);
  return output;
}

function featureSnapshot(value, path) {
  const row = object(value, path, [
    'version', 'capability', 'creationEnabled', 'recoveryEnabled', 'reason',
  ]);
  const output = {
    version: version(row, path),
    capability: member(row.capability, at(path, 'capability'), [AGENT_CONVERSATIONS_CAPABILITY]),
    creationEnabled: bool(row.creationEnabled, at(path, 'creationEnabled')),
    recoveryEnabled: bool(row.recoveryEnabled, at(path, 'recoveryEnabled')),
    reason: member(row.reason, at(path, 'reason'), ['not_released', 'development_opt_in', 'released', 'disabled']),
  };
  if (output.creationEnabled !== ['development_opt_in', 'released'].includes(output.reason)) {
    invalid(path, 'Feature reason and creation state disagree');
  }
  return output;
}

export const validateChatId = (value) => result(id, value);
export const validateModelOptions = (value) => result(modelOptions, value);
export const validateModelSelection = (value) => result(modelSelection, value);
export const validateMessageProvenance = (value) => result(provenance, value);
export const validateAgentConversationMeta = (value) => result(relation, value);
export const validateAgentProfileReference = (value) => result(profileReference, value);
export const validateTaskCompletionPolicy = (value) => result(completionPolicy, value);
export const validateChatTaskResult = (value) => result(taskResult, value);
export const validateChatCommand = (value) => result(command, value);
export const validateChatRequest = (value) => result(request, value);
export const validateChatError = (value) => result(errorRecord, value);
export const validateAgentConversationsFeature = (value) => result(featureSnapshot, value);

/** Resolve semantic overrides without consulting a provider or changing defaults. */
export function resolveModelSelection(value, options = {}) {
  return result((input, path) => {
    const context = object(options, 'resolution', ['inherited', 'defaults']);
    const selected = modelSelection(input, path);
    const inherited = context.inherited === undefined ? null : modelSelection(context.inherited, 'inherited');
    const defaults = context.defaults === undefined ? {} : modelOptions(context.defaults, 'defaults');
    const same = inherited && inherited.providerId === selected.providerId && inherited.modelId === selected.modelId;
    const base = same ? inherited.options ?? defaults : defaults;
    const explicit = has(selected, 'options');
    const resolved = explicit && Object.keys(selected.options).length === 0
      ? {}
      : { ...base, ...(selected.options ?? {}) };
    const output = { providerId: selected.providerId, modelId: selected.modelId };
    if (explicit || Object.keys(resolved).length) output.options = modelOptions(resolved, 'options');
    return output;
  }, value);
}
