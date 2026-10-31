import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runProcess } from '../process-runner.js';
import { validateAllowedWorkspaceRoot } from '../chats-workspace/paths.js';
import { getRequestWorkspaceRoot } from '../runtime/path-access.js';
import { ChatContractError } from './contracts.js';
import { createChatPolicy, intersectChatPolicies } from './policy.js';
import { createChatCaller, createChatProjectRegistry, resolveProjectScope } from './caller.js';

const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const identity = (prefix, value) => `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
const activeStates = new Set(['running', 'waiting', 'waiting_for_model', 'loading_model', 'waiting_for_agents', 'waiting_for_input', 'waiting_for_approval']);

async function directory(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new ChatContractError('workspace_denied', 'A registered project directory is required');
  }
  try {
    const resolved = await fs.realpath(value);
    if (!(await fs.stat(resolved)).isDirectory()) throw new Error('Not a directory');
    return resolved;
  } catch {
    throw new ChatContractError('workspace_denied', 'The conversation checkout is unavailable');
  }
}

async function git(args, cwd) {
  return runProcess('git', args, { cwd, timeout: 10_000 });
}

/** Real directories and git's registration, never a lexical worktree prefix, establish membership. */
export async function loadChatProjectRegistry(workspacePath, { validateRoot = validateAllowedWorkspaceRoot, runGit = git } = {}) {
  await validateRoot(workspacePath);
  const canonical = await directory(workspacePath);
  let common;
  try {
    const result = await runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], canonical);
    if (result.code === 0 && result.stdout?.trim()) common = await fs.realpath(result.stdout.trim());
  } catch { /* A non-git project remains a single, exact directory. */ }
  // Initializing Git in an existing project must keep its logical identity.
  // Linked checkouts share their primary repository's ordinary .git parent.
  const projectRoot = common && path.basename(common).toLowerCase() === '.git' ? path.dirname(common) : common ?? canonical;
  const projectId = identity('project', key(projectRoot));
  const candidates = new Map([[key(canonical), { canonical, aliases: [key(workspacePath)] }]]);
  if (common) {
    let listed;
    try { listed = await runGit(['worktree', 'list', '--porcelain', '-z'], canonical); }
    catch { throw new ChatContractError('workspace_denied', 'Cannot verify the project checkout registry'); }
    if (listed.code !== 0 || listed.accumulationTruncated) {
      throw new ChatContractError('workspace_denied', 'Cannot verify the project checkout registry');
    }
    for (const entry of String(listed.stdout ?? '').split('\0')) {
      if (!entry.startsWith('worktree ')) continue;
      const registered = entry.slice(9);
      let resolved;
      try { resolved = await directory(registered); } catch { continue; }
      // Check each live registration again; a replaced checkout cannot inherit
      // membership solely by occupying a previously registered pathname.
      const verified = await runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], resolved);
      if (verified.code !== 0) continue;
      let targetCommon;
      try { targetCommon = await fs.realpath(verified.stdout.trim()); } catch { continue; }
      if (key(targetCommon) !== key(common)) continue;
      const previous = candidates.get(key(resolved));
      candidates.set(key(resolved), { canonical: resolved, aliases: [...(previous?.aliases ?? []), key(registered)] });
    }
    if (!candidates.has(key(canonical))) throw new ChatContractError('workspace_denied', 'This checkout is no longer registered');
  }
  const registry = createChatProjectRegistry([...candidates.values()].map(row => ({
    projectId, workspaceId: identity('workspace', key(row.canonical)),
    canonicalKey: key(row.canonical), aliases: [...new Set(row.aliases)],
  })));
  return { registry, projectId, scope: resolveProjectScope(registry, { projectId, workspaceKey: key(canonical) }) };
}

/** Adapter boundary: request bodies provide intent; these factories supply authority. */
export function createChatContext({ repository, resolvePolicyInput, validateRoot, runGit } = {}) {
  if (!repository || typeof resolvePolicyInput !== 'function') throw new TypeError('Chat context requires a repository and current policy resolver');
  let loadWorkspaceEdges;
  async function project(workspacePath = getRequestWorkspaceRoot()) {
    const base = await loadChatProjectRegistry(workspacePath, { validateRoot, runGit });
    if (!loadWorkspaceEdges) return base;
    const registry = createChatProjectRegistry(base.registry.entries, await loadWorkspaceEdges(base));
    return { ...base, registry, scope: resolveProjectScope(registry, { projectId: base.projectId, workspaceKey: base.scope.canonicalKey }) };
  }
  async function resolveTarget(chatId, options = {}) {
    const chat = repository.getChat(chatId);
    const checkout = chat.worktreeRoot || chat.workspacePath;
    const root = options.project ?? await project(options.workspacePath ?? checkout);
    const canonical = await directory(checkout);
    const scope = resolveProjectScope(root.registry, { projectId: root.projectId, workspaceKey: key(canonical) });
    const profile = repository.getLatestProfile(chatId);
    const currentPolicy = createChatPolicy(await resolvePolicyInput(chat, scope, root.registry));
    const captured = profile?.snapshot?.policy;
    const policy = captured ? intersectChatPolicies(createChatPolicy(captured), currentPolicy) : currentPolicy;
    return { chat, scope, policy, currentPolicy, profile, registry: root.registry, project: root };
  }
  async function humanCaller(chatId, { workspacePath = getRequestWorkspaceRoot(), ingress = 'renderer' } = {}) {
    if (!['renderer', 'device', 'cli', 'scheduler'].includes(ingress)) throw new TypeError('Invalid human ingress');
    const target = await resolveTarget(chatId, { project: await project(workspacePath) });
    const caller = createChatCaller({ actor: 'human', ingress, chatId: `human-${ingress}`, scope: target.scope, policy: target.currentPolicy });
    return { caller, target };
  }
  async function executionCaller(executionId) {
    const execution = repository.getExecution(executionId);
    if (!execution || !activeStates.has(execution.status)) throw new ChatContractError('caller_not_active', 'The sending execution is no longer active');
    const lease = repository.getLease(execution.chatId);
    if (!lease || lease.executionId !== executionId || lease.state === 'released') throw new ChatContractError('ownership_conflict', 'The sending execution no longer owns its conversation');
    repository.assertFence(execution.chatId, lease);
    const target = await resolveTarget(execution.chatId);
    const captured = execution.captured?.policy;
    const policy = captured ? intersectChatPolicies(createChatPolicy(captured), target.policy) : target.policy;
    const caller = createChatCaller({ actor: 'agent', ingress: 'tool', chatId: execution.chatId,
      executionId, ...(execution.attemptId ? { attemptId: execution.attemptId } : {}), executionActive: true, scope: target.scope, policy });
    return { caller, target, execution, fence: lease };
  }
  return { project, resolveTarget, humanCaller, executionCaller,
    setWorkspaceEdgesLoader(loader) {
      if (typeof loader !== 'function') throw new TypeError('A verified workspace edge loader is required');
      loadWorkspaceEdges = loader;
    },
  };
}
