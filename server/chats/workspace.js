import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ChatContractError, validateChatId } from './contracts.js';
import { assertCaller, assertCallerCanTarget, assertExecutionCaller, resolveProjectScope } from './caller.js';
import { intersectChatPolicies } from './policy.js';
import { createChatWorkspaceRepository } from './workspace-repository.js';
import { getAgentConversationsFeature } from './feature.js';
import { getChatWorktreePath } from '../worktree/paths.js';
import { createChatWorktree } from '../worktree/worktree-ops.js';
import { ensureDependencyDirs } from '../worktree/dep-symlinks.js';
import { runWorktreeSetupProcess } from '../worktree/setup-process.js';
import { pathAccessStore } from '../runtime/path-access.js';

const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const identifier = (value, field) => {
  const parsed = validateChatId(value);
  if (!parsed.ok) throw new ChatContractError('invalid_request', `Invalid ${field}`);
  return parsed.value;
};
const fail = message => { throw new ChatContractError('workspace_denied', message); };
const shortHash = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
const same = (a, b) => a && b && key(a) === key(b);

export function normalizeChatWorkspaceStrategy(strategy = 'shared', workspaceId) {
  if (strategy && typeof strategy === 'object' && !Array.isArray(strategy)) {
    if (Object.keys(strategy).some(name => !['kind', 'workspaceId'].includes(name)) || workspaceId !== undefined) throw new ChatContractError('invalid_request', 'Unsupported workspace strategy fields');
    workspaceId = strategy.workspaceId; strategy = strategy.kind;
  }
  if (!['shared', 'new_worktree', 'existing_worktree'].includes(strategy)) throw new ChatContractError('invalid_request', 'Unsupported workspace strategy');
  if (strategy === 'existing_worktree') return { kind: strategy, workspaceId: identifier(workspaceId, 'workspaceId') };
  if (workspaceId !== undefined && workspaceId !== null) throw new ChatContractError('invalid_request', 'workspace_id is only valid for existing_worktree');
  return { kind: strategy };
}

async function git(args, cwd, signal) {
  return runWorktreeSetupProcess('git', process.platform === 'win32' ? ['-c', 'core.longpaths=true', ...args] : args,
    { cwd, timeout: 120_000, signal });
}

export function createChatWorkspaceAdapters(overrides = {}) {
  return {
    async loadProject(cwd) { return (await import('./context.js')).loadChatProjectRegistry(cwd); },
    async probeCheckout(cwd, signal) {
      const canonicalPath = await fs.realpath(cwd);
      if (!(await fs.stat(canonicalPath)).isDirectory()) fail('The checkout is not a directory');
      const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], canonicalPath, signal);
      if (common.code !== 0) return { canonicalPath, commonDir: null, topLevel: null, head: null, branch: null, dirty: false };
      const commonDir = await fs.realpath(common.stdout.trim());
      const [head, branch, top, status] = await Promise.all([
        git(['rev-parse', '--verify', 'HEAD^{commit}'], canonicalPath, signal),
        git(['symbolic-ref', '--quiet', '--short', 'HEAD'], canonicalPath, signal),
        git(['rev-parse', '--show-toplevel'], canonicalPath, signal),
        git(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], canonicalPath, signal),
      ]);
      signal?.throwIfAborted();
      if (status.code !== 0 || status.accumulationTruncated || top.code !== 0) fail('Cannot verify the checkout state');
      return { canonicalPath, commonDir, topLevel: await fs.realpath(top.stdout.trim()),
        head: head.code === 0 ? head.stdout.trim() : null, branch: branch.code === 0 ? branch.stdout.trim() : null,
        dirty: Boolean(status.stdout) };
    },
    slotPath: (slotId, source) => getChatWorktreePath(slotId, source),
    async exists(full) { try { await fs.lstat(full); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } },
    async create({ slotId, source, branch, baseSha, signal }) {
      const parent = pathAccessStore.getStore();
      return pathAccessStore.run({ ...parent, workspaceRootOverride: source, abortSignal: signal }, () =>
        createChatWorktree({ chatId: slotId, branch, baseRef: baseSha, requireNewBranch: true, signal }));
    },
    prepareDependencies: (source, target, { signal } = {}) => ensureDependencyDirs(source, target, { signal }),
    ...overrides,
  };
}

