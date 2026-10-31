import {
  assertChatPolicy,
  assertChatPolicyWithinCeiling,
  createChatPolicy,
  ChatPolicyError,
  intersectChatPolicies,
} from './policy.js';

const callers = new WeakSet();
const registries = new WeakSet();
const scopes = new WeakSet();
const ACTORS = new Set(['human', 'agent', 'system']);
const INGRESSES = new Set(['renderer', 'server', 'cli', 'scheduler', 'tool', 'device']);
const OPERATION_CAPABILITY = Object.freeze({ read: 'chat.read', send: 'chat.send', stop: 'chat.stop', spawn: 'agent.spawn', respond: 'request.respond' });

function invalid(message) {
  throw new ChatPolicyError('invalid_caller', message);
}

function id(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) invalid(`${field} must be a stable identifier`);
  return value;
}

function key(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 32768 || value.includes('\0')) invalid('A canonical registered workspace key is required');
  return value;
}

/**
 * Input comes from the server's project/worktree registry after realpath and
 * platform-alias canonicalization. This pure module never infers membership
 * from a path prefix or a model-supplied project/workspace claim.
 */
export function createChatProjectRegistry(records, derivedEdges = []) {
  if (!Array.isArray(records)) invalid('Registered workspace records must be an array');
  const knownIds = new Set();
  const knownKeys = new Set();
  const entries = records.map((record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) invalid('Invalid registered workspace');
    const projectId = id(record.projectId, 'projectId');
    const workspaceId = id(record.workspaceId, 'workspaceId');
    const canonicalKey = key(record.canonicalKey);
    if (knownIds.has(workspaceId)) invalid('A workspace can be registered only once');
    knownIds.add(workspaceId);
    if (record.aliases !== undefined && !Array.isArray(record.aliases)) invalid('Workspace aliases must be an array');
    const aliases = [...new Set([canonicalKey, ...(record.aliases ?? []).map(key)])];
    for (const alias of aliases) {
      if (knownKeys.has(alias)) invalid('Workspace aliases must identify exactly one registered checkout');
      knownKeys.add(alias);
    }
    if (record.revoked !== undefined && typeof record.revoked !== 'boolean') invalid('Invalid workspace revocation');
    return Object.freeze({ projectId, workspaceId, canonicalKey, aliases: Object.freeze(aliases), revoked: record.revoked === true });
  });
  if (!Array.isArray(derivedEdges) || derivedEdges.length > 4096) invalid('Invalid derived workspace registrations');
  const derived = new Map();
  for (const edge of derivedEdges) {
    const source = entries.find(row => row.workspaceId === edge?.sourceWorkspaceId);
    const target = entries.find(row => row.workspaceId === edge?.targetWorkspaceId);
    if (!source || !target || source.workspaceId === target.workspaceId || source.projectId !== target.projectId ||
        edge.projectId !== source.projectId || edge.sourceCanonicalPath !== source.canonicalKey || edge.targetCanonicalPath !== target.canonicalKey ||
        derived.has(target.workspaceId)) invalid('A derived checkout requires one verified source in the same project');
    derived.set(target.workspaceId, Object.freeze({ sourceWorkspaceId: source.workspaceId, targetWorkspaceId: target.workspaceId }));
  }
  for (const target of derived.keys()) {
    const visited = new Set();
    for (let current = target; derived.has(current); current = derived.get(current).sourceWorkspaceId) {
      if (visited.has(current) || visited.size >= 32) invalid('Derived workspace registrations must be acyclic and bounded');
      visited.add(current);
    }
  }
  const registry = Object.freeze({ entries: Object.freeze(entries), derivedEdges: Object.freeze([...derived.values()]) });
  registries.add(registry);
  return registry;
}

function assertRegistry(registry) {
  if (!registry || typeof registry !== 'object' || !registries.has(registry)) invalid('Use a server-created project registry');
  return registry;
}

export function resolveProjectScope(registry, input) {
  assertRegistry(registry);
  if (!input || typeof input !== 'object') invalid('A project workspace is required');
  const projectId = id(input.projectId, 'projectId');
  const workspaceKey = key(input.workspaceKey);
  const entry = registry.entries.find((candidate) => candidate.aliases.includes(workspaceKey));
  if (!entry || entry.projectId !== projectId || entry.revoked) {
    throw new ChatPolicyError('project_scope_denied', 'The workspace is not registered for this project');
  }
  const scope = Object.freeze({ projectId: entry.projectId, workspaceId: entry.workspaceId, canonicalKey: entry.canonicalKey });
  scopes.add(scope);
  return scope;
}

function assertScope(scope) {
  if (!scope || typeof scope !== 'object' || !scopes.has(scope)) invalid('Resolve the workspace through the server project registry');
  return scope;
}

