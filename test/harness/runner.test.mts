import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-ignore Evaluation entry is intentionally plain JS, outside the SPA build.
import { evaluate } from '../../evals/harness/runner.mjs';

const config = { profile: 'build', model: 'fixture', workspace: '/app', instruction: 'Fix the bug.',
  maxSteps: 5, timeoutSeconds: 10, contextWindow: 32768, maxTokens: 2048 };
function response(delta: object, finish = 'stop') {
  return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } });
}

test('production loop executes tools and replays failure before completing, without assigning reward', async () => {
  let requests = 0;
  const events: any[] = [];
  const result = await evaluate(config, {
    complete: async (_provider: unknown, body: any) => {
      requests++;
      if (requests === 1) {
        assert.ok(body.tools.some((t: any) => t.function.name === 'search_tools'));
        return response({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: {
          name: 'read_file', arguments: JSON.stringify({ path: '/app/missing.txt' }) } }] }, 'tool_calls');
      }
      assert.ok(body.messages.some((m: any) => m.role === 'tool' && m.content.includes('missing')));
      return response({ content: 'The file is missing; unable to fix it.' });
    },
    execute: async () => ({ content: 'Error: missing file' }),
    event: (e: unknown) => events.push(e),
  });
  assert.equal(requests, 2);
  assert.equal(result.result.outcome, 'no_report');
  assert.equal(result.reward, null);
  assert.equal(result.metrics.toolErrors, 1);
  assert.match(events[0].systemPrompt, /Work agent: Builder/);
  assert.match(events[0].systemPrompt, /Linux/);
});

test('minimal is a prompt/tool ablation using the same runner', async () => {
  let seen: any;
  const result = await evaluate({ ...config, profile: 'minimal' }, {
    complete: async (_p: unknown, body: any) => { seen = body; return response({ content: 'Done.' }); },
    execute: async () => { throw new Error('unexpected tool'); },
  });
  assert.equal(seen.messages[0].content, 'You are a helpful software engineer assistant.');
  assert.deepEqual(seen.tools.map((t: any) => t.function.name), ['execute_command']);
  assert.equal(result.metrics.rounds, 1);
  assert.equal(result.reward, null);
});

test('invalid budgets and unknown profiles fail before inference', async () => {
  const deps = { complete: () => { throw new Error('must not call model'); }, execute: async () => ({ content: '' }) };
  await assert.rejects(evaluate({ ...config, maxSteps: 0 }, deps), /maxSteps/);
  await assert.rejects(evaluate({ ...config, profile: 'typo' }, deps), /Unknown profile/);
});

test('provider failure is a failed run, not a passed task', async () => {
  const result = await evaluate(config, { complete: async () => { throw new Error('provider unavailable'); },
    execute: async () => ({ content: '' }) });
  assert.equal(result.result.outcome, 'crashed');
  assert.equal(result.reward, null);
});

test('continuation compacts old history while preserving a standing user constraint', async () => {
  const history: any[] = [{ role: 'user', content: 'Always preserve the public API. Fix the parser.' }];
  for (let i = 0; i < 12; i++) {
    history.push({ role: 'assistant', content: `Inspection ${i}: ` + 'Source observations and intermediate analysis. '.repeat(180) });
    history.push({ role: 'user', content: `Continue inspection ${i}.` });
  }
  let sent = '';
  const result = await evaluate({ ...config, profile: 'minimal', contextWindow: 8192,
    history, instruction: 'Now finish the parser fix.' }, {
    complete: async (_p: unknown, body: any) => { sent = JSON.stringify(body.messages); return response({ content: 'Done.' }); },
    execute: async () => ({ content: '' }),
  });
  assert.equal(result.result.outcome, 'no_report');
  assert.ok(result.metrics.compactions > 0);
  assert.match(sent, /preserve the public API/);
  assert.match(sent, /Now finish the parser fix/);
});
