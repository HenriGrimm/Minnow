/**
 * Failed server-run turns render a specific, recoverable card at the end of
 * the transcript (regression: the card was removed and failed chats went blank).
 */
import '../tools/install-dom-before-imports.mts';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { Chat } from '../../src/types.ts';

const g = globalThis as unknown as Record<string, unknown>;
const win = g.window as Window & typeof globalThis;
g.localStorage = win.localStorage;
g.sessionStorage = win.sessionStorage;
g.Event = win.Event;
g.CustomEvent = win.CustomEvent;

const { createEmptyChatObject, setSessionStateForTests } = await import('../../src/state/sessions.ts');
const { syncTurnFailureCard, shouldShowTurnFailure } = await import('../../src/ui/turn-failure-card.ts');

const CHAT_ID = '44444444-4444-4444-4444-444444444444';
const realFetch = globalThis.fetch;
let calls: { url: string; body: any }[] = [];

function failedChat(overrides: Partial<NonNullable<Chat['agentExecution']>> = {}, history: Chat['history'] = []): Chat {
  const chat = createEmptyChatObject('gpt-5');
  chat.id = CHAT_ID;
  chat.chatCommandVersion = 1;
  chat.providerId = 'codex-cli';
  chat.historyDigest = 'a'.repeat(64);
  chat.history = history.length ? history : [{ role: 'user', content: 'Fix the build', commandId: 'cmd-1' } as Chat['history'][number]];
  chat.agentExecution = { executionId: 'exec-1', commandId: 'cmd-1', status: 'failed', error: 'Something odd', ...overrides };
  setSessionStateForTests({ version: 5, activeId: chat.id, sidebarCollapsed: false, chats: [chat], groups: [] } as never);
  return chat;
}

function mountArea(): HTMLElement {
  document.body.replaceChildren();
  const area = document.createElement('div');
  area.id = 'chatArea';
  const row = document.createElement('div');
  row.className = 'msg user';
  area.append(row);
  document.body.append(area);
  return area;
}

const card = (area: HTMLElement) => area.querySelector<HTMLElement>(':scope > .chat-turn-failure');
const labels = (area: HTMLElement) => [...card(area)!.querySelectorAll('button')].map(button => button.textContent);

beforeEach(() => {
  calls = [];
  win.localStorage.clear();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url.endsWith('/history')) {
      return new Response(JSON.stringify({
        receipt: { chatId: CHAT_ID, clientRequestId: body.clientRequestId, action: body.action, index: body.index, commandId: 'cmd-2' },
        frame: { chatId: CHAT_ID, hostId: 'minnow-server', history: { start: 0, messages: [], length: 0 } },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setSessionStateForTests(null);
});

describe('turn failure card', () => {
  test('a failed turn with no partial reply still explains itself and offers Try again', () => {
    const chat = failedChat();
    const area = mountArea();
    const requests = document.createElement('section');
    requests.className = 'managed-chat-requests';
    area.append(requests);
    syncTurnFailureCard(chat, area);
    const node = card(area)!;
    assert.ok(node, 'card renders');
    assert.equal(node.dataset.kind, 'generic');
    assert.equal(node.querySelector('h3')?.textContent, 'This turn didn’t finish');
    assert.equal(node.nextElementSibling, requests, 'card is the last transcript row, ahead of requests');
    assert.deepEqual(labels(area), ['Try again']);
    assert.match(node.querySelector('pre')?.textContent ?? '', /Something odd/);
  });

  test('new work removes the card', () => {
    const chat = failedChat();
    const area = mountArea();
    syncTurnFailureCard(chat, area);
    assert.ok(card(area));
    chat.agentExecution = { executionId: 'exec-2', status: 'running' };
    assert.equal(shouldShowTurnFailure(chat), false);
    syncTurnFailureCard(chat, area);
    assert.equal(card(area), null);
  });

  test('legacy (renderer-run) chats are left to their own error bubble', () => {
    const chat = failedChat();
    chat.chatCommandVersion = undefined;
    assert.equal(shouldShowTurnFailure(chat), false);
  });

  test('a signed-out subscription offers sign-in and subscription settings', () => {
    const chat = failedChat({ error: 'Agent CLI authentication failed. Sign in from Models → Subscriptions. 401 Unauthorized' });
    const area = mountArea();
    syncTurnFailureCard(chat, area);
    assert.equal(card(area)!.dataset.kind, 'signed_out');
    assert.deepEqual(labels(area), ['Sign in to Codex', 'Retry now', 'Manage subscriptions']);
  });

  test('out of usage offers retry now and an automatic retry at the reset', async () => {
    const resetAt = Date.now() + 3 * 3600_000;
    const chat = failedChat({ error: 'You have hit your usage limit', failure: { kind: 'quota', resetAt, providerId: 'codex-cli', modelId: 'gpt-5' } });
    const area = mountArea();
    syncTurnFailureCard(chat, area);
    assert.equal(card(area)!.dataset.kind, 'usage_limit');
    const auto = card(area)!.querySelector<HTMLButtonElement>('[data-role="auto"]')!;
    assert.match(auto.textContent ?? '', /^Retry automatically /);
    auto.click();
    const saved = JSON.parse(win.localStorage.getItem('minnow.turnFailure.autoRetry.v1') ?? '{}');
    assert.equal(saved[CHAT_ID].executionId, 'exec-1');
    assert.ok(saved[CHAT_ID].at >= resetAt);
    const again = card(area)!.querySelector<HTMLButtonElement>('[data-role="auto"]')!;
    assert.equal(again.getAttribute('aria-pressed'), 'true');
    assert.equal(again.textContent, 'Cancel automatic retry');
    again.click();
    assert.equal(win.localStorage.getItem('minnow.turnFailure.autoRetry.v1'), null);

    // Retry now lifts the shared cooldown before replaying the original message.
    card(area)!.querySelector<HTMLButtonElement>('.chat-turn-failure__btn--primary')!.click();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(calls.map(call => call.url), ['/api/generations/allowance/retry', `/api/chats/${CHAT_ID}/history`]);
    assert.deepEqual(calls[0]!.body, { providerId: 'codex-cli', modelId: 'gpt-5' });
    assert.equal(calls[1]!.body.action, 'replay');
    assert.equal(calls[1]!.body.index, 0);
  });

  test('a turn that already did work offers Continue and Start over', () => {
    const chat = failedChat({}, [
      { role: 'user', content: 'Fix the build', commandId: 'cmd-1' } as Chat['history'][number],
      { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] } as Chat['history'][number],
      { role: 'tool', tool_call_id: 't1', content: 'ok' } as Chat['history'][number],
    ]);
    const area = mountArea();
    syncTurnFailureCard(chat, area);
    assert.deepEqual(labels(area), ['Continue', 'Start over']);
  });
});
