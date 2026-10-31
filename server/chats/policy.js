import { blockPlanModeWrite } from '../tools/plan-write-guard.js';
import { isParallelSafeTool } from '../runner/parallel-tool-policy.js';
import { ChatContractError } from './contracts.js';

export const CHAT_POLICY_VERSION = 1;

const policies = new WeakSet();
const MODES = new Set(['general', 'build', 'plan', 'debug', 'orchestrate', 'onboarding']);
const PERMISSIONS = ['off', 'ask', 'full'];
const WRITE_SCOPES = ['none', 'plans', 'workspace', 'full'];
const SHELL_SCOPES = ['off', 'prefer', 'require'];
const EFFECTS = new Set(['read', 'file-write', 'git-write', 'shell', 'external-write', 'unknown']);
const CAPABILITIES = new Set(['chat.read', 'chat.send', 'chat.stop', 'agent.spawn', 'request.respond', 'execution.host']);
const POLICY_KEYS = new Set(['version', 'modeId', 'toolPermissions', 'toolEffects', 'workspaceIds', 'filesystemAccess', 'fileWriteScope', 'shellSandboxMode', 'capabilities']);
const FILE_WRITES = new Set(['save_file', 'make_directory', 'append_file', 'insert_at_line', 'replace_text_in_file', 'apply_patch', 'delete_path', 'move_file', 'copy_file', 'create_pdf', 'create_spreadsheet', 'create_word_document']);
const GIT_WRITES = new Set(['git_commit', 'git_add', 'git_checkout', 'git_switch', 'git_reset', 'git_restore', 'git_clean', 'git_merge', 'git_rebase', 'git_cherry_pick', 'git_stash', 'git_push', 'git_tag']);
const SHELL_TOOLS = new Set(['execute_command', 'execute_code']);
const ERROR_CODES = Object.freeze({
  invalid_policy: 'invalid_request', invalid_caller: 'invalid_request',
  untrusted_caller: 'caller_denied', execution_caller_required: 'caller_not_active',
  project_scope_denied: 'workspace_denied', cross_project_denied: 'cross_project_denied',
  capability_denied: 'policy_denied', broader_target_denied: 'policy_denied',
  tool_denied: 'policy_denied', plan_write_denied: 'policy_denied',
  approval_required: 'capability_unavailable', self_target_denied: 'invalid_request',
});

export class ChatPolicyError extends ChatContractError {
  constructor(reason, message, details = {}) {
    const code = ERROR_CODES[reason];
    if (!code) throw new TypeError('Unknown chat policy error reason');
    super(code, message);
    this.name = 'ChatPolicyError';
    this.reason = reason;
    this.details = Object.freeze({ ...details });
  }
}

function invalid(message) {
  throw new ChatPolicyError('invalid_policy', message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function identifier(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) invalid(`${field} must be a stable identifier`);
  return value;
}

function toolName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.:-]{0,255}$/.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value)) {
    invalid('Tool permissions require exact tool names, without wildcards');
  }
  return value;
}

function stringSet(value, field, validate) {
  if (!Array.isArray(value)) invalid(`${field} must be an array`);
  return Object.freeze([...new Set(value.map((entry) => validate(entry, field)))].sort());
}

function permissionRecord(value) {
  if (!isRecord(value)) invalid('toolPermissions must be a record');
  const result = Object.create(null);
  for (const [name, permission] of Object.entries(value)) {
    toolName(name);
    if (!PERMISSIONS.includes(permission)) invalid(`Unknown permission for ${name}`);
    result[name] = permission;
  }
  return Object.freeze(result);
}

function effectRecord(value) {
  if (!isRecord(value)) invalid('toolEffects must be a record');
  const result = Object.create(null);
  for (const [name, effect] of Object.entries(value)) {
    toolName(name);
    if (!EFFECTS.has(effect)) invalid(`Unknown tool effect for ${name}`);
    result[name] = effect;
  }
  return Object.freeze(result);
}

function normalizeMode(value) {
  if (value === 'super-plan') return 'plan';
  if (value === 'desktop' || value === 'email') return 'general';
  if (!MODES.has(value)) invalid('A known effective mode is required');
  return value;
}

