import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { configurePersistentAgentSpawner, handleAgentsRequest } from '../../server/sub-agents/middleware.js';

class Response extends EventEmitter {
  headers = {}; writableEnded = false; headersSent = false; statusCode = 0;
  setHeader(name, value) { this.headers[name] = value; }
  end(body) { this.body = JSON.parse(body); this.writableEnded = true; }
}
function request(body) { const req = Readable.from([JSON.stringify(body)]); req.method = 'POST'; req.headers = {}; return req; }

test('versioned spawn never falls back to the legacy unversioned route when unavailable or rejected', async () => {
  try {
    configurePersistentAgentSpawner(null);
    const missing = new Response(); await handleAgentsRequest(request({ conversationVersion: 1 }), missing, '/api/agents');
    assert.equal(missing.statusCode, 503); assert.equal(missing.body.code, 'capability_unavailable');
    configurePersistentAgentSpawner(async () => null);
    const disabled = new Response(); await handleAgentsRequest(request({ conversationVersion: 1 }), disabled, '/api/agents');
    assert.equal(disabled.statusCode, 403); assert.equal(disabled.body.code, 'capability_disabled');
    configurePersistentAgentSpawner(async () => { throw Object.assign(new Error('The source execution stopped'), { statusCode: 409, code: 'caller_not_active' }); });
    const denied = new Response(); await handleAgentsRequest(request({ conversationVersion: 1 }), denied, '/api/agents');
    assert.equal(denied.statusCode, 409); assert.equal(denied.body.error, 'The source execution stopped');
  } finally { configurePersistentAgentSpawner(null); }
});

test('premature connection close aborts setup while an ordinary completed response keeps its signal settled normally', async () => {
  try {
    let entered, observed;
    const started = new Promise(resolve => { entered = resolve; });
    configurePersistentAgentSpawner(async (_req, _body, { signal }) => {
      observed = signal; entered(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      return { status: 499, body: { ok: false, error: 'Setup aborted' } };
    });
    const disconnected = new Response(); const running = handleAgentsRequest(request({ conversationVersion: 1 }), disconnected, '/api/agents');
    await started; disconnected.emit('close'); await running;
    assert.equal(observed.aborted, true); assert.equal(disconnected.statusCode, 499);
    configurePersistentAgentSpawner(async (_req, _body, { signal }) => { observed = signal; return { status: 201, body: { ok: true, childChatId: 'child' } }; });
    const completed = new Response(); await handleAgentsRequest(request({ conversationVersion: 1 }), completed, '/api/agents');
    completed.emit('close'); assert.equal(observed.aborted, false); assert.equal(completed.body.childChatId, 'child');
  } finally { configurePersistentAgentSpawner(null); }
});
