import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { brainWorkspaceKeyFromPath } from '../brain/paths.js';
import { resolveMemoryProject } from '../brain/memory/scope.js';
import { checkoutKey, identity } from '../chats/checkout-identity.js';
import { createChatRepository } from '../chats/repository.js';
import { getMinnowHome } from '../config/home.js';
import { getSessionsDb } from '../config/sessions-db.js';
import { useJsonSessionsStore } from '../config/sessions-repo.js';
import { readSessionMeta, writeSessionMeta } from '../config/sessions-schema.js';
import { readConfigJson, readResource, updateConfigJson, updateIssuesResource } from '../config/store.js';
import { normalizeWorkspacePath } from '../config/validators.js';
import { listDevServerStatuses } from '../dev-server/manager.js';
import { listBoards, readBoardIdentity } from '../orchestrator/journal.js';
import { runProcess } from '../process-runner.js';
import { hasJobsForWorkspace } from '../scheduler/store.js';
import { listKnownActiveRuns } from '../terminal-runner.js';
import { listOpenWorkspaces } from './open-workspaces.js';
import { discoverWorkspaceRepos, invalidateWorkspaceRepos } from './repos.js';
import {
  dedupeRecentPaths, getAppRoot, getScratchWorkspacePath, isEligibleRecentWorkspacePath,
  normalizeWorkspacePathKey, readRecentPathsFromMeta, repointDefaultAfterMove,
} from './root.js';

const MOVE_KEY = 'pendingProjectMove';
let moving = null;

function inside(root, value) {
  const rel = path.relative(checkoutKey(root), checkoutKey(value));
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
}

function overlaps(a, b) {
  return inside(a, b) || inside(b, a);
}

function rebasePath({ source, destination }, value) {
  return typeof value === 'string' && path.isAbsolute(value) && inside(source, value)
    ? path.join(destination, path.relative(source, value)) : value;
}

export function projectMoveBlocks(value) {
  if (!moving || !value) return false;
  const blocks = root => overlaps(moving.source, root) || overlaps(moving.destination, root);
  if (blocks(value)) return true;
  try { return blocks(fs.realpathSync.native(value)); } catch { return false; }
}

