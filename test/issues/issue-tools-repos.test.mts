/**
 * Repo targeting through the issue tools, the MCP issue hub, and link display.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { findIssueById, setIssuesStateForTests } from '../../src/state/issues-store.ts';
import { executeIssueTool } from '../../src/tools/issue-tools.ts';
import { executeIssueV2Tool } from '../../src/tools/issue-tools-v2.ts';
import { invalidateWorkspaceReposCache } from '../../src/state/workspace-repos.ts';
import { formatIssueForClipboard } from '../../src/issues/clipboard.ts';
import { toggleIssueRepo } from '../../src/issues/repo-scope.ts';
import type { IssueCard } from '../../src/types.ts';

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const REPOS = ['backend', 'frontend'].map((id) => ({ id, relPath: id, absPath: `/w/${id}`, isRoot: false, remote: null }));

describe('issue tools with repos', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    invalidateWorkspaceReposCache();
    setIssuesStateForTests({ version: 2, nextId: 1, issues: [], workspaces: {} });
    globalThis.fetch = async (input) => String(input).startsWith('/api/workspace/repos')
      ? json({ ok: true, repos: REPOS })
      : json({ ok: false });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    invalidateWorkspaceReposCache();
  });

  test('issue_add stores repos and rejects unknown ones', async () => {
    const created = JSON.parse(await executeIssueTool('issue_add', { title: 'Endpoint + UI', repos: ['frontend', 'backend', 'frontend'] }));
    assert.deepEqual(findIssueById(created.id)?.repos, ['frontend', 'backend']);
    const bad = await executeIssueTool('issue_add', { title: 'x', repos: ['nope'] });
    assert.match(bad, /^Error: unknown repo "nope"; this workspace has: backend, frontend/);
  });

  test('issue_update sets and clears repos', async () => {
    const created = JSON.parse(await executeIssueTool('issue_add', { title: 'T' }));
    await executeIssueTool('issue_update', { issue_id: created.id, repos: ['backend'] });
    assert.deepEqual(findIssueById(created.id)?.repos, ['backend']);
    await executeIssueTool('issue_update', { issue_id: created.id, repos: [] });
    assert.equal(findIssueById(created.id)?.repos, undefined);
  });

  test('issue_search repo filter keeps untargeted issues', async () => {
    await executeIssueTool('issue_add', { title: 'back only', repos: ['backend'] });
    await executeIssueTool('issue_add', { title: 'front only', repos: ['frontend'] });
    await executeIssueTool('issue_add', { title: 'anywhere' });
    const out = JSON.parse(await executeIssueV2Tool('issue_search', { repo: 'frontend', fields: ['title', 'repos'] }));
    assert.deepEqual(out.issues.map((i: { title: string }) => i.title).sort(), ['anywhere', 'front only']);
  });

  test('issue_link keeps the repo on a git link', async () => {
    const created = JSON.parse(await executeIssueTool('issue_add', { title: 'T' }));
    await executeIssueTool('issue_link', { issue_id: created.id, git_links: [
      { kind: 'pr', ref: '#12', repo: 'backend' }, { kind: 'pr', ref: '#12', repo: 'frontend' },
    ] });
    assert.deepEqual(findIssueById(created.id)?.gitLinks?.map((l) => l.repo), ['backend', 'frontend']);
  });
});

describe('repo display helpers', () => {
  test('toggle keeps workspace order', () => {
    assert.deepEqual(toggleIssueRepo(['frontend'], 'backend', ['backend', 'frontend']), ['backend', 'frontend']);
    assert.deepEqual(toggleIssueRepo(['backend', 'frontend'], 'backend', ['backend', 'frontend']), ['frontend']);
  });

  test('clipboard shows repo-qualified links', () => {
    const issue = { id: 'ISS-1', type: 'task', title: 'T', description: '', status: 'todo', priority: 'none', labels: [],
      workspacePath: '/w', createdAt: 0, updatedAt: 0,
      gitLinks: [{ kind: 'pr', ref: '#12', repo: 'backend', addedAt: 0 }] } as IssueCard;
    assert.match(formatIssueForClipboard(issue), /pr backend#12/);
  });
});

describe('MCP issue hub with repos', () => {
  let home: string;
  let workspace: string;
  let hub: typeof import('../../server/mcp-hub/issues.js');

  before(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mn-hub-repos-')));
    process.env.MINNOW_HOME = home;
    const { resetMinnowHomeCache } = await import('../../server/config/home.js');
    resetMinnowHomeCache();
    workspace = path.join(home, 'ws');
    for (const id of ['backend', 'frontend']) {
      await fs.mkdir(path.join(workspace, id), { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: path.join(workspace, id) });
    }
    hub = await import('../../server/mcp-hub/issues.js');
  });

  after(async () => {
    delete process.env.MINNOW_HOME;
    const { resetMinnowHomeCache } = await import('../../server/config/home.js');
    resetMinnowHomeCache();
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  });

  test('create validates repos and list filters by repo', async () => {
    const created = await hub.callIssueHubTool('issue_create', { title: 'API change', repos: ['backend'] }, workspace) as { id: string; repos?: string[] };
    assert.deepEqual(created.repos, ['backend']);
    await assert.rejects(hub.callIssueHubTool('issue_create', { title: 'x', repos: ['nope'] }, workspace), /Unknown repo nope; this workspace has: backend, frontend/);
    await hub.callIssueHubTool('issue_create', { title: 'UI change', repos: ['frontend'] }, workspace);
    const listed = await hub.callIssueHubTool('issue_list', { repo: 'backend' }, workspace) as { issues: Array<{ title: string; repos?: string[] }> };
    assert.deepEqual(listed.issues.map((i) => i.title), ['API change']);
    assert.deepEqual(listed.issues[0].repos, ['backend']);
  });
});