function attach(error, binding) {
  const result = error instanceof ChatContractError ? error : new ChatContractError(
    error?.code === 'recovery_required' ? 'recovery_required' : 'capability_unavailable', error?.message ?? 'Checkout setup failed');
  result.binding = binding;
  return result;
}

/** Allocations own checkouts; model execution and graph admission remain outside. */
export function createChatWorkspaceResolver({ workspaceRepository = createChatWorkspaceRepository(), adapters: overrides,
  refreshSourceTarget, feature = getAgentConversationsFeature, ownerId = `workspace-${randomUUID()}` } = {}) {
  const adapters = createChatWorkspaceAdapters(overrides);
  identifier(ownerId, 'ownerId');
  const active = new Map();
  async function sourceFor(input, refresh = false) {
    const caller = assertCaller(input.caller);
    if (caller.actor === 'agent') assertExecutionCaller(caller);
    const sourceTarget = refresh ? await refreshSourceTarget(caller, input.sourceTarget.chat.id) : input.sourceTarget;
    if (!sourceTarget?.scope || sourceTarget.scope.workspaceId !== caller.scope.workspaceId || sourceTarget.scope.projectId !== caller.scope.projectId) fail('The spawning execution must use its own bound checkout');
    const project = await adapters.loadProject(sourceTarget.scope.canonicalKey);
    const scope = resolveProjectScope(project.registry, { projectId: caller.scope.projectId, workspaceKey: sourceTarget.scope.canonicalKey });
    if (scope.workspaceId !== caller.scope.workspaceId || project.projectId !== caller.scope.projectId) fail('The source checkout identity changed');
    const policy = intersectChatPolicies(caller.policy, sourceTarget.policy, sourceTarget.currentPolicy);
    assertCallerCanTarget(caller, { chatId: sourceTarget.chat.id, scope, policy }, {
      operation: 'spawn', currentPolicy: sourceTarget.currentPolicy, registry: project.registry,
    });
    return { target: sourceTarget, project, scope, policy };
  }
  async function verify(binding, project, signal, initial = false) {
    const destination = await adapters.probeCheckout(binding.targetCanonicalPath ?? binding.targetPath, signal);
    if (binding.targetCanonicalPath && !same(destination.canonicalPath, binding.targetCanonicalPath)) fail('The bound checkout path was replaced');
    const target = project.registry.entries.find(entry => same(entry.canonicalKey, destination.canonicalPath));
    if (!target || target.projectId !== binding.projectId || target.revoked) fail('The allocated checkout is no longer registered for this project');
    const scope = resolveProjectScope(project.registry, { projectId: binding.projectId, workspaceKey: target.canonicalKey });
    if (binding.targetWorkspaceId && binding.targetWorkspaceId !== scope.workspaceId) fail('The allocated checkout identity changed');
    const source = await adapters.probeCheckout(binding.sourceCanonicalPath, signal);
    if (!same(source.canonicalPath, binding.sourceCanonicalPath) || !same(destination.canonicalPath, scope.canonicalKey)) fail('The bound checkout path was replaced');
    if (binding.strategy !== 'shared' && (!binding.sourceCommonDir || !same(source.commonDir, binding.sourceCommonDir) || !same(destination.commonDir, binding.sourceCommonDir))) fail('The allocated checkout belongs to a different Git repository');
    if (binding.strategy === 'new_worktree' && (!same(source.topLevel, source.canonicalPath) || !same(destination.topLevel, destination.canonicalPath))) fail('Isolation requires complete registered repository checkouts');
    if (initial && binding.strategy === 'new_worktree' && destination.head !== binding.baseSha) fail('The allocated checkout did not start at the captured parent commit');
    return { scope, destination };
  }
  function output(binding, project, verified) {
    return { binding, project, scope: verified.scope,
      ...(binding.strategy === 'new_worktree' ? { derivedFromWorkspaceId: binding.sourceWorkspaceId } : {}),
      chatPatch: { workspacePath: binding.sourceCanonicalPath, worktreeRoot: verified.scope.canonicalKey,
        gitBranch: verified.destination.branch ?? binding.branch ?? '', chatWorktreeManaged: binding.strategy === 'new_worktree',
        workspaceStrategy: binding.strategy, workspaceAllocationId: binding.allocationId } };
  }
  async function run(input, source, strategy) {
    const signal = input.signal;
    let binding = workspaceRepository.getByAllocation(input.allocationId);
    if (binding) {
      if (binding.childChatId !== input.childChatId || binding.projectId !== source.scope.projectId || binding.strategy !== strategy.kind ||
        binding.sourceWorkspaceId !== source.scope.workspaceId || !same(binding.sourceCanonicalPath, source.scope.canonicalKey) ||
        (strategy.kind === 'existing_worktree' && (binding.targetWorkspaceId ??
          source.project.registry.entries.find(row => same(row.canonicalKey, binding.targetPath))?.workspaceId) !== strategy.workspaceId)) {
        throw new ChatContractError('idempotency_conflict', 'Workspace allocation identity was reused');
      }
      if (binding.setupState === 'ready') return output(binding, source.project, await verify(binding, source.project, signal));
      if (binding.setupState !== 'failed' || input.retrySetup !== true) throw attach(new ChatContractError(
        binding.setupState === 'allocating' ? 'recovery_required' : 'capability_unavailable', `Workspace setup is ${binding.setupState}; its checkout is retained`), binding);
    }
    if (!feature()?.creationEnabled) throw new ChatContractError('capability_disabled', 'New conversation checkout allocation is disabled');
    signal?.throwIfAborted();
    const probe = await adapters.probeCheckout(source.scope.canonicalKey, signal);
    if (!same(probe.canonicalPath, source.scope.canonicalKey)) fail('The source checkout path was replaced');
    let target = source.scope;
    if (strategy.kind === 'existing_worktree') {
      const entry = source.project.registry.entries.find(row => row.workspaceId === strategy.workspaceId && row.projectId === source.scope.projectId && !row.revoked);
      if (!entry || !source.policy.workspaceIds.includes(entry.workspaceId)) fail('The existing checkout is not authorized by the spawning policy');
      target = resolveProjectScope(source.project.registry, { projectId: entry.projectId, workspaceKey: entry.canonicalKey });
      if (!probe.commonDir) fail('Existing worktree selection requires a Git project');
    }
    if (strategy.kind === 'new_worktree') {
      if (typeof refreshSourceTarget !== 'function') throw new ChatContractError('capability_unavailable', 'Owned checkout setup requires a live source authority callback');
      if (!probe.head || !probe.commonDir || !same(probe.topLevel, probe.canonicalPath)) fail('New worktrees require a repository root with a committed HEAD');
    }
    if (!binding) {
      const suffix = shortHash(JSON.stringify([input.allocationId, input.childChatId]));
      const slotId = strategy.kind === 'new_worktree' ? `agent-${suffix}` : null;
      const targetPath = slotId ? adapters.slotPath(slotId, source.scope.canonicalKey) : target.canonicalKey;
      if (!path.isAbsolute(targetPath)) fail('The managed checkout path is not absolute');
      const destination = strategy.kind === 'existing_worktree' ? await adapters.probeCheckout(targetPath, signal) : probe;
      binding = workspaceRepository.reserve({ allocationId: input.allocationId, childChatId: input.childChatId,
        projectId: source.scope.projectId, strategy: strategy.kind, sourceWorkspaceId: source.scope.workspaceId,
        sourceCanonicalPath: source.scope.canonicalKey, sourceCommonDir: probe.commonDir,
        targetPath, slotId, branch: slotId ? `minnow/agent-${suffix.slice(0, 20)}` : destination.branch,
        baseSha: destination.head, sourceHeadSha: probe.head, sourceDirty: probe.dirty });
    }
    const expectedRevision = binding.revision;
    binding = workspaceRepository.claim(binding.allocationId, { expectedRevision, ownerId, retry: input.retrySetup === true });
    let dependencies = binding.dependencies;
    let createdNow = false;
    try {
      if (strategy.kind === 'new_worktree') {
        if (await adapters.exists(binding.targetPath)) {
          if (input.retrySetup !== true) fail('The reserved checkout slot already exists without a ready binding');
          if (!binding.targetCanonicalPath || !binding.targetWorkspaceId) throw new ChatContractError('recovery_required', 'The partial checkout has no confirmed identity; retain it for explicit recovery');
          await verify(binding, await adapters.loadProject(source.scope.canonicalKey), signal);
          dependencies = await adapters.prepareDependencies(binding.sourceCanonicalPath, binding.targetPath, { signal });
        } else {
          const created = await adapters.create({ slotId: binding.slotId, source: binding.sourceCanonicalPath,
            branch: binding.branch, baseSha: binding.baseSha, signal });
          if (!created?.ok || created.created === false || !same(created.path, binding.targetPath) || created.branch !== binding.branch) {
            fail(created?.error || created?.output || 'The requested new checkout was not created');
          }
          createdNow = true;
          dependencies = created.deps ?? await adapters.prepareDependencies(binding.sourceCanonicalPath, binding.targetPath, { signal });
          const verified = await verify(binding, await adapters.loadProject(source.scope.canonicalKey), signal, true);
          binding = workspaceRepository.update(binding.allocationId, { targetWorkspaceId: verified.scope.workspaceId,
            targetCanonicalPath: verified.scope.canonicalKey, dependencies: dependencies ?? null }, { expectedRevision: binding.revision, ownerId });
        }
        if (dependencies?.ok === false) throw new ChatContractError('capability_unavailable', 'Checkout dependency setup failed; the owned checkout was retained');
      }
      signal?.throwIfAborted();
      const currentSource = typeof refreshSourceTarget === 'function' ? await sourceFor(input, true) : source;
      const verified = await verify(binding, currentSource.project, signal, createdNow);
      signal?.throwIfAborted();
      binding = workspaceRepository.update(binding.allocationId, { setupState: 'ready', targetWorkspaceId: verified.scope.workspaceId,
        targetCanonicalPath: verified.scope.canonicalKey, dependencies: dependencies ?? null }, { expectedRevision: binding.revision, ownerId });
      return output(binding, currentSource.project, verified);
    } catch (error) {
      const current = workspaceRepository.getByAllocation(binding.allocationId);
      if (current?.setupState === 'allocating' && current.ownerId === ownerId) {
        binding = workspaceRepository.update(binding.allocationId, {
          setupState: error?.code === 'recovery_required' ? 'recovery_required' : signal?.aborted ? 'cancelled' : 'failed',
          dependencies: dependencies ?? null,
          error: String(error?.message ?? error).slice(0, 2000), ...(signal?.aborted ? { cancelledAt: Date.now() } : {}),
        }, { expectedRevision: current.revision, ownerId });
      } else binding = current ?? binding;
      throw attach(error, binding);
    }
  }
  return {
    async resolve(input) {
      identifier(input.allocationId, 'allocationId'); identifier(input.childChatId, 'childChatId');
      const strategy = normalizeChatWorkspaceStrategy(input.strategy, input.workspaceId);
      const source = await sourceFor(input);
      const intent = JSON.stringify([input.childChatId, strategy, source.scope.projectId, source.scope.workspaceId]);
      const prior = active.get(input.allocationId);
      if (prior) {
        if (prior.intent !== intent) throw new ChatContractError('idempotency_conflict', 'Workspace allocation identity was reused');
        return prior.promise;
      }
      const promise = run(input, source, strategy);
      active.set(input.allocationId, { intent, promise });
      try { return await promise; } finally { if (active.get(input.allocationId)?.promise === promise) active.delete(input.allocationId); }
    },
    /** Loader callback: only protected ready allocations with fresh Git proof become edges. */
    async listVerifiedEdges(project, { signal } = {}) {
      const output = [];
      for (const binding of workspaceRepository.list({ projectId: project.projectId, setupState: 'ready' })) {
        if (binding.strategy !== 'new_worktree' || binding.deletedAt !== null) continue;
        try {
          const source = resolveProjectScope(project.registry, { projectId: binding.projectId, workspaceKey: binding.sourceCanonicalPath });
          if (source.workspaceId !== binding.sourceWorkspaceId) continue;
          await verify(binding, project, signal);
          output.push({ allocationId: binding.allocationId, childChatId: binding.childChatId, projectId: binding.projectId,
            sourceWorkspaceId: binding.sourceWorkspaceId, targetWorkspaceId: binding.targetWorkspaceId,
            sourceCanonicalPath: binding.sourceCanonicalPath, targetCanonicalPath: binding.targetCanonicalPath });
        } catch (error) { if (signal?.aborted) throw error; /* Unverified paths confer no authority. */ }
      }
      return output;
    },
  };
}
