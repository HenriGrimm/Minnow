/**
 * MIN-206 — /followup seed message shape.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MAX_FOLLOWUP_SEED_TASK_CHARS,
  composeFollowupSeedMessage,
  fallbackFollowupTask,
  followupTitleSeed,
} from '../../src/chat/followup/seed-message.ts';

describe('composeFollowupSeedMessage', () => {
  test('renders the header and both sections', () => {
    const message = composeFollowupSeedMessage({
      sourceChatName: 'Build work',
      index: 1,
      total: 5,
      summary: 'Chat: Build work\n\nUser requests:\n- fix the build',
      taskText: 'review the build for bugs and fix them',
    });

    assert.equal(
      message,
      [
        'Follow-up 1/5 · continuing from "Build work"',
        '## Context from the previous chat',
        'Chat: Build work\n\nUser requests:\n- fix the build',
        '## Your task',
        'review the build for bugs and fix them',
      ].join('\n\n'),
    );
    assert.ok(message.indexOf('## Context from the previous chat') < message.indexOf('## Your task'));
  });

  test('falls back to a placeholder name and trims the task', () => {
    const message = composeFollowupSeedMessage({
      sourceChatName: '   ',
      index: 3,
      total: 3,
      summary: 'summary',
      taskText: '  do the thing  ',
    });
    assert.match(message, /^Follow-up 3\/3 · continuing from "previous chat"/);
    assert.ok(message.endsWith('do the thing'));
  });

  test('caps the task text', () => {
    const message = composeFollowupSeedMessage({
      sourceChatName: 'X',
      index: 1,
      total: 1,
      summary: 's',
      taskText: 't'.repeat(9000),
    });
    assert.equal(message.split('## Your task\n\n')[1]?.length, MAX_FOLLOWUP_SEED_TASK_CHARS);
  });
});

describe('followupTitleSeed', () => {
  test('takes the first line only', () => {
    assert.equal(followupTitleSeed('review the build\nfor bugs'), 'review the build');
  });

  test('collapses whitespace and caps the length', () => {
    assert.equal(followupTitleSeed('  review   the build  '), 'review the build');
    assert.equal(followupTitleSeed('x'.repeat(200)).length, 80);
  });

  test('is empty for an empty task', () => {
    assert.equal(followupTitleSeed('   '), '');
  });
});

describe('fallbackFollowupTask', () => {
  const summary = [
    'Chat: Build work',
    'User requests:',
    '- fix the build',
    '- ship it',
    '',
    'Where it ended:',
    'done',
  ].join('\n');

  test('reuses the most recent request', () => {
    assert.equal(
      fallbackFollowupTask(summary),
      'Continue the work from the previous chat: fix the build',
    );
  });

  test('caps the reused request', () => {
    const long = `User requests:\n- ${'y'.repeat(500)}`;
    const task = fallbackFollowupTask(long);
    assert.ok(task.length <= 'Continue the work from the previous chat: '.length + 200);
  });

  test('always returns a usable task', () => {
    assert.equal(fallbackFollowupTask(''), 'Continue the work from the previous chat.');
    assert.equal(
      fallbackFollowupTask('Chat: X\n\nWhere it ended:\nnothing'),
      'Continue the work from the previous chat.',
    );
  });
});
