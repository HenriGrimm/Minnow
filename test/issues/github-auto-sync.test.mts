/**
 * Auto GitHub sync: persist, field gating, debounce, no unlinked backfill, conflicts.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  githubAutoConflictShouldUsePeek,
  githubAutoConflictToast,
} from '../../src/issues/github-auto-conflict.ts';
import {
  getIssuesGithubAuto,
  githubAutoSyncActive,
  resetIssuesGithubForTests,
  setIssuesGithubAuto,
  setIssuesGithubMode,
  syncAllIssuesWithGithub,
  syncIssueWithGithub,
} from '../../src/state/issues-github.ts';
import {
  resetGithubAutoSyncForTests,
  runGithubAutoSyncLinkedPass,
  setGithubAutoSyncTimingForTests,
  startGithubAutoSyncLoop,
} from '../../src/state/issues-github-auto.ts';
import { addIssue, addIssueComment, findIssueById, listIssues, setIssuesStateForTests, updateIssue } from '../../src/state/issues-store.ts';
import { setLocalServerAvailableForTests } from '../../src/tools/config.ts';
import { resetWorkspaceStateForTests, setWorkspaceFromServer } from '../../src/state/workspace.ts';
import { issueNeedsGithubPush } from '../../src/issues/github-sync-plan.ts';
import type { IssueCard, IssueGithubLink } from '../../src/types.ts';

const MODE_KEY = 'minnow.issues.github.mode';
const AUTO_KEY = 'minnow.issues.github.auto';
const SYNCED_AT = 1_000;

const memory = new Map<string, string>();
const storage: Storage = {
  getItem(key: string) {
    return memory.has(key) ? memory.get(key)! : null;
  },
  setItem(key: string, value: string) {
    memory.set(key, String(value));
  },
  removeItem(key: string) {
    memory.delete(key);
  },
  clear() {
    memory.clear();
  },
  key() {
    return null;
  },
  get length() {
    return memory.size;
  },
};

const originalFetch = globalThis.fetch;
const ops: string[] = [];

function gitJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function githubLink(partial: Partial<IssueGithubLink> = {}): IssueGithubLink {
  return {
    number: 5,
    url: 'https://github.com/acme/app/issues/5',
    syncedAt: SYNCED_AT,
    localUpdatedAt: SYNCED_AT,
    remoteUpdatedAt: SYNCED_AT,
    ...partial,
  };
}

function card(partial: Partial<IssueCard> = {}): IssueCard {
  return {
    id: 'MIN-1',
    type: 'task',
    title: 'Local title',
    description: 'Local body',
    status: 'todo',
    priority: 'none',
    labels: ['bug'],
    workspacePath: '/w',
    createdAt: 0,
    updatedAt: SYNCED_AT,
    ...partial,
  } as IssueCard;
}

function mockForge(): void {
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { op?: string };
    const op = typeof body.op === 'string' ? body.op : '';
    ops.push(op);
    if (op === 'issueCreate') {
      return gitJsonResponse({
        ok: true,
        number: 42,
        url: 'https://github.com/acme/app/issues/42',
      });
    }
    if (op === 'issueView') {
      return gitJsonResponse({
        ok: true,
        issue: {
          number: 5,
          title: 'Local title',
          body: 'Local body',
          state: 'open',
          url: 'https://github.com/acme/app/issues/5',
          labels: ['bug'],
          updatedAt: SYNCED_AT,
        },
      });
    }
    if (op === 'issueEdit' || op === 'issueState') {
      return gitJsonResponse({ ok: true });
    }
    return gitJsonResponse({ ok: false, error: `unexpected ${op}` }, 400);
  };
}

describe('GitHub auto-sync', () => {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

  beforeEach(() => {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    memory.clear();
    ops.length = 0;
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
    resetIssuesGithubForTests();
    resetGithubAutoSyncForTests();
    setGithubAutoSyncTimingForTests({ debounceMs: 20, errorCooldownMs: 60_000 });
    setIssuesStateForTests({ version: 2, nextId: 2, issues: [], workspaces: {} });
    setLocalServerAvailableForTests(true);
    setWorkspaceFromServer({ path: '/w', label: 'w', isDefault: false });
    mockForge();
  });

  afterEach(() => {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    globalThis.fetch = originalFetch;
    resetGithubAutoSyncForTests();
    resetIssuesGithubForTests();
    setIssuesStateForTests({ version: 2, nextId: 1, issues: [], workspaces: {} });
    setLocalServerAvailableForTests(false);
    resetWorkspaceStateForTests();
    if (previousStorage) {
      Object.defineProperty(globalThis, 'localStorage', previousStorage);
    } else {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });

  test('auto flag persists; active only when mode is mirror', () => {
    setIssuesGithubAuto(true);
    assert.equal(getIssuesGithubAuto(), true);
    assert.equal(memory.get(AUTO_KEY), 'true');
    setIssuesGithubMode('off');
    assert.equal(githubAutoSyncActive(), false);
    setIssuesGithubMode('mirror');
    assert.equal(githubAutoSyncActive(), true);
    assert.equal(memory.get(MODE_KEY), 'mirror');
  });

  test('addIssue creates on GitHub after debounce', async () => {
    setIssuesGithubMode('mirror');
    setIssuesGithubAuto(true);
    addIssue({ title: 'Brand new', workspacePath: '/w' });
    await wait(60);
    assert.equal(ops.filter((op) => op === 'issueCreate').length, 1);
  });

  test('imported GitHub cards do not schedule a create', async () => {
    setIssuesGithubMode('mirror');
    setIssuesGithubAuto(true);
    addIssue({ title: 'Imported', workspacePath: '/w', source: 'github' });
    await wait(60);
    assert.deepEqual(ops, []);
  });

  test('new cards stay local when automatic sync is disabled', async () => {
    setIssuesGithubMode('mirror');
    addIssue({ title: 'Local', workspacePath: '/w' });
    await wait(60);
    assert.deepEqual(ops, []);
  });

  test('a later title edit on an unlinked card creates once after debounce', async () => {
    setIssuesGithubMode('mirror');
    setIssuesGithubAuto(true);
    const created = addIssue({ title: 'Brand new', workspacePath: '/w' });
    updateIssue(created.id, { title: 'Once' });
    updateIssue(created.id, { title: 'Renamed' });
    await wait(60);
    const creates = ops.filter((op) => op === 'issueCreate');
    assert.equal(creates.length, 1);
  });

  test('rank and assignee writes do not schedule auto-sync', async () => {
    setIssuesGithubMode('mirror');
    setIssuesGithubAuto(true);
    setIssuesStateForTests({
      version: 2,
      nextId: 2,
      issues: [card({ github: githubLink() })],
      workspaces: {},
    });
    updateIssue('MIN-1', { rank: 'a' });
    updateIssue('MIN-1', { assignee: { id: 'me', assignedAt: 1 } });
    await wait(60);
    assert.deepEqual(ops, []);
  });

  test('type, priority and comment edits schedule one debounced push', async () => {
    setIssuesGithubMode('mirror');
    setIssuesGithubAuto(true);
    setIssuesStateForTests({ version: 2, nextId: 2, issues: [card({ github: githubLink() })], workspaces: {} });
    updateIssue('MIN-1', { type: 'bug', priority: 'high' });
    addIssueComment('MIN-1', { body: 'Available on every machine' });
    await wait(60);
    assert.equal(ops.filter((op) => op === 'issueEdit').length, 1);
  });

  test('GitHub pull apply does not bounce back as a local push', async () => {
    setIssuesGithubMode('mirror');
    setIssuesGithubAuto(true);
    setIssuesStateForTests({
      version: 2,
      nextId: 2,
      issues: [card({ github: githubLink() })],
      workspaces: {},
    });
    updateIssue(
      'MIN-1',
      { title: 'From GitHub' },
      { skipGithubAutoSync: true },
    );
    await wait(60);
    assert.deepEqual(ops, []);
  });

  test('poller and enable-on skip unlinked creates', async () => {
    setIssuesGithubMode('mirror');
    setIssuesGithubAuto(true);
    setIssuesStateForTests({
      version: 2,
      nextId: 3,
      issues: [
        card({ id: 'MIN-1' }),
        card({
          id: 'MIN-2',
          github: githubLink(),
        }),
      ],
      workspaces: {},
    });
    startGithubAutoSyncLoop();
    await wait(40);
    assert.equal(ops.includes('issueCreate'), false);
    assert.equal(ops.includes('issueView'), true);

    ops.length = 0;
    await runGithubAutoSyncLinkedPass();
    assert.equal(ops.includes('issueCreate'), false);
  });

  test('background passes skip closed and unassigned workspaces, then follow workspace switches', async () => {
    setIssuesGithubMode('mirror');
    setIssuesGithubAuto(true);
    setIssuesStateForTests({
      version: 2,
      nextId: 4,
      issues: [
        card({ id: 'MIN-1', workspacePath: '/w', github: githubLink() }),
        card({ id: 'MIN-2', workspacePath: '/closed', github: githubLink() }),
        card({ id: 'MIN-3', workspacePath: '', github: githubLink() }),
      ],
      workspaces: {},
    });
    const roots: string[] = [];
    const forgeFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.op === 'issueView') roots.push(body.cwd);
      return forgeFetch(input, init);
    };
    await runGithubAutoSyncLinkedPass();
    assert.deepEqual(roots, ['/w', '/w']);
    setWorkspaceFromServer({ path: '/closed', label: 'closed', isDefault: false });
    await runGithubAutoSyncLinkedPass();
    assert.deepEqual(roots, ['/w', '/w', '/closed', '/closed']);
    resetWorkspaceStateForTests();
    await runGithubAutoSyncLinkedPass();
    assert.deepEqual(roots, ['/w', '/w', '/closed', '/closed']);
  });

  test('syncAll linkedOnly does not create unlinked cards', async () => {
    setIssuesGithubMode('mirror');
    setIssuesStateForTests({
      version: 2,
      nextId: 3,
      issues: [card({ id: 'MIN-1' }), card({ id: 'MIN-2', github: githubLink() })],
      workspaces: {},
    });
    await syncAllIssuesWithGithub({ linkedOnly: true, scope: 'current_workspace', workspacePath: '/w' });
    assert.equal(ops.includes('issueCreate'), false);
    assert.equal(ops.includes('issueView'), true);
    assert.equal(ops.includes('issueList'), false);
  });

  test('syncAll imports open and closed remote issues into an empty workspace without pushing them', async () => {
    setIssuesGithubMode('mirror');
    const requested: string[] = [];
    globalThis.fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      assert.equal(request.op, 'issueList');
      assert.equal(request.state, 'all');
      assert.equal(request.limit, 500);
      requested.push(request.cwd);
      return gitJsonResponse({ ok: true, issues: [
        { number: 12, title: 'External issue', body: 'External body', state: 'open',
          url: 'https://github.com/acme/app/issues/12', labels: ['bug'], updatedAt: SYNCED_AT },
        { number: 13, title: 'External closed issue', body: '', state: 'closed',
          url: 'https://github.com/acme/app/issues/13', labels: [], updatedAt: SYNCED_AT },
      ] });
    };
    const result = await syncAllIssuesWithGithub();
    assert.deepEqual(result, { synced: 0, imported: 2, conflicts: [], errors: [] });
    const rows = listIssues();
    assert.equal(rows.length, 2);
    assert.ok(rows.every((issue) => issue.workspacePath === '/w' && issue.source === 'github' && !issue.triagedAt));
    assert.equal(rows.find((issue) => issue.github?.number === 13)?.status, 'done');
    assert.ok(rows.every((issue) => !issueNeedsGithubPush(issue)));
    assert.deepEqual(requested, ['/w']);
  });

  test('syncAll discovers in each scoped workspace and deduplicates issue numbers within that workspace', async () => {
    setIssuesGithubMode('mirror');
    setIssuesStateForTests({ version: 2, nextId: 4, workspaces: {}, issues: [
      card({ id: 'MIN-1', workspacePath: '/w', github: githubLink({ number: 12 }) }),
      card({ id: 'MIN-2', workspacePath: '/other', github: githubLink({ number: 12 }) }),
      card({ id: 'MIN-3', workspacePath: '' }),
    ] });
    const discovered: string[] = [];
    const existingForge = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.op !== 'issueList') return existingForge(input, init);
      discovered.push(request.cwd);
      return gitJsonResponse({ ok: true, issues: [12, 13].map((number) => ({
        number, title: `Remote ${number}`, body: '', state: 'open', labels: [],
        url: `https://github.com/acme/${request.cwd.slice(1)}/issues/${number}`, updatedAt: SYNCED_AT,
      })) });
    };
    const first = await syncAllIssuesWithGithub({ workspacePath: '/w' });
    assert.equal(first.imported, 1);
    assert.deepEqual(first.errors, []);
    assert.deepEqual(discovered, ['/w']);
    assert.equal(listIssues().filter((issue) => issue.workspacePath === '/other').length, 1);

    discovered.length = 0;
    const all = await syncAllIssuesWithGithub({ scope: 'all' });
    assert.equal(all.imported, 1);
    assert.deepEqual(all.errors, []);
    assert.deepEqual(discovered, ['/w', '/other']);
    assert.equal(listIssues().filter((issue) => issue.github?.number === 12).length, 2);
    assert.equal(listIssues().filter((issue) => issue.github?.number === 13).length, 2);
    assert.ok(ops.includes('issueCreate'));
  });

  test('syncAll surfaces discovery errors while still syncing existing cards', async () => {
    setIssuesGithubMode('mirror');
    setIssuesStateForTests({ version: 2, nextId: 2, issues: [card()], workspaces: {} });
    const existingForge = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.op === 'issueList') return gitJsonResponse({ ok: false, error: 'GitHub CLI is not signed in' });
      return existingForge(input, init);
    };
    const result = await syncAllIssuesWithGithub();
    assert.equal(result.imported, 0);
    assert.equal(result.synced, 1);
    assert.match(result.errors[0], /\/w:.*not signed in/);
    assert.ok(findIssueById('MIN-1')?.github);
  });

  test('syncAll mode off does not discover or sync issues', async () => {
    const result = await syncAllIssuesWithGithub();
    assert.deepEqual(result, { synced: 0, imported: 0, conflicts: [], errors: [] });
    assert.deepEqual(ops, []);
  });

  test('syncAll respects workspace scope', async () => {
    setIssuesGithubMode('mirror');
    setIssuesStateForTests({
      version: 2,
      nextId: 4,
      issues: [
        card({ id: 'MIN-1', workspacePath: '/w', github: githubLink({ number: 1 }) }),
        card({ id: 'MIN-2', workspacePath: '/other', github: githubLink({ number: 2 }) }),
      ],
      workspaces: {},
    });
    ops.length = 0;
    await syncAllIssuesWithGithub({
      linkedOnly: true,
      scope: 'current_workspace',
      workspacePath: '/w',
    });
    assert.equal(ops.filter((op) => op === 'issueView').length, 2);

    ops.length = 0;
    await syncAllIssuesWithGithub({ linkedOnly: true, scope: 'all' });
    assert.equal(ops.filter((op) => op === 'issueView').length, 4);
  });

  for (const automatic of [false, true]) {
    test(`${automatic ? 'background poll' : 'syncAll'} overlaps reads and retains every pulled issue`, async () => {
      const requestedLocks: string[] = [];
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
        locks: { request: async (name: string, run: () => Promise<unknown>) => {
          requestedLocks.push(name);
          return run();
        } },
      } });
      setIssuesGithubMode('mirror');
      setIssuesGithubAuto(automatic);
      const issues = Array.from({ length: 7 }, (_, index) => card({
        id: `MIN-${index + 1}`, github: githubLink({ number: index + 1 }),
      }));
      setIssuesStateForTests({ version: 2, nextId: 8, issues, workspaces: {} });
      storage.setItem('minnow-issues-v1', JSON.stringify({ version: 2, nextId: 8, issues, workspaces: {} }));
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      const reads: number[] = [];
      globalThis.fetch = async (_input, init) => {
        const request = JSON.parse(String(init?.body));
        assert.equal(request.op, 'issueView');
        assert.equal(request.cwd, '/w');
        reads.push(request.number);
        await pending;
        return gitJsonResponse({ ok: true, issue: {
          number: request.number, title: `Remote ${request.number}`, body: 'Remote body',
          state: 'open', labels: ['bug'], updatedAt: SYNCED_AT + 100,
          url: `https://github.com/acme/app/issues/${request.number}`,
        } });
      };
      const pass = automatic ? runGithubAutoSyncLinkedPass()
        : syncAllIssuesWithGithub({ linkedOnly: true, workspacePath: '/w' });
      await wait(0);
      assert.equal(reads.length, 3);
      release();
      const result = await pass;
      if (result) {
        assert.equal(result.synced, 7);
        assert.deepEqual(result.errors, []);
      }
      assert.equal(reads.length, 7);
      for (const issue of issues) {
        const current = findIssueById(issue.id)!;
        assert.equal(current.title, `Remote ${issue.github!.number}`);
        assert.equal(current.github?.remoteUpdatedAt, SYNCED_AT + 100);
        assert.equal(issueNeedsGithubPush(current), false);
        assert.ok(requestedLocks.includes(`minnow-issue-github:${issue.id}`));
      }
      const persisted = JSON.parse(storage.getItem('minnow-issues-v1')!);
      assert.equal(persisted.issues.length, 7);
      assert.ok(persisted.issues.every((issue: IssueCard) =>
        issue.title === `Remote ${issue.github?.number}` && issue.github?.remoteUpdatedAt === SYNCED_AT + 100));
    });
  }

  test('equal legacy content publishes metadata and priority changes need a push', async () => {
    setIssuesGithubMode('mirror');
    setIssuesStateForTests({ version: 2, nextId: 2, issues: [card({ github: githubLink(), updatedAt: 2000 })], workspaces: {} });
    const result = await syncIssueWithGithub('MIN-1');
    assert.equal(result.ok, true);
    assert.equal(result.action, 'push');
    assert.equal(issueNeedsGithubPush(findIssueById('MIN-1')!), false);
    updateIssue('MIN-1', { priority: 'high' });
    assert.equal(issueNeedsGithubPush(findIssueById('MIN-1')!), true);
    updateIssue('MIN-1', { title: 'A new title' });
    assert.equal(issueNeedsGithubPush(findIssueById('MIN-1')!), true);
  });

  test('off does not read a linked remote', async () => {
    setIssuesStateForTests({ version: 2, nextId: 2, issues: [card({ github: githubLink() })], workspaces: {} });
    await syncIssueWithGithub('MIN-1');
    assert.deepEqual(ops, []);
  });

  test('remote read failures are errors, not successful no-ops', async () => {
    setIssuesGithubMode('mirror');
    setIssuesStateForTests({ version: 2, nextId: 2, issues: [card({ github: githubLink() })], workspaces: {} });
    globalThis.fetch = async () => gitJsonResponse({ ok: false, error: 'gh auth required' });
    const result = await syncIssueWithGithub('MIN-1');
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /auth/);
  });

  test('equal-time conflict automatically takes GitHub', async () => {
    setIssuesGithubMode('mirror');
    setIssuesGithubAuto(true);
    setIssuesStateForTests({
      version: 2,
      nextId: 2,
      issues: [
        card({
          title: 'Mine',
          updatedAt: SYNCED_AT + 50,
          github: githubLink(),
        }),
      ],
      workspaces: {},
    });
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { op?: string };
      const op = typeof body.op === 'string' ? body.op : '';
      ops.push(op);
      if (op === 'issueView') {
        return gitJsonResponse({
          ok: true,
          issue: {
            number: 5,
            title: 'Theirs',
            body: 'Local body',
            state: 'open',
            url: 'https://github.com/acme/app/issues/5',
            labels: ['bug'],
            updatedAt: SYNCED_AT + 50,
          },
        });
      }
      return gitJsonResponse({ ok: true });
    };
    await runGithubAutoSyncLinkedPass();
    assert.equal(ops.includes('issueEdit'), false);
    assert.equal(ops.includes('issueCreate'), false);
    assert.equal(findIssueById('MIN-1')?.title, 'Theirs');
  });
});

describe('auto-sync conflict copy', () => {
  test('toast names the GitHub number; peek only when that card is open', () => {
    assert.equal(
      githubAutoConflictToast(12),
      'Both sides changed on #12. Open the issue to pick.',
    );
    assert.equal(githubAutoConflictShouldUsePeek('MIN-1', 'MIN-1'), true);
    assert.equal(githubAutoConflictShouldUsePeek('MIN-1', 'MIN-2'), false);
    assert.equal(githubAutoConflictShouldUsePeek('MIN-1', undefined), false);
  });
});
