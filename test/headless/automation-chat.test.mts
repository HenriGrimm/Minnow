/**
 * Automation-only chat_create: the job's opt-in replaces the per-chat approval.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTOMATION_CHAT_CREATE_LIMIT,
  AUTOMATION_CHAT_CREATE_TOOL,
  createAutomationChatCreator,
} from '../../src/headless/automation-chat.ts';

const context = () => ({ workspacePath: '/repo', modeId: 'build', providerId: 'p', modelId: 'm' });

function harness(response: { ok: boolean; status?: number; body: unknown } = { ok: true, body: { receipt: { commandId: 'cmd-1', state: 'queued' } } }, route = 'legacy') {
  const persisted: any[] = [], requests: { url: string; init: RequestInit }[] = [];
  let n = 0;
  const create = createAutomationChatCreator(context, {
    id: () => String(++n),
    persist: async input => { persisted.push(input); },
    fetch: (async (url: string, init: RequestInit) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith('/ordinary-routing')) {
        const body = init.method === 'POST' ? { receipt: { disposition: 'promoted' } } : { route, revision: 3, reason: 'new_root' };
        return { ok: true, status: 200, json: async () => body } as Response;
      }
      return { ok: response.ok, status: response.status ?? 202, json: async () => response.body } as Response;
    }) as typeof fetch,
  });
  return { create, persisted, requests };
}

describe('automation chat_create', () => {
  it('declares a title-only required schema', () => {
    assert.equal(AUTOMATION_CHAT_CREATE_TOOL.function.name, 'chat_create');
    assert.deepEqual(AUTOMATION_CHAT_CREATE_TOOL.function.parameters.required, ['title']);
  });

  it('opens an empty chat without sending anything when no message is given', async () => {
    const h = harness();
    const result = JSON.parse((await h.create({ title: 'Flaky test' })).content);
    assert.equal(result.chatId, 'auto-1');
    assert.equal(result.disposition, 'created');
    assert.equal(h.persisted[0].chatName, 'Flaky test');
    assert.equal(h.persisted[0].workspacePath, '/repo');
    assert.deepEqual(h.persisted[0].history, []);
    assert.equal(h.requests.length, 0);
  });

  it('promotes the new root, then starts the first message as the scheduler', async () => {
    const h = harness();
    const result = JSON.parse((await h.create({ title: 'Fix CI', message: 'Fix the lint job' })).content);
    assert.equal(result.commandId, 'cmd-1');
    assert.deepEqual(h.requests.map(r => (r.init.method ?? 'GET') + ' ' + r.url.replace(/^.*\/api\/chats\/auto-1/, '')),
      ['GET /ordinary-routing', 'POST /ordinary-routing', 'POST /commands']);
    assert.ok(h.requests.every(r => (r.init.headers as Record<string, string>)['X-Minnow-Chat-Client'] === 'scheduler'));
    assert.deepEqual(JSON.parse(String(h.requests[1].init.body)), { expectedRevision: 3, clientRequestId: 'auto-1-promote' });
    assert.deepEqual(JSON.parse(String(h.requests[2].init.body)), { action: 'send', text: 'Fix the lint job', mode: 'auto', clientRequestId: 'auto-1-first' });
  });

  it('skips promotion when the server already owns the chat', async () => {
    const h = harness(undefined, 'server');
    await h.create({ title: 'T', message: 'go' });
    assert.deepEqual(h.requests.map(r => r.init.method ?? 'GET'), ['GET', 'POST']);
  });

  it('rejects invalid input before creating anything', async () => {
    const h = harness();
    for (const args of [{}, { title: '  ' }, { title: 'x'.repeat(241) }, { title: 'ok', message: '' }, { title: 'ok', message: 5 }]) {
      assert.match((await h.create(args)).content, /^Error:/);
    }
    assert.equal(h.persisted.length, 0);
  });

  it('reports a failed first message without hiding the created chat', async () => {
    const h = harness({ ok: false, status: 403, body: { error: { message: 'denied' } } });
    const result = await h.create({ title: 'T', message: 'go' });
    assert.match(result.content, /opened chat auto-1 .*denied/);
  });

  it('caps creations per run', async () => {
    const h = harness();
    for (let i = 0; i < AUTOMATION_CHAT_CREATE_LIMIT; i++) await h.create({ title: 'T' + i });
    assert.match((await h.create({ title: 'One more' })).content, /per-run limit/);
    assert.equal(h.persisted.length, AUTOMATION_CHAT_CREATE_LIMIT);
  });
});
