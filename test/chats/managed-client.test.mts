import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { createEmptyChatObject, setSessionStateForTests, resetSessionPersistenceForTests } from '../../src/state/sessions.ts';
import { sendRemoteChatCommand, shouldRelayChat } from '../../src/chat/remote-chat-client.ts';
import { setPairedDevice } from '../../src/api/session-token.ts';
import { encodeModelSelectKey } from '../../src/lib/model-select-key.ts';
import { sendProgrammaticChatText } from '../../src/chat/messaging.ts';
import { forkManagedChat, sendManagedChatAction } from '../../src/chat/managed-chat-client.ts';
import { registerPluginSlashCommand } from '../../src/chat/slash-commands/registry.ts';
import { sendMessageWithTools } from '../../src/chat/messaging.ts';
import { attachMessageActions, closeMessageActionsMenu } from '../../src/ui/message-actions.ts';
import { readAgentConversationsCapability } from '../../src/config/agent-conversations-enabled.ts';
import { startManagedChatBridge } from '../../src/chat/managed-chat-bridge.ts';
import { syncComposerPinnedSkillFromActiveChat } from '../../src/ui/composer-pinned-skill.ts';

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
afterEach(async () => {
  await import('../../src/state/issues-store.ts');
  globalThis.fetch = fetchBefore;
  resetSessionPersistenceForTests();
  setSessionStateForTests(null);
  sessionStorage.clear();
  closeMessageActionsMenu();
});

test('an idle managed child admits text/files/images once through server ownership', async () => {
  setup();
  assert.equal(shouldRelayChat(chatId), true);
  const bodies: any[] = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), `/api/chats/${chatId}/commands`);
    bodies.push(JSON.parse(options!.body as string));
    if (bodies.length === 1) throw new TypeError('lost admission receipt');
    return Response.json({ receipt: { commandId: 'admitted', chatId, state: 'running', revision: 1, disposition: 'started' } });
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

test('managed steering sends image-only content with stable image bytes across a lost acknowledgement', async () => {
  setup();
  const bodies: any[] = [];
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(String(options?.body)));
    if (bodies.length === 1) throw new TypeError('lost receipt');
    return Response.json({ receipt: { commandId: 'steered-image', chatId, state: 'queued', revision: 1 } });
  };
  const dataUrl = 'data:image/png;base64,YWJjZA==';
  await sendManagedChatAction(chatId, 'steer', { text: '', attachments: [
    { id: 'image', name: 'screen.png', kind: 'image', size: 4, mimeType: 'image/png', dataUrl },
  ] });
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(bodies[0].action, 'steer');
  assert.equal(bodies[0].text, '[image: screen.png]');
  assert.deepEqual(bodies[0].images, [{ name: 'screen.png', dataUrl }]);
});

