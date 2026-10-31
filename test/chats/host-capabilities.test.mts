import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatHostCapabilityProcessor, chatHostToolCapabilities } from '../../src/chat/host-capabilities.ts';
import type { HostToolEnvelope } from '../../server/chats/host-capabilities.js';
import type { ToolDefinition } from '../../src/tools/definitions.ts';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initSessionsSchema } from '../../server/config/sessions-schema.js';
import { createChatRepository } from '../../server/chats/repository.js';
import { createChatHostCapabilities } from '../../server/chats/host-capabilities.js';
import { consumeServerToolAdmission } from '../../src/tools/server-admission.ts';

class StorageFixture implements Storage {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  removeItem(key: string) { this.data.delete(key); }
  setItem(key: string, value: string) { this.data.set(key, value); }
}
const envelope: HostToolEnvelope = { version: 1, type: 'execute', invocationId: 'invocation', hostId: 'host', projectId: 'project', chatId: 'child',
  executionId: 'execution', toolCallId: 'click', name: 'browser_click', args: { ref: 'button', surface: 'user' }, inputHash: 'a'.repeat(64),
  context: { modeId: 'plan', workspaceRoot: 'C:/project', runId: 'assignment', agentId: 'execution' } };
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test('renderer persists started before the actual tool and done before acknowledgement; a lost receipt never repeats the effect', async () => {
  const storage = new StorageFixture(); let calls = 0; let responses = 0; let context;
  const processor = createChatHostCapabilityProcessor({ hostId: 'host', capabilities: ['tool:browser_click'], storage,
    execute: async (_name, _args, ctx) => { calls++; context = ctx;
      assert.equal(JSON.parse(storage.getItem('minnow.hostTool.v1.invocation')!).state, 'started'); return { content: 'Clicked' }; },
    respond: async response => { responses++; assert.equal(response.result?.content, 'Clicked');
      assert.equal(JSON.parse(storage.getItem('minnow.hostTool.v1.invocation')!).state, 'done');
      if (responses === 1) throw new Error('HTTP acknowledgement lost'); } });
  await assert.rejects(processor.handle(envelope), /acknowledgement lost/);
  await processor.handle(envelope);
  assert.equal(calls, 1); assert.equal(responses, 2);
  assert.equal(context!.chatId, 'child'); assert.equal(context!.workspaceRoot, 'C:/project'); assert.equal(context!.modeId, 'plan');
  assert.equal(context!.benchmarkAutonomous, undefined);
  assert.equal(JSON.parse(storage.getItem('minnow.hostTool.v1.invocation')!).acknowledged, true);
  processor.dispose();
});

test('reload with a started marker reports indeterminate, while reconnect within a live view shares the active call', async () => {
  const storage = new StorageFixture(); let calls = 0; let release!: (value: { content: string }) => void;
  const first = createChatHostCapabilityProcessor({ hostId: 'host', capabilities: ['tool:browser_click'], storage,
    execute: () => { calls++; return new Promise(resolve => { release = resolve; }); }, respond: async () => {} });
  const original = first.handle(envelope); const duplicate = first.handle(envelope);
  while (!release) await tick();
  assert.equal(calls, 1); first.dispose();
  const replies: any[] = [];
  const replacement = createChatHostCapabilityProcessor({ hostId: 'host', capabilities: ['tool:browser_click'], storage,
    execute: async () => { calls++; return { content: 'Unsafe repeat' }; }, respond: async response => { replies.push(response); } });
  await replacement.handle(envelope);
  assert.equal(calls, 1); assert.equal(replies[0].indeterminate, true);
  release({ content: 'Old host finished' }); await Promise.all([original, duplicate]);
  assert.equal(JSON.parse(storage.getItem('minnow.hostTool.v1.invocation')!).state, 'started');
  replacement.dispose();
});

