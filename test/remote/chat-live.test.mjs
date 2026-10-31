import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { createChatTurnRegistry, createChatTurnsMiddleware } from '../../server/chat-turns/middleware.js';
import { createChatLiveBroker, createChatLiveMiddleware } from '../../server/chat-turns/live.js';
import { handleGenerationsRequest } from '../../server/generations/routes.js';
import { runWithViewWorkspace } from '../../server/runtime/path-access.js';

function fixture() {
  const turns = createChatTurnRegistry({ generations: () => [] });
  const broker = createChatLiveBroker({ turns, workspaceForChat: id => id === 'missing' ? null : '/project' });
  const host = [], phone = [];
  const disconnect = broker.register('pc', '/project', event => host.push(event));
  broker.subscribe('/project', event => phone.push(event), 'phone');
  return { turns, broker, host, phone, disconnect };
}

test('queued edit commands reach the host with bounded text and item validation', async () => {
  const { broker, host } = fixture();
  await broker.submit({ id: 'edit', chatId: 'chat', action: 'edit', itemId: 'queued', text: 'revised' }, 'phone');
  assert.equal(host.at(-1).command.action, 'edit');
  assert.equal(host.at(-1).command.text, 'revised');
  await assert.rejects(broker.submit({ id: 'blank', chatId: 'chat', action: 'edit', itemId: 'queued', text: ' ' }, 'phone'), /Add a message/);
  await assert.rejects(broker.submit({ id: 'missing', chatId: 'chat', action: 'edit', text: 'revised' }, 'phone'), /Invalid queued message/);
  await assert.rejects(broker.submit({ id: 'long', chatId: 'chat', action: 'edit', itemId: 'queued', text: 'x'.repeat(100_001) }, 'phone'), /Add a message/);
});