test('the running managed composer steers image-only input instead of queueing it for another turn', async () => {
  setup();
  const { setStreaming } = await import('../../src/app-state.ts');
  const { pushAttachment, clearAttachments, getPendingAttachments } = await import('../../src/attachments/store.ts');
  const input = document.createElement('textarea'); document.body.append(input);
  const dataUrl = 'data:image/png;base64,YWJjZA=='; let body: any;
  setStreaming(true, chatId);
  pushAttachment({ id: 'image', name: 'screen.png', kind: 'image', size: 4, mimeType: 'image/png', dataUrl });
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(String(options?.body));
    return Response.json({ receipt: { chatId, commandId: 'composer-image-steer', revision: 1, state: 'queued' } });
  };
  try {
    await sendMessageWithTools({ inputEl: input });
    assert.equal(body.action, 'steer');
    assert.deepEqual(body.images, [{ name: 'screen.png', dataUrl }]);
    assert.equal(body.mode, undefined);
    assert.equal(getPendingAttachments().length, 0);
  } finally { setStreaming(false, chatId); clearAttachments(); input.remove(); }
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

test('default human Stop includes descendants and pins the current execution', async () => {
  const chat = setup();
  chat.agentExecution = { executionId: 'current-reply', status: 'waiting_for_input' };
  const bodies: any[] = [];
  globalThis.fetch = async (_url, options) => { bodies.push(JSON.parse(String(options?.body))); return Response.json({}); };
  await sendRemoteChatCommand(chatId, 'stop');
  assert.equal(bodies[0].scope, 'tree');
  assert.equal(bodies[0].executionId, 'current-reply');

  chat.agentExecution.status = 'completed';
  await sendRemoteChatCommand(chatId, 'stop');
  assert.equal(bodies[1].scope, 'tree');
  assert.equal(bodies[1].executionId, undefined, 'an idle parent can still stop its running agents');
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
  assert.equal(controls[0].scope, 'tree');
});


test('managed archive and restore use authoritative configuration without changing the local chat', async () => {
  const chat = setup();
  const calls: any[] = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), '/api/chats/' + chatId + '/configuration');
    assert.equal(options!.method, 'PATCH');
    calls.push(JSON.parse(options!.body as string));
    return Response.json({});
  };
  await sendRemoteChatCommand(chatId, 'configure', { patch: { archived: true } });
  await sendRemoteChatCommand(chatId, 'configure', { patch: { archived: false } });
  assert.deepEqual(calls.map(call => call.archived), [true, false]);
  assert.ok(calls.every(call => call.expectedProfileVersion === 3));
  assert.equal(chat.archivedAt, undefined);
});

test('archiving many unloaded background chats applies receipts without entering the transcript observer', async t => {
  const active = setup();
  const chats = Array.from({ length: 40 }, (_, i) => {
    const chat = createEmptyChatObject('model');
    Object.assign(chat, { id: `unloaded-${i}`, chatCommandVersion: 1, historyLoaded: false, messageCount: 5000 });
    return chat;
  });
  setSessionStateForTests({ version: 6, activeId: active.id, sidebarCollapsed: false, chats: [active, ...chats] });
  const source = { onopen: null as any, onmessage: null as any, close() {} };
  let transcriptFrames = 0, requests = 0;
  t.after(startManagedChatBridge({ receive: async () => { transcriptFrames++; }, reconnect() {} }, () => {}, { createSource: () => source }));
  globalThis.fetch = async (url, options) => {
    assert.equal(options?.method, 'PATCH', 'archive must not fetch the full history');
    requests++;
    const id = String(url).split('/')[3];
    return Response.json({ frame: { chatId: id, fields: { archivedAt: 100, chatCommandVersion: 1 } } });
  };
  for (const chat of chats) await sendManagedChatAction(chat.id, 'configure', { patch: { archived: true } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, chats.length);
  assert.equal(transcriptFrames, 0);
  assert.ok(chats.every(chat => chat.archivedAt === 100 && chat.historyLoaded === false && chat.history.length === 0));
});


test('managed programmatic options reach canonical admission as bounded intent rather than trusted prompts', async () => {
  const chat = setup(); let accepted = 0; const calls: any[] = [];
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(String(options?.body)));
    return Response.json({ receipt: { commandId: 'context', chatId, revision: 1, state: 'queued' } });
  };
  await sendProgrammaticChatText(chat, 'Work', { ephemeralContext: 'Surface data', goalDriven: true, suppressUserEcho: true,
    titleSeed: 'Issue title', deferTitleUntilTurnEnd: true, codeMap: { question: 'Why?', title: 'Definition', kind: 'function' },
    onUserMessageAccepted: async () => { accepted++; } });
  assert.equal(calls.length, 1); assert.equal(accepted, 1);
  assert.equal(calls[0].intent.context, 'Surface data'); assert.equal(calls[0].intent.goalDriven, true);
  assert.equal(calls[0].intent.suppressUserEcho, true); assert.equal(calls[0].intent.titleSeed, 'Issue title');
  assert.equal(calls[0].intent.codeMap.title, 'Definition'); assert.equal(calls[0].systemPrompt, undefined);
  await assert.rejects(sendProgrammaticChatText(chat, 'Work', { signal: AbortSignal.abort(new Error('Already stopped')) }), /Already stopped/);
  assert.equal(calls.length, 1);
});

