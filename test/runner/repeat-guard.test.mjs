import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRepeatGuard, REPEAT_WARN_AT } from '../../server/runner/repeat-guard.js';

test('warns about repeated read-like calls', () => {
  const guard = createRepeatGuard();
  let result;
  for (let i = 0; i < REPEAT_WARN_AT; i += 1) {
    result = guard.note('execute_command', '{"command":"false"}', 'exit 1');
  }
  assert.equal(result?.count, REPEAT_WARN_AT);
  assert.match(result?.warning ?? '', /same result 3 times/);
});

test('allows repeated navigation to the same URL to reload application state', () => {
  const guard = createRepeatGuard({ maxRepeats: 4 });
  for (let i = 0; i < 6; i += 1) {
    assert.deepEqual(
      guard.note('browser_navigate', '{"url":"http://localhost:5173"}', 'Navigated'),
      { count: 0, warning: null, stop: false },
    );
  }
});
