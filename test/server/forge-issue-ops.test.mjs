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

  test('truncates huge bodies so import cannot freeze the SPA', () => {
    const issue = normalizeForgeIssue({
      number: 1,
      title: 'Big',
      body: 'x'.repeat(20_000),
      state: 'open',
      url: 'https://github.com/o/r/issues/1',
      labels: [],
    });
    assert.ok((issue?.body.length ?? 0) < 20_000);
    assert.ok(issue?.body.endsWith('…'));
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

describe('gh never rejects', () => {
  test('a missing or unknown verb becomes a result object', async () => {
    const result = await gh(['minnow-not-a-real-gh-verb'], process.cwd(), 8_000);
    assert.equal(typeof result.code, 'number');
    assert.notEqual(result.code, 0);
  });
});