/** Project one verified allocation chain without granting unrelated registered checkouts. */
export function projectChatPolicyToWorkspace(policy, scope, registry) {
  assertChatPolicy(policy);
  assertScope(scope);
  assertRegistry(registry);
  const destination = resolveProjectScope(registry, { projectId: scope.projectId, workspaceKey: scope.canonicalKey });
  if (destination.workspaceId !== scope.workspaceId) invalid('The checkout identity changed');
  if (policy.workspaceIds.includes(scope.workspaceId)) return policy;
  const additions = [];
  let current = scope.workspaceId;
  for (let depth = 0; depth < 32; depth++) {
    const edge = registry.derivedEdges.find(row => row.targetWorkspaceId === current);
    if (!edge) break;
    additions.push(current);
    const source = registry.entries.find(row => row.workspaceId === edge.sourceWorkspaceId);
    if (!source || source.revoked || source.projectId !== scope.projectId) break;
    if (policy.workspaceIds.includes(source.workspaceId)) return createChatPolicy({ ...policy,
      workspaceIds: [...new Set([...policy.workspaceIds, ...additions])] });
    current = source.workspaceId;
  }
  return policy;
}

/** Factory for authenticated adapters; never call it on decoded request/tool input. */
export function createChatCaller(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Trusted execution context is required');
  if (!ACTORS.has(input.actor) || !INGRESSES.has(input.ingress)) invalid('Unknown caller actor or ingress');
  const scope = assertScope(input.scope);
  const policy = assertChatPolicy(input.policy);
  if (!policy.workspaceIds.includes(scope.workspaceId)) invalid('The caller policy does not grant its registered workspace');
  const caller = Object.freeze({
    actor: input.actor,
    ingress: input.ingress,
    chatId: id(input.chatId, 'chatId'),
    ...(input.executionId === undefined ? {} : { executionId: id(input.executionId, 'executionId') }),
    ...(input.attemptId === undefined ? {} : { attemptId: id(input.attemptId, 'attemptId') }),
    executionActive: input.executionActive === true,
    scope,
    policy,
  });
  if (caller.executionActive && !caller.executionId) invalid('An active caller requires an execution identity');
  if (caller.ingress === 'device' && caller.executionActive) invalid('A device cannot own execution');
  callers.add(caller);
  return caller;
}

export function assertCaller(caller) {
  if (!caller || typeof caller !== 'object' || !callers.has(caller)) {
    throw new ChatPolicyError('untrusted_caller', 'Chat authority must come from authenticated server execution context');
  }
  return caller;
}

export function assertExecutionCaller(caller) {
  assertCaller(caller);
  if (caller.ingress === 'device' || !caller.executionActive || !caller.executionId || !caller.policy.capabilities.includes('execution.host')) {
    throw new ChatPolicyError('execution_caller_required', 'Only the current execution host may execute this chat');
  }
  return caller;
}

/** Validate a target loaded by the service, with current registry and revocations. */
export function assertCallerCanTarget(caller, target, options) {
  assertCaller(caller);
  const capability = Object.hasOwn(OPERATION_CAPABILITY, options?.operation) ? OPERATION_CAPABILITY[options.operation] : undefined;
  if (!capability) invalid('A known chat operation is required');
  const scope = assertScope(target?.scope);
  const policy = projectChatPolicyToWorkspace(intersectChatPolicies(caller.policy, options.currentPolicy), scope, options.registry);
  if (!policy.capabilities.includes(capability)) throw new ChatPolicyError('capability_denied', `This caller cannot ${options.operation} chats`);
  const source = resolveProjectScope(options.registry, { projectId: caller.scope.projectId, workspaceKey: caller.scope.canonicalKey });
  const destination = resolveProjectScope(options.registry, { projectId: scope.projectId, workspaceKey: scope.canonicalKey });
  if (source.workspaceId !== caller.scope.workspaceId || destination.workspaceId !== scope.workspaceId ||
      source.projectId !== destination.projectId || !policy.workspaceIds.includes(source.workspaceId) || !policy.workspaceIds.includes(destination.workspaceId)) {
    throw new ChatPolicyError('project_scope_denied', 'The target is outside the caller\'s authorized project workspaces');
  }
  if (target.chatId !== undefined) id(target.chatId, 'target chatId');
  if (options.operation !== 'read') {
    if (caller.actor === 'agent' && (!caller.executionActive || !caller.executionId)) {
      throw new ChatPolicyError('execution_caller_required', 'Agent chat mutations require the calling execution to be active');
    }
    if (options.operation === 'send' && target.chatId === caller.chatId) throw new ChatPolicyError('self_target_denied', 'Use the current conversation instead of sending it a peer message');
    assertChatPolicyWithinCeiling(assertChatPolicy(target.policy), policy);
  }
  return Object.freeze({ caller, scope: destination, policy });
}
