import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { parseRunArgs } from '../../src/headless/argv.ts';
import { runManagedChatIfPresent } from '../../src/headless/managed-chat.ts';

function fixture(args: string[] = []) {
  const parsed = parseRunArgs(['--prompt', 'Task', '--chat-id', 'child', ...args]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error(parsed.message);
  const controller = new AbortController();
  const calls: Array<{ path: string; body?: any; client: string | null }> = [];
  const logs: string[] = [];
  const events: any[] = [];
  const prefix = `m-${createHash('sha256').update('owned-execution').digest('hex').slice(0, 32)}-`;
  const snapshot: any = { chat: { id: 'child', chatCommandVersion: 1, modeId: 'plan', providerId: 'saved', modelId: 'model', workspacePath: '/project' },
    execution: { executionId: 'different-execution', status: 'running' },
    frame: { epoch: 'owned-execution', history: { messages: [{ role: 'assistant', messageId: `${prefix}1`, content: 'Canonical owned answer' }] } } };
  let polls = 0;
  const receipt: any = { commandId: 'command', state: 'queued', revision: 1, disposition: 'queued', executionId: null };
  const response = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  let route = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url === '/api/chats/child') return response(snapshot);
    if (url === '/api/chats/capabilities') return response({ creationEnabled: true, conversationStorage: 'sqlite' });
    if (url === '/api/chats/child/commands') {
      const body = JSON.parse(String(init?.body));
      if (body.action === 'send' || body.action === 'steer') return response({ receipt, frame: { epoch: 'different-execution' } }, 202);
      return response({ receipt: { commandId: 'control', state: 'settled' } }, 202);
    }
    if (url === '/api/chat-commands/command') {
      polls++;
      return response({ receipt: { ...receipt, state: 'settled', disposition: 'settled', executionId: 'owned-execution', result: { outcome: 'no_report' } } });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  const fetchApi: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ path: url, body: init?.body ? JSON.parse(String(init.body)) : undefined,
      client: new Headers(init?.headers).get('X-Minnow-Chat-Client') });
    return route(url, init);
  };
  const options = { cli: parsed.options, workspaceAbs: null, signal: controller.signal,
    log: (line: string) => logs.push(line), onEvent: (event: any) => events.push(event) };
  return { options, controller, calls, logs, events, snapshot, receipt, prefix,
    adapters: { fetch: fetchApi, id: () => 'request', sleep: async () => {} }, response,
    setRoute: (value: typeof route) => { route = value; }, polls: () => polls };
}

test('managed --chat-id sends one durable command and never invokes generations or session writes', async () => {
  const f = fixture(['--persist-chat']);
  const result = await runManagedChatIfPresent(f.options, f.adapters);
  assert.equal(result?.ok, true);
  assert.equal(result?.assistantFinal, 'Canonical owned answer');
  assert.equal(result?.chatId, 'child');
  assert.equal(result?.promptProfile, 'managed');
  assert.equal(result?.managedChat?.commandId, 'command');
  assert.deepEqual(f.calls.filter(call => call.body).map(call => call.body), [
    { action: 'send', text: 'Task', clientRequestId: 'request' },
  ]);
  assert.ok(f.calls.every(call => call.client === 'cli'));
  assert.ok(f.calls.every(call => !call.path.includes('/generations') && !call.path.includes('/sessions')));
});

test('existing ordinary chat ids use durable admission while missing ids alone retain fresh persistence', async () => {
  const legacy = fixture(); legacy.snapshot.chat.chatCommandVersion = undefined;
  assert.equal((await runManagedChatIfPresent(legacy.options, legacy.adapters))?.ok, true);
  assert.equal(legacy.calls.filter(call => call.body).length, 1);
  assert.ok(legacy.calls.every(call => !/generations|sessions/.test(call.path)));
  const absent = fixture(); absent.setRoute(async () => absent.response({ error: { code: 'chat_not_found', message: 'Missing' } }, 404));
  assert.equal(await runManagedChatIfPresent(absent.options, absent.adapters), null);
  const explicit = fixture(['--chat-action', 'send']); explicit.setRoute(async () => explicit.response({ error: { code: 'chat_not_found', message: 'Missing' } }, 404));
  assert.equal((await runManagedChatIfPresent(explicit.options, explicit.adapters))?.exitCode, 2);
  assert.equal(explicit.calls.length, 1);
});

test('disabled creation never falls through and overwrites an existing ordinary conversation', async () => {
  const f = fixture(); f.snapshot.chat.chatCommandVersion = undefined;
  f.setRoute(async url => url === '/api/chats/child' ? f.response(f.snapshot)
    : f.response({ creationEnabled: false, conversationStorage: 'sqlite' }));
  const result = await runManagedChatIfPresent(f.options, f.adapters);
  assert.equal(result?.ok, false); assert.match(result?.error ?? '', /saved history has been preserved/);
  assert.equal(f.calls.length, 2); assert.ok(f.calls.every(call => !call.body));
});

test('authentication/server errors never fall back to a local runner', async () => {
  for (const status of [401, 403, 500]) {
    const f = fixture(); f.setRoute(async () => f.response({ error: { message: 'Denied' } }, status));
    const result = await runManagedChatIfPresent(f.options, f.adapters);
    assert.equal(result?.ok, false); assert.equal(result?.error, 'Denied');
    assert.equal(f.calls.length, 1);
  }
  const oldServer = fixture(); oldServer.setRoute(async () => oldServer.response({ error: 'Unknown endpoint' }, 404));
  assert.equal((await runManagedChatIfPresent(oldServer.options, oldServer.adapters))?.ok, false);
  assert.equal(oldServer.calls.length, 1);
});

