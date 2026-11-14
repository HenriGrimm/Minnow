/**
 * GitHub issue sync in a workspace folder that holds several repos.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  importGithubIssues,
  resetIssuesGithubForTests,
  setIssuesGithubMode,
  syncAllIssuesWithGithub,
  syncIssueWithGithub,
} from '../../src/state/issues-github.ts';
import { findIssueById, listIssues, setIssuesStateForTests } from '../../src/state/issues-store.ts';
import { setLocalServerAvailableForTests } from '../../src/tools/config.ts';
import { invalidateWorkspaceReposCache } from '../../src/state/workspace-repos.ts';
import {
  CHOOSE_REPO_ERROR,
  forgeScopeKey,
  importScopes,
  issueInScope,
  resolveIssueForgeScope,
} from '../../src/issues/github-repo-scope.ts';
import type { IssueCard } from '../../src/types.ts';
import type { WorkspaceRepo } from '../../src/state/workspace-repos.ts';

const WS = '/w';
const repo = (id: string, slug: string | null): WorkspaceRepo => ({
  id, relPath: id, absPath: `${WS}/${id}`, isRoot: id === '.',
  remote: slug ? { url: '', host: 'github', hostname: 'github.com', slug, owner: slug.split('/')[0], name: slug.split('/')[1] } : null,
});
const REPOS = [repo('backend', 'acme/api'), repo('frontend', 'acme/web')];

function card(partial: Partial<IssueCard>): IssueCard {
  return {
    id: 'ISS-1', type: 'task', title: 'T', description: '', status: 'todo', priority: 'none',
    labels: [], workspacePath: WS, createdAt: 0, updatedAt: 10, ...partial,
  } as IssueCard;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('issue forge scope', () => {
  test('single-repo workspaces keep the plain workspace target', () => {
    assert.deepEqual(resolveIssueForgeScope(card({}), [repo('.', 'acme/solo')]), { cwd: WS });
    assert.deepEqual(resolveIssueForgeScope(card({}), []), { cwd: WS });
  });

  test('linked issues follow their stored repo; unlinked ones their single target', () => {
    const linked = card({ github: { number: 4, url: '', repo: 'acme/web', syncedAt: 1 } });
    assert.deepEqual(resolveIssueForgeScope(linked, REPOS), { cwd: WS, repo: 'frontend', slug: 'acme/web' });
    assert.deepEqual(resolveIssueForgeScope(card({ repos: ['backend'] }), REPOS), { cwd: WS, repo: 'backend', slug: 'acme/api' });
    assert.throws(() => resolveIssueForgeScope(card({}), REPOS), { message: CHOOSE_REPO_ERROR });
    assert.throws(() => resolveIssueForgeScope(card({ repos: ['backend', 'frontend'] }), REPOS), { message: CHOOSE_REPO_ERROR });
    assert.throws(() => resolveIssueForgeScope(card({ github: { number: 1, url: '', repo: 'acme/gone', syncedAt: 1 } }), REPOS), /not in this workspace/);
  });

  test('imports list every repo with a remote, and scope matching respects the slug', () => {
    assert.deepEqual(importScopes(WS, [...REPOS, repo('docs', null)]).map((s) => s.repo), ['backend', 'frontend']);
    assert.notEqual(forgeScopeKey({ cwd: WS, repo: 'backend' }), forgeScopeKey({ cwd: WS, repo: 'frontend' }));
    assert.equal(issueInScope(card({ github: { number: 1, url: '', repo: 'acme/api', syncedAt: 1 } }), { cwd: WS, slug: 'acme/web' }), false);
    assert.equal(issueInScope(card({ github: { number: 1, url: '', syncedAt: 1 } }), { cwd: WS, slug: 'acme/web' }), true);
  });
});

describe('multi-repo GitHub sync', () => {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const calls: Record<string, unknown>[] = [];

  beforeEach(() => {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    calls.length = 0;
    invalidateWorkspaceReposCache();
    resetIssuesGithubForTests();
    setIssuesGithubMode('mirror');
    setLocalServerAvailableForTests(true);
    globalThis.fetch = async (input, init) => {
      if (String(input).startsWith('/api/workspace/repos')) return json({ ok: true, repos: REPOS });
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      calls.push(body);
      if (body.op === 'issueCreate') return json({ ok: true, number: 7, url: 'https://github.com/acme/api/issues/7' });
      if (body.op === 'issueBatch') return json({ ok: true, issues: [] });
      if (body.op === 'issueList') {
        const slug = body.repo === 'backend' ? 'acme/api' : 'acme/web';
        return json({ ok: true, issues: [{ number: 3, title: `From ${body.repo}`, body: '', state: 'open', url: `https://github.com/${slug}/issues/3`, labels: [], updatedAt: 5 }] });
      }
      return json({ ok: false, error: `unexpected ${String(body.op)}` }, 400);
    };
  });

  afterEach(() => {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    resetIssuesGithubForTests();
    setIssuesStateForTests({ version: 2, nextId: 1, issues: [], workspaces: {} });
    setLocalServerAvailableForTests(false);
    invalidateWorkspaceReposCache();
  });

  test('an issue targeted at backend is created on the backend repo and linked to it', async () => {
    setIssuesStateForTests({ version: 2, nextId: 2, issues: [card({ repos: ['backend'] })], workspaces: {} });
    const outcome = await syncIssueWithGithub('ISS-1');
    assert.equal(outcome.ok, true, outcome.error);
    const create = calls.find((c) => c.op === 'issueCreate');
    assert.equal(create?.repo, 'backend');
    assert.equal(create?.cwd, WS);
    const issue = findIssueById('ISS-1')!;
    assert.equal(issue.github?.repo, 'acme/api');
    assert.equal(issue.gitLinks?.find((l) => l.kind === 'github-issue')?.repo, 'backend');
  });

  test('an untargeted issue is not published and says why', async () => {
    setIssuesStateForTests({ version: 2, nextId: 2, issues: [card({})], workspaces: {} });
    const outcome = await syncIssueWithGithub('ISS-1');
    assert.equal(outcome.ok, false);
    assert.match(outcome.error ?? '', /Choose a repo/);
    assert.equal(calls.some((c) => c.op === 'issueCreate'), false);
  });

  test('batch reads go once per repo', async () => {
    setIssuesStateForTests({ version: 2, nextId: 3, workspaces: {}, issues: [
      card({ id: 'ISS-1', github: { number: 1, url: '', repo: 'acme/api', syncedAt: 1 } }),
      card({ id: 'ISS-2', github: { number: 2, url: '', repo: 'acme/web', syncedAt: 1 } }),
    ] });
    await syncAllIssuesWithGithub({ linkedOnly: true, workspacePath: WS });
    const batches = calls.filter((c) => c.op === 'issueBatch');
    assert.deepEqual(batches.map((b) => b.repo).sort(), ['backend', 'frontend']);
  });

  test('import pulls from each repo and tags the cards; #3 in two repos stays two issues', async () => {
    setIssuesStateForTests({ version: 2, nextId: 1, issues: [], workspaces: {} });
    const result = await importGithubIssues({ workspacePath: WS });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.imported, 2);
    const rows = listIssues().map((i) => [i.title, i.repos?.[0], i.github?.repo]).sort();
    assert.deepEqual(rows, [['From backend', 'backend', 'acme/api'], ['From frontend', 'frontend', 'acme/web']]);
  });
});
