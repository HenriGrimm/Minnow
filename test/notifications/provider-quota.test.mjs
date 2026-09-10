/**
 * "Out of usage" notice: it fires once per reset window, ignores replayed
 * board history, and never fires for ordinary rate-limit backpressure.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

const QUOTA_ERROR =
  'Upstream HTTP 429: Weekly usage limit reached. Resets in 3 days. To continue using ' +
  'this model now, enable usage from your available balance.';

describe('out-of-usage notice', () => {
  let prefs;
  let store;
  let quota;
  let generations;

  beforeEach(async () => {
    const { Window } = await import('happy-dom');
    const win = new Window();
    const g = globalThis;
    g.window = win;
    g.document = win.document;
    g.localStorage = win.localStorage;
    g.requestAnimationFrame = (fn) => win.setTimeout(fn, 0);
    prefs = await import('../../src/notifications/prefs.ts');
    store = await import('../../src/notifications/store.ts');
    quota = await import('../../src/notifications/provider-quota.ts');
    generations = await import('../../src/api/generations.ts');
    prefs.resetNotificationPrefsForTests();
    store.resetNotificationStoreForTests();
    quota.resetOutOfUsageNoticeForTests();
    win.localStorage.clear();
  });

  afterEach(() => {
    prefs.resetNotificationPrefsForTests();
    store.resetNotificationStoreForTests();
    quota.resetOutOfUsageNoticeForTests();
  });

  test('a spent allowance raises one notification', () => {
    const raised = quota.noticeOutOfUsage({
      status: 'error',
      errorMessage: QUOTA_ERROR,
      chosenProviderId: 'opencode-go',
    });
    assert.equal(raised, true);
    assert.equal(store.getUnreadNotificationCount(), 1);
  });

  test('a second failure inside the window stays quiet', () => {
    const event = { status: 'error', errorMessage: QUOTA_ERROR, chosenProviderId: 'opencode-go' };
    assert.equal(quota.noticeOutOfUsage(event, 1_000), true);
    assert.equal(quota.noticeOutOfUsage(event, 2_000), false);
    assert.equal(store.getUnreadNotificationCount(), 1);
  });

  test('a replayed board.stopped from yesterday is history, not news', () => {
    const now = 1_700_000_000_000;
    assert.equal(quota.noticeBoardOutOfUsage('b1', now - 12 * 60 * 60 * 1000, now), false);
    assert.equal(store.getUnreadNotificationCount(), 0);
  });

  test('a board that just halted does notify', () => {
    const now = 1_700_000_000_000;
    assert.equal(quota.noticeBoardOutOfUsage('b1', now - 1_000, now), true);
    assert.equal(store.getUnreadNotificationCount(), 1);
  });

  test('isOutOfUsageError separates a spent cap from backpressure', () => {
    assert.equal(generations.isOutOfUsageError({ status: 'error', quotaExceeded: true }), true);
    assert.equal(generations.isOutOfUsageError({ status: 'error', errorMessage: QUOTA_ERROR }), true);
    assert.equal(
      generations.isOutOfUsageError({ status: 'error', errorMessage: 'Upstream HTTP 429' }),
      false,
    );
    assert.equal(generations.isOutOfUsageError(undefined), false);
  });

  test('the raw provider blob is rewritten into one readable line', () => {
    const message = generations.formatGenerationErrorMessage(QUOTA_ERROR);
    assert.match(message, /^Out of usage\./);
    assert.match(message, /Resets in 3 days\./);
    assert.ok(!message.includes('Upstream HTTP 429'), message);
  });
});