test('receipt marker failure prevents execution and a result persistence failure becomes indeterminate', async () => {
  for (const failure of ['started', 'done']) {
    const storage = new StorageFixture(); let calls = 0; const replies: any[] = [];
    const set = storage.setItem.bind(storage);
    storage.setItem = (key, raw) => { if (JSON.parse(raw).state === failure) throw new Error('Quota exceeded'); set(key, raw); };
    const processor = createChatHostCapabilityProcessor({ hostId: 'host', capabilities: ['tool:browser_click'], storage,
      execute: async () => { calls++; return { content: 'Clicked' }; }, respond: async response => { replies.push(response); } });
    await processor.handle(envelope);
    assert.equal(calls, failure === 'started' ? 0 : 1);
    if (failure === 'started') assert.match(replies[0].result.content, /not executed/); else assert.equal(replies[0].indeterminate, true);
    processor.dispose();
  }
});

test('wrong host, unsupported capability and managed configuration tools never enter generic executeTool', async () => {
  let calls = 0;
  const processor = createChatHostCapabilityProcessor({ hostId: 'host', capabilities: ['tool:browser_click', 'tool:set_chat_mode'], storage: new StorageFixture(),
    execute: async () => { calls++; return { content: 'Done' }; }, respond: async () => {} });
  await assert.rejects(processor.handle({ ...envelope, hostId: 'other' }), /scope/);
  await assert.rejects(processor.handle({ ...envelope, name: 'browser_eval' }), /scope/);
  await assert.rejects(processor.handle({ ...envelope, name: 'set_chat_mode' }), /scope/);
  assert.equal(calls, 0); processor.dispose();
});

test('cancel targets only its live callback and receipt capacity never evicts an unacknowledged effect', async () => {
  const storage = new StorageFixture(); let started = false; let aborted = false; let calls = 0;
  const processor = createChatHostCapabilityProcessor({ hostId: 'host', capabilities: ['tool:browser_click'], storage, maxRecords: 1,
    execute: async (_name, _args, context) => { calls++; started = true; await new Promise<void>(resolve => context.signal!.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true })); return { content: 'Stopped' }; },
    respond: async () => { throw new Error('Disconnected'); } });
  const running = processor.handle(envelope); running.catch(() => {});
  while (!started) await tick();
  await processor.handle({ version: 1, type: 'cancel', invocationId: 'unrelated' }); assert.equal(aborted, false);
  await processor.handle({ version: 1, type: 'cancel', invocationId: envelope.invocationId });
  await assert.rejects(running, /Disconnected/); assert.equal(aborted, true);
  await assert.rejects(processor.handle({ ...envelope, invocationId: 'second' }), /Disconnected/);
  assert.equal(calls, 1); assert.equal(JSON.parse(storage.getItem('minnow.hostTool.v1.invocation')!).acknowledged, undefined);
  processor.dispose();
});

test('advertised capabilities require real desktop automation and omit server-owned chat mutations', () => {
  const tool = (name: string, serverRequired = false): ToolDefinition => ({ id: name, label: name, description: '', category: 'utility', serverRequired,
    definition: { type: 'function', function: { name, description: '', parameters: { type: 'object', properties: {} } } } });
  const catalog = [tool('browser_click'), tool('set_chat_mode'), tool('todo_write'), tool('read_clipboard'), tool('save_file', true)];
  assert.deepEqual(chatHostToolCapabilities(catalog, false), ['tool:read_clipboard']);
  assert.deepEqual(chatHostToolCapabilities(catalog, true), ['tool:browser_click', 'tool:read_clipboard']);
});