function lstat(value) {
  try { return fs.lstatSync(value, { bigint: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

function stamp(stat) {
  return stat?.isDirectory() && stat.ino !== 0n && stat.birthtimeNs !== 0n
    ? [stat.dev, stat.ino, stat.birthtimeNs].join(':') : null;
}

function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
    throw new Error('Choose an absolute project and destination folder.');
  }
  return path.resolve(value);
}

function assertClosed(source, destination) {
  if (listOpenWorkspaces().some(({ path: root }) => {
    let real = root;
    try { real = fs.realpathSync.native(root); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return overlaps(real, source) || overlaps(real, destination);
  })) throw new Error('Close the project and any overlapping workspace windows before moving it.');
}

async function assertGitCanMove(source, parent) {
  const repos = await discoverWorkspaceRepos(source, { refresh: true });
  if (lstat(path.join(source, '.git')) && !repos.some(repo => repo.isRoot)) {
    throw new Error('Minnow could not verify the project’s Git repository.');
  }
  for (const repo of repos) {
    const marker = lstat(path.join(repo.absPath, '.git'));
    if (!marker?.isDirectory()) {
      throw new Error('Only standalone Git repositories can be moved, not linked checkouts or folders inside a repository.');
    }
    const gitDir = path.join(repo.absPath, '.git');
    const refs = await fsp.readdir(path.join(gitDir, 'worktrees')).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    if (refs.length) throw new Error('Remove linked Git worktrees or prune stale registrations before moving this project.');
    if (lstat(path.join(gitDir, 'objects', 'info', 'alternates'))) {
      throw new Error('A repository in this project uses an external Git object store.');
    }
    // A custom worktree path or a relocated .git directory is not portable.
    const worktree = await runProcess('git', ['config', '--local', '--get', 'core.worktree'], { cwd: repo.absPath, timeout: 5000 });
    if (worktree.code !== 1) throw new Error('A repository in this project has a custom Git worktree or unreadable Git configuration.');
  }
  if (!repos.some(repo => repo.isRoot)) {
    const result = await runProcess('git', ['rev-parse', '--is-inside-work-tree'], { cwd: parent, timeout: 5000 });
    if (result.code === 0) throw new Error('Choose a destination outside existing Git repositories.');
  }
}

function readRows(db, move, preflight) {
  const belongs = (root, candidate) => candidate && path.isAbsolute(candidate) && inside(root, candidate);
  const chats = db.prepare(`SELECT c.id,c.workspace_path,c.worktree_root,c.board_group_id,
    c.meta_json,s.project_id,s.meta_json AS managed_meta
    FROM chats c LEFT JOIN chat_conversation_state s ON s.chat_id=c.id WHERE c.workspace_path!=''`).all();
  const groups = db.prepare("SELECT id,workspace_path,orchestrate_plan_path,view_mode FROM groups WHERE workspace_path!=''").all();
  if (preflight && [...chats, ...groups].some(row => belongs(move.destination, row.workspace_path))) {
    throw new Error('Minnow already has chats at the destination. Choose another folder.');
  }
  const selected = {
    chats: chats.filter(row => belongs(move.source, row.workspace_path)),
    groups: groups.filter(row => belongs(move.source, row.workspace_path)),
  };
  if (!preflight) return selected;
  if ([...selected.chats, ...selected.groups].some(row => checkoutKey(row.workspace_path) !== checkoutKey(move.source))) {
    throw new Error('This project contains another workspace with saved chats.');
  }
  const busy = db.prepare(`SELECT 1 WHERE
    EXISTS (SELECT 1 FROM chat_executions WHERE chat_id=@id AND status NOT IN ('completed','failed','stopped','cancelled')) OR
    EXISTS (SELECT 1 FROM chat_commands WHERE chat_id=@id AND state IN ('accepted','queued','running','waiting_for_host')) OR
    EXISTS (SELECT 1 FROM chat_requests WHERE chat_id=@id AND state='pending') OR
    EXISTS (SELECT 1 FROM chat_workspace_checkpoints WHERE chat_id=@id AND state IN ('executing','uncertain')) OR
    EXISTS (SELECT 1 FROM chat_loops WHERE chat_id=@id AND paused=0) OR
    EXISTS (SELECT 1 FROM chat_outbox WHERE chat_id=@id AND state IN ('pending','claimed')) OR
    EXISTS (SELECT 1 FROM chat_task_subscriptions WHERE recipient_chat_id=@id AND state IN ('active','inline_hold','inline_returned'))`);
  for (const row of selected.chats) {
    const meta = JSON.parse(row.managed_meta || row.meta_json);
    if (row.board_group_id || meta.workspacePreparation || (row.worktree_root && checkoutKey(row.worktree_root) !== checkoutKey(move.source))) {
      throw new Error('A saved chat has a board or worktree binding. Project relocation does not support those bindings.');
    }
    if (row.project_id && row.project_id !== identity('project', checkoutKey(move.source)) &&
        checkoutKey(row.project_id) !== checkoutKey(move.source)) {
      throw new Error('A saved chat belongs to a different Git project.');
    }
    if (busy.get({ id: row.id })) throw new Error('Stop chats, resolve pending requests, and pause chat loops before moving the project.');
  }
  if (selected.groups.some(row => row.orchestrate_plan_path || row.view_mode === 'orchestrate')) {
    throw new Error('This project has saved boards. Board relocation is not supported.');
  }
  return selected;
}

function migrateSessions(db, move) {
  const from = checkoutKey(move.source);
  const to = checkoutKey(move.destination);
  const newPath = normalizeWorkspacePath(move.destination);
  const newProjectId = identity('project', to);
  const oldWorkspaceId = identity('workspace', from);
  const newWorkspaceId = identity('workspace', to);
  const repository = createChatRepository({ db });
  db.transaction(() => {
    const rows = readRows(db, move, false);
    for (const row of rows.chats) {
      const profile = repository.getLatestProfile(row.id);
      const policy = profile?.snapshot?.policy;
      if (policy?.workspaceIds?.includes(oldWorkspaceId)) {
        // New admissions use the new profile. Already captured executions and
        // checkout identities remain immutable and cannot be replayed as new authority.
        repository.saveProfile(row.id, {
          ...profile, profileVersion: profile.profileVersion + 1,
          snapshot: { ...profile.snapshot, policy: {
            ...policy, workspaceIds: policy.workspaceIds.map(id => id === oldWorkspaceId ? newWorkspaceId : id),
          } },
        });
      }
      db.prepare('UPDATE chats SET workspace_path=?, worktree_root=? WHERE id=?')
        .run(newPath, row.worktree_root ? newPath : '', row.id);
      db.prepare('UPDATE chat_conversation_state SET project_id=? WHERE chat_id=?').run(newProjectId, row.id);
      db.prepare('UPDATE chat_relations SET project_id=? WHERE chat_id=?').run(newProjectId, row.id);
    }
    for (const { id } of rows.groups) db.prepare('UPDATE groups SET workspace_path=? WHERE id=?').run(newPath, id);
    const lastActive = readSessionMeta(db, 'lastActiveChatIdByWorkspace', {});
    let selectionMoved = false;
    for (const [key, chatId] of Object.entries(lastActive)) {
      if (!path.isAbsolute(key) || checkoutKey(key) !== from) continue;
      delete lastActive[key];
      lastActive[newPath] = chatId;
      selectionMoved = true;
    }
    if (selectionMoved) writeSessionMeta(db, 'lastActiveChatIdByWorkspace', lastActive);
    if (rows.chats.length || rows.groups.length || selectionMoved) {
      writeSessionMeta(db, 'revision', Number(readSessionMeta(db, 'revision', 0)) + 1);
    }
  }).immediate();
}

function configAfterMove(meta, move) {
  const { source, destination, sourceKey } = move;
  const isSource = value => typeof value === 'string' && path.isAbsolute(value) &&
    (checkoutKey(value) === checkoutKey(source) || normalizeWorkspacePathKey(value) === sourceKey);
  const ws = { ...meta?.workspace };
  ws.recentPaths = dedupeRecentPaths(readRecentPathsFromMeta(meta).map(p => isSource(p) ? destination : p));
  if (isSource(ws.path)) ws.path = destination;
  const destinationKey = normalizeWorkspacePathKey(destination);
  const rebase = value => rebasePath(move, value);
  const withCheckout = row => row && typeof row === 'object' && row.worktreeRoot
    ? { ...row, worktreeRoot: rebase(row.worktreeRoot) } : row;
  const moveKey = (map, transform = value => value) => {
    if (!map || !Object.hasOwn(map, sourceKey)) return map;
    if (Object.hasOwn(map, destinationKey)) throw new Error('Minnow already has project settings at the destination.');
    const next = { ...map, [destinationKey]: transform(map[sourceKey]) };
    delete next[sourceKey];
    return next;
  };
  for (const field of ['devServerSettingsByPath', 'filePanelByPath']) {
    if (ws[field]) ws[field] = moveKey(ws[field]);
  }
  if (ws.terminalByPath) ws.terminalByPath = moveKey(ws.terminalByPath, row => Array.isArray(row?.tabs)
    ? { ...row, tabs: row.tabs.map(tab => ({ ...tab, boundCwd: rebase(tab.boundCwd) })) } : row);
  if (ws.devServersByPath) {
    ws.devServersByPath = moveKey(ws.devServersByPath, row => Array.isArray(row?.servers) ? {
      ...row, servers: row.servers.map(server => {
        const moved = withCheckout(server);
        return moved?.cwd ? { ...moved, cwd: rebase(moved.cwd) } : moved;
      }),
    } : row);
  }
  if (ws.devServerByPath) {
    ws.devServerByPath = moveKey(ws.devServerByPath, row => row?.servers && typeof row.servers === 'object' ? {
      ...row, servers: Object.fromEntries(Object.entries(row.servers).map(([id, server]) => [id, withCheckout(server)])),
    } : withCheckout(row));
  }
  const next = { ...meta, workspace: ws };
  if (isSource(meta?.desktopWorkspace?.path)) next.desktopWorkspace = { ...meta.desktopWorkspace, path: destination };
  if (meta?.workspaceProfiles) next.workspaceProfiles = moveKey(meta.workspaceProfiles);
  if (meta?.terminal?.workspaceShellProfiles) {
    next.terminal = { ...meta.terminal, workspaceShellProfiles: moveKey(meta.terminal.workspaceShellProfiles) };
  }
  return next;
}

function issuesAfterMove(state, move) {
  let changed = false;
  const issues = state.issues?.map(issue => {
    const workspacePath = rebasePath(move, issue.workspacePath);
    if (workspacePath === issue.workspacePath) return issue;
    changed = true;
    return {
      ...issue, workspacePath: normalizeWorkspacePath(workspacePath),
      ...(issue.agent?.worktreePath ? { agent: { ...issue.agent, worktreePath: rebasePath(move, issue.agent.worktreePath) } } : {}),
    };
  });
  const workspaces = { ...state.workspaces };
  for (const [key, config] of Object.entries(state.workspaces ?? {})) {
    const moved = rebasePath(move, key);
    if (key === moved) continue;
    const target = normalizeWorkspacePath(moved);
    if (Object.hasOwn(workspaces, target)) throw new Error('Minnow already has an issue tracker at the destination.');
    changed = true;
    delete workspaces[key];
    workspaces[target] = config;
  }
  return changed ? { ...state, issues, workspaces } : state;
}

async function reassignBrainPages(move) {
  const { assignBrainPage, listPages, readPage } = await import('../brain/store.js');
  const from = move.brainKey ?? brainWorkspaceKeyFromPath(move.source);
  const to = brainWorkspaceKeyFromPath(move.destination);
  for (const page of await listPages()) {
    if ((page.assignedWorkspace ?? page.path.split('/')[1]) !== from || !page.path.startsWith('workspaces/')) continue;
    const { revision, meta } = await readPage(page.path);
    if ((meta.assignedWorkspace ?? page.path.split('/')[1]) === from) {
      await assignBrainPage(page.path, to, revision);
    }
  }
}

/** Project memory is keyed by the Git common directory, which moves with the folder. */
async function rebindProjectMemory(move) {
  if (!move.memoryKey) return;
  const { clearMemoryProjectCache } = await import('../brain/memory/scope.js');
  const { rebindProjectMemories } = await import('../brain/memory/store.js');
  clearMemoryProjectCache(move.source);
  clearMemoryProjectCache(move.destination);
  const to = await resolveMemoryProject(move.destination);
  if (to) await rebindProjectMemories(move.memoryKey, to);
}

async function finishMove(db, move) {
  if (lstat(move.source) || stamp(lstat(move.destination)) !== move.stamp) {
    throw new Error('Cannot verify the moved folder. Restore the project to the move destination before restarting Minnow.');
  }
  migrateSessions(db, move);
  const issues = await readResource('issues');
  if (issues && issuesAfterMove(issues, move) !== issues) {
    await updateIssuesResource(state => issuesAfterMove(state, move));
  }
  await reassignBrainPages(move);
  await rebindProjectMemory(move);
  await updateConfigJson('config.json', meta => configAfterMove(meta, move));
  repointDefaultAfterMove(move.source, move.destination);
  invalidateWorkspaceRepos(move.source);
  invalidateWorkspaceRepos(move.destination);
  writeSessionMeta(db, MOVE_KEY, null);
}

/** Finish metadata publication after a process exit between the rename and the config write. */
export async function recoverProjectMove() {
  if (useJsonSessionsStore()) return;
  const db = getSessionsDb();
  const move = readSessionMeta(db, MOVE_KEY);
  if (!move) return;
  moving = move;
  if (stamp(lstat(move.source)) !== move.stamp) await finishMove(db, move);
  else writeSessionMeta(db, MOVE_KEY, null);
  moving = null;
}

export async function moveRecentProject(sourcePath, parentPath) {
  if (moving) throw new Error('A project move is already in progress. If it did not finish, restart Minnow to recover it.');
  if (useJsonSessionsStore()) throw new Error('Moving projects requires the SQLite session store.');
  const requested = absolute(sourcePath);
  const source = await fsp.realpath(requested);
  const parent = await fsp.realpath(absolute(parentPath));
  const destination = path.join(parent, path.basename(source));
  const sourceKey = normalizeWorkspacePathKey(source);
  const stat = lstat(source);
  const parentStat = lstat(parent);
  const move = { source, destination, sourceKey, stamp: stamp(stat) };
  if (moving) throw new Error('A project move is already in progress.');
  if (!move.stamp || checkoutKey(requested) !== checkoutKey(source) || !stamp(parentStat)) {
    throw new Error('Choose a regular project folder and destination, not a project shortcut.');
  }
  if ([getAppRoot(), getScratchWorkspacePath(), path.join(getMinnowHome(), 'worktrees')].some(root =>
    overlaps(source, root) || overlaps(destination, root)) ||
    inside(source, getMinnowHome()) || inside(destination, getMinnowHome()) ||
    !isEligibleRecentWorkspacePath(source) || !isEligibleRecentWorkspacePath(destination)) {
    throw new Error('This project or destination is reserved.');
  }
  if (inside(source, parent)) throw new Error('Choose a destination outside this project.');
  if (lstat(destination)) throw new Error('A file or folder with this project name already exists there.');
  if (stat.dev !== parentStat.dev) throw new Error('Choose a destination on the same drive. Minnow does not copy and delete project folders.');

  const db = getSessionsDb();
  moving = move;
  let renamed = false;
  let reserved = false;
  try {
    assertClosed(source, destination);
    const meta = await readConfigJson('config.json');
    const recent = readRecentPathsFromMeta(meta);
    if (!recent.some(p => checkoutKey(p) === checkoutKey(source))) throw new Error('Only recent projects can be moved.');
    if (recent.some(p => checkoutKey(p) === checkoutKey(destination) ||
        (checkoutKey(p) !== checkoutKey(source) && overlaps(p, source)))) {
      throw new Error('The project overlaps another recent workspace or the destination is already registered.');
    }
    configAfterMove(meta, move); // Check settings collisions before touching the filesystem.
    const issues = await readResource('issues');
    if (issues) issuesAfterMove(issues, move);
    if (await hasJobsForWorkspace(root => overlaps(source, root) || overlaps(destination, root))) {
      throw new Error('Reassign automations that use this project before moving it.');
    }
    for (const id of await listBoards()) {
      const board = await readBoardIdentity(id).catch(error => {
        if (error.code === 'ENOENT' || error.message === 'board has no creation event') return null;
        throw error;
      });
      if (board?.workspacePath && overlaps(source, board.workspacePath)) {
        throw new Error('This project has saved boards. Board relocation is not supported.');
      }
    }
    const { servers } = await listDevServerStatuses(source);
    if (servers.some(row => row.runId || ['starting', 'running', 'stopping'].includes(row.status))) {
      throw new Error('Stop this project’s dev servers before moving it.');
    }
    await assertGitCanMove(source, parent);
    if ((await listKnownActiveRuns()).some(run => run.cwd && overlaps(source, run.cwd))) {
      throw new Error('Stop running project commands before moving the project.');
    }
    assertClosed(source, destination);
    if (stamp(lstat(source)) !== move.stamp || stamp(lstat(parent)) !== stamp(parentStat)) {
      throw new Error('The project folder or destination changed during setup. Try again.');
    }
    readRows(db, move, true);
    move.brainKey = brainWorkspaceKeyFromPath(source);
    move.memoryKey = (await resolveMemoryProject(source).catch(() => null))?.key ?? null;
    writeSessionMeta(db, MOVE_KEY, move);
    // Reserve an empty destination on POSIX where rename could otherwise
    // overwrite an empty directory. Never copy or recursively remove folders.
    if (process.platform !== 'win32') {
      fs.mkdirSync(destination);
      reserved = true;
    } else if (lstat(destination)) {
      throw Object.assign(new Error('A file or folder with this project name already exists there.'), { code: 'EEXIST' });
    }
    fs.renameSync(source, destination);
    renamed = true;
    await finishMove(db, move);
    return destination;
  } catch (error) {
    if (renamed) throw new Error('The folder moved, but Minnow could not finish updating the project. Restart Minnow to recover it.', { cause: error });
    if (reserved) {
      try { fs.rmdirSync(destination); } catch { /* Do not remove anything placed there by another process. */ }
    }
    writeSessionMeta(db, MOVE_KEY, null);
    if (error.code === 'EXDEV') throw new Error('Choose a destination on the same drive. The project was not moved.');
    if (error.code === 'EEXIST') throw new Error('A file or folder with this project name already exists there.');
    throw error;
  } finally {
    if (!renamed || !readSessionMeta(db, MOVE_KEY)) moving = null;
  }
}
