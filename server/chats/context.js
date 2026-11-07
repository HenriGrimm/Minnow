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

// A fresh Git listing is the revision source, not a watcher or a timed grant.
// Filesystem identity also detects replaced directories/junctions and .git links
// whose registered pathname has not changed. Uncertain reads never reuse a row.
async function filesystemIdentity(value) {
  const canonical = await fs.realpath(value);
  const stat = await fs.stat(canonical, { bigint: true });
  let marker = null;
  try {
    const full = path.join(canonical, '.git');
    const info = await fs.lstat(full, { bigint: true });
    const target = await fs.stat(full, { bigint: true });
    marker = [String(info.dev), String(info.ino), String(info.ctimeNs), String(info.mtimeNs),
      String(target.dev), String(target.ino), String(target.birthtimeNs),
      target.isFile() ? await fs.readFile(full, 'utf8') : await fs.realpath(full)];
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return [key(canonical), String(stat.dev), String(stat.ino), String(stat.birthtimeNs), marker];
}

/** Execution directory identity, stable across ordinary file writes and Git initialization. */
export async function readChatCheckoutIdentity(value) {
  try {
    const canonical = await directory(value);
    const stat = await fs.stat(canonical, { bigint: true });
    if (stat.ino === 0n || stat.birthtimeNs === 0n) throw new Error('Unverifiable directory identity');
    return identity('checkout', JSON.stringify([key(canonical), String(stat.dev), String(stat.ino), String(stat.birthtimeNs)]));
  } catch {
    throw new ChatContractError('workspace_denied', 'Cannot verify the conversation checkout identity');
  }
}

async function discoverProject(workspacePath, runGit) {
  const canonical = await directory(workspacePath);
  let common;
  try {
    const result = await runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], canonical);
    if (result.code === 0 && result.stdout?.trim()) common = await fs.realpath(result.stdout.trim());
  } catch { /* A non-git project remains a single, exact directory. */ }
  if (!common) {
    try { await fs.lstat(path.join(canonical, '.git')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const stamp = await filesystemIdentity(canonical);
      return { canonical, candidates: [canonical], reusable: stamp[2] !== '0' && stamp[3] !== '0', revision: JSON.stringify(stamp) };
    }
    throw new ChatContractError('workspace_denied', 'Cannot verify the project repository identity');
  }
  let listed;
  try { listed = await runGit(['worktree', 'list', '--porcelain', '-z'], canonical); }
  catch { throw new ChatContractError('workspace_denied', 'Cannot verify the project checkout registry'); }
  if (listed.code !== 0 || listed.accumulationTruncated) {
    throw new ChatContractError('workspace_denied', 'Cannot verify the project checkout registry');
  }
  const candidates = String(listed.stdout ?? '').split('\0').filter(entry => entry.startsWith('worktree ')).map(entry => entry.slice(9));
  const identities = [];
  for (const registered of candidates) {
    try { identities.push(await filesystemIdentity(registered)); }
    catch { identities.push(null); }
  }
  if (!identities.some(row => row?.[0] === key(canonical))) {
    throw new ChatContractError('workspace_denied', 'This checkout is no longer registered');
  }
  const commonIdentity = await filesystemIdentity(common);
  return { canonical, common, candidates,
    reusable: [...identities, commonIdentity].every(row => row && row[2] !== '0' && row[3] !== '0'),
    revision: JSON.stringify([commonIdentity, listed.stdout, identities]) };
}

async function buildProjectRegistry(workspacePath, discovered, runGit) {
  const { canonical, common } = discovered;
  // Initializing Git in an existing project must keep its logical identity.
  // Linked checkouts share their primary repository's ordinary .git parent.
  const projectRoot = common && path.basename(common).toLowerCase() === '.git' ? path.dirname(common) : common ?? canonical;
  const projectId = identity('project', key(projectRoot));
  const candidates = new Map(common ? [] : [[key(canonical), { canonical, aliases: [key(workspacePath)] }]]);
  if (common) {
    for (const registered of discovered.candidates) {
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
      candidates.set(key(resolved), { canonical: resolved, aliases: [...(previous?.aliases ?? []), key(registered),
        ...(key(resolved) === key(canonical) ? [key(workspacePath)] : [])] });
    }
    if (!candidates.has(key(canonical))) throw new ChatContractError('workspace_denied', 'This checkout is no longer registered');
  }
  const registry = createChatProjectRegistry([...candidates.values()].map(row => ({
    projectId, workspaceId: identity('workspace', key(row.canonical)),
    canonicalKey: key(row.canonical), aliases: [...new Set(row.aliases)],
  })));
  return { registry, projectId, scope: resolveProjectScope(registry, { projectId, workspaceKey: key(canonical) }) };
}

