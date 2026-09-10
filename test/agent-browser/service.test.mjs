import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentBrowserError, createAgentBrowserService } from '../../server/agent-browser/index.js';

const ownerA = { chatId: 'chat-a', runId: 'run-a', agentId: 'agent-a' };
const ownerB = { chatId: 'chat-b', runId: 'run-b', agentId: 'agent-b' };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeLauncher() {
  const sessions = [];
  const launcher = async (options) => {
    const gates = [];
    const session = {
      alive: true,
      options,
      allowedOriginPatterns: [],
      lastSnapshot: null,
      gates,
      client: {
        on() {},
        async send() { return {}; },
      },
      handle: { browserWsUrl: 'ws://fake' },
      async evaluate(expression) {
        if (expression === 'location.href') return 'about:blank';
        if (expression.startsWith('wait:')) {
          const gate = deferred();
          gates.push(gate);
          await gate.promise;
        }
        return expression;
      },
      async navigate(url) { return { outcome: 'loaded', url, title: url }; },
      async snapshot() { return { nodes: [], byUid: new Map(), text: '(empty page)' }; },
      async screenshot() { return { ok: false, error: 'fake' }; },
      async close() { this.alive = false; },
    };
    sessions.push(session);
    return { ok: true, session, capability: { available: true } };
  };
  const connector = async () => ({ on() {}, async send() { return {}; }, close() {} });
  return { launcher, connector, sessions };
}

test('reservation is owner and lease scoped', async (t) => {
  const fake = fakeLauncher();
  const service = createAgentBrowserService({ launcher: fake.launcher, connector: fake.connector });
  t.after(() => service.close());
  const reservation = await service.reserveTab(ownerA);
  const call = { tabId: reservation.tab.tabId, lease: reservation.lease };

  assert.equal(await service.evaluate({ ...call, owner: ownerA, expression: 'ok' }), 'ok');
  await assert.rejects(
    async () => service.evaluate({ ...call, owner: ownerB, expression: 'bad' }),
    (error) => error instanceof AgentBrowserError && error.code === 'not-owner',
  );
  await assert.rejects(
    async () => service.evaluate({ ...call, owner: ownerA, lease: 'old', expression: 'bad' }),
    (error) => error instanceof AgentBrowserError && error.code === 'stale-lease',
  );
});

test('transfer waits for active work and revokes queued work', async (t) => {
  const fake = fakeLauncher();
  const service = createAgentBrowserService({ launcher: fake.launcher, connector: fake.connector });
  t.after(() => service.close());
  const reservation = await service.reserveTab(ownerA);
  const call = { owner: ownerA, tabId: reservation.tab.tabId, lease: reservation.lease };

  const active = service.evaluate({ ...call, expression: 'wait:active' });
  while (fake.sessions[0].gates.length === 0) await new Promise((resolve) => setImmediate(resolve));
  const queued = service.evaluate({ ...call, expression: 'queued' });
  const transfer = service.reassignTab(reservation.tab.tabId, ownerB);
  let transferred = false;
  void transfer.then(() => { transferred = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transferred, false);

  fake.sessions[0].gates[0].resolve();
  assert.equal(await active, 'wait:active');
  await assert.rejects(
    queued,
    (error) => error instanceof AgentBrowserError && error.code === 'stale-lease',
  );
  const next = await transfer;
  assert.ok(next.lease);
  assert.equal(await service.evaluate({ owner: ownerB, tabId: reservation.tab.tabId, lease: next.lease, expression: 'new owner' }), 'new owner');
});

test('capacity is bounded and owner-scoped inspection never leaks other tabs', async (t) => {
  const fake = fakeLauncher();
  const service = createAgentBrowserService({ launcher: fake.launcher, connector: fake.connector, maxTabs: 1 });
  t.after(() => service.close());
  const reservation = await service.reserveTab(ownerA);
  assert.deepEqual(service.listOwnedTabs(ownerB), []);
  assert.equal(service.listOwnedTabs(ownerA)[0].tabId, reservation.tab.tabId);
  service.updateTabPolicy(reservation.tab.tabId, ['https://example.test']);
  assert.deepEqual(fake.sessions[0].allowedOriginPatterns, ['https://example.test']);
  await assert.rejects(
    () => service.reserveTab(ownerB),
    (error) => error instanceof AgentBrowserError && error.code === 'busy',
  );
  await service.releaseOwnedTab({ owner: ownerA, tabId: reservation.tab.tabId, lease: reservation.lease });
  assert.equal(service.listTabs()[0].owner, null);
});

test('close during launch waits for initialization and cannot return a ghost tab', async () => {
  const gate = deferred();
  const fake = fakeLauncher();
  const service = createAgentBrowserService({
    launcher: async (options) => {
      await gate.promise;
      return fake.launcher(options);
    },
    connector: fake.connector,
  });
  const reserving = service.reserveTab(ownerA);
  const tabId = service.listTabs()[0].tabId;
  const closing = service.closeTab(tabId);
  gate.resolve();
  await assert.rejects(reserving, (error) => error instanceof AgentBrowserError && error.code === 'closed');
  await closing;
  assert.deepEqual(service.listTabs(), []);
  assert.equal(fake.sessions[0].alive, false);
  await service.close();
});

test('a concurrent close wins over ownership transfer without resurrecting the tab', async () => {
  const fake = fakeLauncher();
  const service = createAgentBrowserService({ launcher: fake.launcher, connector: fake.connector });
  const reservation = await service.reserveTab(ownerA);
  const call = { owner: ownerA, tabId: reservation.tab.tabId, lease: reservation.lease };
  const active = service.evaluate({ ...call, expression: 'wait:active' });
  while (fake.sessions[0].gates.length === 0) await new Promise((resolve) => setImmediate(resolve));
  const transfer = service.reassignTab(reservation.tab.tabId, ownerB);
  const closing = service.closeTab(reservation.tab.tabId);
  fake.sessions[0].gates[0].resolve();
  await active;
  await assert.rejects(transfer, (error) => error instanceof AgentBrowserError && error.code === 'closed');
  await closing;
  assert.deepEqual(service.listTabs(), []);
  await service.close();
});

test('same-snapshot calls queue without clearing references; document replacement clears them', async (t) => {
  const fake = fakeLauncher();
  const listeners = new Map();
  const launcher = async (options) => {
    const launched = await fake.launcher(options);
    launched.session.client.on = (name, callback) => listeners.set(name, callback);
    launched.session.client.send = async (name) => {
      if (name === 'DOM.resolveNode') return { object: { objectId: 'node' } };
      if (name === 'Runtime.callFunctionOn') return { result: { value: true } };
      return {};
    };
    return launched;
  };
  const service = createAgentBrowserService({ launcher, connector: fake.connector });
  t.after(() => service.close());
  const reservation = await service.reserveTab(ownerA);
  const call = { owner: ownerA, tabId: reservation.tab.tabId, lease: reservation.lease };
  fake.sessions[0].lastSnapshot = { byUid: new Map([[1, { backendNodeId: 10 }], [2, { backendNodeId: 20 }]]) };
  const result = await Promise.all([
    service.fill({ ...call, uid: 1, text: 'first' }),
    service.fill({ ...call, uid: 2, text: 'second' }),
    service.click({ ...call, uid: 1 }),
  ]);
  assert.deepEqual(result.map((row) => row.uid), [1, 2, 1]);
  listeners.get('DOM.documentUpdated')();
  await assert.rejects(() => service.click({ ...call, uid: 1 }), /fresh snapshot/);
});
