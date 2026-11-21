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
import { addIssue, findIssueById, listIssues, parseIssuesState, setIssuesStateForTests, updateIssue } from '../../src/state/issues-store.ts';
import { setLocalServerAvailableForTests } from '../../src/tools/config.ts';
import { invalidateWorkspaceReposCache } from '../../src/state/workspace-repos.ts';
import {
  CHOOSE_REPO_ERROR,
  forgeScopeKey,
  importScopes,
  githubLinkInScope,
  resolveIssueForgeScope,
  resolveIssueForgeScopes,
} from '../../src/issues/github-repo-scope.ts';
import type { IssueCard } from '../../src/types.ts';
import type { WorkspaceRepo } from '../../src/state/workspace-repos.ts';
import { decodeGithubIssueBody } from '../../src/issues/github-metadata.ts';

const WS = '/w';
const repo = (id: string, slug: string | null): WorkspaceRepo => ({
  id, relPath: id, absPath: `${WS}/${id}`, isRoot: id === '.',
  remote: slug ? { url: '', host: 'github', hostname: 'github.com', slug, owner: slug.split('/')[0], name: slug.split('/')[1] } : null,
});
const REPOS = [repo('backend', 'acme/api'), repo('frontend', 'acme/web')];
const ROOT_REPO = repo('.', 'acme/workspace');

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

  test('a folder with a single child repo still scopes calls to the child', () => {
    const child = [repo('apps/api/backend', 'acme/api')];
    const expected = { cwd: WS, repo: 'apps/api/backend', slug: 'acme/api' };
    assert.deepEqual(resolveIssueForgeScope(card({}), child), expected);
    assert.deepEqual(importScopes(WS, child), [expected]);
  });

  test('linked issues follow their stored repo; unlinked ones their single target', () => {
    const linked = card({ github: { number: 4, url: '', repo: 'acme/web', syncedAt: 1 } });
    assert.deepEqual(resolveIssueForgeScope(linked, REPOS), { cwd: WS, repo: 'frontend', slug: 'acme/web' });
    assert.deepEqual(resolveIssueForgeScope(card({ repos: ['backend'] }), REPOS), { cwd: WS, repo: 'backend', slug: 'acme/api' });
    assert.throws(() => resolveIssueForgeScope(card({}), REPOS), { message: CHOOSE_REPO_ERROR });
    assert.deepEqual(resolveIssueForgeScopes(card({ repos: ['backend', 'frontend'] }), REPOS).map((scope) => scope.repo),
      ['backend', 'frontend']);
    assert.throws(() => resolveIssueForgeScope(card({ github: { number: 1, url: '', repo: 'acme/gone', syncedAt: 1 } }), REPOS), /not in this workspace/);
  });

  test('the workspace repo is the default, not another target for assigned or linked issues', () => {
    const repos = [...REPOS, ROOT_REPO];
    assert.deepEqual(resolveIssueForgeScopes(card({}), repos), [{ cwd: WS, repo: '.', slug: 'acme/workspace' }]);
    assert.deepEqual(resolveIssueForgeScopes(card({ repos: ['backend'] }), repos).map((scope) => scope.repo), ['backend']);
    assert.deepEqual(resolveIssueForgeScopes(card({
      github: { number: 4, url: '', repo: 'acme/web', syncedAt: 1 },
    }), repos).map((scope) => scope.repo), ['frontend']);
    assert.throws(() => resolveIssueForgeScopes(card({
      github: { number: 4, url: '', syncedAt: 1 },
    }), repos), { message: CHOOSE_REPO_ERROR });
  });

  test('imports list every repo with a remote, and scope matching respects the slug', () => {
    assert.deepEqual(importScopes(WS, [...REPOS, repo('docs', null)]).map((s) => s.repo), ['backend', 'frontend']);
    assert.notEqual(forgeScopeKey({ cwd: WS, repo: 'backend' }), forgeScopeKey({ cwd: WS, repo: 'frontend' }));
    const linked = card({ github: { number: 1, url: '', repo: 'acme/api', syncedAt: 1 },
      githubReplicas: [{ number: 2, url: '', repo: 'acme/web', syncedAt: 1 }] });
    assert.equal(githubLinkInScope(linked, { cwd: WS, slug: 'acme/web' })?.number, 2);
    assert.equal(githubLinkInScope(linked, { cwd: WS, repo: 'docs' }), undefined);
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

  test('stopping during a create keeps its identity but never publishes to the next repo', async () => {
    const controller = new AbortController();
    const fetchDefault = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const result = await fetchDefault(input, init);
      if (JSON.parse(String(init?.body ?? '{}')).op === 'issueCreate') controller.abort();
      return result;
    };
    setIssuesStateForTests({ version: 2, nextId: 2, issues: [card({ repos: ['backend', 'frontend'] })], workspaces: {} });
    await syncIssueWithGithub('ISS-1', undefined, controller.signal);
    assert.deepEqual(calls.filter((c) => c.op === 'issueCreate').map((c) => c.repo), ['backend']);
    assert.equal(findIssueById('ISS-1')?.github?.number, 7);
  });

  test('stopping bulk sync during a page read does not import the page or start another request', async () => {
    const controller = new AbortController();
    const fetchDefault = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const result = await fetchDefault(input, init);
      if (JSON.parse(String(init?.body ?? '{}')).op === 'issueList') controller.abort();
      return result;
    };
    setIssuesStateForTests({ version: 2, nextId: 2, issues: [card({ repos: ['backend'] })], workspaces: {} });
    const result = await syncAllIssuesWithGithub({ workspacePath: WS, signal: controller.signal });
    assert.equal(result.imported, 0);
    assert.deepEqual(calls.map((c) => c.op), ['issueList']);
  });

  test('a new issue publishes only to the workspace repo without an explicit assignment', async () => {
    const fetchDefault = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (String(input).startsWith('/api/workspace/repos')) return json({ ok: true, repos: [...REPOS, ROOT_REPO] });
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.op !== 'issueCreate' || body.repo !== '.') return fetchDefault(input, init);
      calls.push(body);
      return json({ ok: true, number: 7, url: 'https://github.com/acme/workspace/issues/7' });
    };
    setIssuesStateForTests({ version: 2, nextId: 1, issues: [], workspaces: {} });
    const issue = addIssue({ title: 'New issue', workspacePath: WS });
    const outcome = await syncIssueWithGithub(issue.id);
    assert.equal(outcome.ok, true, outcome.error);
    assert.deepEqual(calls.filter((c) => c.op === 'issueCreate').map((c) => [c.cwd, c.repo]), [[WS, '.']]);
    assert.equal(findIssueById(issue.id)?.github?.repo, 'acme/workspace');
  });

  test('an untargeted issue in a folder of sibling repos is not published and says why', async () => {
    setIssuesStateForTests({ version: 2, nextId: 2, issues: [card({})], workspaces: {} });
    const outcome = await syncIssueWithGithub('ISS-1');
    assert.equal(outcome.ok, false);
    assert.match(outcome.error ?? '', /Choose a repo/);
    assert.equal(calls.some((c) => c.op === 'issueCreate'), false);
  });

  test('one card publishes to both repos, retries only missing copies, and mirrors edits from either repo', async () => {
    const fetchDefault = globalThis.fetch;
    const remotes = new Map<string, { number: number; url: string; title: string; body: string; state: string; labels: string[]; updatedAt: number }>();
    let failFrontend = true;
    let failBackendEdit = false;
    globalThis.fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (!['issueCreate', 'issueView', 'issueEdit', 'issueList'].includes(body.op)) return fetchDefault(input, init);
      calls.push(body);
      const slug = body.repo === 'backend' ? 'acme/api' : 'acme/web';
      if (body.op === 'issueCreate') {
        if (body.repo === 'frontend' && failFrontend) return json({ ok: false, error: 'Cannot publish frontend' });
        assert.equal(remotes.has(body.repo), false, 'must not create a duplicate');
        const issue = { number: 7, url: `https://github.com/${slug}/issues/7`, title: body.title,
          body: body.body, state: 'open', labels: [], updatedAt: 20 };
        remotes.set(body.repo, issue);
        return json({ ok: true, number: issue.number, url: issue.url });
      }
      const remote = remotes.get(body.repo);
      if (body.op === 'issueList') return json({ ok: true, issues: remote ? [remote] : [] });
      assert.equal(body.number, remote?.number);
      if (body.op === 'issueView') return json({ ok: true, issue: remote });
      if (body.repo === 'backend' && failBackendEdit) return json({ ok: false, error: 'Cannot edit backend' });
      Object.assign(remote!, { title: body.title, body: body.body, updatedAt: Date.now() });
      return json({ ok: true });
    };
    setIssuesStateForTests({ version: 2, nextId: 2, issues: [card({ repos: ['backend', 'frontend'] })], workspaces: {} });
    const failed = await syncAllIssuesWithGithub({ workspacePath: WS });
    assert.match(failed.errors.join(), /frontend: Cannot publish frontend/);
    assert.equal(findIssueById('ISS-1')?.github?.repo, 'acme/api');

    failFrontend = false;
    const retried = await syncAllIssuesWithGithub({ workspacePath: WS, linkedOnly: true });
    assert.deepEqual(retried.errors, []);
    assert.equal(retried.synced, 1);
    assert.deepEqual(calls.filter((call) => call.op === 'issueCreate').map((call) => call.repo),
      ['backend', 'frontend', 'frontend']);
    setIssuesStateForTests(parseIssuesState(JSON.parse(JSON.stringify({
      version: 2, nextId: 2, issues: listIssues(), workspaces: {},
    }))));
    assert.equal(findIssueById('ISS-1')?.githubReplicas?.[0].repo, 'acme/web');
    assert.equal((await importGithubIssues({ workspacePath: WS })).imported, 0);
    assert.equal(listIssues().length, 1);

    updateIssue('ISS-1', { title: 'Edited locally' });
    assert.equal((await syncIssueWithGithub('ISS-1')).ok, true);
    assert.deepEqual([...remotes.values()].map((remote) => remote.title), ['Edited locally', 'Edited locally']);

    // Newer GitHub activity on the unchanged primary is not a competing edit.
    Object.assign(remotes.get('frontend')!, { title: 'Edited on frontend', updatedAt: Date.now() + 1000 });
    remotes.get('backend')!.updatedAt = Date.now() + 2000;
    failBackendEdit = true;
    assert.match((await syncIssueWithGithub('ISS-1')).error ?? '', /backend: Cannot edit backend/);
    assert.equal(findIssueById('ISS-1')?.title, 'Edited on frontend');
    failBackendEdit = false;
    assert.equal((await syncIssueWithGithub('ISS-1')).ok, true);
    assert.equal(findIssueById('ISS-1')?.title, 'Edited on frontend');
    assert.equal(remotes.get('backend')?.title, 'Edited on frontend');
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

  test('bulk sync publishes both parent copies before assigning the repo-specific parent numbers', async () => {
    const fetchDefault = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.op === 'issueList') return json({ ok: true, issues: [] });
      if (body.op !== 'issueCreate') return fetchDefault(input, init);
      calls.push(body);
      const number = (body.repo === 'backend' ? 10 : 20) + (body.title === 'Parent' ? 0 : 1);
      const slug = body.repo === 'backend' ? 'acme/api' : 'acme/web';
      return json({ ok: true, number, url: `https://github.com/${slug}/issues/${number}` });
    };
    const repos = ['backend', 'frontend'];
    setIssuesStateForTests({ version: 2, nextId: 3, workspaces: {}, issues: [
      card({ id: 'ISS-2', parentId: 'ISS-1', title: 'Child', repos }),
      card({ title: 'Parent', repos }),
    ] });
    const outcome = await syncAllIssuesWithGithub({ workspacePath: WS });
    assert.deepEqual(outcome.errors, []);
    assert.equal(outcome.synced, 2);
    assert.deepEqual(calls.map((call) => [call.title, call.repo, decodeGithubIssueBody(String(call.body)).metadata?.parent]), [
      ['Parent', 'backend', null], ['Parent', 'frontend', null], ['Child', 'backend', 10], ['Child', 'frontend', 20],
    ]);
  });

  test('import pulls from each repo and tags the cards; #3 in two repos stays two issues', async () => {
    setIssuesStateForTests({ version: 2, nextId: 1, issues: [], workspaces: {} });
    const result = await importGithubIssues({ workspacePath: WS });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.imported, 2);
    const rows = listIssues().map((i) => [i.title, i.repos?.[0], i.github?.repo]).sort();
    assert.deepEqual(rows, [['From backend', 'backend', 'acme/api'], ['From frontend', 'frontend', 'acme/web']]);
  });

  test('an explicit import reads both repos while two-way sync is off', async () => {
    setIssuesGithubMode('off');
    setIssuesStateForTests({ version: 2, nextId: 1, issues: [], workspaces: {} });
    const result = await importGithubIssues({ workspacePath: WS, allPages: true, userInitiated: true });
    assert.equal(result.imported, 2);
    assert.deepEqual(calls.map((call) => [call.op, call.repo]), [
      ['issueList', 'backend'], ['issueList', 'frontend'],
    ]);
  });

  test('import continues after a repo fails and checks every page without duplicating child workspace cards', async () => {
    setIssuesStateForTests({ version: 2, nextId: 2, workspaces: {}, issues: [
      card({ workspacePath: `${WS}/frontend`, github: {
        number: 4, url: 'https://github.com/acme/web/issues/4', syncedAt: 1,
      } }),
    ] });
    const fetchDefault = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.op !== 'issueList') return fetchDefault(input, init);
      calls.push(body);
      if (body.repo === 'backend') return json({ ok: false, error: 'Could not read backend' });
      const issue = (number: number) => ({
        number, title: `Remote ${number}`, url: `https://github.com/acme/web/issues/${number}`,
        body: '', labels: [], state: 'closed',
      });
      return body.cursor === null
        ? json({ ok: true, issues: [issue(4)], nextCursor: 'page-two' })
        : json({ ok: true, issues: [issue(5)] });
    };
    const result = await importGithubIssues({ workspacePath: WS, allPages: true });
    assert.deepEqual(result, { ok: false, imported: 1, skipped: 1, error: 'backend: Could not read backend' });
    assert.deepEqual(calls.map((call) => [call.repo, call.cursor]), [
      ['backend', null], ['frontend', null], ['frontend', 'page-two'],
    ]);
    assert.deepEqual(listIssues().map((issue) => issue.github?.number).sort(), [4, 5]);
  });
});
