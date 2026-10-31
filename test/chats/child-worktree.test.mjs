import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { initSessionsSchema } from '../../server/config/sessions-schema.js';
import { resetMinnowHomeCache } from '../../server/config/home.js';
import { createChatRepository } from '../../server/chats/repository.js';
import { createChatWorkspaceRepository } from '../../server/chats/workspace-repository.js';
import { createChatWorkspaceResolver, createChatWorkspaceAdapters, normalizeChatWorkspaceStrategy } from '../../server/chats/workspace.js';
import { createChatPolicy, intersectChatPolicies, assertChatToolAllowed } from '../../server/chats/policy.js';
import { createChatCaller } from '../../server/chats/caller.js';
import { createChatContext, loadChatProjectRegistry } from '../../server/chats/context.js';
import { createChatDelegation } from '../../server/chats/delegation.js';
import { createChatCommandService } from '../../server/chats/service.js';
import { installChatWorkspaces } from '../../server/chats/workspace-runtime.js';
import { runWorktreeSetupProcess } from '../../server/worktree/setup-process.js';

const exec = promisify(execFile);
async function fixture(run, { gitRepository = true, committed = true, existing = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-child-worktree-'));
  const repo = path.join(root, 'project'), home = path.join(root, 'home');
  const previous = process.env.MINNOW_HOME;
  process.env.MINNOW_HOME = home; resetMinnowHomeCache();
  const git = (args, cwd = repo) => exec('git', args, { cwd, windowsHide: true });
  const load = cwd => loadChatProjectRegistry(cwd, { validateRoot: async () => {} });
  const db = new Database(':memory:'); initSessionsSchema(db);
  const chats = createChatRepository({ db }), allocations = createChatWorkspaceRepository({ db });
  try {
    await fs.mkdir(repo); await fs.mkdir(home);
    if (gitRepository) {
      await git(['init']); await git(['config', 'user.name', 'Fixture']); await git(['config', 'user.email', 'fixture@example.test']);
    }
    await fs.writeFile(path.join(repo, 'README.md'), 'committed base');
    if (gitRepository && committed) { await git(['add', 'README.md']); await git(['commit', '-m', 'base']); }
    let existingPath;
    if (existing) {
      existingPath = path.join(root, 'existing');
      await git(['worktree', 'add', '-b', 'existing-fixture', existingPath, 'HEAD']);
    }
    const project = await load(repo);
    const inputPolicy = { modeId: 'build', toolPermissions: { spawn_sub_agent: 'full', read_file: 'full', save_file: 'full', execute_command: 'full' },
      toolEffects: { spawn_sub_agent: 'external-write', read_file: 'read', save_file: 'file-write', execute_command: 'shell' },
      workspaceIds: project.registry.entries.map(entry => entry.workspaceId), filesystemAccess: 'workspace', fileWriteScope: 'workspace',
      capabilities: ['agent.spawn', 'execution.host', 'chat.read', 'chat.send', 'chat.stop'] };
    let currentPolicy = createChatPolicy(inputPolicy);
    const capturedPolicy = currentPolicy;
    chats.createChat({ id: 'parent', name: 'Parent', workspacePath: repo, modeId: 'build' });
    // The fixture has no host keepalive while its real Git subprocesses run.
    const fence = chats.claimExecution({ chatId: 'parent', executionId: 'source-execution', ownerId: 'source-host', leaseMs: 120000 });
    const caller = createChatCaller({ actor: 'agent', ingress: 'tool', chatId: 'parent', executionId: fence.executionId,
      executionActive: true, scope: project.scope, policy: capturedPolicy });
    async function target() {
      const fresh = await load(repo);
      return { chat: chats.getChat('parent'), ...fresh, scope: fresh.scope, project: fresh,
        currentPolicy, policy: intersectChatPolicies(capturedPolicy, currentPolicy), profile: null };
    }
    const adapters = createChatWorkspaceAdapters({ loadProject: load });
    let creates = 0;
    const originalCreate = adapters.create;
    adapters.create = async input => { creates++; return originalCreate(input); };
    const refreshSourceTarget = async () => {
      const execution = chats.getExecution(fence.executionId);
      if (!execution || execution.status !== 'running') throw new Error('Source execution is no longer active');
      chats.assertFence('parent', fence); return target();
    };
    const resolver = createChatWorkspaceResolver({ workspaceRepository: allocations, adapters,
      refreshSourceTarget, feature: () => ({ creationEnabled: true }), ownerId: 'setup-owner' });
    const base = { allocationId: 'allocation', childChatId: 'child', caller, sourceTarget: await target() };
    await run({ root, repo, home, db, chats, allocations, adapters, resolver, base, git, load, project, existingPath,
      creates: () => creates, target, refreshSourceTarget,
      revokeSpawn() { currentPolicy = createChatPolicy({ ...inputPolicy, capabilities: inputPolicy.capabilities.filter(value => value !== 'agent.spawn') }); },
    });
  } finally {
    db.close();
    if (previous === undefined) delete process.env.MINNOW_HOME; else process.env.MINNOW_HOME = previous;
    resetMinnowHomeCache();
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('shared default binds the actual spawning checkout, including non-git projects', async () => {
  await fixture(async f => {
    const result = await f.resolver.resolve(f.base);
    assert.equal(result.binding.strategy, 'shared'); assert.equal(result.scope.workspaceId, f.project.scope.workspaceId);
    assert.equal(result.chatPatch.worktreeRoot, f.project.scope.canonicalKey); assert.equal(f.creates(), 0);
    assert.equal(result.binding.baseSha, null);
    assert.equal(path.resolve(f.chats.getChat('parent').workspacePath), path.resolve(f.repo));
  }, { gitRepository: false, committed: false });
});

test('new checkout pins parent commit, excludes dirty/untracked files and coalesces durable retries', async () => {
  await fixture(async f => {
    const head = (await f.git(['rev-parse', 'HEAD'])).stdout.trim();
    await fs.writeFile(path.join(f.repo, 'README.md'), 'uncommitted parent edit');
    await fs.writeFile(path.join(f.repo, 'untracked.txt'), 'parent-only');
    const input = { ...f.base, strategy: 'new_worktree' };
    const [one, duplicate] = await Promise.all([f.resolver.resolve(input), f.resolver.resolve(input)]);
    assert.equal(one.binding.setupState, 'ready'); assert.equal(duplicate.binding.allocationId, one.binding.allocationId);
    assert.equal(f.creates(), 1); assert.equal(one.binding.baseSha, head); assert.equal(one.binding.sourceDirty, true);
    assert.equal(one.binding.uncommittedParentEditsExcluded, true);
    assert.equal(await fs.readFile(path.join(one.scope.canonicalKey, 'README.md'), 'utf8'), 'committed base');
    await assert.rejects(fs.access(path.join(one.scope.canonicalKey, 'untracked.txt')));
    assert.equal((await f.git(['rev-parse', 'HEAD'], one.scope.canonicalKey)).stdout.trim(), head);
    assert.equal(await fs.readFile(path.join(f.repo, 'README.md'), 'utf8'), 'uncommitted parent edit');
    const followup = await f.resolver.resolve(input);
    assert.equal(followup.scope.workspaceId, one.scope.workspaceId); assert.equal(f.creates(), 1);
    assert.equal((await f.resolver.listVerifiedEdges(await f.load(f.repo))).length, 1);
    assert.equal(f.chats.listChats({}).length, 1, 'allocator never creates a phantom child shell');
  });
});

test('captured Plan parent delegates through real context and admits fresh messages into its verified child checkout', async () => {
  await fixture(async f => {
    await fs.writeFile(path.join(f.repo, 'README.md'), 'dirty parent content');
    await fs.writeFile(path.join(f.repo, 'untracked.txt'), 'parent only');
    const captured = createChatPolicy({ ...f.base.caller.policy, modeId: 'plan', fileWriteScope: 'plans',
      workspaceIds: [f.project.scope.workspaceId] });
    const modelSelection = { providerId: 'fixture', modelId: 'captured-model', options: { reasoningEffort: 'high' } };
    f.chats.configureChat('parent', { modeId: 'plan', providerId: 'fixture', modelId: 'captured-model' });
    f.chats.saveProfile('parent', { profileId: 'parent-profile', profileVersion: 1, snapshot: { policy: captured, modelSelection } });
    const context = createChatContext({ repository: f.chats, validateRoot: async () => {},
      resolvePolicyInput: async (_chat, _scope, registry) => ({ ...captured,
        workspaceIds: registry.entries.map(entry => entry.workspaceId) }) });
    const source = await context.executionCaller('source-execution');
    assert.deepEqual(source.caller.policy.workspaceIds, [f.project.scope.workspaceId]);
    const active = caller => {
      try { return Boolean(f.chats.assertFence(caller.chatId, f.chats.getLease(caller.chatId))); } catch { return false; }
    };
    const runtime = { repository: f.chats, context, isExecutionCallerActive: active };
    const resolver = installChatWorkspaces(runtime, { workspaceRepository: f.allocations, adapters: f.adapters,
      feature: () => ({ creationEnabled: true }) });
    const events = [], errors = [];
    const service = createChatCommandService({ repository: f.chats, context, feature: () => ({ creationEnabled: true }),
      resolveModelSelection: ({ selection }) => selection, onError: error => errors.push(error) });
    try {
      const delegation = createChatDelegation({ repository: f.chats, context, service,
        feature: () => ({ creationEnabled: true }), validateSourceCaller: active,
        getEngine: async () => ({ append: async rows => { events.push(...rows); }, tick: async () => {} }),
        loadConfig: async () => ({ enabled: true, types: { explore: { enabled: true } } }),
        resolveModelSelection: async ({ parentSelection }) => ({ selection: parentSelection, source: 'parent', exactModel: false }),
        captureProfile: async (child, scope, options) => {
          assert.equal(child.modeId, 'plan'); assert.notEqual(scope.workspaceId, source.caller.scope.workspaceId);
          return { policy: createChatPolicy({ ...captured, workspaceIds: options.workspaceIds }),
            prompt: { capturedRole: 'Immutable delegated role' }, modelSelection: options.modelSelection, exactModel: options.exactModel };
        },
        resolveWorkspace: async ({ caller, target, strategy, allocationId, childChatId, signal }) => {
          const bound = await resolver.resolve({ caller, sourceTarget: target, strategy, allocationId, childChatId, signal });
          const project = await context.project(target.scope.canonicalKey);
          return { ...bound.chatPatch, scope: bound.scope, registry: project.registry, binding: bound.binding };
        },
      });
      const result = await delegation.spawn(source.caller, { type: 'explore', task: 'Inspect in isolation',
        workspace_strategy: 'new_worktree', client_request_id: 'isolated-plan' }, { toolCallId: 'spawn-call' });
      const child = await context.resolveTarget(result.childChatId);
      const binding = f.allocations.getByChild(result.childChatId);
      assert.equal(binding.setupState, 'ready');
      assert.equal(path.relative(child.chat.workspacePath, source.target.scope.canonicalKey), '');
      assert.equal(path.relative(child.chat.worktreeRoot, binding.targetCanonicalPath), '');
      assert.equal(child.scope.workspaceId, binding.targetWorkspaceId);
      assert.equal(child.profile.snapshot.workspaceBinding.allocationId, binding.allocationId);
      assert.equal(child.profile.snapshot.prompt.capturedRole, 'Immutable delegated role');
      assert.deepEqual(child.profile.snapshot.modelSelection, modelSelection);
      assert.equal(child.policy.modeId, 'plan'); assert.equal(child.policy.fileWriteScope, 'plans');
      assert.equal(child.policy.toolPermissions.spawn_sub_agent ?? 'off', 'off');
      assert.throws(() => assertChatToolAllowed(child.policy, 'save_file', { path: 'src/file.ts', content: 'x' },
        { currentPolicy: child.currentPolicy }), error => error.code === 'policy_denied');
      assert.doesNotThrow(() => assertChatToolAllowed(child.policy, 'save_file', { path: 'documentation/plans/review.md', content: 'x' },
        { currentPolicy: child.currentPolicy }));
      assert.deepEqual(source.caller.policy.workspaceIds, [f.project.scope.workspaceId], 'allocation must not rewrite captured parent scope');
      const sent = await service.send(source.caller, { chatId: child.chat.id, message: 'Follow up on this checkout', clientRequestId: 'fresh-child-message' });
      assert.equal(sent.chatId, child.chat.id);
      assert.equal(f.chats.getCommand(sent.commandId).captured.scope.workspaceId, child.scope.workspaceId);
      assert.equal(events[0].cwd, child.scope.canonicalKey);
      assert.equal(await fs.readFile(path.join(child.scope.canonicalKey, 'README.md'), 'utf8'), 'committed base');
      await assert.rejects(fs.access(path.join(child.scope.canonicalKey, 'untracked.txt')));
      assert.equal(await fs.readFile(path.join(f.repo, 'README.md'), 'utf8'), 'dirty parent content');
      assert.equal(await fs.readFile(path.join(f.repo, 'untracked.txt'), 'utf8'), 'parent only');
      await service.idle(); assert.deepEqual(errors, []);
    } finally { await service.dispose(); }
  });
});

test('existing checkout needs the exact captured workspace grant, even with full filesystem access', async () => {
  await fixture(async f => {
    const existing = f.project.registry.entries.find(entry => entry.canonicalKey !== f.project.scope.canonicalKey);
    const result = await f.resolver.resolve({ ...f.base, strategy: 'existing_worktree', workspaceId: existing.workspaceId });
    assert.equal(result.scope.workspaceId, existing.workspaceId); assert.equal(f.creates(), 0);
    assert.equal((await f.resolver.listVerifiedEdges(await f.load(f.repo))).length, 0, 'existing selection never creates a derived grant');
  }, { existing: true });
  await fixture(async f => {
    const added = path.join(f.root, 'later'); await f.git(['worktree', 'add', '-b', 'later', added, 'HEAD']);
    const project = await f.load(f.repo), target = project.registry.entries.find(entry => entry.canonicalKey !== project.scope.canonicalKey);
    await assert.rejects(f.resolver.resolve({ ...f.base, strategy: 'existing_worktree', workspaceId: target.workspaceId }), error => error.code === 'workspace_denied');
    await assert.rejects(f.resolver.resolve({ ...f.base, strategy: 'existing_worktree', workspaceId: 'unrelated' }), error => error.code === 'workspace_denied');
    assert.equal(f.allocations.getByAllocation('allocation'), null);
  });
});

test('new-worktree slots hash full identities and never attach a pre-existing branch', async () => {
  await fixture(async f => {
    const suffix = createHash('sha256').update(JSON.stringify(['allocation', 'child'])).digest('hex').slice(0, 32);
    const branch = `minnow/agent-${suffix.slice(0, 20)}`;
    await f.git(['branch', branch]);
    await assert.rejects(f.resolver.resolve({ ...f.base, strategy: 'new_worktree' }), error => error.binding?.setupState === 'failed');
    const binding = f.allocations.getByAllocation('allocation');
    assert.ok(binding.slotId.length <= 64); await assert.rejects(fs.access(binding.targetPath));
    assert.equal((await f.git(['show-ref', '--verify', `refs/heads/${branch}`])).stdout.includes(branch), true);
    await assert.rejects(f.resolver.resolve({ ...f.base, childChatId: 'another', strategy: 'new_worktree' }), error => error.code === 'idempotency_conflict');
  });
});

test('dependency failure retains an identified checkout and explicit retry preserves its local edits', async () => {
  await fixture(async f => {
    const create = f.adapters.create;
    f.adapters.create = async input => ({ ...await create(input), deps: { ok: false, failed: [{ dir: 'node_modules', reason: 'fixture failure' }] } });
    const resolver = createChatWorkspaceResolver({ workspaceRepository: f.allocations, adapters: f.adapters,
      refreshSourceTarget: f.refreshSourceTarget, feature: () => ({ creationEnabled: true }), ownerId: 'retry-owner' });
    const input = { ...f.base, strategy: 'new_worktree' };
    await assert.rejects(resolver.resolve(input), error => error.binding?.setupState === 'failed');
    const failed = f.allocations.getByAllocation('allocation');
    assert.ok(failed.targetCanonicalPath); assert.ok(failed.targetWorkspaceId); assert.equal(failed.dependencies.ok, false);
    await fs.writeFile(path.join(failed.targetCanonicalPath, 'README.md'), 'retained child work');
    f.adapters.prepareDependencies = async () => ({ ok: true, linked: [], repaired: [], installed: [], failed: [] });
    // Adapters are copied at factory creation; provide a new owner for the explicit retry.
    const retry = createChatWorkspaceResolver({ workspaceRepository: f.allocations, adapters: f.adapters,
      refreshSourceTarget: f.refreshSourceTarget, feature: () => ({ creationEnabled: true }), ownerId: 'retry-second-owner' });
    const result = await retry.resolve({ ...input, retrySetup: true });
    assert.equal(result.binding.setupState, 'ready');
    assert.equal(await fs.readFile(path.join(result.scope.canonicalKey, 'README.md'), 'utf8'), 'retained child work');
    assert.equal(f.creates(), 1);
  });
});

test('Stop during allocation retains ownership and cannot be resurrected by a late/repeated result', async () => {
  await fixture(async f => {
    const controller = new AbortController();
    let notify;
    const created = new Promise(resolve => { notify = resolve; });
    const create = f.adapters.create;
    f.adapters.create = async input => {
      const result = await create(input); notify(result);
      await new Promise((resolve, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }));
      return result;
    };
    const resolver = createChatWorkspaceResolver({ workspaceRepository: f.allocations, adapters: f.adapters,
      refreshSourceTarget: f.refreshSourceTarget, feature: () => ({ creationEnabled: true }) });
    const pending = resolver.resolve({ ...f.base, strategy: 'new_worktree', signal: controller.signal });
    await created; controller.abort(new DOMException('Stopped', 'AbortError'));
    await assert.rejects(pending, error => error.binding?.setupState === 'cancelled');
    const binding = f.allocations.getByAllocation('allocation');
    await fs.access(binding.targetPath);
    await assert.rejects(resolver.resolve({ ...f.base, strategy: 'new_worktree', retrySetup: true }), error => error.binding?.setupState === 'cancelled');
    assert.deepEqual(await resolver.listVerifiedEdges(await f.load(f.repo)), []);
    assert.equal(f.creates(), 1);
  });
});

test('revoked live source rights prevent checkout publication after setup', async () => {
  await fixture(async f => {
    const create = f.adapters.create;
    f.adapters.create = async input => { const result = await create(input); f.revokeSpawn(); return result; };
    const resolver = createChatWorkspaceResolver({ workspaceRepository: f.allocations, adapters: f.adapters,
      refreshSourceTarget: f.refreshSourceTarget, feature: () => ({ creationEnabled: true }) });
    await assert.rejects(resolver.resolve({ ...f.base, strategy: 'new_worktree' }), error => error.code === 'policy_denied' && error.binding?.setupState === 'failed');
    const binding = f.allocations.getByAllocation('allocation'); await fs.access(binding.targetPath);
    assert.deepEqual(await resolver.listVerifiedEdges(await f.load(f.repo)), []);
  });
});

test('deleting a chat preserves allocation ownership and tombstoning never deletes dirty files', async () => {
  await fixture(async f => {
    const result = await f.resolver.resolve({ ...f.base, strategy: 'new_worktree' });
    f.chats.createChat({ id: 'child', workspacePath: result.scope.canonicalKey });
    f.db.prepare('DELETE FROM chats WHERE id=?').run('child');
    assert.equal(f.allocations.getByChild('child').setupState, 'ready');
    await fs.writeFile(path.join(result.scope.canonicalKey, 'README.md'), 'dirty retained');
    f.allocations.tombstone('child');
    const tombstone = f.allocations.getByChild('child');
    assert.equal(tombstone.setupState, 'tombstoned');
    assert.throws(() => f.allocations.claim(tombstone.allocationId, { expectedRevision: tombstone.revision, ownerId: 'later-owner', retry: true }),
      error => error.code === 'ownership_conflict');
    assert.equal(await fs.readFile(path.join(result.scope.canonicalKey, 'README.md'), 'utf8'), 'dirty retained');
    assert.deepEqual(await f.resolver.listVerifiedEdges(await f.load(f.repo)), []);
  });
});

test('replacing a recorded checkout with an unrelated repository drops its derived authority', async () => {
  await fixture(async f => {
    const result = await f.resolver.resolve({ ...f.base, strategy: 'new_worktree' });
    const target = result.scope.canonicalKey, retained = path.join(f.root, 'retained-checkout');
    for (const full of [target, retained]) {
      const relative = path.relative(path.resolve(f.root), path.resolve(full));
      assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    }
    await fs.rename(target, retained);
    await fs.mkdir(target); await f.git(['init'], target);
    await fs.writeFile(path.join(target, 'foreign.txt'), 'foreign repo contents');
    const project = await f.load(f.repo);
    assert.deepEqual(await f.resolver.listVerifiedEdges(project), []);
    await assert.rejects(f.resolver.resolve({ ...f.base, strategy: 'new_worktree' }), error => error.code === 'workspace_denied');
    assert.equal(await fs.readFile(path.join(target, 'foreign.txt'), 'utf8'), 'foreign repo contents');
    assert.equal(await fs.readFile(path.join(retained, 'README.md'), 'utf8'), 'committed base');
  });
});

test('source without a commit cannot allocate isolation and arbitrary strategy roots are rejected', async () => {
  await fixture(async f => {
    await assert.rejects(f.resolver.resolve({ ...f.base, strategy: 'new_worktree' }), error => error.code === 'workspace_denied');
    assert.equal(f.allocations.getByChild('child'), null); assert.equal(f.creates(), 0);
    assert.throws(() => normalizeChatWorkspaceStrategy({ kind: 'new_worktree', root: '/arbitrary' }), error => error.code === 'invalid_request');
    assert.throws(() => normalizeChatWorkspaceStrategy('shared', 'another'), error => error.code === 'invalid_request');
  }, { committed: false });
});

test('owned setup process confirms shutdown before Stop returns and cannot write later', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-setup-process-'));
  const marker = path.join(root, 'late.txt'), controller = new AbortController();
  let child;
  let notify;
  const spawned = new Promise(resolve => { notify = resolve; });
  try {
    const pending = runWorktreeSetupProcess(process.execPath, ['-e',
      `process.on('SIGTERM',()=>{});setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'late'),2000);setInterval(()=>{},1000)`],
    { cwd: root, signal: controller.signal, onSpawn: value => { child = value; notify(); } });
    await spawned; controller.abort(new DOMException('Stopped', 'AbortError'));
    await assert.rejects(pending);
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'owned process must confirm exit');
    await assert.rejects(fs.access(marker));
  } finally {
    if (child && child.exitCode == null && child.signalCode == null) {
      child.kill('SIGKILL');
      await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 500); });
    }
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(root, { recursive: true, force: true });
  }
});
