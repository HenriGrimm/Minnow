/**
 * Tests for client-side tool permission / workspace prompt heuristics.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  blockAfkInteractionAttempt,
  companionToolRequiresApproval,
  outsideWorkspaceBlockMessage,
  toolInvocationWouldPrompt,
} from '../../src/tools/permission-gate.ts';
import { defaultToolConfig, setToolConfigForTests } from '../../src/tools/config.ts';
import {
  createEmptyChatObject,
  flushScheduledSessionSaveForTests,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import type { ChatGroup } from '../../src/types.ts';

afterEach(() => {
  flushScheduledSessionSaveForTests();
  setSessionStateForTests(null);
  setToolConfigForTests(defaultToolConfig());
});

describe('companionToolRequiresApproval', () => {
  test('forces approval for mutating and command tools', () => {
    assert.equal(companionToolRequiresApproval('save_file'), true);
    assert.equal(companionToolRequiresApproval('git_commit'), true);
    assert.equal(companionToolRequiresApproval('execute_command'), true);
  });

  test('does not force an extra prompt for read-only tools', () => {
    assert.equal(companionToolRequiresApproval('read_file'), false);
    assert.equal(companionToolRequiresApproval('web_search'), false);
    assert.equal(companionToolRequiresApproval('git_status'), false);
  });
});

describe('toolInvocationWouldPrompt', () => {
  test('ask mode prompts even when paths are inside workspace', () => {
    assert.equal(
      toolInvocationWouldPrompt(
        'read_file',
        { path: 'src/foo.ts' },
        'ask',
        'workspace',
        'C:/proj',
      ),
      true,
    );
  });

  test('full permission skips modal when paths stay inside workspace', () => {
    assert.equal(
      toolInvocationWouldPrompt(
        'read_file',
        { path: 'src/foo.ts' },
        'full',
        'workspace',
        'C:/proj',
      ),
      false,
    );
  });

  test('full permission blocks without modal when path escapes workspace in workspace FS mode', () => {
    assert.equal(
      toolInvocationWouldPrompt(
        'read_file',
        { path: 'C:/Windows/system.ini' },
        'full',
        'workspace',
        'C:/proj',
      ),
      false,
    );
  });

  test('full filesystem mode skips path-only prompt', () => {
    assert.equal(
      toolInvocationWouldPrompt(
        'read_file',
        { path: 'C:/Windows/system.ini' },
        'full',
        'full',
        'C:/proj',
      ),
      false,
    );
  });

  test('outsideWorkspaceBlockMessage matches server copy', () => {
    assert.equal(
      outsideWorkspaceBlockMessage('/'),
      'Error: Path "/" resolves outside the workspace directory. Enable full disk access in Settings → General → Filesystem access (dangerous) to allow paths outside the workspace.',
    );
  });
});

describe('leftover interaction execution guard', () => {
  test('no longer skips prompts based on leftover board flags', () => {
    const planner = createEmptyChatObject('model', '/tmp/ws');
    planner.id = 'planner-leftover';
    planner.modeId = 'orchestrate';
    const group: ChatGroup = {
      id: 'group-leftover',
      name: 'Leftover board',
      workspacePath: '/tmp/ws',
      collapsed: false,
      order: 0,
      plannerChatId: planner.id,
      orchestrateBoard: {
        planPath: 'documentation/plans/leftover.md',
        tasks: [{ id: 'W1-A', title: 'Task', wave: 'W1', category: 'build', status: 'planned' }],
        waves: [{ id: 'W1' }],
        startedAt: 1,
        lastUpdatedAt: 1,
        status: 'running',
      },
    };
    setSessionStateForTests({
      version: 5,
      activeId: planner.id,
      chats: [planner],
      groups: [group],
    });

    const result = blockAfkInteractionAttempt(
      { chatId: planner.id, modeId: 'orchestrate' },
      'question',
      'ask_question was attempted',
    );

    assert.equal(result, null);
  });
});