test('an incomplete successful admission keeps its request identity and cannot report acceptance or fall back', async () => {
  setup(); const requests: any[] = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), `/api/chats/${chatId}/commands`);
    requests.push(JSON.parse(String(options?.body)));
    if (requests.length === 1) return Response.json({});
    return Response.json({ receipt: { commandId: 'recovered', chatId, state: 'queued', revision: 1 } });
  };
  await assert.rejects(sendManagedChatAction(chatId, 'send', { text: 'Keep identity', mode: 'queue' }), /acknowledgement is incomplete/);
  await sendManagedChatAction(chatId, 'send', { text: 'Keep identity', mode: 'queue' });
  assert.deepEqual(requests[0], requests[1]); assert.equal(requests[0].mode, 'queue');
});

test('fork retries retain the original source revision and identity after an uncertain acknowledgement', async () => {
  setup(); const requests: any[] = []; let reads = 0;
  globalThis.fetch = async (url, options) => {
    if (!options?.method) { reads++; return Response.json({ chat: { id: chatId, revision: 17 } }); }
    assert.equal(String(url), `/api/chats/${chatId}/fork`);
    requests.push(JSON.parse(String(options.body)));
    if (requests.length <= 2) throw new TypeError('lost fork acknowledgement');
    return Response.json({ receipt: { sourceChatId: chatId, sourceMessageId: 'fork-anchor', chatId: 'forked', commandId: 'fork-command' } });
  };
  await assert.rejects(forkManagedChat(chatId, 'fork-anchor'), /lost fork/);
  const result = await forkManagedChat(chatId, 'fork-anchor');
  assert.equal(result.chatId, 'forked'); assert.equal(reads, 1);
  assert.equal(requests.length, 3); assert.deepEqual(requests[0], requests[1]); assert.deepEqual(requests[0], requests[2]);
  assert.equal(requests[0].expectedRevision, 17);
});

test('managed plugin slash commands stay local and preserve attached files without a model admission', async () => {
  const chat = setup(); let invoked = '', calls = 0;
  const remove = registerPluginSlashCommand('fixture', { id: 'check', label: 'Check', description: 'Local check', run: async input => { invoked = input.args; } });
  const input = document.createElement('textarea'); input.value = '/plugin-fixture--check argument'; document.body.append(input);
  globalThis.fetch = async () => { calls++; return Response.json({}); };
  try { await sendMessageWithTools({ inputEl: input }); assert.equal(invoked, 'argument'); assert.equal(calls, 0); assert.deepEqual(chat.history, []); }
  finally { remove(); input.remove(); }
});

test('canonical root menu exposes replay into a new chat but no local rewrite actions', () => {
  const chat = setup(); chat.history = [{ role: 'user', content: 'Original', messageId: 'saved-user', commandId: 'saved-command' }];
  const wrap = document.createElement('div'); wrap.innerHTML = '<div class="msg-bubble">Original</div>'; document.body.append(wrap);
  attachMessageActions(wrap, { chatId, historyIndex: 0, turnKind: 'user' });
  wrap.querySelector<HTMLButtonElement>('.message-actions__trigger')!.click();
  assert.deepEqual([...document.querySelectorAll('.message-actions__menu button')].map(button => button.textContent), ['Copy', 'Replay in new chat']);
  closeMessageActionsMenu(); wrap.remove();
});

