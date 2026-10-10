import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cursorAcpModelMatches, cursorPermissionAllowed, cursorUnnamedMcpCall } from '../../server/generations/agent-cli/cursor-acp.js';

test('Cursor MCP identity matches the rows the real CLI emits', () => {
  const names = new Set(['echo_value']);
  // Recorded: tool_call placeholder, then the tool_call_update that names it.
  const placeholder = { sessionUpdate: 'tool_call', title: 'MCP: tool', kind: 'other', status: 'pending', rawInput: {} };
  const named = { sessionUpdate: 'tool_call_update', title: 'minnow: echo_value',
    rawInput: { providerIdentifier: 'minnow', toolName: 'echo_value', args: { key: 'alpha' } } };
  assert.equal(cursorPermissionAllowed({ toolCall: placeholder }, names), false);
  assert.equal(cursorUnnamedMcpCall(placeholder), true);
  assert.equal(cursorPermissionAllowed({ toolCall: named }, names), true);
  assert.equal(cursorPermissionAllowed({ toolCall: { title: 'minnow: echo_value' } }, names), true);
  assert.equal(cursorPermissionAllowed({ toolCall: { ...named, rawInput: { ...named.rawInput, providerIdentifier: 'other' }, title: 'other: echo_value' } }, names), false);
  assert.equal(cursorPermissionAllowed({ toolCall: { ...named, rawInput: { ...named.rawInput, toolName: 'shell' }, title: 'minnow: shell' } }, names), false);
  assert.equal(cursorUnnamedMcpCall(named), false);
  assert.equal(cursorUnnamedMcpCall({ title: 'Shell', kind: 'execute', rawInput: {} }), false);
});

// Shapes recorded from `cursor-agent --model <slug> acp` (2026.10.01) with the
// parameterized model picker advertised.
const result = (currentModelId, params = {}) => ({
  models: { currentModelId },
  configOptions: Object.entries(params).map(([id, currentValue]) => ({ id, currentValue })),
});

test('Cursor ACP model check accepts what --model selected for each slug shape', () => {
  assert.equal(cursorAcpModelMatches('auto', result('default')), true);
  assert.equal(cursorAcpModelMatches('gpt-5.3-codex-low', result('gpt-5.3-codex', { reasoning: 'low', fast: 'false' })), true);
  assert.equal(cursorAcpModelMatches('gpt-5.3-codex-high-fast', result('gpt-5.3-codex', { reasoning: 'high', fast: 'true' })), true);
  assert.equal(cursorAcpModelMatches('gpt-5.3-codex-xhigh', result('gpt-5.3-codex', { reasoning: 'extra-high', fast: 'false' })), true);
  assert.equal(cursorAcpModelMatches('claude-opus-5-thinking-high',
    result('claude-opus-5', { thinking: 'true', context: '300k', effort: 'high', fast: 'false' })), true);
  assert.equal(cursorAcpModelMatches('cursor-grok-4.5-high', result('grok-4.5', { effort: 'high', fast: 'false' })), true);
  assert.equal(cursorAcpModelMatches('grok-4.7-low-fast', result('grok-4.7', { context: '256k', reasoning_effort: 'low', fast: 'true' })), true);
  assert.equal(cursorAcpModelMatches('composer-2.5', result('composer-2.5', { fast: 'false' })), true);
  assert.equal(cursorAcpModelMatches('', result('anything')), true);
});

test('Cursor ACP model check rejects a different model or variant', () => {
  assert.equal(cursorAcpModelMatches('auto', result('composer-2.5')), false);
  assert.equal(cursorAcpModelMatches('composer-2.5', result('default')), false);
  assert.equal(cursorAcpModelMatches('gpt-5.3-codex-low', result('gpt-5.3-codex', { reasoning: 'medium', fast: 'false' })), false);
  assert.equal(cursorAcpModelMatches('gpt-5.3-codex-high-fast', result('gpt-5.3-codex', { reasoning: 'high', fast: 'false' })), false);
  assert.equal(cursorAcpModelMatches('gpt-5.3-codex-low', result('gpt-5.3-codex')), false);
  assert.equal(cursorAcpModelMatches('claude-opus-5-thinking-high', result('claude-opus-5', { thinking: 'false', effort: 'high' })), false);
  // The variants picker's combined id must not be mistaken for a confirmation.
  assert.equal(cursorAcpModelMatches('gpt-5.3-codex-low', result('gpt-5.3-codex[reasoning=medium,fast=false]')), false);
  assert.equal(cursorAcpModelMatches('composer-2.5', null), false);
});
