import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendAgentCliOutput,
  beginAgentCliOutput,
  endAgentCliOutput,
  getAgentCliOutput,
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
