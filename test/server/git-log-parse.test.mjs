/**
 * Unit tests for git log line parsing (%D ref decorators).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { historyLogArgs, historyLogPage, log, parseLogLine } from '../../server/git/git-ops.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

describe('parseLogLine', () => {
  test('parses bare comma-separated refs after relative time', () => {
    const parsed = parseLogLine(
      '330e95e8556a51d8c0962229089f387d617b4e48 f7fc4702a0aced650ab8c3bed807c527b52253ce Add auto-resize desktop composer (8-line cap) HenriGrimm 2 hours ago origin/Orchestrator-board-upgrade, Orchestrator-board-upgrade',
    );

    assert.ok(parsed);
    assert.equal(parsed.hash, '330e95e8556a51d8c0962229089f387d617b4e48');
    assert.deepEqual(parsed.parents, ['f7fc4702a0aced650ab8c3bed807c527b52253ce']);
    assert.equal(parsed.subject, 'Add auto-resize desktop composer (8-line cap)');
    assert.equal(parsed.author, 'HenriGrimm');
    assert.equal(parsed.relativeTime, '2 hours ago');
    assert.deepEqual(parsed.refs, [
      'origin/Orchestrator-board-upgrade',
      'Orchestrator-board-upgrade',
    ]);
  });

  test('parses HEAD and remote refs after relative time', () => {
    const parsed = parseLogLine(
      '5f6816e56ada952293ea7eea2a26114c9577a246 6ac48bee66cf47b300cbb3b7c13febb71f489d67 fix(settings): update general settings description and add network access field HenriGrimm 13 minutes ago HEAD -> main, origin/main, origin/HEAD',
    );

    assert.ok(parsed);
    assert.equal(parsed.subject, 'fix(settings): update general settings description and add network access field');
    assert.equal(parsed.relativeTime, '13 minutes ago');
    assert.deepEqual(parsed.refs, ['HEAD -> main', 'origin/main', 'origin/HEAD']);
  });

  test('parses commits without decorators', () => {
    const parsed = parseLogLine(
      '6ac48bee66cf47b300cbb3b7c13febb71f489d67 381919a048e5ed140a02ceb7a401bc7cb9b0e3fc feat(network): implement LAN access and enhance network configuration HenriGrimm 36 minutes ago ',
    );

    assert.ok(parsed);
    assert.equal(parsed.subject, 'feat(network): implement LAN access and enhance network configuration');
    assert.deepEqual(parsed.refs, []);
  });

  test('parses %x1f-delimited lines with multi-word authors exactly', () => {
    const SEP = '\u001f';
    const parsed = parseLogLine(
      [
        '5f6816e56ada952293ea7eea2a26114c9577a246',
        '6ac48bee66cf47b300cbb3b7c13febb71f489d67',
        '🐛 Fix Super Plan research sources list overflow and scrolling',
        'Cursor Agent',
        '2 hours ago',
        'HEAD -> main, origin/main',
      ].join(SEP),
    );

    assert.ok(parsed);
    assert.equal(parsed.subject, '🐛 Fix Super Plan research sources list overflow and scrolling');
    assert.equal(parsed.author, 'Cursor Agent');
    assert.equal(parsed.relativeTime, '2 hours ago');
    assert.deepEqual(parsed.refs, ['HEAD -> main', 'origin/main']);
  });

  test('parses %x1f-delimited merge commits and empty fields', () => {
    const SEP = '\u001f';
    const parsed = parseLogLine(
      [
        '5f6816e56ada952293ea7eea2a26114c9577a246',
        '6ac48bee66cf47b300cbb3b7c13febb71f489d67 381919a048e5ed140a02ceb7a401bc7cb9b0e3fc',
        'Merge branch main into feature',
        'HenriGrimm',
        'just now',
        '',
      ].join(SEP),
    );

    assert.ok(parsed);
    assert.deepEqual(parsed.parents, [
      '6ac48bee66cf47b300cbb3b7c13febb71f489d67',
      '381919a048e5ed140a02ceb7a401bc7cb9b0e3fc',
    ]);
    assert.equal(parsed.author, 'HenriGrimm');
    assert.deepEqual(parsed.refs, []);
  });
});

test('history windows clamp inputs, retain all refs, and remove the sentinel', () => {
  const request = historyLogArgs(2.9, 3.9, true);
  assert.equal(request.size, 2);
  assert.equal(request.offset, 3);
  for (const flag of ['--all', '--topo-order', '--exclude=refs/stash', '--skip=3', '--decorate=full']) assert.ok(request.args.includes(flag));
  assert.equal(request.args.at(-1), '3');
  assert.equal(historyLogArgs(Infinity, NaN).size, 10);
  assert.equal(historyLogArgs(-4, -5).offset, 0);
  assert.equal(historyLogArgs(9000, 9e9).size, 200);
  assert.equal(historyLogArgs(1, 9e9).offset, 1_000_000);
  const line = (n) => [`${n}`.repeat(40), '', `Commit ${n}`, 'Tester', 'now', 'HEAD -> refs/heads/main, refs/remotes/upstream/main, tag: refs/tags/v1'].join('\u001f');
  const page = historyLogPage([line(1), line(2), line(3)].join('\n'), 2, 3);
  assert.equal(page.commits.length, 2);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextSkip, 5);
  assert.deepEqual(page.commits[0].refs, ['HEAD -> refs/heads/main', 'refs/remotes/upstream/main', 'tag: refs/tags/v1']);
  assert.equal(historyLogPage(line(1), 2, 0).nextSkip, null);
  assert.equal(historyLogPage('', 2, 0).hasMore, false);
});

test('consecutive real Git windows have no overlap and include remote-only history', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-history-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'History Tester');
    git('config', 'user.email', 'test@example.com');
    for (let i = 0; i < 5; i++) git('commit', '--allow-empty', '-m', `Commit ${i}`);
    git('tag', 'v1');
    git('checkout', '-b', 'remote-only');
    git('commit', '--allow-empty', '-m', 'Remote tip');
    git('update-ref', 'refs/remotes/upstream/remote-only', 'HEAD');
    git('checkout', 'main');
    git('branch', '-D', 'remote-only');
    const first = await log({ cwd, count: 3, fullRefs: true });
    const second = await log({ cwd, count: 3, skip: first.nextSkip, fullRefs: true, historyKey: first.historyKey });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.hasMore, true);
    assert.equal(second.hasMore, false);
    const all = [...first.commits, ...second.commits];
    assert.equal(new Set(all.map((c) => c.hash)).size, 6);
    assert.ok(all.some((c) => c.refs.includes('refs/remotes/upstream/remote-only')));
    const index = new Map(all.map((c, i) => [c.hash, i]));
    for (const c of all) for (const p of c.parents) assert.ok(index.get(p) > index.get(c.hash));
    git('commit', '--allow-empty', '-m', 'New head');
    const changed = await log({ cwd, count: 3, skip: first.nextSkip, historyKey: first.historyKey });
    assert.equal(changed.historyChanged, true);
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
});
