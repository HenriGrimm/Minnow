/**
 * Unit tests for forge (gh CLI) parsing helpers — remote host classification
 * and status-check rollup.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parseRemoteHost, rollupConclusion, processError } from '../../server/git/forge-ops.js';

test('long rate-limit errors retain the reset time when normalized', () => {
  const result = { stderr: 'GraphQL: API rate limit already exceeded\n' + 'context\n'.repeat(10) +
    'Retry after 2026-10-10T22:00:00.000Z', stdout: '' };
  const message = processError(result, 'fallback');
  assert.equal(message.split('\n').length, 6);
  assert.match(message, /Retry after 2026-10-10T22:00:00.000Z$/);
});

describe('parseRemoteHost', () => {
  test('classifies https GitHub remotes', () => {
    const parsed = parseRemoteHost('https://github.com/DukkyGames/Minnow.git');
    assert.equal(parsed.host, 'github');
    assert.equal(parsed.slug, 'DukkyGames/Minnow');
    assert.equal(parsed.hostname, 'github.com');
  });

  test('classifies scp-style ssh GitHub remotes', () => {
    const parsed = parseRemoteHost('git@github.com:DukkyGames/Minnow.git');
    assert.equal(parsed.host, 'github');
    assert.equal(parsed.slug, 'DukkyGames/Minnow');
  });

  test('classifies ssh:// GitHub remotes', () => {
    const parsed = parseRemoteHost('ssh://git@github.com/DukkyGames/Minnow.git');
    assert.equal(parsed.host, 'github');
    assert.equal(parsed.slug, 'DukkyGames/Minnow');
  });

  test('classifies GitLab remotes as unsupported rather than github', () => {
    assert.equal(parseRemoteHost('https://gitlab.com/group/project.git').host, 'gitlab');
    assert.equal(parseRemoteHost('git@gitlab.com:group/project.git').host, 'gitlab');
  });

  test('classifies Bitbucket remotes', () => {
    assert.equal(parseRemoteHost('git@bitbucket.org:team/repo.git').host, 'bitbucket');
  });

  test('classifies self-hosted GitHub Enterprise by hostname', () => {
    const parsed = parseRemoteHost('https://github.acme-corp.net/team/repo.git');
    assert.equal(parsed.host, 'github-enterprise');
    assert.equal(parsed.slug, 'team/repo');
  });

  test('falls back to other for unknown hosts', () => {
    assert.equal(parseRemoteHost('https://git.sr.ht/~user/repo').host, 'other');
  });

  test('reports none for an empty remote', () => {
    const parsed = parseRemoteHost('');
    assert.equal(parsed.host, 'none');
    assert.equal(parsed.slug, '');
  });

  test('strips trailing slashes and .git from the slug', () => {
    assert.equal(parseRemoteHost('https://github.com/owner/name/').slug, 'owner/name');
    assert.equal(parseRemoteHost('https://github.com/owner/name.git').slug, 'owner/name');
  });
});

describe('rollupConclusion', () => {
  test('reports none for an empty rollup', () => {
    assert.equal(rollupConclusion([]), 'none');
    assert.equal(rollupConclusion(undefined), 'none');
  });

  test('reports success when every check completed successfully', () => {
    const rollup = [
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
    ];
    assert.equal(rollupConclusion(rollup), 'success');
  });

  test('failure outranks pending', () => {
    const rollup = [
      { status: 'IN_PROGRESS', conclusion: '' },
      { status: 'COMPLETED', conclusion: 'FAILURE' },
    ];
    assert.equal(rollupConclusion(rollup), 'failure');
  });

  test('an incomplete check makes the rollup pending', () => {
    const rollup = [
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { status: 'QUEUED', conclusion: '' },
    ];
    assert.equal(rollupConclusion(rollup), 'pending');
  });

  test('reads StatusContext entries that carry state instead of conclusion', () => {
    assert.equal(rollupConclusion([{ state: 'SUCCESS' }]), 'success');
    assert.equal(rollupConclusion([{ state: 'FAILURE' }]), 'failure');
    assert.equal(rollupConclusion([{ state: 'PENDING' }]), 'pending');
  });

  test('treats a cancelled check as failing, not passing', () => {
    assert.equal(rollupConclusion([{ status: 'COMPLETED', conclusion: 'CANCELLED' }]), 'failure');
  });

  test('skipped checks do not fail the rollup', () => {
    const rollup = [
      { status: 'COMPLETED', conclusion: 'SKIPPED' },
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
    ];
    assert.equal(rollupConclusion(rollup), 'success');
  });
});
