import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { createChatTurnRegistry, createChatTurnsMiddleware } from '../../server/chat-turns/middleware.js';

test('quiescent renderer expiry releases durable queued work once and never releases a live generation', () => {
  let clock = 1000;
  const generations = [];
  const releases = [];
  const registry = createChatTurnRegistry({ now: () => clock, generations: () => generations,
    onRelease: (chatId, ownerId) => releases.push({ chatId, ownerId }) });
  assert.equal(registry.claim('chat', 'owner'), true);
  generations.push({ chatId: 'chat', status: 'streaming', subscribers: new Set() });
  clock += 31000;
  assert.equal(registry.listLegacy().length, 1);
  assert.deepEqual(releases, []);
  generations.length = 0;
  assert.deepEqual(registry.listLegacy(), []);
  assert.deepEqual(releases, [{ chatId: 'chat', ownerId: 'owner' }]);
  registry.listLegacy();
  assert.equal(releases.length, 1);
});

test('chat ownership covers tool gaps and stale owners cannot release a replacement', () => {
  let clock = 0;
  const registry = createChatTurnRegistry({ now: () => clock, generations: () => [] });
  assert.equal(registry.claim('chat', 'pc'), true);
  assert.equal(registry.claim('chat', 'phone'), false, 'no generation is needed to keep the turn exclusive');
  clock = 25_000;
  assert.equal(registry.renew('chat', 'pc'), true);
  clock = 40_000;
  assert.equal(registry.claim('chat', 'phone'), false);
  clock = 56_000;
  assert.equal(registry.claim('chat', 'phone'), true, 'a dead renderer eventually releases the chat');
  registry.release('chat', 'pc');
  assert.deepEqual(registry.list(), [{ chatId: 'chat', ownerId: 'phone' }]);
  assert.equal(registry.renew('chat', 'pc'), false);
});

test('an expired owner cannot be replaced while its CLI generation is still live', () => {
  let clock = 0;
  const generation = { chatId: 'chat', status: 'streaming', subscribers: new Set() };
  const registry = createChatTurnRegistry({ now: () => clock, generations: () => [generation] });
  assert.equal(registry.claim('chat', 'pc'), true);
  clock = 90_000;
  assert.equal(registry.claim('chat', 'phone'), false);
  generation.status = 'complete';
  assert.equal(registry.claim('chat', 'phone'), true);
});

test('an already attached generation is protected even without an earlier turn claim', () => {
  const registry = createChatTurnRegistry({ generations: () => [
    { chatId: 'chat', status: 'streaming', subscribers: new Set([{}]) },
  ] });
  assert.equal(registry.claim('chat', 'phone'), false);
});

test('the same view reconnects after reload but cannot duplicate an attached reader', () => {
  const generation = { chatId: 'chat', status: 'streaming', subscribers: new Set() };
  const registry = createChatTurnRegistry({ generations: () => [generation] });
  assert.equal(registry.claim('chat', 'same-tab'), true);
  assert.equal(registry.claim('chat', 'same-tab'), true, 'reload retains its tab owner id');
  generation.subscribers.add({});
  assert.equal(registry.claim('chat', 'same-tab'), false, 'duplicated tabs cannot replay an attached runner');
  assert.equal(registry.renew('chat', 'same-tab'), true, 'the actual owner can still heartbeat');
});

test('release waits for an outstanding backend cancellation before allowing another device', () => {
  const generation = { chatId: 'chat', status: 'streaming', subscribers: new Set() };
  const registry = createChatTurnRegistry({ generations: () => [generation] });
  assert.equal(registry.claim('chat', 'pc'), true);
  registry.release('chat', 'pc');
  assert.equal(registry.claim('chat', 'phone'), false);
  generation.status = 'cancelled';
  assert.equal(registry.claim('chat', 'phone'), true);
});

test('two devices see one owner through the HTTP API; release permits the next turn', async () => {
  const middleware = createChatTurnsMiddleware(createChatTurnRegistry({ generations: () => [] }));
  const server = http.createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/chat-turns`;
  const post = (action, ownerId) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, chatId: 'chat', ownerId }) });
  try {
    const claims = await Promise.all([post('claim', 'pc'), post('claim', 'phone')]);
    assert.deepEqual(claims.map(res => res.status).sort(), [200, 409]);
    assert.equal((await claims.find(res => res.ok).json()).leaseMs, 30_000);
    const status = await fetch(url);
    assert.equal(status.headers.get('cache-control'), 'no-store');
    const { turns } = await status.json();
    assert.equal(turns.length, 1);
    const owner = turns[0].ownerId;
    const observer = owner === 'pc' ? 'phone' : 'pc';
    assert.equal((await post('renew', observer)).status, 409);
    assert.equal((await post('release', observer)).status, 200);
    assert.equal((await post('claim', observer)).status, 409);
    assert.equal((await post('release', owner)).status, 200);
    assert.equal((await post('claim', observer)).status, 200);
    const invalid = await fetch(url, { method: 'POST', body: JSON.stringify({ action: 'claim', chatId: '../bad', ownerId: 'pc' }) });
    assert.equal(invalid.status, 400);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
