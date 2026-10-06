import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import {
  appendAgentCliOutput,
  beginAgentCliOutput,
  endAgentCliOutput,
  getAgentCliOutput,
  subscribeAgentCliOutput,
} from '../../server/generations/agent-cli/output.js';
import { createGenerationsMiddleware } from '../../server/generations/routes.js';

test('CLI output follows one process, preserves split lines, and redacts credentials', () => {
  const chatId = 'cli-output-test';
  const capture = beginAgentCliOutput(chatId, 'codex-cli', 'test-model', ['private-token']);
  appendAgentCliOutput(capture, Buffer.from('{"text":"private-'));
  assert.equal(getAgentCliOutput(chatId).output, '');
  appendAgentCliOutput(capture, Buffer.from('token"}\n'));
  assert.equal(getAgentCliOutput(chatId).output, '{"text":"[redacted]"}\n');
  assert.equal(getAgentCliOutput(chatId).status, 'running');
  appendAgentCliOutput(capture, Buffer.from('final fragment'));
  endAgentCliOutput(capture, 0);
  assert.match(getAgentCliOutput(chatId).output, /final fragment$/);
  assert.equal(getAgentCliOutput(chatId).exitCode, 0);
  assert.deepEqual(capture.secrets, []);
  appendAgentCliOutput(capture, Buffer.from('ignored\n'));
  assert.doesNotMatch(getAgentCliOutput(chatId).output, /ignored/);

  const next = beginAgentCliOutput(chatId, 'claude-code-cli', 'next-model');
  assert.equal(getAgentCliOutput(chatId).output, '');
  assert.equal(getAgentCliOutput(chatId).providerId, 'claude-code-cli');
  endAgentCliOutput(next, 1);
});

test('output subscribers append redacted deltas and reconnect from a bounded snapshot', () => {
  const chatId = 'output-stream-reconnect', rows = [];
  const capture = beginAgentCliOutput(chatId, 'codex-cli', 'model', ['stream-secret']);
  const unsubscribe = subscribeAgentCliOutput(chatId, row => rows.push(row));
  assert.equal(rows[0].snapshot.output, '');
  appendAgentCliOutput(capture, 'stream-secret\n');
  assert.equal(rows[1].delta, '[redacted]\n');
  const broken = subscribeAgentCliOutput(chatId, row => { if (!('snapshot' in row)) throw new Error('Disconnected'); });
  appendAgentCliOutput(capture, `${'x'.repeat(300_000)}\n`);
  assert.equal(rows.at(-1).delta.length, 256 * 1024);
  unsubscribe(); broken();
  const reconnect = subscribeAgentCliOutput(chatId, row => rows.push(row));
  assert.equal(rows.at(-1).snapshot.output.length, 256 * 1024);
  assert.equal(rows.at(-1).snapshot.version, getAgentCliOutput(chatId).version);
  endAgentCliOutput(capture, 0);
  assert.equal(rows.at(-1).status, 'exited');
  reconnect();
});

test('generation route returns the current process and skips unchanged snapshots', async () => {
  const chatId = 'cli-output-route-test';
  const capture = beginAgentCliOutput(chatId, 'cursor-agent-cli', 'auto');
  appendAgentCliOutput(capture, 'one line\n');
  const middleware = createGenerationsMiddleware();
  const get = async (since) => {
    let body = '';
    const req = { method: 'GET', url: `/api/generations/agent-cli-output?chatId=${chatId}${since == null ? '' : `&since=${since}`}` };
    const res = { statusCode: 0, setHeader() {}, end(value) { body = value; } };
    await middleware(req, res, () => { throw new Error('Unexpected next'); });
    assert.equal(res.statusCode, 200);
    return JSON.parse(body);
  };
  const first = await get();
  assert.equal(first.capture.output, 'one line\n');
  assert.deepEqual(await get(first.capture.version), { unchanged: true });
  endAgentCliOutput(capture, 0);
});

test('stream route delivers a snapshot, appends deltas, and removes disconnected subscribers', async () => {
  const chatId = 'cli-output-stream-route';
  const capture = beginAgentCliOutput(chatId, 'codex-cli', 'fixture');
  const middleware = createGenerationsMiddleware();
  const res = new EventEmitter();
  const frames = [];
  Object.assign(res, { writableLength: 0, destroyed: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    write(frame) { frames.push(JSON.parse(frame.slice(6))); },
    destroy() { this.destroyed = true; this.emit('close'); }, end() { this.emit('close'); },
  });
  await middleware({ method: 'GET', url: `/api/generations/agent-cli-output/stream?chatId=${chatId}` }, res,
    () => { throw new Error('Unexpected next'); });
  try {
    assert.equal(res.statusCode, 200); assert.equal(res.headers['Content-Type'], 'text/event-stream');
    assert.equal(frames[0].snapshot.output, '');
    appendAgentCliOutput(capture, 'Appended\n');
    assert.equal(frames.at(-1).delta, 'Appended\n');
    res.emit('close');
    const count = frames.length;
    appendAgentCliOutput(capture, 'After disconnect\n');
    assert.equal(frames.length, count);
  } finally { res.emit('close'); endAgentCliOutput(capture, 0); }
});
