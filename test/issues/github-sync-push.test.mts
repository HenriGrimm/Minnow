/**
 * Linked-issue push must send the label add/remove diff, not title/body only.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  resetIssuesGithubForTests,
  resolveSyncConflict,
  setIssuesGithubMode,
  syncIssueWithGithub,
} from '../../src/state/issues-github.ts';
import { findIssueById, updateIssue, setIssuesStateForTests } from '../../src/state/issues-store.ts';
import { setLocalServerAvailableForTests } from '../../src/tools/config.ts';
import { issueNeedsGithubPush } from '../../src/issues/github-sync-plan.ts';
import type { IssueCard, IssueGithubLink } from '../../src/types.ts';
import { decodeGithubIssueBody } from '../../src/issues/github-metadata.ts';

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

function gitJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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
    labels: ['bug', 'ui'],
    workspacePath: '/w',
    createdAt: 0,
    updatedAt: SYNCED_AT + 50,
    github: githubLink(),
    ...partial,
  } as IssueCard;
}

describe('GitHub label push', () => {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const forgeCalls: Record<string, unknown>[] = [];

  beforeEach(() => {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    memory.clear();
    forgeCalls.length = 0;
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
    resetIssuesGithubForTests();
    setIssuesGithubMode('mirror');
    setLocalServerAvailableForTests(true);
    setIssuesStateForTests({ version: 2, nextId: 2, issues: [card()], workspaces: {} });

    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      forgeCalls.push(body);
      const op = typeof body.op === 'string' ? body.op : '';
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
      if (op === 'issueEdit' || op === 'issueState' || op === 'issueCreate') {
        return gitJsonResponse({
          ok: true,
          number: op === 'issueCreate' ? 42 : 5,
          url: 'https://github.com/acme/app/issues/42',
        });
      }
      return gitJsonResponse({ ok: false, error: `unexpected ${op}` }, 400);
    };
  });

  afterEach(() => {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    globalThis.fetch = originalFetch;
    resetIssuesGithubForTests();
    setIssuesStateForTests({ version: 2, nextId: 1, issues: [], workspaces: {} });
    setLocalServerAvailableForTests(false);
    if (previousStorage) {
      Object.defineProperty(globalThis, 'localStorage', previousStorage);
    } else {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });

  test('edits made during a push remain pending and use the issue workspace', async () => {
    const normalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      if (body.op === 'issueEdit') updateIssue('MIN-1', { title: 'Typed while syncing' });
      return normalFetch(input, init);
    };
    const outcome = await syncIssueWithGithub('MIN-1');
    assert.equal(outcome.ok, true);
    assert.equal(issueNeedsGithubPush(findIssueById('MIN-1')!), true);
    assert.equal(findIssueById('MIN-1')?.title, 'Typed while syncing');
    assert.ok(forgeCalls.every((call) => call.cwd === '/w'));
  });

  test('push sends addLabels for names GitHub does not have yet', async () => {
    const outcome = await syncIssueWithGithub('MIN-1');
    assert.equal(outcome.ok, true);
    assert.equal(outcome.action, 'push');
    const edit = forgeCalls.find((call) => call.op === 'issueEdit');
    assert.ok(edit);
    assert.deepEqual(edit.addLabels, ['ui']);
    assert.deepEqual(edit.removeLabels, []);
    assert.equal(edit.title, 'Local title');
    assert.equal(decodeGithubIssueBody(String(edit.body)).body, 'Local body');
  });

  test('push sends removeLabels when a chip was taken off locally', async () => {
    setIssuesStateForTests({
      version: 2,
      nextId: 2,
      issues: [card({ labels: ['bug'] })],
      workspaces: {},
    });
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      forgeCalls.push(body);
      const op = typeof body.op === 'string' ? body.op : '';
      if (op === 'issueView') {
        return gitJsonResponse({
          ok: true,
          issue: {
            number: 5,
            title: 'Local title',
            body: 'Local body',
            state: 'open',
            url: 'https://github.com/acme/app/issues/5',
            labels: ['bug', 'docs'],
            updatedAt: SYNCED_AT,
          },
        });
      }
      if (op === 'issueEdit') return gitJsonResponse({ ok: true, number: 5 });
      return gitJsonResponse({ ok: false, error: `unexpected ${op}` }, 400);
    };

    const outcome = await syncIssueWithGithub('MIN-1');
    assert.equal(outcome.ok, true);
    const edit = forgeCalls.find((call) => call.op === 'issueEdit');
    assert.deepEqual(edit?.addLabels, []);
    assert.deepEqual(edit?.removeLabels, ['docs']);
  });

  test('create still includes the local label names', async () => {
    setIssuesStateForTests({
      version: 2,
      nextId: 2,
      issues: [card({ github: undefined, labels: ['ux', 'api'] })],
      workspaces: {},
    });
    const outcome = await syncIssueWithGithub('MIN-1');
    assert.equal(outcome.ok, true);
    assert.equal(outcome.action, 'create');
    const create = forgeCalls.find((call) => call.op === 'issueCreate');
    assert.deepEqual(create?.labels, ['ux', 'api']);
  });

  test('Keep mine also pushes the label diff', async () => {
    const outcome = await resolveSyncConflict(
      {
        issueId: 'MIN-1',
        number: 5,
        url: 'https://github.com/acme/app/issues/5',
        local: {
          title: 'Local title',
          body: 'Local body',
          closed: false,
          labels: ['bug', 'ui'],
        },
        remote: {
          title: 'Remote title',
          body: 'Remote body',
          closed: false,
          labels: ['bug'],
        },
      },
      'local',
    );
    assert.equal(outcome.ok, true);
    assert.equal(outcome.action, 'push');
    const edit = forgeCalls.find((call) => call.op === 'issueEdit');
    assert.deepEqual(edit?.addLabels, ['ui']);
    assert.deepEqual(edit?.removeLabels, []);
  });
});
