/**
 * Tool approval queue abort signal (P8-A / MIN-754).
 *
 * Stubs the modal so these tests do not need the composer DOM.
 * The stub honours `request.signal` the same way the real strip dismisses.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import type { ToolApprovalDecision, ToolApprovalRequest } from '../../src/tools/tool-approval-types.ts';

type Decision = ToolApprovalDecision;
const ALLOW: Decision = { kind: 'allow-once' };
const CHAT: Decision = { kind: 'allow-chat' };
const DENY: Decision = { kind: 'deny' };

const showCalls: ToolApprovalRequest[] = [];
const pendingResolvers: Array<(decision: Decision) => void> = [];

mock.module('../../src/ui/tool-approval-modal.ts', {
  namedExports: {
    showToolApprovalModal: (request: ToolApprovalRequest) => {
      showCalls.push(request);
      if (request.signal?.aborted) return Promise.resolve(DENY);
      return new Promise<Decision>((resolve) => {
        pendingResolvers.push(resolve);
        request.signal?.addEventListener(
          'abort',
          () => resolve(DENY),
          { once: true },
        );
      });
    },
  },
});

const queue = await import('../../src/tools/approval-queue.ts');

function sampleRequest(
  overrides: Partial<ToolApprovalRequest> = {},
): ToolApprovalRequest {
  return {
    toolName: 'save_file',
    title: 'save_file',
    argsJson: '{"path":"src/a.ts"}',
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  showCalls.length = 0;
  pendingResolvers.length = 0;
  queue.resetApprovalQueueForTests();
});

afterEach(() => {
  for (const resolve of pendingResolvers) resolve(DENY);
  pendingResolvers.length = 0;
  queue.resetApprovalQueueForTests();
});

describe('enqueueToolApproval AbortSignal', () => {
  test('already-aborted request resolves cancel without showing the modal', async () => {
    const abort = new AbortController();
    abort.abort();
    const decision = await queue.enqueueToolApproval(
      sampleRequest({ signal: abort.signal }),
    );
    assert.deepEqual(decision, DENY);
    assert.equal(showCalls.length, 0);
    assert.equal(queue.hasPendingToolApproval(), false);
  });

  test('abort while queued (not yet shown) resolves cancel and does not stall', async () => {
    const first = new AbortController();
    const shown = queue.enqueueToolApproval(sampleRequest({ toolName: 'first' }));
    await flush();
    assert.equal(showCalls.length, 1);

    const queuedAbort = new AbortController();
    const waiting = queue.enqueueToolApproval(
      sampleRequest({ toolName: 'queued', signal: queuedAbort.signal }),
    );
    await flush();
    assert.equal(showCalls.length, 1, 'second entry waits behind the open strip');

    queuedAbort.abort();
    assert.deepEqual(await waiting, DENY);

    pendingResolvers[0]?.(ALLOW);
    assert.deepEqual(await shown, ALLOW);
    await flush();
    assert.equal(showCalls.length, 1, 'aborted waiter must never reach the modal');
    assert.equal(queue.hasPendingToolApproval(), false);
  });

  test('abort while the modal is open resolves cancel and the next queued approval still shows', async () => {
    const firstAbort = new AbortController();
    const first = queue.enqueueToolApproval(
      sampleRequest({ toolName: 'open', signal: firstAbort.signal }),
    );
    const second = queue.enqueueToolApproval(sampleRequest({ toolName: 'next' }));
    await flush();
    assert.equal(showCalls[0]?.toolName, 'open');

    firstAbort.abort();
    assert.deepEqual(await first, DENY);
    await flush();
    assert.equal(showCalls[1]?.toolName, 'next', 'queue must drain after abort');

    pendingResolvers.at(-1)?.(CHAT);
    assert.deepEqual(await second, CHAT);
    assert.equal(queue.hasPendingToolApproval(), false);
  });

  test('happy path still forwards allow-once', async () => {
    const pending = queue.enqueueToolApproval(sampleRequest());
    await flush();
    pendingResolvers[0]?.(ALLOW);
    assert.deepEqual(await pending, ALLOW);
  });
});

describe('settleQueuedApprovalsForGrant', () => {
  const grantAction = (key: string, risk: 'low' | 'elevated' | 'high' = 'elevated') => ({
    tool: 'execute_command', kind: 'shell' as const, mutates: true, external: false, risk,
    reasons: [], resources: [], floor: false, title: 'Run', detail: 'npm test',
    grant: { key, label: '`npm test` commands' },
  });

  test('allows queued requests with the same grant and leaves others waiting', async () => {
    const open = queue.enqueueToolApproval(sampleRequest({ toolName: 'open' }));
    await flush();
    const same = queue.enqueueToolApproval(sampleRequest({ toolName: 'same', chatId: 'c1', action: grantAction('shell:npm test') }));
    const high = queue.enqueueToolApproval(sampleRequest({ toolName: 'high', chatId: 'c1', action: grantAction('shell:npm test', 'high') }));
    const other = queue.enqueueToolApproval(sampleRequest({ toolName: 'other', chatId: 'c2', action: grantAction('shell:npm test') }));

    queue.settleQueuedApprovalsForGrant('shell:npm test', 'c1');
    assert.deepEqual(await same, ALLOW);
    assert.equal(queue.pendingToolApprovalCount(), 3, 'open card + high-risk + other chat remain');

    pendingResolvers[0]?.(ALLOW);
    assert.deepEqual(await open, ALLOW);
    await flush();
    pendingResolvers.at(-1)?.(DENY);
    assert.deepEqual(await high, DENY);
    await flush();
    pendingResolvers.at(-1)?.(DENY);
    assert.deepEqual(await other, DENY);
  });
});
