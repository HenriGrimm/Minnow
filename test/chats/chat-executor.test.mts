import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { executeChatTool } from '../../src/tools/chat-executor.ts';
import { executeTool } from '../../src/tools/client.ts';
import { defaultToolConfig, setToolConfigForTests } from '../../src/tools/config.ts';
import { executeHeadlessTool, getHeadlessToolDefinitions } from '../../src/headless/execute-tool.ts';
import { AGENT_CHAT_TOOL_IDS } from '../../server/chats/tool-catalog.js';

const originalFetch = globalThis.fetch;
Object.assign(globalThis, { sessionStorage: window.sessionStorage });
afterEach(() => { globalThis.fetch = originalFetch; sessionStorage.clear(); setToolConfigForTests(defaultToolConfig()); });

test('renderer helper derives source proof from the current lease and keeps arguments separate', async () => {
  sessionStorage.setItem('minnow.chatTurnOwner.source', 'owning-lease');
  let sent: any;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), '/api/chats/agent-commands');
    sent = JSON.parse(options!.body as string);
    return Response.json({ result: { commandId: 'accepted' } });
  };
  const result = await executeChatTool('chat_send', { chat_id: 'target', message: 'Review' }, { chatId: 'source', toolCallId: 'call' });
  assert.equal(JSON.parse(result.content).commandId, 'accepted');
  assert.deepEqual(sent, { sourceChatId: 'source', ownerId: 'owning-lease', toolCallId: 'call', name: 'chat_send', args: { chat_id: 'target', message: 'Review' } });
  assert.equal(sent.policy, undefined); assert.equal(sent.approvalGranted, undefined);
});

test('renderer Ask delegates once to the durable server request and Off never sends', async () => {
  sessionStorage.setItem('minnow.chatTurnOwner.source', 'owning-lease');
  const config = defaultToolConfig(); config.permissions.default.chat_send = 'ask'; setToolConfigForTests(config);
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ result: { commandId: 'approved' } }); };
  const approved = await executeTool('chat_send', { chat_id: 'target', message: 'Review' }, { chatId: 'source', toolCallId: 'call', modeId: 'build' });
  assert.equal(JSON.parse(approved.content).commandId, 'approved'); assert.equal(calls, 1);
  assert.equal(document.querySelectorAll('.tool-approval-strip').length, 0);
  config.permissions.default.chat_send = 'off'; setToolConfigForTests(config);
  assert.match((await executeTool('chat_send', { chat_id: 'target', message: 'No' }, { chatId: 'source', toolCallId: 'off' })).content, /disabled/);
  assert.equal(calls, 1);
});

test('renderer without a current owner cannot forge a sender from tool arguments', async () => {
  let calls = 0; globalThis.fetch = async () => { calls++; return Response.json({}); };
  const result = await executeChatTool('chat_send', { chat_id: 'target', message: 'x', ownerId: 'forged', sourceChatId: 'forged' }, { chatId: 'source', toolCallId: 'call' });
  assert.match(result.content, /active owning chat execution/); assert.equal(calls, 0);
});

test('fresh legacy CLI hides coordination and cannot manufacture authority; managed CLI uses the server owner', async () => {
  setToolConfigForTests(defaultToolConfig());
  assert.ok(getHeadlessToolDefinitions('build').every(tool => !AGENT_CHAT_TOOL_IDS.includes(tool.function.name)));
  const result = await executeHeadlessTool('chat_send', { chat_id: 'target', message: 'x' }, { chatId: 'forged', executionId: 'forged' },
    { modeId: 'build', autoRejectQuestions: true, noApproval: false });
  assert.match(result.content, /managed --chat-id/);
});