test('scheduler queue and steer use their explicit ingress and action, without implicit replies', async () => {
  const queued = fixture(['--scheduler-run', '--chat-action', 'queue']);
  assert.equal((await runManagedChatIfPresent(queued.options, queued.adapters))?.ok, true);
  assert.deepEqual(queued.calls.find(call => call.body)?.body, { action: 'send', text: 'Task', mode: 'queue', clientRequestId: 'request' });
  assert.ok(queued.calls.every(call => call.client === 'scheduler'));
  const steer = fixture(['--chat-action', 'steer']);
  Object.assign(steer.receipt, { state: 'settled', disposition: 'steered', executionId: 'owned-execution' });
  const result = await runManagedChatIfPresent(steer.options, steer.adapters);
  assert.equal(result?.ok, true); assert.equal(result?.assistantFinal, '');
  assert.equal(steer.calls.find(call => call.body)?.body.action, 'steer');
});

test('lost admission response retries identical intent and client receipt identity', async () => {
  const f = fixture(['--client-request-id', 'stable']);
  let attempts = 0;
  f.setRoute(async (url, init) => {
    if (url === '/api/chats/child') return f.response(f.snapshot);
    if (url.endsWith('/commands')) {
      attempts++; if (attempts === 1) throw new TypeError('Connection lost after admission');
      return f.response({ receipt: { ...f.receipt, state: 'settled' } });
    }
    throw new Error(url);
  });
  assert.equal((await runManagedChatIfPresent(f.options, f.adapters))?.ok, true);
  const sent = f.calls.filter(call => call.body);
  assert.equal(sent.length, 2); assert.deepEqual(sent[0].body, sent[1].body);
  assert.equal(sent[0].body.clientRequestId, 'stable');
});

test('SIGINT stops only the command pinned execution, never descendants or another active turn', async () => {
  const f = fixture();
  Object.assign(f.receipt, { state: 'running', executionId: 'owned-execution' });
  f.adapters.sleep = async () => { f.controller.abort(); };
  f.setRoute(async (url, init) => {
    if (url === '/api/chats/child') return f.response(f.snapshot);
    if (url === '/api/chat-commands/command') return f.response({ receipt: f.receipt });
    if (url.endsWith('/commands')) return f.response({ receipt: f.receipt });
    throw new Error(url);
  });
  const result = await runManagedChatIfPresent(f.options, f.adapters);
  assert.equal(result?.exitCode, 130);
  const stop = f.calls.find(call => call.body?.action === 'stop')?.body;
  assert.deepEqual(stop, { action: 'stop', scope: 'turn', executionId: 'owned-execution', clientRequestId: 'request-stop' });
  assert.ok(!f.calls.some(call => call.body?.scope === 'tree'));
});

test('SIGINT removes only its queued message when another execution owns the chat', async () => {
  const f = fixture();
  f.adapters.sleep = async () => { f.controller.abort(); };
  f.setRoute(async url => {
    if (url === '/api/chats/child') return f.response(f.snapshot);
    return f.response({ receipt: f.receipt });
  });
  assert.equal((await runManagedChatIfPresent(f.options, f.adapters))?.exitCode, 130);
  assert.deepEqual(f.calls.find(call => call.body?.action === 'remove')?.body,
    { action: 'remove', itemId: 'command', expectedRevision: 1, clientRequestId: 'request-remove' });
  assert.ok(!f.calls.some(call => call.body?.action === 'stop'));
});

test('wait timeout returns the receipt and keeps accepted work running', async () => {
  const f = fixture(['--wait-timeout', '1']);
  let clock = 0;
  f.setRoute(async url => url === '/api/chats/child' ? f.response(f.snapshot) : f.response({ receipt: f.receipt }));
  const result = await runManagedChatIfPresent(f.options, { ...f.adapters, now: () => clock, sleep: async () => { clock += 1000; } });
  assert.equal(result?.exitCode, 124); assert.equal(result?.managedChat?.commandId, 'command');
  assert.ok(!f.calls.some(call => ['remove', 'stop'].includes(call.body?.action)));
});

test('explicit configuration overrides fail before admission while unchanged provider/model are accepted', async () => {
  const changed = fixture(['--model', 'another']);
  assert.match((await runManagedChatIfPresent(changed.options, changed.adapters))?.error ?? '', /saved agent, model/);
  assert.equal(changed.calls.length, 1);
  const approval = fixture(['--no-approval']);
  assert.match((await runManagedChatIfPresent(approval.options, approval.adapters))?.error ?? '', /saved tool approvals/);
  assert.equal(approval.calls.length, 1);
  const same = fixture(['--provider', 'saved', '--model', 'model', '--mode', 'plan']);
  assert.equal((await runManagedChatIfPresent(same.options, same.adapters))?.ok, true);
});

test('CLI parses managed controls with strict receipt identities and no legacy argument break', () => {
  for (const args of [['--chat-action', 'invalid'], ['--client-request-id', 'x/y'], ['--wait-timeout=-1']]) {
    assert.equal(parseRunArgs(['--prompt', 'Task', '--chat-id', 'child', ...args]).ok, false);
  }
  assert.equal(parseRunArgs(['--prompt', 'Task', '--chat-action', 'send']).ok, false);
  const ordinary = parseRunArgs(['--prompt', 'Task']);
  assert.equal(ordinary.ok, true);
  if (ordinary.ok) assert.equal(ordinary.options.chatAction, undefined);
});
