import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { createEmptyChatObject, setSessionStateForTests, resetSessionPersistenceForTests } from '../../src/state/sessions.ts';
import { sendRemoteChatCommand, shouldRelayChat } from '../../src/chat/remote-chat-client.ts';
import { setPairedDevice } from '../../src/api/session-token.ts';
import { encodeModelSelectKey } from '../../src/lib/model-select-key.ts';
import { sendProgrammaticChatText } from '../../src/chat/messaging.ts';

const fetchBefore = globalThis.fetch;
Object.assign(globalThis, { sessionStorage: window.sessionStorage });
const chatId = 'managed-client-test';
function setup() {
  const chat = createEmptyChatObject('model');
  chat.id = chatId;
  chat.chatCommandVersion = 1;
  chat.profileReference = { profileId: 'profile', profileVersion: 3 };
  setSessionStateForTests({ version: 6, activeId: chatId, sidebarCollapsed: false, chats: [chat] });
  setPairedDevice(false);
  return chat;
}
afterEach(() => {
  globalThis.fetch = fetchBefore;
  resetSessionPersistenceForTests();
  setSessionStateForTests(null);
  sessionStorage.clear();
});

test('an idle managed child admits text/files/images once through server ownership', async () => {
  setup();
  assert.equal(shouldRelayChat(chatId), true);
  const bodies: any[] = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), `/api/chats/${chatId}/commands`);
    bodies.push(JSON.parse(options!.body as string));
    if (bodies.length === 1) throw new TypeError('lost admission receipt');
    return Response.json({ receipt: { commandId: 'admitted', disposition: 'started' } });
  };
  await sendRemoteChatCommand(chatId, 'send', { text: 'Inspect', attachments: [
    { id: 'text', name: 'file.txt', kind: 'text', size: 4, mimeType: 'text/plain', text: 'body' },
    { id: 'image', name: 'view.png', kind: 'image', size: 4, mimeType: 'image/png', dataUrl: 'data:image/png;base64,YWJjZA==' },
  ] });
  assert.deepEqual(bodies[0], bodies[1]);
  assert.match(bodies[0].text, /<file name="file.txt">\nbody/);
  assert.match(bodies[0].text, /\[image: view.png\]/);
  assert.equal(bodies[0].images[0].dataUrl, 'data:image/png;base64,YWJjZA==');
  assert.equal(bodies[0].provenance, undefined, 'server stamps authorship');
});

test('managed queue edits include the observed revision and stale UI cannot manufacture one', async () => {
  const chat = setup();
  chat.pendingMessageQueue = [{ id: 'queued', text: 'Before', createdAt: 1, commandRevision: 4 }];
  let body: any;
  globalThis.fetch = async (_url, options) => { body = JSON.parse(options!.body as string); return Response.json({}); };
  await sendRemoteChatCommand(chatId, 'edit', { itemId: 'queued', text: 'After' });
  assert.equal(body.expectedRevision, 4);
  assert.equal(body.itemId, 'queued');
  assert.equal(chat.pendingMessageQueue[0].text, 'Before', 'receipt projections own queue updates');
  await assert.rejects(sendRemoteChatCommand(chatId, 'remove', { itemId: 'missing' }), /changed/);
});

test('managed configuration captures a complete pair without writing a remembered default or stopping work', async () => {
  setup();
  const calls: { url: string; body: any; method: string }[] = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options!.body as string), method: options!.method! });
    return Response.json({});
  };
  await sendRemoteChatCommand(chatId, 'configure', { patch: { modelSelectValue: encodeModelSelectKey('provider', 'next') } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].url, `/api/chats/${chatId}/configuration`);
  assert.deepEqual(calls[0].body.selection, { providerId: 'provider', modelId: 'next', options: {} });
  assert.equal(calls[0].body.expectedProfileVersion, 3);
});

test('a programmatic completed-turn requirement waits for its own durable terminal receipt', async () => {
  const chat = setup();
  let polls = 0, accepted = false, completed = false;
  globalThis.fetch = async (url, options) => {
    if (options?.method === 'POST') return Response.json({ receipt: { commandId: 'own', chatId, revision: 1, state: 'queued' } });
    assert.equal(String(url), '/api/chat-commands/own');
    polls++;
    return Response.json({ receipt: { commandId: 'own', chatId, revision: polls + 1,
      state: polls === 1 ? 'running' : 'settled', executionId: 'own-execution', assistantFinal: 'Own answer' } });
  };
  const result = sendProgrammaticChatText(chat, 'Continue', { requireCompletedTurn: true,
    onUserMessageAccepted: async () => { accepted = true; } }).then(() => { completed = true; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(accepted, true);
  assert.equal(completed, false);
  await result;
  assert.equal(polls, 2);
});

test('aborting a programmatic send pins Stop to its own execution', async () => {
  const chat = setup();
  const abort = new AbortController();
  const controls: any[] = [];
  globalThis.fetch = async (url, options) => {
    if (options?.method === 'POST') {
      const body = JSON.parse(options.body as string);
      if (body.action === 'stop') { controls.push(body); return Response.json({}); }
    }
    return Response.json({ receipt: { commandId: 'own', chatId, revision: 2, state: 'running', executionId: 'own-execution' } });
  };
  const run = sendProgrammaticChatText(chat, 'Work', { requireCompletedTurn: true, signal: abort.signal,
    onUserMessageAccepted: async () => { abort.abort(new Error('Stopped by caller')); } });
  await assert.rejects(run, /Stopped by caller/);
  assert.equal(controls.length, 1);
  assert.equal(controls[0].executionId, 'own-execution');
  assert.equal(controls[0].scope, 'turn');
});
