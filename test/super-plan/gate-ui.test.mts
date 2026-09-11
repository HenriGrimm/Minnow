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
    host.hidden = true;
    renderSuperPlanGate(host, chat);
    assert.equal(host.hidden, false, 'reconciliation restores a hidden question host');
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

test('structured questions keep selections across updates and submit a complete answer batch', async () => {
  const window = new Window(); installHappyDomGlobals(window);
  const originalFetch = globalThis.fetch;
  try {
    const host = document.createElement('div'); document.body.append(host);
    const questions = [
      { id: 'layout', prompt: 'Choose a layout', options: [{ id: 'a', label: 'Compact' }, { id: 'b', label: 'Comfortable' }] },
      { id: 'features', prompt: 'Choose features', allow_multiple: true, options: [{ id: 'x', label: 'Search' }, { id: 'y', label: 'Export' }] },
    ];
    const chat = { id: 'batch', superPlanRunId: 'batch', superPlanView: { gate: { gateId: 'batch:1', kind: 'question', question: 'Fallback', questions } } } as Chat;
    const sent: any[] = [];
    globalThis.fetch = (async (_url, options) => {
      if (options?.method === 'POST') sent.push(JSON.parse(String(options.body)));
      return new Response(JSON.stringify({ ok: true, state: {} }));
    }) as typeof fetch;
    renderSuperPlanGate(host, chat);
    host.querySelector('button')!.click();
    assert.match(host.querySelector('[role="alert"]')!.textContent!, /Answer each/);
    const radio = host.querySelector<HTMLInputElement>('input[value="b"]')!;
    radio.click();
    host.querySelector<HTMLInputElement>('input[value="x"]')!.click();
    host.querySelector<HTMLInputElement>('input[value="y"]')!.click();
    renderSuperPlanGate(host, chat);
    assert.equal(host.querySelector('input[value="b"]'), radio);
    assert.equal(radio.checked, true);
    host.querySelector('button')!.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(JSON.parse(sent[0].answer), { status: 'answered', answers: [
      { questionId: 'layout', selectedIds: ['b'], otherText: null },
      { questionId: 'features', selectedIds: ['x', 'y'], otherText: null },
    ] });
  } finally { globalThis.fetch = originalFetch; window.close(); }
});
