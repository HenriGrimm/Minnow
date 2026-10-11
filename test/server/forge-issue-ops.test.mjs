/**
 * gh issue forge ops — parse helpers and fail-closed list (MIN-660).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { gh } from '../../server/git/forge-ops.js';
import {
  buildIssueDeleteArgs,
  buildIssueBatchQuery,
  parseIssueBatch,
  issueBatch,
  buildIssueEditArgs,
  cleanLabelNames,
  issueList,
  labelAlreadyExists,
  labelsMissingFromRepo,
  normalizeForgeIssue,
  parseIssueCreateOutput,
  parseLabelListJson,
} from '../../server/git/forge-issue-ops.js';

describe('normalizeForgeIssue', () => {
  test('drops records without a positive issue number', () => {
    assert.equal(normalizeForgeIssue(null), null);
    assert.equal(normalizeForgeIssue({ title: 'x' }), null);
    assert.equal(normalizeForgeIssue({ number: 0, title: 'x' }), null);
  });

  test('maps labels and assignees from gh JSON objects or strings', () => {
    const issue = normalizeForgeIssue({
      number: 4,
      title: 'Title',
      body: 'Body',
      state: 'OPEN',
      url: 'https://github.com/o/r/issues/4',
      labels: [{ name: 'bug' }, 'docs'],
      assignees: [{ login: 'ada' }, 'grace'],
      updatedAt: '2026-01-02T00:00:00Z',
    });
    assert.equal(issue?.number, 4);
    assert.equal(issue?.state, 'open');
    assert.deepEqual(issue?.labels, ['bug', 'docs']);
    assert.deepEqual(issue?.assignees, ['ada', 'grace']);
    assert.equal(typeof issue?.updatedAt, 'number');
  });

  test('preserves large bodies so portable metadata is never truncated', () => {
    const issue = normalizeForgeIssue({
      number: 1,
      title: 'Big',
      body: 'x'.repeat(20_000),
      state: 'open',
      url: 'https://github.com/o/r/issues/1',
      labels: [],
    });
    assert.equal(issue?.body.length, 20_000);
    assert.throws(() => normalizeForgeIssue({ number: 1, body: 'x'.repeat(65_537) }), /exceeds/);
  });
});

describe('parseIssueCreateOutput', () => {
  test('reads the issue URL and number from gh stdout', () => {
    const parsed = parseIssueCreateOutput(
      'https://github.com/acme/app/issues/88\n',
    );
    assert.equal(parsed.number, 88);
    assert.equal(parsed.url, 'https://github.com/acme/app/issues/88');
  });
});

describe('issue deletion', () => {
  test('uses the non-interactive GitHub CLI command', () => {
    assert.deepEqual(buildIssueDeleteArgs(12), ['issue', 'delete', '12', '--yes']);
  });
});

describe('repo label helpers', () => {
  test('cleanLabelNames trims, drops empties, and de-dupes case-insensitively', () => {
    assert.deepEqual(cleanLabelNames([' Bug ', '', 'bug', 'ui', null]), ['Bug', 'ui']);
    assert.deepEqual(cleanLabelNames(undefined), []);
  });

  test('parseLabelListJson reads gh JSON objects or strings', () => {
    assert.deepEqual(
      parseLabelListJson('[{"name":"bug"},{"name":"docs"}]'),
      ['bug', 'docs'],
    );
    assert.deepEqual(parseLabelListJson('not json'), []);
  });

  test('labelsMissingFromRepo is case-insensitive', () => {
    assert.deepEqual(labelsMissingFromRepo(['Bug', 'ui'], ['bug']), ['ui']);
    assert.deepEqual(labelsMissingFromRepo(['bug'], ['bug', 'docs']), []);
  });

  test('labelAlreadyExists matches GitHub and gh wording', () => {
    assert.equal(labelAlreadyExists('HTTP 422: already_exists'), true);
    assert.equal(labelAlreadyExists('', 'label "bug" already exists'), true);
    assert.equal(labelAlreadyExists('permission denied'), false);
  });

  test('buildIssueEditArgs sends add and remove flags', () => {
    assert.deepEqual(
      buildIssueEditArgs({
        number: 12,
        title: 'Title',
        body: 'Body',
        addLabels: ['ui'],
        removeLabels: ['docs'],
      }),
      [
        'issue',
        'edit',
        '12',
        '--title',
        'Title',
        '--body',
        'Body',
        '--add-label',
        'ui',
        '--remove-label',
        'docs',
      ],
    );
  });

  test('buildIssueEditArgs with only labels is still a valid edit', () => {
    const args = buildIssueEditArgs({
      number: 3,
      addLabels: ['ux'],
      removeLabels: [],
    });
    assert.deepEqual(args, ['issue', 'edit', '3', '--add-label', 'ux']);
  });
});

describe('issueList fail-closed', () => {
  test('returns ok:false in a non-git directory instead of throwing', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-forge-issue-'));
    try {
      const result = await issueList({ cwd: tmpDir });
      assert.equal(result.ok, false);
      assert.ok(result.error);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('issue batches', () => {
  test('queries exact identities once and validates sizes/numbers before launching gh', async () => {
    const query = buildIssueBatchQuery([1, 2, 1]);
    assert.equal(query.match(/i1:issue/g)?.length, 1);
    assert.match(query, /i2:issue\(number:2\)/);
    assert.match(query, /query\(\$owner:String!,\$name:String!\)/);
    for (const numbers of [[], [0], [1.5], ['1'], Array.from({ length: 51 }, (_, i) => i + 1)]) {
      assert.throws(() => buildIssueBatchQuery(numbers), /1 and 50/);
    }
    assert.equal((await issueBatch({ numbers: [0] })).ok, false);
  });

  test('normalizes batched connections and preserves missing issues and full bodies', () => {
    const issue = { number: 3, title: 'Reopened', state: 'OPEN', body: 'x'.repeat(60_000),
      labels: { nodes: [{ name: 'bug' }], pageInfo: { hasNextPage: false } },
      assignees: { nodes: [{ login: 'ada' }] }, updatedAt: '2026-01-02T00:00:00Z' };
    const stdout = JSON.stringify({ data: { repository: { i3: issue, i4: null } } });
    const result = parseIssueBatch(stdout, [3, 4]);
    assert.equal(result.length, 1);
    assert.equal(result[0].body.length, 60_000);
    assert.deepEqual(result[0].labels, ['bug']);
    assert.deepEqual(result[0].assignees, ['ada']);
    assert.equal(result[0].state, 'open');
    const partial = { data: { repository: { i3: issue, i4: null } },
      errors: [{ type: 'NOT_FOUND', path: ['repository', 'i4'] }] };
    assert.equal(parseIssueBatch(JSON.stringify(partial), [3, 4]).length, 1);
    assert.throws(() => parseIssueBatch('{}', [3]), /Could not read/);
    assert.throws(() => parseIssueBatch(JSON.stringify({ data: { repository: { i3: issue } }, errors: [{}] }), [3]), /Could not read/);
    issue.labels.pageInfo.hasNextPage = true;
    assert.throws(() => parseIssueBatch(JSON.stringify({ data: { repository: { i3: issue } } }), [3]), /more labels/);
  });
});

describe('gh never rejects', () => {
  test('a missing or unknown verb becomes a result object', async () => {
    const result = await gh(['minnow-not-a-real-gh-verb'], process.cwd(), 8_000);
    assert.equal(typeof result.code, 'number');
    assert.notEqual(result.code, 0);
  });
});
