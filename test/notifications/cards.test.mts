/**
 * Activity records → notification card options (src/notifications/cards.ts).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { notificationCardOptions } from '../../src/notifications/cards.ts';
import type { NotificationRecord } from '../../src/notifications/types.ts';

function record(overrides: Partial<NotificationRecord>): NotificationRecord {
  return {
    id: 'n1',
    kind: 'chat_turn_complete',
    title: 'Fix flaky git test',
    preview: 'All 42 git tests pass.',
    chatId: 'chat-1',
    appId: 'code',
    createdAt: 0,
    read: false,
    ...overrides,
  };
}

describe('notification cards', () => {
  it('labels a finished turn and opens its chat', () => {
    const opened: NotificationRecord[] = [];
    const source = record({});
    const options = notificationCardOptions(source, (target) => opened.push(target));
    assert.ok(options);
    assert.equal(options.tone, 'success');
    assert.equal(options.source, 'Code');
    assert.equal(options.context, 'Fix flaky git test');
    assert.equal(options.title, 'Agent finished');
    assert.equal(options.message, 'All 42 git tests pass.');
    assert.equal(options.openLabel, 'Open chat');
    options.open?.();
    assert.deepEqual(opened, [source]);
  });

  it('gives questions a waiting card with an Answer action', async () => {
    const opened: NotificationRecord[] = [];
    const options = notificationCardOptions(record({ kind: 'chat_question' }), (target) => opened.push(target));
    assert.ok(options);
    assert.equal(options.tone, 'attention');
    assert.equal(options.durationMs, undefined, 'tone default (until handled) applies');
    assert.deepEqual(options.actions?.map((action) => action.label), ['Answer']);
    await options.actions?.[0].run({} as never);
    assert.equal(opened.length, 1);
  });

  it('keeps kinds with their own card or no news in Activity only', () => {
    for (const kind of ['device_request', 'synthesis', 'research', 'task_started', 'sub_agent_complete'] as const) {
      assert.equal(notificationCardOptions(record({ kind }), () => {}), null, kind);
    }
  });

  it('uses the record title when the kind has no label of its own', () => {
    const options = notificationCardOptions(
      record({ kind: 'provider_quota', title: 'Out of usage', chatId: undefined }),
      () => {},
    );
    assert.equal(options?.title, 'Out of usage');
    assert.equal(options?.context, undefined);
    assert.equal(options?.tone, 'error');
  });
});
