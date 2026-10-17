import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createToolExposure } from '../../server/runner/tool-exposure.js';
import { prepareConversation, continuation } from '../../server/generations/codex-app-server/conversation.js';
import { estimateToolsTokens, estimateHistoryTokens } from '../../server/runner/token-estimate-core.js';
import { checkpointMatches, cliHash } from '../../server/generations/agent-cli/checkpoints.js';

const tool = (name, description = name) => ({ type: 'function', function: {
  name, description, parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
} });
const native = catalog => createToolExposure(catalog, { apiKind: 'agent-cli-v1', lazyTools: true });

test('large MCP catalogs load only matching schemas into history, leaving native schemas and reserves fixed', () => {
  const builtins = [tool('read_file'), tool('git_log')];
  const mcp = Array.from({ length: 137 }, (_, i) => tool(`mcp__resend__email_${i}`, 'Email schema details '.repeat(200)));
  const exposure = native([...builtins, ...mcp]);
  const before = structuredClone(exposure.tools);
  const tokens = estimateToolsTokens(before);
  assert.deepEqual(before.map(t => t.function.name), ['read_file', 'git_log', 'search_mcp_tools', 'call_mcp_tool']);
  assert.ok(tokens < estimateToolsTokens([...builtins, ...mcp]) / 10);
  assert.deepEqual(native(builtins).tools, before, 'connecting a server does not change native schemas');
  assert.deepEqual(createToolExposure([...builtins, ...mcp], { apiKind: 'agent-cli-v1', lazyTools: false }).tools, before);
  const content = exposure.cliMcpTools.search({ query: mcp[12].function.name, limit: 1 });
  assert.deepEqual(JSON.parse(content).tools, [mcp[12].function]);
  assert.ok(estimateHistoryTokens([{ role: 'tool', content }]) > 0, 'discovered schemas count as transcript context');
  assert.deepEqual(exposure.tools, before);
  assert.equal(estimateToolsTokens(exposure.tools), tokens);
  const listing = JSON.parse(exposure.cliMcpTools.search({ list_only: true }));
  assert.equal(listing.names.length, 137);
  assert.ok(!JSON.stringify(listing).includes('parameters'));
});

test('MCP facade validates calls against the current authorized catalog without turn-local discovery state', () => {
  const exposed = native([tool('mcp__docs__read', 'Read documentation'), tool('read_file')]);
  assert.deepEqual(exposed.cliMcpTools.resolveCall({ name: 'mcp__docs__read', arguments: { value: 'x' } }),
    { name: 'mcp__docs__read', arguments: { value: 'x' } });
  for (const args of ['{', null, [], {}, { name: 'mcp__docs__read', arguments: [] },
    { name: 'read_file', arguments: {} }, { name: 'mcp__other__write', arguments: {} },
    { name: 'call_mcp_tool', arguments: {} }, { name: '__proto__', arguments: {} }]) {
    assert.match(exposed.cliMcpTools.resolveCall(args).error, /^Error:/);
  }
  assert.deepEqual(JSON.parse(exposed.cliMcpTools.search({ query: 'other write' })).tools, []);
  assert.match(exposed.cliMcpTools.search({ query: 'docs', limit: 6 }), /^Error:/);
  assert.match(native([]).cliMcpTools.resolveCall({ name: 'mcp__docs__read', arguments: {} }).error, /not available/);
});

test('discovering, invoking, and updating MCP schemas preserve the Codex continuation fingerprint', () => {
  const catalog = [tool('read_file'), tool('mcp__docs__read')];
  const first = native(catalog);
  const messages = [{ role: 'user', content: 'Look up docs.' }];
  const prepared = prepareConversation({ messages, tools: first.tools }, {});
  const call = { id: 'discover', type: 'function', function: { name: 'search_mcp_tools', arguments: '{"query":"docs"}' } };
  const accepted = [...prepared.messages, { role: 'assistant', content: '', tool_calls: [call] }];
  const result = { role: 'tool', tool_call_id: 'discover', content: first.cliMcpTools.search({ query: 'docs' }) };
  const refreshed = native([tool('read_file'), tool('mcp__docs__read', 'Updated docs'), tool('mcp__mail__send')]);
  const next = prepareConversation({ messages: [...accepted, result], tools: refreshed.tools }, {});
  assert.equal(next.signature, prepared.signature);
  const session = { signature: prepared.signature, accepted, handed: [call], waiting: true };
  assert.ok(continuation(session, next)?.results.has('discover'));
  const completed = [...next.messages, { role: 'assistant', content: 'Done.' }];
  const followUp = prepareConversation({ messages: [...completed, { role: 'user', content: 'Use those docs again.' }],
    tools: native([tool('read_file')]).tools }, {});
  assert.ok(continuation({ signature: next.signature, accepted: completed, waiting: false }, followUp)?.input);
  assert.ok(checkpointMatches({ clean: true, fingerprint: next.signature, acceptedCount: completed.length,
    acceptedHash: cliHash(completed) }, followUp.signature, followUp.messages), 'restart checkpoints survive MCP catalog changes too');
});

test('non-CLI exposure retains ordinary lazy discovery and the explicit full-catalog setting', () => {
  const catalog = [tool('read_file'), tool('git_log'), tool('mcp__docs__read')];
  const lazy = createToolExposure(catalog, { apiKind: 'openai-v1', lazyTools: true });
  assert.equal(lazy.cliMcpTools, null);
  assert.deepEqual(lazy.tools.map(t => t.function.name), ['read_file', 'search_tools']);
  lazy.lazyTools.search({ query: 'mcp__docs__read', limit: 1 });
  assert.equal(lazy.tools.at(-1), catalog[2]);
  assert.deepEqual(createToolExposure(catalog, { apiKind: 'openai-v1', lazyTools: false }).tools, catalog);
});