/** Real directories and git's registration, never a lexical worktree prefix, establish membership. */
export async function loadChatProjectRegistry(workspacePath, { validateRoot = validateAllowedWorkspaceRoot, runGit = git } = {}) {
  await validateRoot(workspacePath);
  return buildProjectRegistry(workspacePath, await discoverProject(workspacePath, runGit), runGit);
}

/** Adapter boundary: request bodies provide intent; these factories supply authority. */
export function createChatContext({ repository, resolvePolicyInput, validateRoot, runGit } = {}) {
  if (!repository || typeof resolvePolicyInput !== 'function') throw new TypeError('Chat context requires a repository and current policy resolver');
  let loadWorkspaceEdges;
  const discoveredProjects = new Map();
  const discovering = new Map();
  async function project(workspacePath = getRequestWorkspaceRoot()) {
    // Allowlist/config restrictions remain live, even for concurrent callers.
    await (validateRoot ?? validateAllowedWorkspaceRoot)(workspacePath);
    const workspaceKey = key(workspacePath);
    let pending = discovering.get(workspaceKey);
    if (!pending) {
      pending = (async () => {
        const discovered = await discoverProject(workspacePath, runGit ?? git);
        let cached = discoveredProjects.get(workspaceKey);
        if (!discovered.reusable || cached?.revision !== discovered.revision) {
          cached = { revision: discovered.revision,
            base: await buildProjectRegistry(workspacePath, discovered, runGit ?? git) };
          if (discoveredProjects.size >= 64) discoveredProjects.clear();
          discoveredProjects.set(workspaceKey, cached);
        }
        return cached.base;
      })();
      discovering.set(workspaceKey, pending);
      pending.finally(() => { if (discovering.get(workspaceKey) === pending) discovering.delete(workspaceKey); }).catch(() => {});
    }
    const base = await pending;
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
    if (options.project || key(canonical) !== root.scope.canonicalKey) {
      const current = await discoverProject(checkout, runGit ?? git);
      const projectRoot = current.common && path.basename(current.common).toLowerCase() === '.git'
        ? path.dirname(current.common) : current.common ?? current.canonical;
      if (identity('project', key(projectRoot)) !== root.projectId) {
        throw new ChatContractError('workspace_denied', 'The target checkout repository identity changed');
      }
    }
    const profile = repository.getLatestProfile(chatId);
    const currentPolicy = createChatPolicy(await resolvePolicyInput(chat, scope, root.registry));
    const checkoutIdentity = await readChatCheckoutIdentity(canonical);
    let captured = profile?.snapshot?.policy;
    const prepared = chat.workspacePreparation;
    if (captured && prepared?.status === 'ready' && prepared.binding?.checkoutIdentity === checkoutIdentity &&
        prepared.intent?.projectId === scope.projectId && key(prepared.binding.path) === key(canonical) &&
        captured.workspaceIds?.includes(prepared.intent.sourceWorkspaceId)) {
      // Trusted durable allocation maps the original source ceiling to its
      // verified checkout; no tool/mode/filesystem grants change.
      captured = { ...captured, workspaceIds: captured.workspaceIds.map(id => id === prepared.intent.sourceWorkspaceId ? scope.workspaceId : id) };
    }
    const policy = captured ? intersectChatPolicies(createChatPolicy(captured), currentPolicy) : currentPolicy;
    return { chat, scope, policy, currentPolicy, profile, registry: root.registry, project: root, checkoutIdentity };
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
