/**
 * MIN-206 — /followup composer command parsing.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MAX_FOLLOWUP_CHAIN,
  MAX_FOLLOWUP_TASK_CHARS,
  isFollowupSlashCommand,
  isNestedFollowupPrompt,
  parseFollowupSlashInput,
} from '../../src/chat/followup/parse-command.ts';

describe('parseFollowupSlashInput', () => {
  test('returns null for non-followup commands', () => {
    assert.equal(parseFollowupSlashInput('/git-commit fix'), null);
    assert.equal(parseFollowupSlashInput('hello'), null);
    assert.equal(parseFollowupSlashInput('/loop 5m check deploy'), null);
    assert.equal(parseFollowupSlashInput('/goal clear'), null);
  });

  test('bare /followup arms one agent-chosen follow-up', () => {
    assert.deepEqual(parseFollowupSlashInput('/followup'), {
      kind: 'arm',
      count: 1,
      promptText: '',
    });
    assert.deepEqual(parseFollowupSlashInput('  /followup  '), {
      kind: 'arm',
      count: 1,
      promptText: '',
    });
  });

  test('a prompt arms one follow-up with that task', () => {
    assert.deepEqual(parseFollowupSlashInput('/followup review the build'), {
      kind: 'arm',
      count: 1,
      promptText: 'review the build',
    });
  });

  test('a bare count arms that many follow-ups', () => {
    assert.deepEqual(parseFollowupSlashInput('/followup 3'), {
      kind: 'arm',
      count: 3,
      promptText: '',
    });
  });

  test('count plus prompt splits correctly', () => {
    assert.deepEqual(parseFollowupSlashInput('/followup 5 review the build for bugs and fix them'), {
      kind: 'arm',
      count: 5,
      promptText: 'review the build for bugs and fix them',
    });
  });

  test('clear aliases stop a chain', () => {
    for (const alias of ['stop', 'clear', 'off', 'cancel', 'reset', 'none']) {
      assert.deepEqual(parseFollowupSlashInput(`/followup ${alias}`), { kind: 'clear' });
    }
  });

  test('out-of-range counts are invalid', () => {
    assert.equal(parseFollowupSlashInput('/followup 0')?.kind, 'invalid');
    assert.equal(parseFollowupSlashInput(`/followup ${MAX_FOLLOWUP_CHAIN + 1}`)?.kind, 'invalid');
    assert.deepEqual(parseFollowupSlashInput(`/followup ${MAX_FOLLOWUP_CHAIN}`), {
      kind: 'arm',
      count: MAX_FOLLOWUP_CHAIN,
      promptText: '',
    });
  });

  test('keeps text before the token in the task (same rule as /loop)', () => {
    // Removing the token can leave a doubled space; /loop behaves identically and
    // the composer picker only ever inserts the command first.
    const parsed = parseFollowupSlashInput('do this /followup 2');
    assert.equal(parsed?.kind, 'arm');
    assert.equal(parsed && 'count' in parsed ? parsed.count : -1, 1);
    assert.equal(
      (parsed && 'promptText' in parsed ? parsed.promptText : '').replace(/\s+/g, ' '),
      'do this 2',
    );
  });

  test('caps the stored task text', () => {
    const parsed = parseFollowupSlashInput(`/followup ${'x'.repeat(5000)}`);
    assert.equal(parsed?.kind, 'arm');
    assert.equal(
      parsed && 'promptText' in parsed ? parsed.promptText.length : -1,
      MAX_FOLLOWUP_TASK_CHARS,
    );
  });
});

describe('isFollowupSlashCommand', () => {
  test('matches the command token only', () => {
    assert.equal(isFollowupSlashCommand('/followup'), true);
    assert.equal(isFollowupSlashCommand('  /FOLLOWUP 3 x'), true);
    assert.equal(isFollowupSlashCommand('try /followup'), true);
    assert.equal(isFollowupSlashCommand('/followups'), false);
    assert.equal(isFollowupSlashCommand('/loop 5m x'), false);
  });
});

describe('isNestedFollowupPrompt', () => {
  test('rejects a task that starts another chain', () => {
    assert.equal(isNestedFollowupPrompt('/followup 2 x'), true);
    assert.equal(isNestedFollowupPrompt('review the build'), false);
    assert.equal(isNestedFollowupPrompt('   '), false);
  });
});
