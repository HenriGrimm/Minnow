/**
 * Issues workflow seed builders + status helpers (MIN-261 Phase 3).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildIssueContextBlock,
  buildIssueDebugSeed,
  buildIssueForegroundModeSeed,
  buildIssueForegroundSeed,
  buildIssuePlanSeed,
  canRunIssueWorkflow,
  canSendIssueToBoard,
  formatIssueCodeRefLine,
  issueActivityChip,
  issueActivityTarget,
  issueCodeRefsToLaunch,
  ISSUE_FOREGROUND_CHAT_MODES,
  issuePlanPathForId,
  resolveIssuePlanPath,
} from '../../src/chat/issues/workflow-seeds.ts';
import type { IssueCard } from '../../src/types.ts';

function makeIssue(overrides: Partial<IssueCard> = {}): IssueCard {
  return {
    id: 'ISS-42',
    type: 'bug',
    title: 'Null when saving settings',
    description: 'Repro: open Settings, click Save.',
    status: 'todo',
    priority: 'high',
    labels: ['settings'],
    workspacePath: '/workspace',
    createdAt: 1,
    updatedAt: 1,
    notes: 'Likely in appearance store.',
    codeRefs: [
      {
        path: 'src/ui/settings-page.ts',
        startLine: 10,
        endLine: 20,
        snippet: 'export function openSettings() {}',
      },
    ],
    ...overrides,
  };
}

describe('issues workflow seeds', () => {
  test('issuePlanPathForId uses documentation/plans/issues/', () => {
    assert.equal(issuePlanPathForId('ISS-42'), 'documentation/plans/issues/ISS-42.md');
  });

  test('formatIssueCodeRefLine and issueCodeRefsToLaunch', () => {
    assert.equal(
      formatIssueCodeRefLine({ path: 'a/b.ts', startLine: 3, endLine: 5 }),
      'a/b.ts:3-5',
    );
    const launch = issueCodeRefsToLaunch(makeIssue());
    assert.equal(launch.length, 1);
    assert.equal(launch[0]?.path, 'src/ui/settings-page.ts');
    assert.equal(launch[0]?.startLine, 10);
    assert.equal(launch[0]?.endLine, 20);
    assert.match(launch[0]?.text ?? '', /openSettings/);
  });

  test('buildIssuePlanSeed points at the issues plan path', () => {
    const path = 'documentation/plans/issues/ISS-42.md';
    const seed = buildIssuePlanSeed(makeIssue(), path);
    assert.match(seed, /Plan mode/);
    assert.match(seed, /documentation\/plans\/issues\/ISS-42\.md/);
    assert.match(seed, /do not implement/i);
  });

  test('buildIssueDebugSeed carries full context', () => {
    const seed = buildIssueDebugSeed(makeIssue());
    assert.match(seed, /Debug this issue/);
    assert.match(seed, /Likely in appearance store/);
    assert.ok(seed.includes(buildIssueContextBlock(makeIssue()).slice(0, 40)));
  });

  test('foreground mode lists and seeds', () => {
    assert.deepEqual(ISSUE_FOREGROUND_CHAT_MODES, ['general', 'build', 'plan', 'debug']);
    assert.match(buildIssueForegroundSeed(makeIssue(), 'build'), /Build mode/);
    assert.match(buildIssueForegroundModeSeed(makeIssue(), 'general'), /General mode/);
    assert.match(buildIssueForegroundModeSeed(makeIssue(), 'plan'), /Plan mode/);
  });

  test('canSendIssueToBoard requires planPath', () => {
    assert.equal(canSendIssueToBoard(makeIssue()), false);
    assert.equal(
      canSendIssueToBoard(makeIssue({ planPath: 'documentation/plans/issues/ISS-42.md' })),
      true,
    );
  });

  test('canRunIssueWorkflow respects closed statuses', () => {
    assert.equal(canRunIssueWorkflow(makeIssue({ status: 'done' })), false);
    assert.equal(canRunIssueWorkflow(makeIssue({ status: 'canceled' })), false);
  });

  test('resolveIssuePlanPath prefers existing planPath', () => {
    assert.equal(resolveIssuePlanPath(makeIssue()), 'documentation/plans/issues/ISS-42.md');
    assert.equal(
      resolveIssuePlanPath(makeIssue({ planPath: 'documentation/plans/issues/custom.md' })),
      'documentation/plans/issues/custom.md',
    );
  });

  test('issueActivityChip for board / planning / investigating', () => {
    assert.equal(issueActivityChip(makeIssue({ status: 'review' })), 'In review');
    assert.equal(
      issueActivityChip(
        makeIssue({ status: 'in_progress', boardChatId: 'chat-1' }),
      ),
      'On board',
    );
    assert.equal(
      issueActivityChip(
        makeIssue({ status: 'in_progress', planRunId: 'run-1', notes: 'x' }),
      ),
      'Planning…',
    );
    assert.equal(
      issueActivityChip(
        makeIssue({
          status: 'in_progress',
          investigateRunId: 'run-2',
          notes: '',
        }),
      ),
      'Investigating…',
    );
    assert.equal(
      issueActivityChip(
        makeIssue({
          status: 'in_progress',
          investigateRunId: 'run-2',
          notes: 'done looking',
        }),
      ),
      null,
    );
  });

  test('issueActivityTarget for sub-agent and board chips', () => {
    assert.deepEqual(
      issueActivityTarget(
        makeIssue({ status: 'in_progress', boardChatId: 'chat-board' }),
      ),
      { kind: 'board_chat', chatId: 'chat-board' },
    );
    assert.deepEqual(
      issueActivityTarget(
        makeIssue({ status: 'in_progress', planRunId: 'run-plan' }),
      ),
      { kind: 'sub_agent', runId: 'run-plan' },
    );
    assert.deepEqual(
      issueActivityTarget(
        makeIssue({
          status: 'in_progress',
          investigateRunId: 'run-inv',
          notes: '',
        }),
      ),
      { kind: 'sub_agent', runId: 'run-inv' },
    );
    assert.equal(issueActivityTarget(makeIssue({ status: 'review' })), null);
    assert.equal(
      issueActivityTarget(
        makeIssue({
          status: 'in_progress',
          investigateRunId: 'run-2',
          notes: 'done looking',
        }),
      ),
      null,
    );
  });
});
