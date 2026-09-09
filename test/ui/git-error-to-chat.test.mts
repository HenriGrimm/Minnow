import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildGitErrorFixSeedMessage,
} from '../../src/ui/git-error-to-chat.ts';

describe('buildGitErrorFixSeedMessage', () => {
  it('includes commit failure context and error text', () => {
    const seed = buildGitErrorFixSeedMessage('commit', 'error: pathspec did not match', {
      branch: 'feature/test',
    });
    assert.match(seed, /commit failed in Source Control/i);
    assert.match(seed, /pathspec did not match/);
    assert.match(seed, /feature\/test/);
    assert.match(seed, /git_status/);
  });

  it('includes worktree path when cwd differs from workspace', () => {
    const seed = buildGitErrorFixSeedMessage('merge', 'CONFLICT (content): file.ts', {
      cwd: '/repo/.worktrees/task-a',
      branch: 'main',
    });
    assert.match(seed, /merge failed in Source Control/i);
    assert.match(seed, /CONFLICT \(content\): file\.ts/);
    assert.match(seed, /\/repo\/\.worktrees\/task-a/);
    assert.match(seed, /Do not run `git merge --abort`/);
  });

  it('includes push failure context and parsed title', () => {
    const seed = buildGitErrorFixSeedMessage('push', 'error: failed to push some refs', {
      branch: 'feature/x',
      title: 'Push rejected',
      summary: 'The remote has commits you do not have locally.',
    });
    assert.match(seed, /push failed in Source Control/i);
    assert.match(seed, /Parsed as: Push rejected/);
    assert.match(seed, /failed to push some refs/);
    assert.match(seed, /Do not force-push/);
  });

  it('tells the agent to use gh for pull request failures', () => {
    const seed = buildGitErrorFixSeedMessage('pr', 'GraphQL: Resource not accessible by integration', {
      branch: 'main',
    });
    assert.match(seed, /pull request action failed/i);
    assert.match(seed, /local `gh` CLI/);
    assert.match(seed, /Do not scrape github.com/);
  });

  it('tells the agent to use gh for GitHub sync failures', () => {
    const seed = buildGitErrorFixSeedMessage('github', 'gh: Not Found (HTTP 404)', {
      title: 'Permission denied',
    });
    assert.match(seed, /GitHub operation failed in Minnow/i);
    assert.match(seed, /local `gh` CLI/);
    assert.match(seed, /HTTP 404/);
  });
});