test('promoted historical messages without a captured command do not advertise unusable replay', () => {
  const chat = setup(); chat.history = [{ role: 'user', content: 'Historical text', messageId: 'legacy-row' }];
  const wrap = document.createElement('div'); document.body.append(wrap);
  attachMessageActions(wrap, { chatId, historyIndex: 0, turnKind: 'user' });
  wrap.querySelector<HTMLButtonElement>('.message-actions__trigger')!.click();
  assert.deepEqual([...document.querySelectorAll('.message-actions__menu button')].map(button => button.textContent), ['Copy']);
  closeMessageActionsMenu(); wrap.remove();
});


test('ordinary rollout metadata cannot disable the independent released agent capability reader', () => {
  const agent = { version: 1, capability: 'agentConversationsV1', creationEnabled: true, recoveryEnabled: true, reason: 'released' };
  const envelope = { ...agent, conversationStorage: 'sqlite', clientProtocol: { version: 1, minReaderVersion: 1, minWriterVersion: 1 },
    ordinaryExecution: { version: 1, capability: 'ordinaryChatExecutionV1', admissionEnabled: false, promotionEnabled: false } };
  assert.deepEqual(readAgentConversationsCapability(envelope), agent);
  assert.equal(readAgentConversationsCapability({ ...envelope, unrelatedFutureField: true }), null);
});

test('ordinary slash and pinned sends use skill references and keep identical intent after lost receipts', async () => {
  const chat = setup(); const calls: any[] = []; let accepted = 0;
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(String(options?.body)));
    if (calls.length <= 2) throw new TypeError('lost context acknowledgement');
    return Response.json({ receipt: { commandId: 'skill', chatId, revision: 1, state: 'queued' } });
  };
  const options = { ephemeralContext: 'same snapshot', onUserMessageAccepted: async () => { accepted++; } };
  await assert.rejects(sendProgrammaticChatText(chat, '/caveman ultra Inspect', options), /lost context/);
  assert.equal(chat.pinnedSkill, undefined); assert.equal(accepted, 0);
  await sendProgrammaticChatText(chat, '/caveman ultra Inspect', options);
  assert.deepEqual(calls[0], calls[1]); assert.deepEqual(calls[0], calls[2]);
  assert.deepEqual(calls[0].intent.skill, { id: 'caveman', source: 'slash', intensity: 'ultra', input: 'Inspect' });
  assert.equal(calls[0].text, 'Inspect\n\n[skill: caveman]');
  await sendProgrammaticChatText(chat, 'Continue');
  assert.equal(calls[3].intent.skill.source, 'pinned'); assert.equal(calls[3].intent.skill.intensity, 'ultra');
  await sendProgrammaticChatText(chat, 'normal mode');
  assert.equal(calls[4].intent.skill, null); assert.equal(chat.pinnedSkill, null);
});

test('ordinary composer slash context is queued rather than discarded or sent as an unscoped steer', async () => {
  setup(); const calls: any[] = [];
  const input = document.createElement('textarea'); input.value = '/git-commit Fix bug'; document.body.append(input);
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(String(options?.body)));
    return Response.json({ receipt: { commandId: 'composer-context', chatId, revision: 1, state: 'queued' } });
  };
  try {
    await sendMessageWithTools({ inputEl: input, ephemeralContext: 'App snapshot', followupDelivery: 'queue' });
    assert.equal(calls.length, 1); assert.equal(calls[0].action, 'send'); assert.equal(calls[0].mode, 'queue');
    assert.equal(calls[0].intent.skill.id, 'git-commit'); assert.equal(calls[0].intent.context, 'App snapshot');
    assert.equal(input.value, '');
  } finally { input.remove(); }
});