test('live text and tools reach the same chat immediately and reconnect replays a coalesced snapshot', async () => {
  const { turns, broker, phone } = fixture();
  turns.claim('chat', 'owner', 'pc');
  await broker.publish('pc', { chatId: 'chat', epoch: 'turn1', running: true, fields: { name: 'Shared' },
    history: { start: 2, length: 3, messages: [{ role: 'user', content: 'Build' }] },
    live: { lastDelta: 'Hello', lastThinking: 'Plan', toolCallCount: 0 } });
  assert.equal(phone.at(-1).frame.live.lastDelta, 'Hello');
  await broker.publish('pc', { chatId: 'chat', epoch: 'turn1', running: true,
    liveAppend: { textOffset: 5, thinkingOffset: 4, text: ' world', thinking: ' ahead' } });
  assert.equal(phone.at(-1).frame.liveAppend.text, ' world', 'the wire sends new tokens, not a whole transcript');
  await broker.publish('pc', { chatId: 'chat', epoch: 'turn1', running: true,
    history: { start: 3, length: 5, messages: [
      { role: 'assistant', content: '', tool_calls: [{ id: 't', function: { name: 'save_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't', content: 'Saved' },
    ] }, live: null });
  const replay = [];
  broker.subscribe('/project', event => replay.push(event), 'phone');
  const snapshot = replay.find(event => event.kind === 'frame').frame;
  assert.equal(snapshot.history.start, 2);
  assert.equal(snapshot.history.length, 5);
  assert.equal(snapshot.history.messages.at(-1).content, 'Saved');
  assert.equal(snapshot.live, null);
  await broker.publish('pc', { chatId: 'chat', epoch: 'turn1', running: false, fields: { turnError: true }, live: null });
  assert.equal(phone.at(-1).frame.running, false);
  assert.equal(phone.at(-1).frame.fields.turnError, true);
  const other = [];
  broker.subscribe('/other', event => other.push(event), 'phone');
  assert.equal(other.some(event => event.kind === 'frame'), false);
});

test('reconnect during a token stream retains complete reasoning and prose', async () => {
  const { broker } = fixture();
  await broker.publish('pc', { chatId: 'chat', epoch: 'turn', running: true,
    live: { lastDelta: 'A', lastThinking: 'Why', toolCallCount: 0 } });
  await broker.publish('pc', { chatId: 'chat', epoch: 'turn', running: true,
    liveAppend: { textOffset: 1, thinkingOffset: 3, text: 'BC', thinking: ' now' } });
  assert.equal(broker.snapshot('chat', '/project').live.lastDelta, 'ABC');
  assert.equal(broker.snapshot('chat', '/project').live.lastThinking, 'Why now');
  await assert.rejects(broker.publish('pc', { chatId: 'chat', epoch: 'turn', running: true,
    liveAppend: { textOffset: 1, thinkingOffset: 3, text: 'duplicate', thinking: '' } }), { status: 409 });
  await broker.publish('pc', { chatId: 'chat', epoch: 'next', running: true,
    history: { start: 5, length: 6, messages: [{ role: 'user', content: 'Next turn' }] }, live: null });
  assert.equal(broker.snapshot('chat', '/project').history.start, 5, 'new turns do not retain every earlier live suffix');
});

test('send, steer and stop target the PC owner; retries and host reconnect do not duplicate admission', async () => {
  const { turns, broker, host, phone, disconnect } = fixture();
  const wrongHost = [];
  broker.register('other-window', '/project', event => wrongHost.push(event));
  turns.claim('chat', 'owner', 'pc');
  const input = { id: 'send1', chatId: 'chat', action: 'send', text: 'Hello' };
  const [one, two] = await Promise.all([broker.submit(input, 'phone'), broker.submit(input, 'phone')]);
  assert.equal(one.id, two.id);
  assert.equal(host.length, 1);
  assert.equal(wrongHost.length, 0);
  await broker.submit({ id: 'steer1', chatId: 'chat', action: 'steer', text: 'Use TypeScript' }, 'phone');
  await broker.submit({ id: 'stop1', chatId: 'chat', action: 'stop' }, 'phone');
  assert.deepEqual(host.map(event => event.command.action), ['send', 'steer', 'stop']);
  assert.throws(() => broker.acknowledge(one.id, 'other-window', { ok: true }), { status: 409 });
  broker.acknowledge(one.id, 'pc', { ok: true });
  assert.equal(phone.at(-1).kind, 'command-result');
  assert.equal(broker.result(one.id, 'phone').ok, true);
  assert.throws(() => broker.result(one.id, 'another-phone'), { status: 404 });
  disconnect();
  const replay = [];
  broker.register('pc', '/project', event => replay.push(event));
  assert.deepEqual(replay.map(event => event.command.action), ['steer', 'stop']);
  assert.ok(replay.every(event => event.command.deliveryId.startsWith('phone:')));
  await broker.submit(input, 'phone');
  assert.equal(replay.length, 2, 'an acknowledged retry never restarts the PC');
});

test('a disconnected PC rejects new messages instead of transferring execution to a phone', async () => {
  const { broker, disconnect } = fixture();
  disconnect();
  await assert.rejects(broker.submit({ id: 'one', chatId: 'chat', action: 'send', text: 'Hello' }, 'phone'), { status: 503 });
  await assert.rejects(broker.submit({ id: 'two', chatId: 'missing', action: 'stop' }, 'phone'), { status: 404 });
});

test('HTTP devices may send commands but cannot register as a host, publish, claim, or start CLI chat generations', async () => {
  const turns = createChatTurnRegistry({ generations: () => [] });
  const ownership = createChatTurnsMiddleware(turns);
  const live = createChatLiveMiddleware(turns, { workspaceForChat: () => '/project' });
  const server = http.createServer((req, res) => {
    req.minnowAuth = { kind: 'device', deviceId: 'phone' };
    ownership(req, res, () => live(req, res, () => void handleGenerationsRequest(req, res, '/api/generations')));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(`${root}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(`${root}/api/chat-sync/host?hostId=phone`)).status, 403);
    assert.equal((await post('/api/chat-sync/publish', { hostId: 'phone', frame: {} })).status, 403);
    assert.equal((await post('/api/chat-sync/publish', { hostId: 'phone', frames: [{}] })).status, 403);
    assert.equal((await post('/api/chat-turns', { action: 'claim', chatId: 'chat', ownerId: 'phone' })).status, 403);
    assert.equal((await post('/api/generations', { persist: true, chatId: 'chat', providerId: 'cli', body: {} })).status, 403);
    const response = await post('/api/chat-sync/commands', { id: 'send1', chatId: 'chat', action: 'send', text: 'Hello' });
    assert.equal(response.status, 503, 'no host is connected, and no phone engine is started');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('batched HTTP publications retain individual host and workspace fences', async () => {
  const turns = createChatTurnRegistry({ generations: () => [] });
  const broker = createChatLiveBroker({ turns, workspaceForChat: id => id === 'foreign' ? '/other' : '/project' });
  const disconnect = broker.register('pc', '/project', () => {});
  const live = createChatLiveMiddleware(turns, { broker });
  const server = http.createServer((req, res) => {
    req.minnowAuth = { kind: 'host' };
    runWithViewWorkspace('/project', () => live(req, res, () => { res.statusCode = 404; res.end(); }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${server.address().port}`;
  const post = frames => fetch(`${root}/api/chat-sync/publish`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hostId: 'pc', frames }) });
  try {
    const response = await post(['one', 'two'].map(chatId => ({ chatId, epoch: 'turn', running: true,
      live: { lastDelta: chatId, lastThinking: '', toolCallCount: 0 } })));
    assert.equal(response.status, 200);
    assert.ok((await response.json()).results.every(row => row.ok));
    assert.equal(broker.snapshot('one', '/project').live.lastDelta, 'one');
    assert.equal(broker.snapshot('two', '/project').live.lastDelta, 'two');
    const mixed = await post([{ chatId: 'foreign', epoch: 'turn', running: true },
      { chatId: 'one', epoch: 'turn', running: false }]);
    assert.deepEqual((await mixed.json()).results.map(row => row.ok), [false, true]);
    assert.equal(broker.snapshot('one', '/project').running, false);
    assert.equal((await post([])).status, 400);
    assert.equal((await post(Array.from({ length: 65 }, () => ({})))).status, 400);
  } finally { disconnect(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('real event streams deliver phone controls to the PC and push output back without a poll interval', async () => {
  const turns = createChatTurnRegistry({ generations: () => [] });
  const live = createChatLiveMiddleware(turns, { workspaceForChat: () => '/project' });
  const server = http.createServer((req, res) => {
    req.minnowAuth = req.headers['x-test-host'] ? { kind: 'host' } : { kind: 'device', deviceId: 'phone' };
    runWithViewWorkspace('/project', () => live(req, res, () => { res.statusCode = 404; res.end(); }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${server.address().port}`;
  const controller = new AbortController();
  const subscribe = async (path, headers = {}) => {
    const response = await fetch(`${root}${path}`, { headers, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    return async () => {
      for (;;) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary >= 0) {
          const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          if (block.startsWith('data: ')) return JSON.parse(block.slice(6));
          continue;
        }
        const { value, done } = await reader.read();
        assert.equal(done, false);
        buffer += decoder.decode(value, { stream: true });
      }
    };
  };
  const post = (path, body, host = false) => fetch(`${root}/api/chat-sync/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(host ? { 'X-Test-Host': '1' } : {}) },
    body: JSON.stringify(body), signal: controller.signal,
  });
  const deadline = setTimeout(() => controller.abort(), 3_000);
  try {
    const pc = await subscribe('/api/chat-sync/host?hostId=pc', { 'X-Test-Host': '1' });
    const phone = await subscribe('/api/chat-sync/events');
    assert.equal((await phone()).kind, 'presence');
    const accepted = await post('commands', { id: 'send1', chatId: 'chat', action: 'send', text: 'Phone request' });
    assert.equal(accepted.status, 202);
    const command = (await pc()).command;
    assert.equal(command.text, 'Phone request');
    await post('ack', { id: command.deliveryId, hostId: 'pc', ok: true }, true);
    assert.equal((await phone()).kind, 'command-result');
    await post('publish', { hostId: 'pc', frame: { chatId: 'chat', running: true, epoch: 'one',
      live: { lastDelta: 'Live reply', lastThinking: '', toolCallCount: 0 } } }, true);
    assert.equal((await phone()).frame.live.lastDelta, 'Live reply');
    await post('commands', { id: 'stop1', chatId: 'chat', action: 'stop' });
    assert.equal((await pc()).command.action, 'stop');
  } finally {
    clearTimeout(deadline); controller.abort(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
