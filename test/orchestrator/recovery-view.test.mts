import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { emptyState } from '../../server/orchestrator/core/derive.js';
import { recoveryHold } from '../../server/orchestrator/core/recovery.js';
import { renderRecovery } from '../../src/orchestrator/recovery-view.ts';

test('action holds escape diagnostics, prevent duplicate clicks and recover from a failed check', async () => {
  const window = new Window();
  globalThis.document = window.document as unknown as Document;
  try {
    const state = emptyState();
    state.status = 'running';
    const message = '<script>alert(1)</script> العربية 中文 ' + 'x'.repeat(300);
    const hold = recoveryHold(state, { taskId: 'A', role: 'builder', now: 1000, failure: { category: 'prerequisite', scope: 'task', message, fingerprint: 'missing-device' } });
    state.recoveryHolds[hold.key] = hold;
    let calls = 0;
    let rejectCheck!: (error: Error) => void;
    const view = renderRecovery(state, async () => {
      calls += 1;
      await new Promise<void>((_, reject) => { rejectCheck = reject; });
    })!;
    document.body.appendChild(view);
    assert.equal(view.querySelector('script'), null);
    assert.ok(view.textContent?.includes(message));
    const button = view.querySelector('button') as HTMLButtonElement;
    button.click();
    button.click();
    assert.equal(calls, 1);
    assert.equal(button.disabled, true);
    rejectCheck(new Error('The prerequisite is still unavailable'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(button.disabled, false);
    assert.match(view.querySelector('[role=status]')!.textContent!, /still unavailable/);
  } finally { await window.happyDOM.abort(); }
});

test('automatic waits need no button and stopped boards do not offer automatic execution', async () => {
  const window = new Window();
  globalThis.document = window.document as unknown as Document;
  try {
    const state = emptyState();
    assert.equal(renderRecovery(state, async () => {}), null);
    state.status = 'running';
    const hold = recoveryHold(state, { role: 'builder', now: 1000, failure: { category: 'unavailable', scope: 'task', message: 'Provider loading', fingerprint: 'loading' } });
    state.recoveryHolds[hold.key] = hold;
    const waiting = renderRecovery(state, async () => {})!;
    assert.equal(waiting.querySelector('button'), null);
    assert.match(waiting.textContent!, /Resumes automatically/);
    state.status = 'stopped';
    hold.attention = true;
    const stopped = renderRecovery(state, async () => { throw new Error('must not execute'); })!;
    assert.equal(stopped.querySelector('button'), null);
    assert.match(stopped.textContent!, /when you start/);
  } finally { await window.happyDOM.abort(); }
});
