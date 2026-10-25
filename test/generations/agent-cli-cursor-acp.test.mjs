import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCursorAcp, cursorAcpModelMatches, cursorPermissionAllowed, cursorUnnamedMcpCall } from '../../server/generations/agent-cli/cursor-acp.js';

test('Cursor ACP registers the authorized bridge before starting the session', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-cursor-mcp-'));
  const mcpServers = [{ name: 'minnow', command: process.execPath, args: ['bridge.mjs'], env: [{ name: 'FIXTURE', value: 'private' }] }];
  let run;
  try {
    run = await openCursorAcp({ command: process.execPath,
      args: [fileURLToPath(new URL('../fixtures/fake-cursor-acp.mjs', import.meta.url))], cwd: root,
      env: { ...process.env, CURSOR_DATA_DIR: root, ACP_EXPECT_MCP: JSON.stringify(mcpServers) }, selectedModel: 'fixture', mcpServers });
    assert.equal(run.method, 'new');
  } finally { await run?.stop(); await fs.rm(root, { recursive: true, force: true }); }
});

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
  assert.equal(cursorPermissionAllowed({ toolCall: { ...named, rawInput: { ...named.rawInput, providerIdentifier: 'other' } } }, names), false);
  assert.equal(cursorPermissionAllowed({ toolCall: { ...named, rawInput: { ...named.rawInput, serverName: 'other' } } }, names), false);
  assert.equal(cursorUnnamedMcpCall(named), false);
  assert.equal(cursorUnnamedMcpCall({ title: 'Shell', kind: 'execute', rawInput: {} }), false);
});

async function fixture(env, check) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'minnow-cursor-recovery-'));
  const log = path.join(root, 'calls.log');
  const diagnostics = [];
  let run;
  try {
    run = await openCursorAcp({ command: process.execPath,
      args: [fileURLToPath(new URL('../fixtures/fake-cursor-acp.mjs', import.meta.url))], cwd: root,
      env: { ...process.env, CURSOR_DATA_DIR: root, ACP_CALL_LOG: log, ...env }, selectedModel: 'fixture' },
    { onNativeData: chunk => diagnostics.push(chunk.toString()) });
    const rows = [];
    let finish;
    const terminal = new Promise(resolve => { finish = resolve; });
    let pending = '';
    run.child.stdout.on('data', chunk => {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const row = JSON.parse(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        rows.push(row);
        if (row.type === 'result' || row.type === 'error') finish(row);
      }
    });
    await check({ run, root, log, rows, terminal, diagnostics });
  } finally { await run?.stop(); await fs.rm(root, { recursive: true, force: true }); }
}

for (const env of [{ ACP_EDIT_PERMISSION: '1', ACP_LATE_TEXT: '1' }, { ACP_CANCEL_ERROR: '1' }]) {
  test(`Cursor cancels a native edit and continues after ${env.ACP_CANCEL_ERROR ? 'RPC cancellation' : 'permission cancellation'}`, { timeout: 10_000 }, async () => {
    await fixture(env, async ({ run, root, log, rows, terminal, diagnostics }) => {
      await run.send('EDIT_NATIVE');
      assert.equal((await terminal).type, 'result');
      assert.equal(rows.filter(row => row.type === 'assistant').map(row => row.message.content[0].text).join(''), 'Reply 2.');
      assert.match(diagnostics.join(''), /rejected unexposed native tool "Edit File"/);
      assert.equal((await fs.readFile(log, 'utf8')).match(/^session\/prompt$/gm).length, 2);
      assert.equal((await fs.readFile(log, 'utf8')).match(/^session\/cancel$/gm).length, 1);
      assert.equal(await fs.access(path.join(root, 'forbidden')).then(() => true, () => false), false);
    });
  });
}

test('Cursor bounds repeated native tool recovery and names the rejected tool in the final error', { timeout: 10_000 }, async () => {
  await fixture({ ACP_REPEAT_NATIVE: '1' }, async ({ run, log, terminal }) => {
    await run.send('EDIT_NATIVE');
    const end = await terminal;
    assert.equal(end.type, 'error');
    assert.match(end.message, /unexposed native tool "Edit File".*exceeded 2 recovery attempts/);
    assert.equal((await fs.readFile(log, 'utf8')).match(/^session\/prompt$/gm).length, 3);
  });
});

test('stopping Cursor during native tool cancellation never sends a recovery prompt', { timeout: 10_000 }, async () => {
  await fixture({ ACP_IGNORE_CANCEL: '1' }, async ({ run, log, diagnostics }) => {
    const controller = new AbortController();
    await run.send('EDIT_NATIVE', controller.signal);
    // Wait for the notification to reach the guard before exercising Stop.
    while (!diagnostics.some(line => line.includes('[Minnow]'))) await new Promise(resolve => setTimeout(resolve, 10));
    controller.abort();
    await run.stop();
    await run.done;
    assert.equal((await fs.readFile(log, 'utf8')).match(/^session\/prompt$/gm).length, 1);
  });
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
