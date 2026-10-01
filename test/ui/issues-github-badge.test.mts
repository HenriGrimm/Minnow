import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Window } from 'happy-dom';
import type { IssueCard } from '../../src/types.ts';
import { createIssueGithubSyncBadge } from '../../src/ui/issues-github-badge.ts';

const win = new Window();
globalThis.document = win.document;
after(() => win.close());
const issue: IssueCard = {
  id: 'MIN-1', type: 'task', title: 'Title', description: '', labels: [],
  status: 'todo', priority: 'none', createdAt: 1, updatedAt: 20,
  github: { number: 1, url: 'https://github.com/a/b/issues/1', syncedAt: 10,
    localUpdatedAt: 10, localChangedAt: 20 },
};

test('pending edits have a visible and accessible warning, even with sync turned off', () => {
  const badge = createIssueGithubSyncBadge(issue, false)!;
  assert.equal(badge.textContent, 'GitHub · Needs push');
  assert.match(badge.getAttribute('aria-label')!, /not been synced/);
});

test('synced issues and local-only changes do not warn', () => {
  assert.equal(createIssueGithubSyncBadge({ ...issue,
    github: { ...issue.github!, localChangedAt: 10 } }, true), null);
  assert.equal(createIssueGithubSyncBadge({ ...issue, updatedAt: 10,
    github: { ...issue.github!, localChangedAt: undefined } }, true), null);
});

test('unlinked issues warn only when mirroring is enabled, and conflicts take precedence', () => {
  const unlinked = { ...issue, github: undefined };
  assert.equal(createIssueGithubSyncBadge(unlinked, false), null);
  assert.equal(createIssueGithubSyncBadge(unlinked, true)?.textContent, 'GitHub · Not synced');
  assert.equal(createIssueGithubSyncBadge(issue, true, true)?.textContent, 'GitHub · Conflict');
});
