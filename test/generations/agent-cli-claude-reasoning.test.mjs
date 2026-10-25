import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareClaudeReasoningMod } from '../../server/generations/agent-cli/claude-reasoning-mod.js';

async function observer(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-thinking-mod-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const dir = await prepareClaudeReasoningMod(cwd, { url: 'http://127.0.0.1:1234/thinking', token: 'test-token', sessionId: 'session' });
  const { register } = await import(pathToFileURL(path.join(dir, 'hooks', 'register.js')));
  let handler;
  register((name, fn) => { assert.equal(name, 'turn.step'); handler = fn; });
  return { cwd, handler };
}

test('native observer forwards thinking immediately and leaves all model chunks and the result intact', async t => {
  const { cwd, handler } = await observer(t);
  const chunks = [{ kind: 'engine', ref: 1 }, { kind: 'thinking', index: 0, text: 'First', ref: 2 },
    { kind: 'thinking', index: 0, text: ' thought.', ref: 3 }, { kind: 'text', index: 1, text: 'Reply', ref: 4 }];
  const result = { answer: 'Reply', usage: { output_tokens: 4 } }, posts = [];
  const stream = handler({ http: { fetch: async (url, options) => { posts.push({ url, ...options }); } } },
    { turnId: 'turn', index: 2 }, async function* () { yield* chunks; return result; });
  for (const chunk of chunks) {
    assert.equal((await stream.next()).value, chunk);
    if (chunk.kind === 'thinking') assert.equal(JSON.parse(posts.at(-1).body).delta, chunk.text);
  }
  assert.equal((await stream.next()).value, result);
  assert.deepEqual(posts.map(p => JSON.parse(p.body)), ['First', ' thought.'].map((delta, index) => ({
    session_id: 'session', cwd, turn_id: 'turn', step_index: 2, block_index: 0, index, delta,
  })));
  assert.ok(posts.every(p => p.headers.Authorization === 'Bearer test-token'));
});

test('observer delivery failure leaves native output available and cancellation closes the upstream iterator', async t => {
  const { handler } = await observer(t);
  let closed = false;
  const chunk = { kind: 'thinking', index: 0, text: 'Visible in native Claude.' };
  const stream = handler({ http: { fetch: async () => { throw new Error('listener closed'); } } },
    { turnId: 'turn', index: 0 }, async function* () {
      try { yield chunk; yield { kind: 'text', text: 'Reply' }; }
      finally { closed = true; }
    });
  assert.equal((await stream.next()).value, chunk);
  await stream.return();
  assert.equal(closed, true);
});

test('observer leaves native subagents outside the parent reasoning stream', async t => {
  const { handler } = await observer(t);
  const chunk = { kind: 'thinking', index: 0, text: 'Other agent.' };
  const stream = handler({ http: { fetch: async () => assert.fail('must not publish subagent thoughts') } },
    { agentId: 'child', turnId: 'turn', index: 0 }, async function* () { yield chunk; });
  assert.equal((await stream.next()).value, chunk);
  assert.equal((await stream.next()).done, true);
});
