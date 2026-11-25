import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GITHUB_WATCH_RETIRED_SUMMARY, githubRepositoryFromRemote, runGithubWatch } from '../../server/scheduler/github-watch-runtime.js';

test('githubRepositoryFromRemote reads https, ssh and scp-style GitHub remotes', () => {
  assert.equal(githubRepositoryFromRemote('https://github.com/Owner/Repo.git'), 'owner/repo');
  assert.equal(githubRepositoryFromRemote('git@github.com:owner/repo.git'), 'owner/repo');
  assert.equal(githubRepositoryFromRemote('ssh://git@github.com/owner/repo'), 'owner/repo');
  assert.equal(githubRepositoryFromRemote('https://gitlab.com/owner/repo.git'), null);
});

test('the retired Issue Watcher never claims work and says why', async () => {
  const result = await runGithubWatch({ job: { githubWatch: { repository: 'owner/repo' } } });
  assert.deepEqual(result, { blocked: true, changed: false, summary: GITHUB_WATCH_RETIRED_SUMMARY });
});