test('composer /plan and a plain follow-up send distinct turn intents', async () => {
  const chat = setup(); const calls: any[] = [];
  const input = document.createElement('textarea'); document.body.append(input);
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(String(options?.body)));
    return Response.json({ receipt: { commandId: `plan-turn-${calls.length}`, chatId, revision: calls.length, state: 'queued' } });
  };
  try {
    input.value = '/plan Design the change';
    await sendMessageWithTools({ inputEl: input });
    input.value = 'Implement it';
    await sendMessageWithTools({ inputEl: input });
    assert.deepEqual(calls.map(call => call.intent.skill), [{ id: 'plan', source: 'slash', input: 'Design the change' }, null]);
    assert.equal(calls[1].text, 'Implement it');
    assert.equal(chat.pinnedSkill, undefined);
  } finally { input.remove(); }
});

test('a saved plan pin can be dismissed in the composer during an in-flight send', async () => {
  const chat = setup(); chat.pinnedSkill = { id: 'plan' };
  const toolbar = document.createElement('div'); toolbar.id = 'composerControls'; document.body.append(toolbar);
  const calls: any[] = [];
  try {
    syncComposerPinnedSkillFromActiveChat();
    const strip = toolbar.querySelector<HTMLElement>('#pinnedSkillStrip')!;
    const dismiss = strip.querySelector<HTMLButtonElement>('button[aria-label="Unpin /plan"]')!;
    assert.equal(strip.classList.contains('hidden'), false);
    globalThis.fetch = async (_url, options) => {
      calls.push(JSON.parse(String(options?.body)));
      if (calls.length === 1) dismiss.click();
      return Response.json({ receipt: { commandId: `unpin-${calls.length}`, chatId, revision: calls.length, state: 'queued' } });
    };
    await sendRemoteChatCommand(chatId, 'send', { text: 'Finish the plan' });
    assert.equal(chat.pinnedSkill, null);
    assert.equal(strip.classList.contains('hidden'), true);
    await sendRemoteChatCommand(chatId, 'send', { text: 'Implement it' });
    assert.deepEqual(calls.map(call => call.intent.skill), [{ id: 'plan', source: 'pinned', input: 'Finish the plan' }, null]);
  } finally { toolbar.remove(); }
});

test('direct remote ordinary entry point captures pinned skills and attachment reference metadata', async () => {
  const chat = setup(); chat.pinnedSkill = { id: 'git-commit' }; let body: any;
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(String(options?.body)); return Response.json({ receipt: { chatId, commandId: 'direct-context', revision: 1, state: 'queued' } });
  };
  await sendRemoteChatCommand(chatId, 'send', { text: 'Inspect', attachments: [
    { id: 'ref', name: 'src/main.ts', kind: 'codeRef', size: 8, mimeType: 'text/plain', text: 'let x=1;', workspacePath: 'src/main.ts', lineStart: 4, lineEnd: 8 },
  ] });
  assert.equal(body.intent.skill.id, 'git-commit'); assert.equal(body.intent.skill.source, 'pinned');
  assert.equal(body.intent.attachments[0].workspacePath, 'src/main.ts'); assert.equal(body.intent.attachments[0].lineStart, 4);
  assert.match(body.text, /let x=1/); assert.equal(body.intent.skillBody, undefined);
});

test('programmatic managed sends clear only an acknowledged unchanged draft and respect clearComposerOnSend', async () => {
  const chat = setup(); chat.composerDraft = 'Original draft';
  globalThis.fetch = async () => Response.json({ receipt: { chatId, commandId: 'draft', revision: 1, state: 'queued' } });
  await sendProgrammaticChatText(chat, 'Work', { clearComposerOnSend: false });
  assert.equal(chat.composerDraft, 'Original draft');
  await sendProgrammaticChatText(chat, 'Work'); assert.equal(chat.composerDraft, undefined);
  chat.composerDraft = 'Draft before admission';
  globalThis.fetch = async () => { chat.composerDraft = 'New text while sending'; return Response.json({ receipt: { chatId, commandId: 'draft-next', revision: 1, state: 'queued' } }); };
  await sendProgrammaticChatText(chat, 'Work'); assert.equal(chat.composerDraft, 'New text while sending');
});
