import fs from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from '../process-runner.js';
import { validateAllowedWorkspaceRoot } from '../chats-workspace/paths.js';
import { getRequestWorkspaceRoot } from '../runtime/path-access.js';
import { ChatContractError } from './contracts.js';
import { createChatPolicy, intersectChatPolicies } from './policy.js';
import { createChatCaller, createChatProjectRegistry, resolveProjectScope } from './caller.js';
import { checkoutKey as key, directory, identity, readChatCheckoutIdentity } from './checkout-identity.js';
import { readMirroredBinding } from './worktree-binding.js';

export { readChatCheckoutIdentity } from './checkout-identity.js';
const activeStates = new Set(['running', 'waiting', 'waiting_for_model', 'loading_model', 'waiting_for_agents', 'waiting_for_input', 'waiting_for_approval']);

// Unavailable registrations require fresh verification on every send. Overlap
// independent reads without spawning unbounded Git processes or caching grants.
async function readCheckouts(values, read) {
  const results = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await read(values[index]);
    }
  }));
  return results;
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
  const identities = await readCheckouts(candidates, async registered => {
    try { return await filesystemIdentity(registered); }
    catch { return null; }
  });
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
    const verifiedCheckouts = await readCheckouts(discovered.candidates, async registered => {
      let resolved;
      try { resolved = await directory(registered); } catch { return null; }
      // Check each live registration again; a replaced checkout cannot inherit
      // membership solely by occupying a previously registered pathname.
      const verified = await runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], resolved);
      if (verified.code !== 0) return null;
      let targetCommon;
      try { targetCommon = await fs.realpath(verified.stdout.trim()); } catch { return null; }
      if (key(targetCommon) !== key(common)) return null;
      return { registered, resolved };
    });
    for (const checkout of verifiedCheckouts) {
      if (!checkout) continue;
      const { registered, resolved } = checkout;
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
  return { registry, projectId, registeredPaths: discovered.candidates.map(key),
    scope: resolveProjectScope(registry, { projectId, workspaceKey: key(canonical) }) };
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
    const edges = await loadWorkspaceEdges(base);
    const delegatedMirrors = edges.filter(edge => edge.mirrored);
    const registry = createChatProjectRegistry([...base.registry.entries, ...delegatedMirrors.map(edge => ({
      projectId: edge.projectId, workspaceId: edge.targetWorkspaceId, canonicalKey: edge.targetCanonicalPath,
    }))], edges);
    return { ...base, registry, delegatedMirrors, scope: resolveProjectScope(registry, { projectId: base.projectId, workspaceKey: base.scope.canonicalKey }) };
  }
  /** Read-only probe for host-side reconciliation, never used as a send target. */
  async function findMissingWorktree(chatId, workspacePath = getRequestWorkspaceRoot()) {
    const chat = repository.getChat(chatId);
    if (chat.chatCommandVersion !== 1 || chat.agentConversation || !chat.worktreeRoot?.trim() ||
        !chat.workspacePath?.trim() || key(chat.worktreeRoot) === key(chat.workspacePath)) return null;
    const intent = chat.workspacePreparation?.intent;
    const projectId = repository.getChatProjectId(chatId);
    if (!projectId || (intent && (intent.chatId !== chatId || intent.projectId !== projectId))) return null;
    const root = await project(workspacePath);
    if (root.projectId !== projectId) return null;
    const source = await directory(chat.workspacePath);
    const scope = resolveProjectScope(root.registry, { projectId, workspaceKey: key(source) });
    const mirrored = Boolean(intent?.source?.repos);
    if (intent) {
      if (scope.workspaceId !== intent.sourceWorkspaceId ||
          await readChatCheckoutIdentity(source) !== intent.source?.checkoutIdentity) return null;
      if (mirrored) {
        const binding = chat.workspacePreparation.binding;
        if (!binding || key(binding.path) !== key(chat.worktreeRoot) || key(intent.slotPath) !== key(chat.worktreeRoot)) return null;
      } else {
        const common = await (runGit ?? git)(['rev-parse', '--path-format=absolute', '--git-common-dir'], source);
        if (common.code !== 0 || !common.stdout?.trim() ||
            await readChatCheckoutIdentity(common.stdout.trim()) !== intent.source.commonIdentity) return null;
      }
    }

    let checkout;
    try { checkout = await fs.realpath(chat.worktreeRoot); }
    catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      return chat;
    }
    // Git registers a mirror's individual repositories, not its parent folder.
    if (mirrored) return null;
    // An existing directory is only orphaned after Git drops its registration.
    // A failed per-checkout verification is not itself evidence of removal.
    const paths = [key(checkout), key(chat.worktreeRoot)];
    return paths.some(candidate => root.registeredPaths.includes(candidate) ||
      root.registry.entries.some(entry => entry.aliases.includes(candidate))) ? null : chat;
  }
  async function resolveTarget(chatId, options = {}) {
    const chat = repository.getChat(chatId);
    const checkout = options.workspaceRecovery ? chat.workspacePath : chat.worktreeRoot || chat.workspacePath;
    const prepared = chat.workspacePreparation;
    const mirrored = Boolean(!options.workspaceRecovery && chat.worktreeRoot && prepared?.intent?.source?.repos);
    const canonical = await directory(checkout);
    let root;
    if (mirrored) {
      if (prepared.status !== 'ready' || !prepared.binding || key(prepared.binding.path) !== key(canonical) ||
          key(prepared.intent.source.path) !== key(await directory(chat.workspacePath))) {
        throw new ChatContractError('workspace_denied', 'The chat no longer has a verified workspace worktree.');
      }
      const callerProject = options.project ?? (options.workspacePath ? await project(options.workspacePath) : null);
      if (callerProject && callerProject.projectId !== prepared.intent.projectId && callerProject.scope.canonicalKey !== key(canonical)) {
        throw new ChatContractError('workspace_denied', 'The worktree is outside the active project.');
      }
      const verified = await verifyMirroredSlot(prepared.intent, prepared.binding, { ready: true });
      root = verified.project;
    } else {
      const delegated = chat.agentConversation?.origin === 'delegated' && chat.worktreeRoot;
      root = options.project ?? await project(options.workspacePath ?? (delegated ? chat.workspacePath : checkout));
      if (delegated && options.project && root.delegatedMirrors?.some(edge => edge.childChatId === chatId)) {
        root = await project(chat.workspacePath);
        if (root.projectId !== options.project.projectId) throw new ChatContractError('workspace_denied', 'The worktree is outside the active project.');
      }
      if (delegated && chat.projectId && chat.projectId !== root.projectId) {
        throw new ChatContractError('workspace_denied', 'The child checkout is outside its recorded project.');
      }
    }
    const delegatedMirror = chat.agentConversation?.origin === 'delegated' &&
      root.delegatedMirrors?.find(edge => edge.childChatId === chatId && edge.targetCanonicalPath === key(canonical));
    const scope = resolveProjectScope(root.registry, { projectId: root.projectId, workspaceKey: key(canonical) });
    if (!mirrored && !delegatedMirror && (options.project || key(canonical) !== root.scope.canonicalKey)) {
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
    if (delegatedMirror && delegatedMirror.checkoutIdentity !== checkoutIdentity) {
      throw new ChatContractError('workspace_denied', 'The delegated workspace checkout was replaced');
    }
    let captured = profile?.snapshot?.policy;
    // An ordinary chat's first profile preserves its role and tools. The
    // global permission setting is sampled at each new turn admission.
    if (captured && !chat.agentConversation && !chat.forkOrigin) {
      captured = { ...captured, permissionLevel: currentPolicy.permissionLevel,
        filesystemAccess: currentPolicy.filesystemAccess,
        fileWriteScope: ['workspace', 'full'].includes(captured.fileWriteScope) ? currentPolicy.fileWriteScope : captured.fileWriteScope };
    }
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
  async function verifyMirroredSlot(intent, expected, options) {
    const binding = await readMirroredBinding(intent, expected, options);
    const source = await project(intent.source.path);
    if (source.projectId !== intent.projectId || source.scope.workspaceId !== intent.sourceWorkspaceId) {
      throw new ChatContractError('workspace_denied', 'The prepared checkout is no longer in the original project');
    }
    // Register this chat's verified mirror for this resolution only. The child
    // repositories and other chats' mirrors are not separate chat grants.
    const canonicalKey = key(binding.path);
    const edges = source.registry.derivedEdges.map(edge => ({ ...edge, projectId: source.projectId,
      sourceCanonicalPath: source.registry.entries.find(row => row.workspaceId === edge.sourceWorkspaceId).canonicalKey,
      targetCanonicalPath: source.registry.entries.find(row => row.workspaceId === edge.targetWorkspaceId).canonicalKey }));
    const registry = createChatProjectRegistry([...source.registry.entries, { projectId: source.projectId,
      workspaceId: identity('workspace', canonicalKey), canonicalKey }], edges);
    return { binding, project: { ...source, registry },
      scope: resolveProjectScope(registry, { projectId: source.projectId, workspaceKey: canonicalKey }) };
  }
  async function humanCaller(chatId, { workspacePath = getRequestWorkspaceRoot(), ingress = 'renderer', workspaceRecovery = false } = {}) {
    if (!['renderer', 'device', 'cli', 'scheduler'].includes(ingress)) throw new TypeError('Invalid human ingress');
    const target = await resolveTarget(chatId, { project: await project(workspacePath), workspaceRecovery });
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
  return { project, findMissingWorktree, resolveTarget, humanCaller, executionCaller, verifyMirroredSlot,
    setWorkspaceEdgesLoader(loader) {
      if (typeof loader !== 'function') throw new TypeError('A verified workspace edge loader is required');
      loadWorkspaceEdges = loader;
    },
  };
}
