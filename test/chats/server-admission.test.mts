import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { createServerToolAdmission, consumeServerToolAdmission } from '../../src/tools/server-admission.ts';
import { maybeBlockToolForUserApproval } from '../../src/tools/permission-gate.ts';
import { defaultToolConfig, setToolConfigForTests } from '../../src/tools/config.ts';
import { resetToolSecurityMetaCache } from '../../src/config/tool-security-meta.ts';

const context = { chatId: 'child', executionId: 'execution', toolCallId: 'click', modeId: 'plan', workspaceRoot: 'C:/project' };
const args = { ref: 'button', surface: 'user' };
const mint = () => createServerToolAdmission({ ...context, toolName: 'browser_click', args });
const originalFetch = globalThis.fetch;
const originalDocument = globalThis.document;
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.document = originalDocument;
  resetToolSecurityMetaCache(); setToolConfigForTests(defaultToolConfig());
});
function prepare(permission: 'ask' | 'off' = 'ask') {
  globalThis.document = new Window().document as unknown as Document;
  globalThis.fetch = (async () => new Response(JSON.stringify({ toolSecurity: { filesystemAccess: 'workspace', shellSandbox: 'off' } }),
    { headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  const config = defaultToolConfig(); config.permissions.default.browser_click = permission;
  setToolConfigForTests(config); resetToolSecurityMetaCache();
}

test('server admission is private, exact and consumed once; JSON copies and altered calls cannot forge it', () => {
  assert.equal(consumeServerToolAdmission({}, 'browser_click', args, context), false);
  assert.equal(consumeServerToolAdmission(JSON.parse(JSON.stringify(mint())), 'browser_click', args, context), false);
  for (const change of [{ chatId: 'other' }, { executionId: 'other' }, { toolCallId: 'other' }, { modeId: 'build' }, { workspaceRoot: 'C:/other' }]) {
    assert.equal(consumeServerToolAdmission(mint(), 'browser_click', args, { ...context, ...change }), false);
  }
  assert.equal(consumeServerToolAdmission(mint(), 'browser_fill', args, context), false);
  assert.equal(consumeServerToolAdmission(mint(), 'browser_click', { ...args, ref: 'other-button' }, context), false);
  const token = mint();
  assert.equal(consumeServerToolAdmission(token, 'browser_click', { surface: 'user', ref: 'button' }, context), true);
  assert.equal(consumeServerToolAdmission(token, 'browser_click', args, context), false);
});

test('only saved Brave key enrichment may differ from the original search args', () => {
  const token = createServerToolAdmission({ ...context, toolName: 'web_search', args: { query: 'Minnow' } });
  assert.equal(consumeServerToolAdmission(token, 'web_search', { query: 'Minnow', api_key: 'locally-saved' }, context), true);
  const explicit = createServerToolAdmission({ ...context, toolName: 'web_search', args: { query: 'Minnow', api_key: 'explicit' } });
  assert.equal(consumeServerToolAdmission(explicit, 'web_search', { query: 'Minnow', api_key: 'changed' }, context), false);
});

test('valid server-once approval avoids a duplicate Ask while current Off still denies the same branded call', async () => {
  prepare();
  assert.equal(await maybeBlockToolForUserApproval('browser_click', args, { ...context, serverAdmission: mint() }), null);
  assert.equal(document.querySelectorAll('.tool-approval-strip').length, 0);
  prepare('off');
  const denied = await maybeBlockToolForUserApproval('browser_click', args, { ...context, serverAdmission: mint() });
  assert.match(denied!.content, /disabled in Settings/);
});

test('forged or mismatched proof keeps the ordinary Ask gate, and approval cannot bypass the path boundary', async () => {
  prepare();
  for (const token of [{} as ReturnType<typeof mint>, mint()]) {
    const denied = await maybeBlockToolForUserApproval('browser_click', args, { ...context, chatId: 'wrong-child', serverAdmission: token,
      signal: AbortSignal.abort(new DOMException('Declined', 'AbortError')) });
    assert.match(denied!.content, /denied tool execution/);
  }
  const config = defaultToolConfig(); config.permissions.default.read_file = 'ask'; setToolConfigForTests(config);
  const outside = { path: 'C:/outside/private.txt' };
  const token = createServerToolAdmission({ ...context, toolName: 'read_file', args: outside });
  const blocked = await maybeBlockToolForUserApproval('read_file', outside, { ...context, serverAdmission: token });
  assert.match(blocked!.content, /outside the workspace/);
});
