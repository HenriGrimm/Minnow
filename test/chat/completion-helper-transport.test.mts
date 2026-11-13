import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { resetPromptExpanderConfigCache, setPromptExpanderConfigForTests } from '../../src/config/prompt-expander-meta.ts';
import { resetUtilityModelConfigCache, setUtilityModelConfigForTests } from '../../src/config/utility-model-meta.ts';
import { createEmptyChatObject, setSessionStateForTests } from '../../src/state/sessions.ts';
import { generateFollowupSuggestion } from '../../src/chat/followup-suggestion-client.ts';
import { generateChatTitle } from '../../src/chat/titles/generate.ts';
import { createTitleProviderPort } from '../../src/chat/titles/provider-port.ts';
import { fetchExpandedPrompt } from '../../src/ui/composer-expand-client.ts';
import type { ChatCompletionBody } from '../../src/api/chat.ts';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  setStorageModeForTests(null);
  resetPromptExpanderConfigCache();
  resetUtilityModelConfigCache();
  setSessionStateForTests(null);
});

/** Exercise the real provider port, generation shim, stream consumer and parser. */
function installCliTransport(reply: string, role: string, stream = false) {
  setStorageModeForTests('server');
  let requests = 0;
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (path === '/api/providers') return Response.json({ providers: [{ id: 'codex-cli', label: 'Codex CLI',
      apiKind: 'agent-cli-v1', enabled: true, baseUrl: '', hasApiKey: false }] });
    if (path === '/api/generations') {
      requests++;
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.providerId, 'codex-cli');
      assert.equal(payload.fallbackRole, role);
      const body: ChatCompletionBody = payload.body;
      assert.equal(body.model, 'gpt-6.1-sol');
      assert.equal(body.tools, undefined);
      assert.equal(body.stream, stream);
      // The live CLI rejects off -> none for this reasoning-required model.
      if (body.reasoning_effort === 'off' || body.reasoning_effort === 'none') {
        return Response.json({ error: 'Unsupported value: none' }, { status: 400 });
      }
      return Response.json({ generationId: 'helper-generation' }, { status: 201 });
    }
    if (path === '/api/generations/helper-generation/stream') {
      const content = { role: 'assistant', content: reply };
      const choice = stream ? { delta: content } : { message: content };
      const completion = JSON.stringify({ choices: [{ ...choice, finish_reason: 'stop' }] });
      return new Response(`${stream ? 'data: ' : ''}${completion}\n\nevent: end\ndata: {"status":"complete"}\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  return () => requests;
}

test('titles reach the CLI and parse its non-streaming generation without forcing reasoning off', async () => {
  const requests = installCliTransport('Application architecture', 'chat-titles');
  const result = await generateChatTitle('Explain how this app works', { modelId: 'gpt-6.1-sol', providerId: 'codex-cli',
    maxTokens: 24, temperature: 0.3 }, createTitleProviderPort('codex-cli'));
  assert.equal(result.title, 'Application architecture');
  assert.equal(requests(), 1);
});

test('prompt expansion streams from the CLI without forcing reasoning off', async () => {
  const requests = installCliTransport('Explain how the application is structured.', 'utility', true);
  const chat = createEmptyChatObject('gpt-6.1-sol');
  chat.providerId = 'codex-cli';
  setSessionStateForTests({ chats: [chat], activeId: chat.id });
  setPromptExpanderConfigForTests({ providerId: '', modelId: '' });
  setUtilityModelConfigForTests({ providerId: '', modelId: '' });
  const result = await fetchExpandedPrompt({
    draft: 'explain the app',
    signal: new AbortController().signal,
    attachments: [],
  });
  assert.deepEqual(result, { text: 'Explain how the application is structured.' });
  assert.equal(requests(), 1);
});

test('follow-ups reach the chat CLI and parse its non-streaming generation without forcing reasoning off', async () => {
  const requests = installCliTransport('Walk me through the main workflow.', 'utility');
  const chat = createEmptyChatObject('gpt-6.1-sol');
  chat.providerId = 'codex-cli'; chat.modelId = 'gpt-6.1-sol';
  chat.history = [{ role: 'user', content: 'Explain how this app works' }, { role: 'assistant', content: 'This app manages properties.' }];
  const result = await generateFollowupSuggestion(chat, new AbortController().signal);
  assert.equal(result, 'Walk me through the main workflow.');
  assert.equal(requests(), 1);
});