test('actual broker and renderer replay a missed receipt without repeating a real scratch-file effect', async () => {
  const db = new Database(':memory:'); initSessionsSchema(db);
  const repository = createChatRepository({ db });
  repository.createChat({ id: 'child', workspacePath: 'C:/project' });
  const fence = repository.claimExecution({ chatId: 'child', executionId: 'execution', ownerId: 'server' });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'minnow-host-receipt-'));
  const file = path.join(scratch, 'effect.txt');
  const broker = createChatHostCapabilities({ repository, retryMs: 10, resolveProject: () => ({ projectId: 'project', workspaceRoot: 'C:/project' }) });
  let calls = 0, replies = 0;
  const processor = createChatHostCapabilityProcessor({ hostId: 'host', capabilities: ['tool:browser_click'], storage: new StorageFixture(),
    execute: async (name, args, context) => {
      assert.equal(consumeServerToolAdmission(context.serverAdmission, name, args, context), true);
      calls++; fs.appendFileSync(file, 'effect\n'); return { content: 'Clicked' };
    },
    respond: async response => { if (++replies === 1) throw new Error('Request lost before server acceptance'); return broker.respond(response); } });
  broker.register({ hostId: 'host', projectId: 'project', capabilities: ['tool:browser_click'], send: frame => { void processor.handle(frame).catch(() => {}); } });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const input = { name: 'browser_click', args: envelope.args, ctx: { toolCallId: 'click' }, chatId: 'child', executionId: 'execution', fence,
      signal: new AbortController().signal, prepared: { policy: { modeId: 'plan' } } } as Parameters<typeof broker.executeHostTool>[0];
    const result = await Promise.race([broker.executeHostTool(input), new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Receipt retry hung')), 2000); })]);
    assert.equal(result.content, 'Clicked'); assert.equal(calls, 1); assert.equal(replies, 2);
    assert.equal(fs.readFileSync(file, 'utf8'), 'effect\n');
    assert.equal(repository.listOutbox({ states: ['applied'] }).filter(row => row.kind === 'host.tool.result').length, 1);
  } finally {
    clearTimeout(timeout); processor.dispose(); broker.dispose(); db.close();
    assert.ok(path.resolve(scratch).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('a renderer replacement after a started effect reports indeterminate and leaves the original intent for recovery', async () => {
  const db = new Database(':memory:'); initSessionsSchema(db);
  const repository = createChatRepository({ db });
  repository.createChat({ id: 'child', workspacePath: 'C:/project' });
  const fence = repository.claimExecution({ chatId: 'child', executionId: 'execution', ownerId: 'server' });
  repository.recordToolIntent({ invocationId: 'intent', chatId: 'child', executionId: 'execution', toolCallId: 'click', toolName: 'browser_click', input: envelope.args }, { fence });
  const broker = createChatHostCapabilities({ repository, retryMs: 1000, resolveProject: () => ({ projectId: 'project', workspaceRoot: 'C:/project' }) });
  const storage = new StorageFixture(); let effects = 0; let release!: (result: { content: string }) => void;
  const first = createChatHostCapabilityProcessor({ hostId: 'host', capabilities: ['tool:browser_click'], storage,
    execute: () => { effects++; return new Promise(resolve => { release = resolve; }); }, respond: async response => broker.respond(response) });
  broker.register({ hostId: 'host', projectId: 'project', capabilities: ['tool:browser_click'], send: frame => { void first.handle(frame).catch(() => {}); } });
  const input = { name: 'browser_click', args: envelope.args, ctx: { toolCallId: 'click' }, chatId: 'child', executionId: 'execution', fence,
    signal: new AbortController().signal, prepared: { policy: { modeId: 'plan' } } } as Parameters<typeof broker.executeHostTool>[0];
  const waiting = broker.executeHostTool(input); waiting.catch(() => {});
  let replacement: ReturnType<typeof createChatHostCapabilityProcessor> | undefined;
  try {
    while (!release) await tick(); first.dispose();
    replacement = createChatHostCapabilityProcessor({ hostId: 'host', capabilities: ['tool:browser_click'], storage,
      execute: async () => { effects++; return { content: 'Unsafe duplicate' }; }, respond: async response => broker.respond(response) });
    broker.register({ hostId: 'host', projectId: 'project', capabilities: ['tool:browser_click'], send: frame => { void replacement!.handle(frame).catch(() => {}); } });
    await assert.rejects(waiting, { code: 'recovery_required' });
    assert.equal(effects, 1); assert.equal(repository.listUnsettledToolInvocations('execution').length, 1);
    release({ content: 'Late result' }); await tick();
  } finally { first.dispose(); replacement?.dispose(); broker.dispose(); db.close(); }
});
