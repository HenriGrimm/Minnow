import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTranscriptDecoration } from '../../server/runner/transcript-decoration.js';
import { finalizeResponseMeta } from '../../server/runner/response-meta.js';

test('canonical decoration retains signed reasoning, source identity, images and checkout provenance', () => {
  let clock = 0;
  const decoration = createTranscriptDecoration({ now: () => clock, omitSystem: true });
  const blocks = [{ type: 'thinking', thinking: '  Read\n\nprices. ', signature: 'signed' },
    { type: 'redacted_thinking', data: 'opaque' }];
  decoration.observe({ type: 'round_start', index: 0 });
  decoration.observe({ type: 'thinking', text: blocks[0].thinking });
  clock = 220;
  decoration.observe({ type: 'reasoning_end' });
  const assistant = decoration.decorate({ role: 'assistant', content: null, messageId: 'a1',
    reasoning_blocks: blocks, tool_calls: [{ id: 'read', type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
  assert.deepEqual(assistant.thinking, ['Read', 'prices.']);
  assert.deepEqual(assistant.thinkingBlocks, blocks);
  assert.equal(assistant.reasoning_blocks, undefined);
  assert.equal(assistant.thinkingDurationMs, 220);
  const attachments = [{ type: 'image', mime: 'image/png', url: '/shot', dataUrl: 'data:image/png;base64,aA==' }];
  const codeChange = { additions: 1, deletions: 0, workspacePath: 'C:/project/worktree', gitBranch: 'feature' };
  decoration.observe({ type: 'tool_result', id: 'read', name: 'read_file', content: 'ok', attachments, codeChange });
  const tool = decoration.decorate({ role: 'tool', tool_call_id: 'read', content: 'ok' });
  assert.deepEqual(tool.attachments, attachments);
  assert.deepEqual(tool.codeChange, codeChange);
  const provenance = { version: 1, actor: 'agent', source: 'agent_tool', kind: 'peer_message', sourceChatId: 'other', sourceTurnId: 'other-execution' };
  assert.deepEqual(decoration.decorate({ role: 'user', content: '[Sub-agent finished] actual peer text', messageId: 'u1', provenance }),
    { role: 'user', content: '[Sub-agent finished] actual peer text', messageId: 'u1', provenance });
  assert.equal(decoration.decorate({ role: 'system', content: 'private profile' }), null);
  assert.equal(decoration.decorate({ role: 'user', toolImageFollowUp: true, content: [] }), null);
});

test('late round completion patches the persisted assistant without resetting tool identity or accounting', () => {
  const decoration = createTranscriptDecoration();
  decoration.observe({ type: 'round_start', index: 0 });
  const original = decoration.decorate({ role: 'assistant', messageId: 'saved', content: 'Partial',
    tool_calls: [{ id: 'call', type: 'function', function: { name: 'calculate', arguments: '{}' } }] });
  decoration.observe({ type: 'round_end', index: 0, text: 'Partial', reasoning: '', toolCallCount: 1,
    usage: { prompt_tokens: 20, completion_tokens: 10 }, finishReason: 'length', t0: 0, tFirst: 100, tEnd: 1100 });
  const patched = decoration.patchAssistant(original);
  assert.equal(patched.messageId, 'saved');
  assert.deepEqual(patched.tool_calls, original.tool_calls);
  assert.equal(patched.truncated, true);
  assert.deepEqual(patched.usage, { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 });
  assert.ok(patched.stats.tokens_per_second > 0);
  assert.equal(original.truncated, undefined, 'projection does not mutate the repository read');
});

test('shared response accounting preserves hidden-reasoning and warm llama cache behavior', () => {
  const hidden = finalizeResponseMeta({ usage: { prompt_tokens: 10, completion_tokens: 110,
    completion_tokens_details: { reasoning_tokens: 100 } } }, 0, 1000, 2000);
  assert.equal(hidden.stats.tokens_per_second, 5);
  const local = finalizeResponseMeta({ timings: { prompt_n: 10, cache_n: 90, predicted_n: 20 } }, 0, 100, 1000);
  assert.deepEqual(local.usage, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
});
