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
import { addIssue, findIssueById, setIssuesStateForTests, updateIssue } from '../../src/state/issues-store.ts';
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
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

  beforeEach(() => {
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

  test('addIssue does not create on GitHub', async () => {
    setIssuesGithubMode('mirror');
    setIssuesGithubAuto(true);
    addIssue({ title: 'Brand new', workspacePath: '/w' });
    await wait(60);
    assert.equal(ops.includes('issueCreate'), false);
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
    assert.deepEqual(roots, ['/w']);
    setWorkspaceFromServer({ path: '/closed', label: 'closed', isDefault: false });
    await runGithubAutoSyncLinkedPass();
    assert.deepEqual(roots, ['/w', '/closed']);
    resetWorkspaceStateForTests();
    await runGithubAutoSyncLinkedPass();
    assert.deepEqual(roots, ['/w', '/closed']);
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
    assert.equal(ops.filter((op) => op === 'issueView').length, 1);

    ops.length = 0;
    await syncAllIssuesWithGithub({ linkedOnly: true, scope: 'all' });
    assert.equal(ops.filter((op) => op === 'issueView').length, 2);
  });

  test('equal content repairs stale watermarks and metadata stays synced', async () => {
    setIssuesGithubMode('mirror');
    setIssuesStateForTests({ version: 2, nextId: 2, issues: [card({ github: githubLink(), updatedAt: 2000 })], workspaces: {} });
    const result = await syncIssueWithGithub('MIN-1');
    assert.equal(result.ok, true);
    assert.equal(result.action, 'noop');
    assert.equal(issueNeedsGithubPush(findIssueById('MIN-1')!), false);
    updateIssue('MIN-1', { priority: 'high' });
    assert.equal(issueNeedsGithubPush(findIssueById('MIN-1')!), false);
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
