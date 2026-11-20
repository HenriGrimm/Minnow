import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { brainWorkspaceKeyFromPath } from '../../server/brain/paths.js';
import { createPage, readPage } from '../../server/brain/store.js';
import { resolveMemoryProject } from '../../server/brain/memory/scope.js';
import { createMemory, readMemory } from '../../server/brain/memory/store.js';
import { checkoutKey, identity } from '../../server/chats/checkout-identity.js';
import { loadChatProjectRegistry } from '../../server/chats/context.js';
import { createChatRepository } from '../../server/chats/repository.js';
import { ensureMinnowLayout } from '../../server/config/home.js';
import { closeSessionsDb, getSessionsDb, readSessionMeta, writeSessionMeta } from '../../server/config/sessions-db.js';
import { readConfigJson, readResource, updateConfigJson, updateIssuesResource } from '../../server/config/store.js';
import { normalizeWorkspacePath } from '../../server/config/validators.js';
import { runProcess } from '../../server/process-runner.js';
import { handleWorkspaceRequest } from '../../server/workspace/middleware.js';
import { closeWorkspace, openWorkspace } from '../../server/workspace/open-workspaces.js';
import { moveRecentProject, recoverProjectMove } from '../../server/workspace/project-move.js';
import { getDefaultWorkspaceRoot, normalizeWorkspacePathKey, setDefaultWorkspaceRoot, touchRecentWorkspacePath } from '../../server/workspace/root.js';
import { httpRequest, rmTestHome, setTestHome } from '../config/test-helpers.js';

let home, projects, db;
before(async () => {
  home = setTestHome(process.env, 'minnow-project-move');
  await ensureMinnowLayout();
  home = await fs.realpath(home);
  projects = path.join(home, 'Projects');
  await fs.mkdir(projects);
  db = getSessionsDb();
});
after(async () => {
  closeSessionsDb();
  await rmTestHome(home);
});

async function project(name) {
  const root = path.join(home, name);
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, '.local-test'), 'local work\n');
  await touchRecentWorkspacePath(root);
  return root;
}

