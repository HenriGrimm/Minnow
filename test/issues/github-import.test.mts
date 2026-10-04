/**
 * GitHub issue import: recoverable errors, no local-server flag flip, success path.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { OPEN_MINNOW_RETRY } from '../../src/copy/local-session.ts';
import {
  importGithubIssues,
  resetIssuesGithubForTests,
  setIssuesGithubMode,
} from '../../src/state/issues-github.ts';
import { listIssues, setIssuesStateForTests } from '../../src/state/issues-store.ts';
import { resetWorkspaceStateForTests, setWorkspaceFromServer } from '../../src/state/workspace.ts';
import {
  isLocalServerAvailable,
  setLocalServerAvailableForTests,
} from '../../src/tools/config.ts';

const originalFetch = globalThis.fetch;

function gitJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('importGithubIssues', () => {
  beforeEach(() => {
    setIssuesStateForTests({ version: 2, nextId: 1, issues: [], workspaces: {} });
    resetIssuesGithubForTests();
    setIssuesGithubMode('mirror');
    setLocalServerAvailableForTests(true);
    resetWorkspaceStateForTests();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setIssuesStateForTests({ version: 2, nextId: 1, issues: [], workspaces: {} });
    resetIssuesGithubForTests();
    setLocalServerAvailableForTests(false);
    resetWorkspaceStateForTests();
  });

  test('tool server down returns Open or restart Minnow, not server_off', async () => {
    setLocalServerAvailableForTests(false);
    const result = await importGithubIssues();
    assert.equal(result.ok, false);
    assert.equal(result.imported, 0);
    assert.equal(result.error, OPEN_MINNOW_RETRY);
    assert.doesNotMatch(result.error ?? '', /server[_ ]off/i);
  });

  test('Failed to fetch does not mark the local server unavailable', async () => {
    globalThis.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    const result = await importGithubIssues();
    assert.equal(result.ok, false);
    assert.equal(result.error, OPEN_MINNOW_RETRY);
    assert.equal(isLocalServerAvailable(), true);
  });

  test('HTTP 400 with a JSON error surfaces that error, not HTTP 400', async () => {
    globalThis.fetch = async () =>
      gitJsonResponse(
        { ok: false, error: 'The GitHub CLI is not signed in. Run `gh auth login`.' },
        400,
      );
    const result = await importGithubIssues();
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /not signed in/);
    assert.equal(isLocalServerAvailable(), true);
  });

  test('successful list creates triage cards linked to GitHub numbers', async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('/api/git')) {
        return gitJsonResponse({
          ok: true,
          issues: [
            {
              number: 12,
              title: 'From GitHub',
              body: 'Imported body',
              state: 'open',
              url: 'https://github.com/acme/app/issues/12',
              labels: ['bug'],
              updatedAt: 1_710_000_000_000,
            },
            {
              number: 13,
              title: '',
              body: '',
              state: 'closed',
              url: 'https://github.com/acme/app/issues/13',
              labels: [],
              updatedAt: 1_710_000_000_000,
            },
          ],
        });
      }
      return gitJsonResponse({ ok: true });
    };

    const result = await importGithubIssues();
    assert.equal(result.ok, true);
    assert.equal(result.imported, 2);
    assert.equal(result.skipped, 0);

    const cards = listIssues();
    assert.equal(cards.length, 2);
    assert.equal(cards[0]?.source, 'github');
    assert.equal(cards[0]?.title, 'From GitHub');
    assert.equal(cards[0]?.github?.number, 12);
    assert.equal(cards[0]?.githubSync, undefined);
    assert.equal(cards[0]?.triagedAt, undefined);
    assert.equal(cards[1]?.title, 'GitHub #13');
    assert.equal(cards[1]?.status, 'done');
    assert.equal(cards[1]?.github?.number, 13);
  });

  test('already-linked numbers are skipped', async () => {
    setIssuesStateForTests({
      version: 2,
      nextId: 2,
      issues: [
        {
          id: 'MIN-1',
          type: 'task',
          title: 'Existing',
          description: '',
          status: 'backlog',
          priority: 'none',
          labels: [],
          workspacePath: '',
          createdAt: 1,
          updatedAt: 1,
          source: 'github',
          github: {
            number: 12,
            url: 'https://github.com/acme/app/issues/12',
            syncedAt: 1,
            localUpdatedAt: 1,
          },
        },
      ],
      workspaces: {},
    });
    globalThis.fetch = async () =>
      gitJsonResponse({
        ok: true,
        issues: [
          {
            number: 12,
            title: 'From GitHub',
            body: '',
            state: 'open',
            url: 'https://github.com/acme/app/issues/12',
            labels: [],
          },
        ],
      });

    const result = await importGithubIssues();
    assert.equal(result.ok, true);
    assert.equal(result.imported, 0);
    assert.equal(result.skipped, 1);
    assert.equal(listIssues().length, 1);
  });

  test('import keeps its captured destination when the workspace changes during discovery', async () => {
    setWorkspaceFromServer({ path: '/original', label: 'original', isDefault: false });
    globalThis.fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      assert.equal(request.cwd, '/original');
      setWorkspaceFromServer({ path: '/new', label: 'new', isDefault: false });
      return gitJsonResponse({ ok: true, issues: [{
        number: 12, title: 'External issue', body: '', state: 'open', labels: [],
        url: 'https://github.com/acme/app/issues/12',
      }] });
    };
    const result = await importGithubIssues();
    assert.equal(result.imported, 1);
    assert.equal(listIssues()[0].workspacePath, '/original');
  });

  test('explicit import destination overrides the active workspace and its linked numbers', async () => {
    setWorkspaceFromServer({ path: '/active', label: 'active', isDefault: false });
    globalThis.fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      return gitJsonResponse({ ok: true, issues: [{
        number: 12, title: 'External issue', body: '', state: 'open', labels: [],
        url: `https://github.com/acme/${request.cwd.slice(1)}/issues/12`,
      }] });
    };
    assert.equal((await importGithubIssues()).imported, 1);
    assert.equal((await importGithubIssues({ workspacePath: '/other' })).imported, 1);
    assert.equal((await importGithubIssues({ workspacePath: '/other' })).skipped, 1);
    assert.deepEqual(listIssues().map((issue) => issue.workspacePath), ['/active', '/other']);
  });

  test('uninitialized store does not leak issuesState error or fetch GitHub', async () => {
    setIssuesStateForTests(null);
    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      return gitJsonResponse({ ok: true, issues: [] });
    };
    const result = await importGithubIssues();
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Issues are still loading. Try again in a moment.');
    assert.doesNotMatch(result.error ?? '', /issuesState is not initialized/);
    assert.equal(fetched, false);
    assert.equal(isLocalServerAvailable(), true);
  });

  test('mode off does not fetch', async () => {
    setIssuesGithubMode('off');
    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      return gitJsonResponse({ ok: true, issues: [] });
    };
    const result = await importGithubIssues();
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /sync is off/i);
    assert.equal(fetched, false);
  });
});
