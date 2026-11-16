/**
 * Static fixtures for git / GitHub stderr classification.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { OPEN_MINNOW_RETRY } from '../../src/copy/local-session.ts';
import {
  firstMeaningfulGitErrorLine,
  parseGitError,
  splitGitErrorDetails,
} from '../../src/lib/git-error-parse.ts';

describe('parseGitError', () => {
  test('maps gh auth login stderr to auth', () => {
    const parsed = parseGitError(
      'You are not logged into any GitHub hosts. To log in, run: gh auth login',
    );
    assert.equal(parsed.kind, 'auth');
    assert.equal(parsed.title, 'Not signed in to GitHub');
    assert.equal(parsed.summary, 'Sign in with gh auth login, then try again.');
  });

  test('maps missing gh binary to gh_missing', () => {
    const parsed = parseGitError("'gh' is not recognized as an internal or external command");
    assert.equal(parsed.kind, 'gh_missing');
    assert.equal(parsed.title, 'GitHub CLI is not installed');
    assert.equal(parsed.summary, 'Install GitHub CLI (gh) and restart Minnow.');
  });

  test('maps non-fast-forward push to rejected', () => {
    const parsed = parseGitError(
      '! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs to \'origin\'',
    );
    assert.equal(parsed.kind, 'rejected');
    assert.equal(parsed.title, 'Push rejected');
    assert.equal(
      parsed.summary,
      'The remote has commits you do not have locally. Pull or rebase, then push again.',
    );
  });

  test('maps protected branch before generic rejected', () => {
    const parsed = parseGitError(
      'remote: error: GH006: Protected branch update failed for refs/heads/main.\nerror: failed to push some refs to \'github.com:acme/app.git\'',
    );
    assert.equal(parsed.kind, 'protected_branch');
    assert.equal(parsed.title, 'Protected branch');
  });

  test('maps CONFLICT (content) to conflict', () => {
    const parsed = parseGitError(
      'CONFLICT (content): Merge conflict in src/app.ts\nAutomatic merge failed; fix conflicts and then commit the result.',
    );
    assert.equal(parsed.kind, 'conflict');
    assert.equal(parsed.title, 'Merge conflict');
    assert.equal(
      parsed.summary,
      'Git stopped because files have conflicting changes. Resolve the conflicts, then continue.',
    );
  });

  test('maps server_off to OPEN_MINNOW_RETRY', () => {
    const parsed = parseGitError('server_off');
    assert.equal(parsed.kind, 'server_off');
    assert.equal(parsed.title, 'Minnow is not running');
    assert.equal(parsed.summary, OPEN_MINNOW_RETRY);
  });

  test('maps timeout copy', () => {
    const parsed = parseGitError('gh timed out after 45000ms');
    assert.equal(parsed.kind, 'timeout');
    assert.equal(parsed.title, 'GitHub timed out');
    assert.equal(parsed.summary, 'GitHub did not respond in time. Try again.');
  });

  test('maps generic noise to first meaningful line', () => {
    const parsed = parseGitError(
      'hint: Updates were not sent\nerror: pathspec \'src/missing.ts\' did not match any file(s) known to git',
    );
    assert.equal(parsed.kind, 'generic');
    assert.equal(parsed.title, 'Git operation failed');
    assert.equal(
      parsed.summary,
      "error: pathspec 'src/missing.ts' did not match any file(s) known to git",
    );
  });

  test('maps authentication failed over publickey', () => {
    const parsed = parseGitError('Permission denied (publickey).\nfatal: Could not read from remote repository.');
    assert.equal(parsed.kind, 'auth');
  });

  test('maps permission denied on a GitHub repo', () => {
    const parsed = parseGitError('remote: Permission to acme/app.git denied to jane.');
    assert.equal(parsed.kind, 'permission');
    assert.equal(parsed.title, 'Permission denied');
  });

  test('maps hook declined', () => {
    const parsed = parseGitError('pre-commit hook failed\nhusky - pre-commit script exited with code 1');
    assert.equal(parsed.kind, 'hook');
    assert.equal(parsed.title, 'Git hook failed');
  });

  test('maps nothing to commit', () => {
    const parsed = parseGitError('On branch main\nnothing to commit, working tree clean');
    assert.equal(parsed.kind, 'nothing_to_commit');
    assert.equal(parsed.title, 'Nothing to commit');
  });

  test('maps network failures', () => {
    const parsed = parseGitError('fatal: Could not resolve host: github.com');
    assert.equal(parsed.kind, 'network');
    assert.equal(parsed.title, 'Could not reach the remote');
  });
});

describe('checkout failures', () => {
  test('incidental "timeout" and "fix conflicts" text does not misclassify', () => {
    assert.equal(parseGitError("error: pathspec 'src/timeout.ts' did not match any file(s) known to git").kind, 'generic');
    assert.equal(parseGitError("remote: Commit 'fix conflicts in readme' rejected by hook").kind, 'generic');
    assert.equal(parseGitError('fatal: unable to access: Connection timeout after 30000 ms').kind, 'timeout');
    assert.equal(parseGitError('connect ETIMEDOUT 140.82.112.3:443').kind, 'timeout');
  });

  test('maps a branch held by another worktree', () => {
    const parsed = parseGitError("fatal: 'feature' is already used by worktree at 'C:/repo/.worktrees/feature'");
    assert.equal(parsed.kind, 'worktree_in_use');
    assert.equal(parsed.title, 'Checked out in another worktree');
  });

  test('maps overwrite, lock file and busy output', () => {
    assert.equal(parseGitError('error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt').kind, 'overwrite');
    assert.equal(parseGitError("fatal: Unable to create 'C:/r/.git/index.lock': File exists.").kind, 'lock_file');
    assert.equal(parseGitError('A local action is running in this worktree. Stop it before changing branches or removing the worktree.').kind, 'busy');
  });

  test('a server code wins over text matching', () => {
    assert.equal(parseGitError('Could not switch', undefined, 'in_worktree').kind, 'worktree_in_use');
    assert.equal(parseGitError("error: pathspec 'nope' did not match any file(s) known to git", undefined, 'missing_ref').kind, 'missing_ref');
    assert.equal(parseGitError('The current branch changed.', undefined, 'stale_branch').kind, 'stale');
    assert.equal(parseGitError('fatal: Could not resolve host: github.com', undefined, 'unknown').kind, 'network');
  });
});

describe('firstMeaningfulGitErrorLine', () => {
  test('skips hint and remote prefixes', () => {
    assert.equal(
      firstMeaningfulGitErrorLine('hint: See the note\nremote: GitHub found\nerror: boom'),
      'error: boom',
    );
  });
});

describe('splitGitErrorDetails', () => {
  test('keeps short details intact', () => {
    const split = splitGitErrorDetails('one\ntwo');
    assert.equal(split.preview, 'one\ntwo');
    assert.equal(split.rest, '');
  });

  test('splits after twelve lines', () => {
    const lines = Array.from({ length: 14 }, (_, i) => `line-${i + 1}`);
    const split = splitGitErrorDetails(lines.join('\n'));
    assert.equal(split.preview, lines.slice(0, 12).join('\n'));
    assert.equal(split.rest, 'line-13\nline-14');
  });
});
