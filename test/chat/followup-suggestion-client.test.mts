import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { createEmptyChatObject } from '../../src/state/sessions.ts';
import { setUtilityModelConfigForTests } from '../../src/config/utility-model-meta.ts';
import { generateFollowupSuggestion } from '../../src/chat/followup-suggestion-client.ts';
import type { ChatCompletionBody } from '../../src/api/chat.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';

const originalFetch = globalThis.fetch;
let win: Window;

function setup() {
  win = new Window();
  installHappyDomGlobals(win);
  setStorageModeForTests('server');
  globalThis.fetch = async () => new Response(JSON.stringify({ providers: [{
    id: 'local', label: 'Local', apiKind: 'openai-v1', enabled: true,
    baseUrl: 'http://localhost:1234', hasApiKey: false,
  }] }), { headers: { 'Content-Type': 'application/json' } });
  setUtilityModelConfigForTests({ providerId: '', modelId: '' });
  const chat = createEmptyChatObject('chat-model');
  chat.modelId = 'chat-model';
  chat.providerId = 'local';
  chat.history = [{ role: 'user', content: 'Fix the parser' }, { role: 'assistant', content: 'Fixed the parser.' }];
  return chat;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  setStorageModeForTests(null);
  win?.close();
});

test('uses the chat model for a bounded tool-free utility request and records its usage', async () => {
  const chat = setup();
  let body: ChatCompletionBody | undefined;
  const signal = new AbortController().signal;
  const result = await generateFollowupSuggestion(chat, signal, async (provider, request, passedSignal, options) => {
    assert.equal(provider.id, 'local');
    assert.equal(passedSignal, signal);
    assert.equal(options?.fallbackRole, 'utility');
    body = request;
    return {
      choices: [{ message: { content: 'Can you show me the diff?' } }],
      usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 },
    };
  });
  assert.equal(result, 'Can you show me the diff?');
  assert.equal(body?.model, 'chat-model');
  assert.equal(body?.max_tokens, 100);
  assert.equal(body?.tools, undefined);
  assert.match(body?.messages[1].content as string, /Fixed the parser/);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(chat.tokenLedger?.bySource['utility:followup-suggestion']?.totalTokens, 38);
});

test('uses the configured utility model instead of the conversation model', async () => {
  const chat = setup();
  setUtilityModelConfigForTests({ providerId: 'local', modelId: 'utility-model' });
  let called = false;
  await generateFollowupSuggestion(chat, new AbortController().signal, async (_provider, body) => {
    called = true;
    assert.equal(body.model, 'utility-model');
    return { choices: [{ message: { content: 'NONE' } }] };
  });
  assert.equal(called, true);
});

test('aborted requests and missing models do not start a completion', async () => {
  const chat = setup();
  let calls = 0;
  const complete = async () => { calls++; return {}; };
  const controller = new AbortController();
  controller.abort();
  assert.equal(await generateFollowupSuggestion(chat, controller.signal, complete), null);
  chat.modelId = '';
  assert.equal(await generateFollowupSuggestion(chat, new AbortController().signal, complete), null);
  assert.equal(calls, 0);
});

test('provider failures and reasoning-only output silently yield no suggestion', async () => {
  const chat = setup();
  const signal = new AbortController().signal;
  assert.equal(await generateFollowupSuggestion(chat, signal, async () => { throw new Error('offline'); }), null);
  assert.equal(await generateFollowupSuggestion(chat, signal, async () => ({
    choices: [{ message: { reasoning_content: 'Internal reasoning' } }],
  })), null);
});

test('an unloaded library model is skipped without a completion or load request', async () => {
  const chat = setup();
  chat.providerId = 'minnow-library';
  let completions = 0;
  const requests: string[] = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return new Response(JSON.stringify({ models: [], serves: [] }), { headers: { 'Content-Type': 'application/json' } });
  };
  const result = await generateFollowupSuggestion(chat, new AbortController().signal, async () => {
    completions++;
    return {};
  });
  assert.equal(result, null);
  assert.equal(completions, 0);
  assert.ok(requests.every(url => !/\/load(?:[/?]|$)/.test(url)));
});