async function git(cwd, ...args) {
  const result = await runProcess('git', args, { cwd, timeout: 10000 });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

test('host move preserves a Git folder, local files, managed chats, groups and recent/default registration', async t => {
  const source = await project('move-this');
  const destination = path.join(projects, path.basename(source));
  await git(source, 'init');
  await git(source, 'add', '.local-test');
  await git(source, '-c', 'user.email=move@example.test', '-c', 'user.name=Move Test', 'commit', '-m', 'initial');
  const head = await git(source, 'rev-parse', 'HEAD');
  await fs.writeFile(path.join(source, '.gitignore'), '.env\n');
  await fs.writeFile(path.join(source, '.env'), 'ignored test fixture');
  await setDefaultWorkspaceRoot(source);
  const oldKey = normalizeWorkspacePathKey(source);
  const oldPath = normalizeWorkspacePath(source);
  const brainPath = `workspaces/${brainWorkspaceKeyFromPath(source)}/notes.md`;
  await createPage({ relPath: brainPath, body: 'Keep these notes.', skipVectorSync: true });
  await updateConfigJson('config.json', meta => ({ ...meta, brain: { ...meta.brain, embeddings: { enabled: false } } }));
  const memory = await createMemory({ project: await resolveMemoryProject(source),
    title: 'Move preserves release cadence', body: 'Release on Fridays.', kind: 'decision' });
  await updateIssuesResource(state => ({
    ...state,
    issues: [...state.issues, { id: 'MOV-8', title: 'Keep this issue', workspacePath: oldPath }],
    workspaces: { ...state.workspaces, [oldPath]: { projectKey: 'MOV', nextId: 9 } },
  }));
  const oldProject = identity('project', checkoutKey(source));
  const oldWorkspace = identity('workspace', checkoutKey(source));
  const repository = createChatRepository({ db });
  db.prepare('INSERT INTO groups(id, name, workspace_path) VALUES (?,?,?)').run('group', 'Folder', oldPath);
  db.prepare('INSERT INTO chats(id, name, workspace_path, group_id) VALUES (?,?,?,?)').run('chat', 'Keep history', oldPath, 'group');
  writeSessionMeta(db, 'lastActiveChatIdByWorkspace', { [oldPath]: 'chat' });
  db.prepare('INSERT INTO messages(chat_id,seq,payload_json) VALUES (?,?,?)').run('chat', 1, '{"role":"user","content":"Keep this"}');
  repository.ensureManagedChat('chat', {
    projectId: oldProject,
    profile: { profileId: 'move-profile', profileVersion: 1, snapshot: { policy: { workspaceIds: [oldWorkspace], permissionLevel: 'manual' } } },
  });
  await updateConfigJson('config.json', meta => ({
    ...meta, workspace: { ...meta.workspace, devServerSettingsByPath: { [oldKey]: { port: 16500 } } },
  }));
  const server = http.createServer((req, res) => {
    // Simulate the authentication middleware's principal.
    if (req.url.includes('host=1')) req.minnowAuth = { kind: 'host' };
    const url = new URL(req.url, 'http://127.0.0.1');
    void handleWorkspaceRequest(req, res, url.pathname, url.searchParams);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const body = { path: source, parentPath: projects };
  assert.equal((await httpRequest(url, 'POST', '/api/workspace/move', body)).status, 403);
  const result = await httpRequest(url, 'POST', '/api/workspace/move?host=1', body);
  assert.equal(result.status, 200, result.text);
  assert.equal(result.json.path, destination);
  await assert.rejects(fs.stat(source), { code: 'ENOENT' });
  assert.equal(await git(destination, 'rev-parse', 'HEAD'), head);
  assert.equal(await fs.readFile(path.join(destination, '.env'), 'utf8'), 'ignored test fixture');
  const info = await httpRequest(url, 'GET', '/api/workspace');
  assert.ok(info.json.recent.some(row => row.path === destination && row.exists));
  assert.ok(!info.json.recent.some(row => row.path === source));
  assert.equal(getDefaultWorkspaceRoot(), destination);
  const config = await readConfigJson('config.json');
  assert.equal(config.workspace.path, destination);
  assert.deepEqual(config.workspace.devServerSettingsByPath, { [normalizeWorkspacePathKey(destination)]: { port: 16500 } });
  const issueState = await readResource('issues');
  assert.equal(issueState.issues.find(issue => issue.id === 'MOV-8').workspacePath, normalizeWorkspacePath(destination));
  assert.equal(issueState.workspaces[normalizeWorkspacePath(destination)].projectKey, 'MOV');
  assert.equal(issueState.workspaces[oldPath], undefined);
  const page = await readPage(brainPath);
  assert.equal(page.meta.assignedWorkspace, brainWorkspaceKeyFromPath(destination));
  assert.equal(page.body.trim(), 'Keep these notes.');
  const movedMemory = await readMemory(memory.meta.id, { project: await resolveMemoryProject(destination) });
  assert.equal(movedMemory.body, memory.body);
  assert.notEqual(movedMemory.meta.projectKey, memory.meta.projectKey);
  const { projectId, scope } = await loadChatProjectRegistry(destination);
  assert.equal(repository.getChatProjectId('chat'), projectId);
  assert.deepEqual(repository.getLatestProfile('chat').snapshot.policy, { workspaceIds: [scope.workspaceId], permissionLevel: 'manual' });
  assert.deepEqual(repository.getProfile('move-profile', 1).snapshot.policy.workspaceIds, [oldWorkspace]);
  assert.equal(repository.getChat('chat').workspacePath, normalizeWorkspacePath(destination));
  assert.deepEqual(readSessionMeta(db, 'lastActiveChatIdByWorkspace'), { [normalizeWorkspacePath(destination)]: 'chat' });
  assert.equal(db.prepare('SELECT workspace_path FROM groups WHERE id=?').get('group').workspace_path, normalizeWorkspacePath(destination));
  assert.equal(db.prepare('SELECT payload_json FROM messages WHERE chat_id=?').get('chat').payload_json, '{"role":"user","content":"Keep this"}');
});

test('rejects collisions, nested destinations, open projects and unregistered sources without changing files', async () => {
  const source = await project('reject-this');
  const destination = path.join(projects, path.basename(source));
  await fs.mkdir(destination);
  await fs.writeFile(path.join(destination, 'existing'), 'do not overwrite');
  await assert.rejects(moveRecentProject(source, projects), /already exists/);
  assert.equal(await fs.readFile(path.join(destination, 'existing'), 'utf8'), 'do not overwrite');
  await fs.mkdir(path.join(source, 'child'));
  await assert.rejects(moveRecentProject(source, path.join(source, 'child')), /outside this project/);
  const other = path.join(home, 'target');
  await fs.mkdir(other);
  openWorkspace(source);
  try {
    await assert.rejects(moveRecentProject(source, other), /Close the project/);
  } finally {
    closeWorkspace(source);
  }
  const unregistered = path.join(home, 'unregistered');
  await fs.mkdir(unregistered);
  await assert.rejects(moveRecentProject(unregistered, other), /Only recent projects/);
  assert.equal(await fs.readFile(path.join(source, '.local-test'), 'utf8'), 'local work\n');
  assert.equal(readSessionMeta(db, 'pendingProjectMove'), null);
});

test('refuses to move a project with linked Git worktrees', async () => {
  const source = await project('with-worktree');
  await git(source, 'init');
  await git(source, 'add', '.local-test');
  await git(source, '-c', 'user.email=move@example.test', '-c', 'user.name=Move Test', 'commit', '-m', 'initial');
  const worktree = path.join(home, 'linked');
  await git(source, 'worktree', 'add', '--detach', worktree);
  await assert.rejects(moveRecentProject(source, projects), /linked Git worktrees/);
  assert.equal(await git(worktree, 'rev-parse', 'HEAD'), await git(source, 'rev-parse', 'HEAD'));
});

test('refuses to move a project with unfinished conversation work', async () => {
  const source = await project('chat-is-running');
  const id = 'in-progress-chat';
  db.prepare('INSERT INTO chats(id,workspace_path) VALUES (?,?)').run(id, normalizeWorkspacePath(source));
  db.prepare("INSERT INTO chat_executions(execution_id,chat_id,status,created_at,updated_at) VALUES (?,?,'running',0,0)")
    .run('in-progress-run', id);
  await assert.rejects(moveRecentProject(source, projects), /Stop chats/);
  assert.equal(await fs.readFile(path.join(source, '.local-test'), 'utf8'), 'local work\n');
  assert.equal(readSessionMeta(db, 'pendingProjectMove'), null);
});

test('restart completes a recorded rename, without repeating the rename or losing chats', async () => {
  const source = await project('resume-this');
  const destination = path.join(projects, path.basename(source));
  const stat = await fs.stat(source, { bigint: true });
  writeSessionMeta(db, 'pendingProjectMove', {
    source, destination, sourceKey: normalizeWorkspacePathKey(source), stamp: [stat.dev, stat.ino, stat.birthtimeNs].join(':'),
  });
  db.prepare('INSERT INTO chats(id,workspace_path) VALUES (?,?)').run('recovery-chat', normalizeWorkspacePath(source));
  await fs.rename(source, destination);
  await recoverProjectMove();
  await recoverProjectMove();
  assert.equal(readSessionMeta(db, 'pendingProjectMove'), null);
  assert.equal((await readConfigJson('config.json')).workspace.recentPaths[0], destination);
  assert.equal(createChatRepository({ db }).getChat('recovery-chat').workspacePath, normalizeWorkspacePath(destination));
});