/** Server adapters construct this from resolved mode/type/catalog permissions, never tool arguments. */
export function createChatPolicy(input) {
  if (!isRecord(input)) invalid('A policy snapshot is required');
  for (const key of Object.keys(input)) if (!POLICY_KEYS.has(key)) invalid(`Unknown policy field: ${key}`);
  if (input.version !== undefined && input.version !== CHAT_POLICY_VERSION) invalid('Unsupported chat policy version');
  const modeId = normalizeMode(input.modeId);
  const filesystemAccess = input.filesystemAccess ?? 'workspace';
  if (!['workspace', 'full'].includes(filesystemAccess)) invalid('Unknown filesystem access');
  const shellSandboxMode = input.shellSandboxMode ?? 'off';
  if (!SHELL_SCOPES.includes(shellSandboxMode)) invalid('Unknown shell sandbox mode');
  let fileWriteScope = input.fileWriteScope ?? 'none';
  if (!WRITE_SCOPES.includes(fileWriteScope)) invalid('Unknown file write scope');
  if (modeId === 'plan' && WRITE_SCOPES.indexOf(fileWriteScope) > WRITE_SCOPES.indexOf('plans')) fileWriteScope = 'plans';
  if (fileWriteScope === 'full' && filesystemAccess !== 'full') invalid('Full file writes require full filesystem access');
  const result = Object.freeze({
    version: CHAT_POLICY_VERSION,
    modeId,
    toolPermissions: permissionRecord(input.toolPermissions ?? {}),
    toolEffects: effectRecord(input.toolEffects ?? {}),
    workspaceIds: stringSet(input.workspaceIds ?? [], 'workspaceIds', identifier),
    filesystemAccess,
    fileWriteScope,
    shellSandboxMode,
    capabilities: stringSet(input.capabilities ?? [], 'capabilities', (value) => {
      if (!CAPABILITIES.has(value)) invalid(`Unknown chat capability: ${value}`);
      return value;
    }),
  });
  policies.add(result);
  return result;
}

export function assertChatPolicy(policy) {
  if (!policy || typeof policy !== 'object' || !policies.has(policy)) invalid('Use a server-validated chat policy snapshot');
  return policy;
}

function permission(policy, name) {
  return policy.toolPermissions[name] ?? 'off';
}

function effect(policy, name) {
  // Built-in effects cannot be weakened by a supplied metadata row.
  if (FILE_WRITES.has(name)) return 'file-write';
  if (GIT_WRITES.has(name)) return 'git-write';
  if (SHELL_TOOLS.has(name)) return 'shell';
  if (isParallelSafeTool(name)) return 'read';
  return policy.toolEffects[name] ?? 'unknown';
}

function intersectionEffect(values) {
  if (values.includes('unknown')) return 'unknown';
  if (values.includes('git-write')) return 'git-write';
  if (values.includes('file-write')) return 'file-write';
  if (values.includes('external-write')) return 'external-write';
  if (values.includes('shell')) return 'shell';
  return 'read';
}

/** Current permission changes can only narrow a captured execution snapshot. */
export function intersectChatPolicies(...inputs) {
  if (!inputs.length) invalid('At least one policy is required');
  const snapshots = inputs.map(assertChatPolicy);
  const first = snapshots[0];
  const toolPermissions = Object.create(null);
  const toolEffects = Object.create(null);
  for (const name of Object.keys(first.toolPermissions)) {
    const rank = Math.min(...snapshots.map((policy) => PERMISSIONS.indexOf(permission(policy, name))));
    if (rank === 0) continue;
    toolPermissions[name] = PERMISSIONS[rank];
    toolEffects[name] = intersectionEffect(snapshots.map((policy) => effect(policy, name)));
  }
  return createChatPolicy({
    modeId: snapshots.some((policy) => policy.modeId === 'plan') ? 'plan' : first.modeId,
    toolPermissions,
    toolEffects,
    workspaceIds: first.workspaceIds.filter((id) => snapshots.every((policy) => policy.workspaceIds.includes(id))),
    filesystemAccess: snapshots.every((policy) => policy.filesystemAccess === 'full') ? 'full' : 'workspace',
    fileWriteScope: WRITE_SCOPES[Math.min(...snapshots.map((policy) => WRITE_SCOPES.indexOf(policy.fileWriteScope)))],
    shellSandboxMode: SHELL_SCOPES[Math.max(...snapshots.map((policy) => SHELL_SCOPES.indexOf(policy.shellSandboxMode)))],
    capabilities: first.capabilities.filter((name) => snapshots.every((policy) => policy.capabilities.includes(name))),
  });
}

