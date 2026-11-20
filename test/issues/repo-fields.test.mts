/**
 * Multi-repo issue fields: `repos`, `gitLinks[].repo`, `agent.prRepo`.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseIssuesState } from '../../src/state/issues-store.ts';
import { validateIssuesState } from '../../server/config/validators.js';
import { ISSUES_COMPAT_VERSION, ISSUES_SCHEMA_VERSION } from '../../src/types.ts';
import { issueRepoIds, repoQualifiedRef, sameLinkRepo } from '../../src/issues/repo-scope.ts';

function stateWith(issue: Record<string, unknown>) {
  return {
    version: ISSUES_COMPAT_VERSION,
    schemaRevision: ISSUES_SCHEMA_VERSION,
    nextId: 2,
    workspaces: {},
    issues: [{
      id: 'ISS-1', type: 'task', title: 'T', description: '', status: 'todo', priority: 'none',
      labels: [], workspacePath: '/w', createdAt: 1, updatedAt: 1, ...issue,
    }],
  };
}

const multi = {
  repos: ['backend', 'backend', ' ', 'frontend/'],
  gitLinks: [{ kind: 'pr', ref: '#12', repo: ' backend ', addedAt: 1 }, { kind: 'commit', ref: 'abc', repo: '', addedAt: 2 }],
  agent: { agentId: 'a', phase: 'review', startedAt: 1, updatedAt: 1, prNumber: 12, prRepo: 'backend' },
};

describe('multi-repo issue fields', () => {
  for (const [name, parse] of [
    ['server validateIssuesState', (raw: unknown) => validateIssuesState(raw)],
    ['client parseIssuesState', (raw: unknown) => parseIssuesState(raw)],
  ] as const) {
    test(`${name} normalizes repos, link repo and prRepo`, () => {
      const issue = (parse(stateWith(multi)) as { issues: Array<Record<string, any>> }).issues[0];
      assert.deepEqual(issue.repos, ['backend', 'frontend']);
      assert.equal(issue.gitLinks[0].repo, 'backend');
      assert.equal('repo' in issue.gitLinks[1], false);
      assert.equal(issue.agent.prRepo, 'backend');
    });

    test(`${name} leaves records without the new fields unchanged`, () => {
      const issue = (parse(stateWith({ gitLinks: [{ kind: 'pr', ref: '#3', addedAt: 1 }] })) as { issues: Array<Record<string, any>> }).issues[0];
      assert.equal('repos' in issue, false);
      assert.deepEqual(issue.gitLinks, [{ kind: 'pr', ref: '#3', addedAt: 1 }]);
    });
  }

  test('issueRepoIds falls back to the workspace repo or the only repo', () => {
    assert.deepEqual(issueRepoIds({}, [{ id: '.' }]), ['.']);
    assert.deepEqual(issueRepoIds({ repos: [] }, [{ id: 'frontend' }, { id: '.' }]), ['.']);
    assert.deepEqual(issueRepoIds({}, [{ id: 'frontend' }]), ['frontend']);
    assert.deepEqual(issueRepoIds({}, [{ id: 'frontend' }, { id: 'backend' }]), []);
    assert.deepEqual(issueRepoIds({ repos: ['backend'] }, [{ id: 'frontend' }, { id: 'backend' }]), ['backend']);
  });

  test('link helpers qualify refs by repo', () => {
    assert.equal(repoQualifiedRef('#12', 'backend'), 'backend#12');
    assert.equal(repoQualifiedRef('#12', '.'), '#12');
    assert.equal(repoQualifiedRef('#12'), '#12');
    assert.equal(sameLinkRepo({ repo: 'a' }, { repo: 'b' }), false);
    assert.equal(sameLinkRepo({}, {}), true);
  });
});
