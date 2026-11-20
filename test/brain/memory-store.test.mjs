/**
 * Project memory scope and store: repository keys shared by worktrees, scope
 * isolation, limits, duplicates, secrets and project moves.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ensureMinnowLayout, resetMinnowHomeCache } from '../../server/config/home.js';
import { closeSessionsDb } from '../../server/config/sessions-db.js';
import { closeCodeDbForTests } from '../../server/brain/code/schema.js';
import { getChatWorktreePath } from '../../server/worktree/paths.js';
import { listPages, resolvePageLookup } from '../../server/brain/store.js';
import {
  clearMemoryProjectCache,
  memoryScopeOfPath,
  resolveMemoryProject,
} from '../../server/brain/memory/scope.js';
import {
  MEMORY_LIMITS,
  MemoryError,
  createMemory,
  forgetMemory,
  listMemories,
  readMemory,
  rebindProjectMemories,
  updateMemory,
} from '../../server/brain/memory/store.js';

const deps = { config: { embeddings: { enabled: false } } };
let homeDir;
let scratch;

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

async function makeRepo(dir) {
  await fs.mkdir(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

const save = (project, fields) => createMemory({ project, kind: 'decision', ...fields }, deps);

before(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-memory-store-'));
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-memory-repos-'));
  process.env.MINNOW_HOME = homeDir;
  resetMinnowHomeCache();
  await ensureMinnowLayout();
  const configPath = path.join(homeDir, 'config.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  config.memory = { ...(config.memory ?? {}), embeddings: { enabled: false } };
  config.brain = { ...(config.brain ?? {}), embeddings: { enabled: false } };
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
});

after(async () => {
  closeCodeDbForTests();
  closeSessionsDb();
  delete process.env.MINNOW_HOME;
  resetMinnowHomeCache();
  clearMemoryProjectCache();
  await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  await fs.rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('memory scope', () => {
  test('a repository and two linked worktrees resolve to one key', async () => {
    const repo = await makeRepo(path.join(scratch, 'alpha'));
    git(repo, 'worktree', 'add', '-q', path.join(scratch, 'alpha-wt1'), '-b', 'wt1');
    git(repo, 'worktree', 'add', '-q', path.join(scratch, 'alpha-wt2'), '-b', 'wt2');
    const main = await resolveMemoryProject(repo);
    const one = await resolveMemoryProject(path.join(scratch, 'alpha-wt1'));
    const two = await resolveMemoryProject(path.join(scratch, 'alpha-wt2'));
    assert.equal(main.label, 'alpha');
    assert.equal(one.key, main.key);
    assert.equal(two.key, main.key);
    assert.equal(one.label, 'alpha');
    assert.match(main.key, /^alpha--[a-f0-9]{32}$/);
    const sub = path.join(repo, 'src');
    await fs.mkdir(sub);
    assert.equal((await resolveMemoryProject(sub)).key, main.key);
  });

  test('unrelated repositories, plain folders and multi-repo folders get distinct keys', async () => {
    const beta = await resolveMemoryProject(await makeRepo(path.join(scratch, 'beta')));
    const plainDir = path.join(scratch, 'plain');
    await fs.mkdir(plainDir);
    const plain = await resolveMemoryProject(plainDir);
    const multiDir = path.join(scratch, 'multi');
    await makeRepo(path.join(multiDir, 'frontend'));
    await makeRepo(path.join(multiDir, 'backend'));
    const multi = await resolveMemoryProject(multiDir);
    const alpha = await resolveMemoryProject(path.join(scratch, 'alpha'));
    const keys = new Set([beta.key, plain.key, multi.key, alpha.key]);
    assert.equal(keys.size, 4);
    assert.equal(plain.label, 'plain');
    assert.equal(multi.label, 'multi');
    assert.equal((await resolveMemoryProject(plainDir)).key, plain.key);
  });

  test('a cancelled wait does not poison the shared lookup', async () => {
    clearMemoryProjectCache();
    const controller = new AbortController();
    const waiting = resolveMemoryProject(path.join(scratch, 'beta'), { signal: controller.signal });
    controller.abort();
    await assert.rejects(waiting);
    assert.match((await resolveMemoryProject(path.join(scratch, 'beta'))).key, /^beta--/);
  });

  test('mirrored multi-repo checkouts share their source scope but cannot forge another project', async () => {
    const source = await fs.realpath(path.join(scratch, 'multi'));
    const checkout = getChatWorktreePath('memory-scope-test', source);
    await fs.mkdir(checkout, { recursive: true });
    const manifest = path.join(checkout, '.minnow-worktree.json');
    await fs.writeFile(manifest, JSON.stringify({ kind: 'multi-repo', workspaceRoot: source, repos: [] }));
    assert.equal((await resolveMemoryProject(checkout)).key, (await resolveMemoryProject(source)).key);
    const other = path.join(scratch, 'beta');
    await fs.writeFile(manifest, JSON.stringify({ kind: 'multi-repo', workspaceRoot: other, repos: [] }));
    clearMemoryProjectCache(checkout);
    assert.notEqual((await resolveMemoryProject(checkout)).key, (await resolveMemoryProject(other)).key);
  });

  test('memoryScopeOfPath only accepts the memory folders', () => {
    assert.deepEqual(memoryScopeOfPath('memory/user/a.md'), { scope: 'user', projectKey: null });
    assert.equal(memoryScopeOfPath(`memory/projects/x--${'a'.repeat(32)}/a.md`).scope, 'project');
    assert.equal(memoryScopeOfPath('facts/a.md'), null);
    assert.equal(memoryScopeOfPath('memory/user/nested/a.md'), null);
    assert.equal(memoryScopeOfPath('memory/projects/bad/a.md'), null);
  });
});

describe('memory store', () => {
  let alpha;
  let beta;

  before(async () => {
    alpha = await resolveMemoryProject(path.join(scratch, 'alpha'));
    beta = await resolveMemoryProject(path.join(scratch, 'beta'));
  });

  test('projects never see each other; user memories are shared', async () => {
    const a = await save(alpha, { title: 'Alpha uses pnpm workspaces', body: 'Install with pnpm, never npm.' });
    const u = await save(alpha, { title: 'User prefers terse summaries', body: 'Keep reports short.', kind: 'preference', scope: 'user' });
    assert.equal(a.scope, 'project');
    assert.match(a.path, new RegExp(`^memory/projects/${alpha.key}/alpha-uses-pnpm-workspaces-`));
    assert.equal(a.meta.projectKey, alpha.key);
    assert.equal(a.meta.kind, 'decision');
    assert.match(u.path, /^memory\/user\//);

    const fromBeta = await listMemories({ project: beta });
    assert.deepEqual(fromBeta.map(row => row.id), [u.meta.id]);
    await assert.rejects(readMemory(a.meta.id, { project: beta }), /No memory with id/);
    assert.equal((await readMemory(a.meta.id, { project: alpha })).meta.title, 'Alpha uses pnpm workspaces');
    assert.equal((await readMemory(u.meta.id, { project: beta })).scope, 'user');
  });

  test('legacy pages are never readable as memories', async () => {
    const { createPage } = await import('../../server/brain/store.js');
    const legacy = await createPage({ relPath: 'facts/legacy.md', title: 'Legacy', body: 'old', skipVectorSync: true });
    await assert.rejects(readMemory(legacy.meta.id, { project: alpha }), /No memory with id/);
  });

  test('limits, kinds and secrets fail with actionable messages and write nothing', async () => {
    const before = (await listPages()).length;
    await assert.rejects(save(alpha, { title: 'x'.repeat(MEMORY_LIMITS.title + 1), body: 'b' }), /limit is 100/);
    await assert.rejects(save(alpha, { title: 'Long body', body: 'b'.repeat(MEMORY_LIMITS.body + 1) }), /limit is 1200/);
    await assert.rejects(save(alpha, { title: 'Long evidence', body: 'b', evidence: 'e'.repeat(301) }), /limit is 300/);
    await assert.rejects(save(alpha, { title: 'Bad kind', body: 'b', kind: 'todo' }), /kind must be one of/);
    await assert.rejects(save(alpha, { title: 'Deploy key', body: 'Use sk-abcdefghijklmnopqrstuv for deploys' }), /credential/);
    await assert.rejects(save(alpha, { title: 'Scope', body: 'b', scope: 'global' }), /scope must be/);
    await assert.rejects(save(null, { title: 'No project', body: 'b' }), /No project is open/);
    assert.equal((await listPages()).length, before);
  });

  test('a cancelled save never writes even when the abort reason is an ordinary Error', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Stopped by user'));
    const before = (await listPages()).length;
    await assert.rejects(createMemory({ project: alpha, scope: 'user', kind: 'preference',
      title: 'Cancelled preference', body: 'Do not persist.' }, { ...deps, signal: controller.signal }), /Stopped by user/);
    assert.equal((await listPages()).length, before);
  });

  test('a duplicate title is refused and names the existing id', async () => {
    const original = (await listMemories({ project: alpha, scope: 'project' }))[0];
    await assert.rejects(
      save(alpha, { title: 'alpha uses PNPM workspaces!', body: 'again' }),
      error => error instanceof MemoryError && error.code === 'duplicate' && error.message.includes(original.id),
    );
    // The same title in another project is not a duplicate.
    await save(beta, { title: 'Alpha uses pnpm workspaces', body: 'Beta copy.' });
  });

  test('a near-duplicate by embedding is refused', async () => {
    const vectors = new Map();
    const embedDeps = {
      config: { embeddings: { enabled: true, backend: 'local', queryTimeoutMs: 3000 } },
      getEmbedder: async () => ({ id: 'fake', dim: 2 }),
      embedTexts: async () => [[1, 0], ...vectors.values()],
      loadVectorStore: async () => ({ vectors: Object.fromEntries(vectors) }),
      isVectorStoreCompatible: () => true,
      getEntryVector: async () => null,
    };
    const existing = (await listMemories({ project: alpha, scope: 'project' }))[0];
    vectors.set(existing.id, [0.99, 0.05]);
    await assert.rejects(
      createMemory({ project: alpha, kind: 'decision', title: 'Package manager is pnpm', body: 'pnpm only' }, embedDeps),
      new RegExp(existing.id),
    );
    vectors.set(existing.id, [0, 1]);
    const ok = await createMemory({ project: alpha, kind: 'gotcha', title: 'Windows needs long paths', body: 'core.longpaths' }, embedDeps);
    assert.ok(ok.meta.id);
  });

  test('supersedes cannot bypass duplicate detection', async () => {
    const original = await save(alpha, { title: 'Supersedes duplicate guard', body: 'Keep one record.' });
    await assert.rejects(save(alpha, {
      title: original.meta.title, body: 'Rewrite in place instead.', supersedes: [original.meta.id],
    }), error => error.code === 'duplicate' && error.conflictId === original.meta.id);
  });

  test('duplicate titles normalize Unicode without treating distinct titles as empty', async () => {
    await save(beta, { title: '日本語の設定', body: 'A verified preference.' });
    await save(beta, { title: '別の選択', body: 'Another decision.' });
    await assert.rejects(save(beta, { title: '日本語の設定！', body: 'Duplicate.' }), /already exists/);
  });

  test('update is revision-checked; forget keeps a backup and removes the page', async () => {
    const created = await save(alpha, { title: 'Release from main only', body: 'Tags come from main.' });
    await assert.rejects(updateMemory({ project: alpha, id: created.meta.id, body: 'x' }, deps), /expectedRevision is required/);
    await assert.rejects(updateMemory({ project: alpha, id: created.meta.id, expectedRevision: 'nope', body: 'x' }, deps), /changed since you read it/);
    await assert.rejects(updateMemory({ project: beta, id: created.meta.id, expectedRevision: created.revision, body: 'x' }, deps), /No memory with id/);
    const updated = await updateMemory({ project: alpha, id: created.meta.id, expectedRevision: created.revision, body: 'Tags come from main after CI.' }, deps);
    assert.equal(updated.body, 'Tags come from main after CI.');
    assert.notEqual(updated.revision, created.revision);
    await assert.rejects(updateMemory({ project: alpha, id: created.meta.id, expectedRevision: updated.revision, scope: 'user' }, deps), /scope cannot change/);

    const gone = await forgetMemory({ project: alpha, id: created.meta.id });
    assert.equal(gone.id, created.meta.id);
    await assert.rejects(readMemory(created.meta.id, { project: alpha }), /No memory with id/);
    const backup = path.join(homeDir, 'brain', 'pages', ...gone.path.split('/')) + '.bak';
    assert.match(await fs.readFile(backup, 'utf8'), /after CI/);
    await assert.rejects(forgetMemory({ project: beta, id: (await listMemories({ project: alpha, scope: 'project' }))[0].id }), /No memory with id/);
  });

  test('supersedes must reference visible memories', async () => {
    await assert.rejects(save(alpha, { title: 'New rule', body: 'b', supersedes: ['00000000-0000-4000-8000-000000000000'] }), /unknown memory id/);
    const old = await save(alpha, { title: 'Old CI runner', body: 'GitHub hosted.' });
    const next = await save(alpha, { title: 'CI runner', body: 'Self hosted now.', supersedes: [old.meta.id] });
    assert.deepEqual(next.meta.supersedes, [old.meta.id]);
  });

  test('the user cap refuses the next save without evicting', async () => {
    const existing = (await listMemories({ project: alpha, scope: 'user' })).length;
    for (let i = existing; i < MEMORY_LIMITS.userCap; i += 1) {
      await save(alpha, { title: `Preference number ${i}`, body: `pref ${i}`, kind: 'preference', scope: 'user' });
    }
    await assert.rejects(save(alpha, { title: 'One too many', body: 'b', kind: 'preference', scope: 'user' }), /full \(40\/40\)/);
    assert.equal((await listMemories({ project: alpha, scope: 'user' })).length, MEMORY_LIMITS.userCap);
  });

  test('moving a repository rebinds its memories to the new key', async () => {
    const repo = await makeRepo(path.join(scratch, 'moving', 'gamma'));
    const before = await resolveMemoryProject(repo);
    const saved = await save(before, { title: 'Gamma ships weekly', body: 'Fridays.' });
    const destination = path.join(scratch, 'moved', 'gamma');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(repo, destination);
    clearMemoryProjectCache();
    const after = await resolveMemoryProject(destination);
    assert.notEqual(after.key, before.key);
    assert.equal((await listMemories({ project: after })).filter(row => row.scope === 'project').length, 0);
    assert.equal(await rebindProjectMemories(before.key, after), 1);
    const moved = await readMemory(saved.meta.id, { project: after });
    assert.equal(moved.meta.projectKey, after.key);
    assert.match(moved.path, new RegExp(`^memory/projects/${after.key}/`));
    assert.equal(await resolvePageLookup(saved.meta.id), moved.path);
    assert.equal(await rebindProjectMemories(before.key, after), 0);
  });

  test('project rebind recovers a rename whose frontmatter was not restamped', async () => {
    const project = await resolveMemoryProject(path.join(scratch, 'beta'));
    const saved = await save(project, { title: 'Rebind interrupted rename', body: 'Keep the same id.' });
    const targetProject = await resolveMemoryProject(path.join(scratch, 'plain'));
    const target = saved.path.replace(project.key, targetProject.key);
    const root = path.join(homeDir, 'brain', 'pages');
    await fs.mkdir(path.dirname(path.join(root, target)), { recursive: true });
    await fs.rename(path.join(root, saved.path), path.join(root, target));
    await rebindProjectMemories(project.key, targetProject);
    const recovered = await readMemory(saved.meta.id, { project: targetProject });
    assert.equal(recovered.meta.projectKey, targetProject.key);
    assert.equal(recovered.meta.projectLabel, targetProject.label);
  });
});