/** Compare actual grants, not a ranking of General/Build/Debug mode labels. */
export function compareChatPolicies(ceiling, target) {
  assertChatPolicy(ceiling);
  assertChatPolicy(target);
  const violations = [];
  for (const name of Object.keys(target.toolPermissions)) {
    if (PERMISSIONS.indexOf(permission(target, name)) > PERMISSIONS.indexOf(permission(ceiling, name))) violations.push(`tool:${name}`);
    if (permission(target, name) !== 'off' && effect(target, name) !== effect(ceiling, name)) violations.push(`tool_effect:${name}`);
  }
  for (const id of target.workspaceIds) if (!ceiling.workspaceIds.includes(id)) violations.push(`workspace:${id}`);
  for (const name of target.capabilities) if (!ceiling.capabilities.includes(name)) violations.push(`capability:${name}`);
  if (target.filesystemAccess === 'full' && ceiling.filesystemAccess !== 'full') violations.push('filesystem_access');
  if (WRITE_SCOPES.indexOf(target.fileWriteScope) > WRITE_SCOPES.indexOf(ceiling.fileWriteScope)) violations.push('file_write_scope');
  if (SHELL_SCOPES.indexOf(target.shellSandboxMode) < SHELL_SCOPES.indexOf(ceiling.shellSandboxMode)) violations.push('shell_sandbox');
  return Object.freeze({ allowed: violations.length === 0, violations: Object.freeze(violations) });
}

export function assertChatPolicyWithinCeiling(target, ceiling) {
  const result = compareChatPolicies(ceiling, target);
  if (!result.allowed) throw new ChatPolicyError('broader_target_denied', 'The target execution has broader permissions than its caller', { violations: result.violations });
  return target;
}

/**
 * Check immediately before dispatch. Filesystem canonicalization and ownership
 * fencing remain the execution host's responsibilities. An absent current
 * policy is an error, so a saved grant cannot silently bypass revocation.
 */
export function assertChatToolAllowed(capturedPolicy, name, args = {}, options = {}) {
  toolName(name);
  if (!isRecord(args)) invalid('Tool arguments must be a record');
  const policy = intersectChatPolicies(capturedPolicy, options.currentPolicy);
  const allowed = permission(policy, name);
  if (allowed === 'off') throw new ChatPolicyError('tool_denied', `Tool ${name} is not allowed by the effective chat policy`, { toolName: name });
  const toolEffect = effect(policy, name);
  if (policy.fileWriteScope === 'none' && ['file-write', 'git-write', 'unknown'].includes(toolEffect)) {
    throw new ChatPolicyError('tool_denied', `Tool ${name} exceeds this chat's file write scope`, { toolName: name });
  }
  if (policy.fileWriteScope === 'plans') {
    if (toolEffect === 'git-write' || (toolEffect === 'unknown' && /^(?:mcp__|plugin__)/.test(name)) ||
        (toolEffect === 'file-write' && !FILE_WRITES.has(name))) {
      throw new ChatPolicyError('tool_denied', `Tool ${name} cannot be constrained to the chat's plan write scope`, { toolName: name });
    }
    const blocked = blockPlanModeWrite('plan', name, args);
    if (blocked) throw new ChatPolicyError('plan_write_denied', blocked, { toolName: name });
  }
  if (allowed === 'ask' && options.approvalGranted !== true) {
    throw new ChatPolicyError('approval_required', `Tool ${name} requires approval`, { toolName: name });
  }
  return Object.freeze({ toolName: name, permission: allowed, policy });
}
