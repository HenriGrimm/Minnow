/**
 * V2 finish report pane: replaces the kanban, renders markdown, exposes actions.
 */
import '../tools/install-dom-before-imports.mts';

import assert from 'node:assert/strict';
import { afterEach, describe, mock, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { derive } from '../../server/orchestrator/core/derive.js';
import type { BoardState } from '../../server/orchestrator/core/types';

/** Captures follow-up navigation so tests can assert close-then-create, no seed. */
const followUpLog: Array<{ kind: string; payload?: unknown }> = [];
let fileTreeRefreshCalls = 0;

mock.module('../../src/ui/sidebar.ts', {
  namedExports: {
    createChatWithMode: (options: unknown) => {
      followUpLog.push({ kind: 'createChatWithMode', payload: options });
      return {};
    },
  },
});

mock.module('../../src/orchestrator/boards-view.ts', {
  namedExports: {
    closeBoardsView: async (options?: unknown) => {
      followUpLog.push({ kind: 'closeBoardsView', payload: options });
    },
  },
});

mock.module('../../src/state/git-api.ts', {
  namedExports: {
    gitCommit: async () => ({ ok: true }),
    gitPush: async () => ({ ok: true }),
  },
});

mock.module('../../src/ui/file-tree-refresh-bridge.ts', {
  namedExports: {
    refreshFileTreeViaBridge: async () => {
      fileTreeRefreshCalls += 1;
    },
  },
});

mock.module('../../src/state/worktree-service.ts', {
  namedExports: {
    cleanupBoardWorktrees: async () => ({ ok: true, removed: 0 }),
    mergeIntegrationIntoWorkspace: async () => ({ ok: true, merged: true }),
    openWorkspacePr: async () => ({ ok: true, url: 'https://example.test/pr' }),
    workspaceLandingStats: async () => ({
      ok: true,
      fileCount: 3,
      additions: 12,
      deletions: 2,
      hasRemote: false,
      hasGh: false,
      alreadyLanded: false,
    }),
  },
});

mock.module('dompurify', {
  defaultExport: {
    sanitize: (html: string) => html,
  },
});

const {
  renderBoardReport,
  wantsReportScreen,
  canReopenFailed,
  canFixFinal,
  clearBoardReportStateForTests,
  integrationBranchName,
  buildBoardFollowUpContext,
  startFollowUp,
} = await import('../../src/orchestrator/board-report.ts');
const { getPendingAttachments, clearAttachments } = await import(
  '../../src/attachments/store.ts'
);

let activeWindow: Window | undefined;

function setupDom(): void {
  activeWindow?.close();
  const win = new Window();
  activeWindow = win;
  installHappyDomGlobals(win);
}

afterEach(() => {
  followUpLog.length = 0;
  fileTreeRefreshCalls = 0;
  if (activeWindow) {
    clearAttachments();
    document.body.innerHTML = '';
    activeWindow.close();
    activeWindow = undefined;
  }
  clearBoardReportStateForTests();
});

function finishedBoard(): BoardState {
  return derive([
    {
      v: 1,
      seq: 1,
      type: 'board.created',
      boardId: 'b1',
      planPath: 'documentation/plans/x.md',
      name: 'Example',
      waves: [{ n: 1, name: 'Foundations' }],
      tasks: [
        { id: 'W1-A', title: 'A', wave: 1, dependsOn: [], touches: ['a.ts'] },
        { id: 'W1-B', title: 'B', wave: 1, dependsOn: [], touches: ['b.ts'] },
      ],
    },
    {
      v: 1,
      seq: 2,
      type: 'merge.succeeded',
      taskId: 'W1-A',
      sha: 'abc123abc123',
    },
    {
      v: 1,
      seq: 3,
      type: 'task.abandoned',
      taskId: 'W1-B',
      reason: 'builder-failed-twice',
    },
    {
      v: 1,
      seq: 4,
      type: 'final.test.ended',
      outcome: 'fail',
      runInstructions: 'npx tsc --noEmit',
    },
    {
      v: 1,
      seq: 5,
      type: 'run.finished',
      summary: '1 merged, 1 abandoned, final test fail',
    },
  ]);
}

describe('wantsReportScreen', () => {
  test('is true when finished or user-stopped', () => {
    const done = finishedBoard();
    assert.equal(wantsReportScreen(done), true);
    const stopped = derive([
      {
        v: 1,
        seq: 1,
        type: 'board.created',
        boardId: 'b1',
        planPath: 'p.md',
        tasks: [{ id: 'W1-A', title: 'A', wave: 1, dependsOn: [], touches: ['a.ts'] }],
        waves: [],
      },
      { v: 1, seq: 2, type: 'board.started', concurrency: 2 },
      { v: 1, seq: 3, type: 'board.stopped', reason: 'user' },
    ]);
    assert.equal(wantsReportScreen(stopped), true);
    assert.equal(canReopenFailed(done), true);
    assert.equal(canFixFinal(done), true);
  });
});

describe('renderBoardReport', () => {
  test('renders markdown, journal ledger, and actions instead of a pre dump', () => {
    setupDom();
    const state = finishedBoard();
    const node = renderBoardReport(state, '# Hello report\n\nDone.', false, {
      dismiss: () => {},
      reopen: () => {},
      fixFinal: () => {},
      resetTask: () => {},
    });
    assert.equal(node.querySelector('pre.ov2-finish__body'), null);
    assert.match(node.textContent ?? '', /Board blocked/);
    assert.match(node.textContent ?? '', /Hello report/);
    assert.match(node.textContent ?? '', /What the journal says/);
    assert.match(node.textContent ?? '', /Rerun 1 failed task/);
    assert.match(node.textContent ?? '', /Back to board/);
    assert.match(node.textContent ?? '', /Start follow-up chat/);
    assert.match(node.textContent ?? '', /npx tsc --noEmit/);
    assert.match(node.textContent ?? '', /Needs attention/);
    assert.match(node.textContent ?? '', /Run notes/);
  });

  test('Commit refreshes the file tree after landing changes', async () => {
    setupDom();
    const node = renderBoardReport(finishedBoard(), 'ok', false, {
      dismiss: () => {},
      reopen: () => {},
      fixFinal: () => {},
      resetTask: () => {},
    });
    const commit = node.querySelector<HTMLButtonElement>('.ov2-report-screen__commit-primary');
    assert.ok(commit);
    commit!.click();
    for (let i = 0; i < 40 && fileTreeRefreshCalls === 0; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(fileTreeRefreshCalls, 1);
  });

  test('Back to board calls dismiss', () => {
    setupDom();
    let dismissed = 0;
    const node = renderBoardReport(finishedBoard(), 'ok', false, {
      dismiss: () => {
        dismissed += 1;
      },
      reopen: () => {},
      fixFinal: () => {},
      resetTask: () => {},
    });
    const back = [...node.querySelectorAll('button')].find((b) => b.textContent === 'Back to board');
    assert.ok(back);
    back!.click();
    assert.equal(dismissed, 1);
  });
});

describe('integrationBranchName', () => {
  test('matches the engine worktree formula', () => {
    assert.equal(integrationBranchName('ant-game-build'), 'minnow/board/ant-game-build/integration');
  });
});

describe('buildBoardFollowUpContext', () => {
  test('includes title, plan, every task phase, and report; omits the review prompt', () => {
    const state = finishedBoard();
    const text = buildBoardFollowUpContext(state, '# Hello report\n\nDone.');
    assert.match(text, /Board: Example/);
    assert.match(text, /Board id: b1/);
    assert.match(text, /Plan: documentation\/plans\/x\.md/);
    assert.match(text, /minnow\/board\/b1\/integration/);
    assert.match(text, /Summary: 1 merged, 1 abandoned, final test fail/);
    assert.match(text, /W1-A \[merged\]: A/);
    assert.match(text, /W1-B \[abandoned\]: B/);
    assert.match(text, /Hello report/);
    assert.doesNotMatch(text, /Help me review/);
    assert.doesNotMatch(text, /Merged tasks:/);
  });
});

describe('startFollowUp', () => {
  test('closes Boards, opens General chat without a seed, and queues a title chip', async () => {
    setupDom();
    const input = document.createElement('textarea');
    input.id = 'msgInput';
    document.body.appendChild(input);
    const preview = document.createElement('div');
    preview.id = 'attachPreview';
    document.body.appendChild(preview);

    const state = finishedBoard();
    await startFollowUp(state, '# Hello report\n\nDone.');

    assert.deepEqual(
      followUpLog.map((entry) => entry.kind),
      ['closeBoardsView', 'createChatWithMode'],
    );
    assert.deepEqual(followUpLog[0].payload, { restoreChat: false });
    const createOpts = followUpLog[1].payload as { modeId?: string; initialUserMessage?: string };
    assert.equal(createOpts.modeId, 'general');
    assert.equal('initialUserMessage' in createOpts, false);

    const pending = getPendingAttachments();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].kind, 'text');
    assert.equal(pending[0].name, 'Example');
    assert.match(pending[0].text ?? '', /W1-B \[abandoned\]: B/);
    assert.doesNotMatch(pending[0].text ?? '', /Help me review/);
    assert.equal(document.activeElement, input);
  });

  test('Start follow-up chat does not auto-send', async () => {
    setupDom();
    const node = renderBoardReport(finishedBoard(), 'ok', false, {
      dismiss: () => {},
      reopen: () => {},
      fixFinal: () => {},
      resetTask: () => {},
    });
    const follow = [...node.querySelectorAll('button')].find(
      (b) => b.textContent === 'Start follow-up chat',
    );
    assert.ok(follow);
    follow!.click();
    for (let i = 0; i < 40 && !followUpLog.some((e) => e.kind === 'createChatWithMode'); i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const create = followUpLog.find((entry) => entry.kind === 'createChatWithMode');
    assert.ok(create);
    const opts = create!.payload as { initialUserMessage?: string };
    assert.equal(opts.initialUserMessage, undefined);
  });
});

// Saved reports must remain useful even when their evidence predates the current fold.
describe('structured report evidence', () => {
  test('renders structured run notes with task-style sections instead of raw markdown headings', () => {
    setupDom();
    const state = derive([
      {
        v: 1,
        seq: 1,
        type: 'board.created',
        boardId: 'b1',
        name: 'super-plan-server-side-run-engine',
        planPath: 'p.md',
        tasks: [{ id: 'W1-A', title: 'Fix D1', wave: 1, dependsOn: [], touches: [] }],
        waves: [],
      },
      { v: 1, seq: 2, type: 'board.stopped', reason: 'user' },
    ]);
    const markdown = [
      '# End-of-run report',
      '',
      '**super-plan-server-side-run-engine**',
      '',
      '## Summary',
      '',
      'Run stopped by the user. Partial progress below — this is not an error.',
      '',
      '## Shipped',
      '',
      '- **W1-A** — Fix D1 — propagate timeoutMs/modeId through spawn',
      '',
      '## Abandoned',
      '',
      '### W3-B',
      '',
      'Reason: user stopped the board',
      '',
      'Evidence:',
      '',
      '```json',
      JSON.stringify({
        by: 'user',
        outcome: 'abandoned',
        attempts: [
          { role: 'builder', outcome: 'crashed' },
          { role: 'builder', outcome: 'pass' },
        ],
      }),
      '```',
      '',
      'Next step: Reset W3-B and rerun the board.',
    ].join('\n');
    const node = renderBoardReport(state, markdown, false, {
      dismiss() {},
      reopen() {},
      fixFinal() {},
      resetTask() {},
    });
    const notes = node.querySelector<HTMLDetailsElement>('.ov2-report-notes')!;
    notes.open = true;
    notes.dispatchEvent(new window.Event('toggle'));
    const body = notes.querySelector('.ov2-report-card__body')!;
    assert.equal(body.querySelector('h1, h2'), null, 'raw markdown headings should not leak into Run notes');
    assert.ok(body.querySelector('.ov2-report-notes__section'));
    assert.ok(body.querySelector('.ov2-report-notes__shipped-row'));
    assert.ok(body.querySelector('.ov2-report-notes__task'));
    assert.match(body.textContent!, /Run stopped by the user/);
    assert.match(body.textContent!, /W1-A/);
    assert.match(body.textContent!, /Reset W3-B and rerun the board/);
    assert.doesNotMatch(body.textContent!, /End-of-run report/);
    const attempt = [...body.querySelectorAll('details')].find(
      (d) => d.querySelector('summary')?.textContent === '1. Builder · Crashed',
    );
    assert.ok(attempt);
  });

  test('converts saved JSON to labeled fields and defers large diagnostics', async () => {
    setupDom();
    const evidence = { by: 'user', attempts: [{ role: 'tester', outcome: 'fail', summary: '<img src=x onerror=alert(1)>', testOutput: 'compiler failure', diff: { files: ['src/example.ts'], patch: 'large patch' } }] };
    const node = renderBoardReport(finishedBoard(), 'Before\n\n```json\n' + JSON.stringify(evidence) + '\n```\n\nAfter', false, { dismiss() {}, reopen() {}, fixFinal() {}, resetTask() {} });
    document.body.append(node);
    assert.match(node.textContent!, /Stopped by/);
    assert.match(node.textContent!, /Before/);
    assert.match(node.textContent!, /After/);
    assert.equal(node.querySelector('img'), null);
    assert.doesNotMatch(node.textContent!, /compiler failure|large patch/);
    const attempt = [...node.querySelectorAll('details')].find((d) => d.querySelector('summary')?.textContent === '1. Tester · Fail')!;
    assert.ok(attempt);
    attempt.open = true;
    attempt.dispatchEvent(new window.Event('toggle'));
    assert.match(attempt.textContent!, /<img src=x onerror=alert\(1\)>/);
    assert.equal(attempt.querySelector('img'), null);
    const log = [...attempt.querySelectorAll('details')].find((d) => d.querySelector('summary')?.textContent === 'View test output')!;
    log.open = true;
    log.dispatchEvent(new window.Event('toggle'));
    log.dispatchEvent(new window.Event('toggle'));
    assert.equal(log.querySelectorAll('pre').length, 1);
    assert.equal(log.querySelector('pre')?.textContent, 'compiler failure');
  });

  test('keeps malformed JSON accessible behind a disclosure', () => {
    setupDom();
    const node = renderBoardReport(finishedBoard(), '```json\n{broken\n```', false, { dismiss() {}, reopen() {}, fixFinal() {}, resetTask() {} });
    const details = [...node.querySelectorAll('details')].find((d) => d.textContent === 'View recorded evidence')!;
    assert.ok(details);
    assert.equal(details.open, false);
    details.open = true;
    details.dispatchEvent(new window.Event('toggle'));
    assert.match(details.textContent!, /\{broken/);
  });

  test('task rows stay closed and open onto runs, files, and the merge commit', () => {
    setupDom();
    const state = finishedBoard();
    state.tasks.get('W1-A')!.attempts.push({ attemptId: 'a1', role: 'builder', worktree: null, seedKind: 'initial', ended: true, outcome: 'pass', summary: 'Implemented the fix', evidence: { files: ['a.ts'] }, manual: false, retired: false });
    const node = renderBoardReport(state, null, true, { dismiss() {}, reopen() {}, fixFinal() {}, resetTask() {} });
    const rows = [...node.querySelectorAll<HTMLDetailsElement>('.ov2-report-task')];
    assert.deepEqual(rows.map((row) => row.dataset.taskId), ['W1-A', 'W1-B']);
    const merged = rows[0];
    const notes = node.querySelector<HTMLDetailsElement>('.ov2-report-notes')!;
    assert.equal(merged.open, false);
    assert.equal(notes.open, false);
    // The builder attempt plus the journalled merge attempt.
    assert.match(merged.textContent!, /2 runs/);
    assert.match(merged.textContent!, /1 file/);
    assert.doesNotMatch(merged.textContent!, /Implemented the fix/);
    merged.open = true;
    merged.dispatchEvent(new window.Event('toggle'));
    assert.match(merged.textContent!, /Implemented the fix/);
    assert.match(merged.textContent!, /abc123abc123/);
    assert.equal(merged.querySelector('.ov2-report-file__name')?.textContent, 'a.ts');
    assert.match(node.textContent!, /Writing the end-of-run report/);
  });

  test('Needs attention lists the issue and a Reset button per unfinished task', () => {
    setupDom();
    const state = finishedBoard();
    state.tasks.get('W1-B')!.attempts.push({ attemptId: 'a-fail', role: 'builder', worktree: null, seedKind: 'initial', ended: true, outcome: 'blocked', summary: 'Could not reach the database.', evidence: { blockers: ['psql refused the connection'] }, manual: false, retired: false });
    const resets: string[] = [];
    const node = renderBoardReport(state, null, false, { dismiss() {}, reopen() {}, fixFinal() {}, resetTask: (id) => resets.push(id) });
    const rows = [...node.querySelectorAll<HTMLElement>('.ov2-attention__row')];
    // The failed integration check leads, then the abandoned task.
    assert.equal(rows.length, 2);
    assert.match(rows[0].textContent!, /Integration check/);
    assert.match(rows[0].textContent!, /npx tsc --noEmit/);
    const task = rows[1];
    assert.equal(task.dataset.taskId, 'W1-B');
    assert.match(task.textContent!, /The builder failed twice/);
    assert.match(task.textContent!, /psql refused the connection/);
    // Triage only: no attempts, patches, or evidence dumps in the row.
    assert.equal(task.querySelector('.ov2-run'), null);
    assert.equal(task.querySelector('details'), null);
    const reset = [...task.querySelectorAll('button')].find((b) => b.textContent === 'Reset task')!;
    assert.ok(reset);
    reset.click();
    assert.deepEqual(resets, ['W1-B']);
  });

  test('hides the attention group when every task merged and integration passed', () => {
    setupDom();
    const state = derive([
      {
        v: 1,
        seq: 1,
        type: 'board.created',
        boardId: 'b1',
        planPath: 'documentation/plans/x.md',
        name: 'Clean',
        waves: [{ n: 1, name: 'Foundations' }],
        tasks: [{ id: 'W1-A', title: 'A', wave: 1, dependsOn: [], touches: ['a.ts'] }],
      },
      { v: 1, seq: 2, type: 'merge.succeeded', taskId: 'W1-A', sha: 'abc123abc123' },
      { v: 1, seq: 3, type: 'final.test.ended', outcome: 'fail', runInstructions: 'npx tsc --noEmit' },
      { v: 1, seq: 4, type: 'run.finished', summary: '1 merged, final test fail' },
      { v: 1, seq: 5, type: 'board.reopened', taskIds: [], reason: 'user' },
      { v: 1, seq: 6, type: 'final.test.ended', outcome: 'pass', runInstructions: 'npx tsc --noEmit' },
      { v: 1, seq: 7, type: 'run.finished', summary: '1 merged, final test pass' },
    ]);
    const node = renderBoardReport(state, 'All good.', false, { dismiss() {}, reopen() {}, fixFinal() {}, resetTask() {} });
    assert.equal(node.querySelector('.ov2-report-screen__group--attention'), null);
    assert.equal(node.querySelector('.ov2-attention__row'), null);
    assert.match(node.textContent!, /Tasks/);
    assert.match(node.textContent!, /Board complete/);
    // A passing integration check is a stat tile, not a card to open.
    const integration = [...node.querySelectorAll('.ov2-stat-tile')].find((tile) =>
      tile.textContent?.includes('integration'),
    )!;
    assert.ok(integration);
    assert.equal(integration.getAttribute('data-tone'), 'good');
  });

  test('folds a long write-up into a run row and leads with journalled blockers', () => {
    setupDom();
    const state = finishedBoard();
    const wall =
      'W3-B complete. Build: created live-events then wrote a long paragraph about middleware UNIQUE_BURIED_TOKEN after many files.';
    state.tasks.get('W1-B')!.attempts.push({
      attemptId: 'a-fail',
      role: 'builder',
      worktree: null,
      seedKind: 'initial',
      ended: true,
      outcome: 'blocked',
      summary: wall,
      evidence: {
        blockers: ['psql refused'],
        needs: ['DATABASE_URL'],
        testOutput: 'connection refused',
        diff: {
          files: ['src/a.ts', 'src/b.ts'],
          patch: 'diff --git a/src/a.ts',
          truncated: true,
          originalLength: 51651,
        },
      },
      manual: false,
      retired: false,
    });
    const node = renderBoardReport(state, null, false, { dismiss() {}, reopen() {}, fixFinal() {}, resetTask() {} });
    const row = [...node.querySelectorAll<HTMLDetailsElement>('.ov2-report-task')].find(
      (card) => card.dataset.taskId === 'W1-B',
    )!;
    // The task row summarises; the runs only exist once it is opened.
    assert.match(row.textContent!, /2 files/);
    row.open = true;
    row.dispatchEvent(new window.Event('toggle'));
    const run = row.querySelector('.ov2-run')!;
    assert.ok(run);
    assert.match(run.textContent!, /W3-B complete\./);
    assert.match(run.textContent!, /psql refused/);
    assert.match(run.textContent!, /DATABASE_URL/);
    assert.doesNotMatch(run.textContent!, /UNIQUE_BURIED_TOKEN/);
    const writeUp = run.querySelector<HTMLDetailsElement>('.ov2-attempt-writeup__full')!;
    assert.equal(writeUp.open, false);
    writeUp.open = true;
    writeUp.dispatchEvent(new window.Event('toggle'));
    assert.match(run.textContent!, /UNIQUE_BURIED_TOKEN/);
    // Test output stays behind one disclosure; the raw patch is not in the report.
    const output = [...run.querySelectorAll('details')].find(
      (d) => d.querySelector('summary')?.textContent === 'View test output',
    )!;
    assert.ok(output);
    assert.doesNotMatch(run.textContent!, /connection refused/);
    output.open = true;
    output.dispatchEvent(new window.Event('toggle'));
    assert.match(output.textContent!, /connection refused/);
    assert.equal(
      [...row.querySelectorAll('summary')].some((s) => s.textContent?.includes('View patch')),
      false,
    );
    // Files are deduped onto the task, with the paths the attempts recorded.
    assert.deepEqual(
      [...row.querySelectorAll('.ov2-report-file__path')].map((n) => n.textContent),
      ['src/a.ts', 'src/b.ts'],
    );
  });
});
