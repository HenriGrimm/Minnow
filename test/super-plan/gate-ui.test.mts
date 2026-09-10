import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { renderSuperPlanGate } from '../../src/ui/super-plan-gate.ts';
import type { Chat } from '../../src/types.ts';

test('gate keeps edits and focus during reconciliation and displays submission errors', async () => {
  const window = new Window();
  installHappyDomGlobals(window);
  const originalFetch = globalThis.fetch;
  try {
    const host = document.createElement('div'); document.body.append(host);
    const chat = { id: 'gate-ui', superPlanRunId: 'gate-ui', superPlanView: { gate: { gateId: 'g:1', kind: 'spec', question: 'Confirm?', choices: ['confirm', 'revise'] } } } as Chat;
    renderSuperPlanGate(host, chat);
    const input = host.querySelector('textarea')!;
    input.value = 'Keep keyboard support'; input.focus();
    renderSuperPlanGate(host, chat);
    assert.equal(host.querySelector('textarea'), input);
    assert.equal(document.activeElement, input);
    assert.equal(input.value, 'Keep keyboard support');
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'Server unavailable' }), { status: 503 })) as typeof fetch;
    host.querySelector('button')!.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(host.querySelector('[role="alert"]')!.textContent!, /Server unavailable/);
    assert.equal(host.querySelector('button')!.disabled, false);
    chat.superPlanView!.gate = null;
    renderSuperPlanGate(host, chat);
    assert.equal(host.querySelector('form'), null);
  } finally { globalThis.fetch = originalFetch; window.close(); }
});
