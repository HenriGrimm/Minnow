import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchIssueChanges } from '../../server/git/forge-issue-ops.js';

const options = { cwd: '/workspace', repo: 'owner/repo', hostname: 'github.example.com' };
const row = (number) => ({ number, title: `Issue ${number}`, body: 'Body', state: 'closed',
  html_url: `https://github.example.com/owner/repo/issues/${number}`, labels: [{ name: 'bug' }],
  updated_at: '2026-10-08T18:00:00Z', created_at: '2026-01-01T00:00:00Z' });

test('reads every page beyond 500 issues, excludes PRs, and normalizes REST fields', async () => {
  const rows = [...Array.from({ length: 518 }, (_, i) => row(i + 1)), { ...row(999), pull_request: {} }];
  let calls = 0;
  const result = await fetchIssueChanges(options, async (args, cwd) => {
    assert.equal(cwd, options.cwd);
    assert.deepEqual(args.slice(0, 3), ['api', '--hostname', options.hostname]);
    const params = new URL(`https://example.com/${args[3]}`).searchParams;
    assert.equal(params.get('state'), 'all');
    assert.equal(params.get('per_page'), '100');
    const page = Number(params.get('page'));
    calls++;
    return { code: 0, stdout: JSON.stringify(rows.slice((page - 1) * 100, page * 100)) };
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 6);
  assert.equal(result.issues.length, 518);
  assert.equal(result.issues[517].number, 518);
  assert.equal(result.issues[0].state, 'closed');
  assert.equal(result.issues[0].url, row(1).html_url);
  assert.equal(result.issues[0].updatedAt, Date.parse(row(1).updated_at));
  assert.deepEqual(result.issues[0].labels, ['bug']);
  assert.ok(result.cursor <= Date.now());
});

test('incremental reads overlap the cursor boundary to retain simultaneous changes', async () => {
  const since = Date.parse('2026-01-01T00:01:00Z');
  const result = await fetchIssueChanges({ ...options, since }, async (args) => {
    const params = new URL(`https://example.com/${args[3]}`).searchParams;
    assert.equal(params.get('since'), '2026-01-01T00:00:00.000Z');
    return { code: 0, stdout: JSON.stringify([row(1)]) };
  });
  assert.equal(result.ok, true);
});

test('partial failure, truncation, and malformed pages never advance the cursor', async () => {
  for (const failure of [
    { code: 1, stdout: '', stderr: 'API rate limit exceeded' },
    { code: 0, stdout: '[]', accumulationTruncated: true },
    { code: 0, stdout: '{"message":"invalid"}' },
  ]) {
    let calls = 0;
    const result = await fetchIssueChanges(options, async () => ++calls === 1
      ? { code: 0, stdout: JSON.stringify(Array.from({ length: 100 }, (_, i) => row(i + 1))) } : failure);
    assert.equal(result.ok, false);
    assert.equal(result.cursor, undefined);
    assert.equal(result.issues, undefined);
  }
});
