/**
 * MIN-187: boot resume must subscribe once; post-tool rounds POST new generations.
 */

// Must come first: dompurify binds to globalThis.window at module eval, and the
// tool loop renders assistant markdown on both the success and failure paths.
import './install-dom-before-imports.mts';

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import type { Chat } from '../../src/types.ts';
import { setSessionStateForTests } from '../../src/state/sessions.ts';
import { endChatTurnSetup } from '../../src/chat/chat-turn-guard.ts';
import { getChatAbort, setChatAbort, setStreaming } from '../../src/app-state.ts';
import {
  defaultToolConfig,
  setToolConfigForTests,
} from '../../src/tools/config.ts';

const CHAT_ID = '11111111-1111-1111-1111-111111111111';
const GEN_RESUME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GEN_ROUND2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TOOL_CALL_ID = 'call_loop_resume_test';
const STARTED = 1710000000000;

function makeChat(generationId?: string): Chat {
  return {
    id: CHAT_ID,
    name: 'resume-loop',
    workspacePath: '',
    modelId: 'm1',
    history: [{ role: 'user', content: 'What time is it?' }],
    lastStats: null,
    modelInfo: {},
    updatedAt: STARTED,
    ...(generationId ? { currentGenerationId: generationId } : {}),
  };
}

function sseResponse(chunks: string[]): Response {
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function toolCallsSse(toolName: string, toolCallId: string): string[] {
  const delta = JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: toolCallId,
              type: 'function',
              function: { name: toolName, arguments: '{}' },
            },
          ],
        },
      },
    ],
  });
  const finish = JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'tool_calls' }],
  });
  return [
    `data: ${delta}\n\n`,
    `data: ${finish}\n\n`,
    `event: end\ndata: {"status":"complete"}\n\n`,
  ];
}

function proseSse(text: string): string[] {
  const delta = JSON.stringify({
    choices: [{ delta: { content: text } }],
  });
  const finish = JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'stop' }],
  });
  return [
    `data: ${delta}\n\n`,
    `data: ${finish}\n\n`,
    `event: end\ndata: {"status":"complete"}\n\n`,
  ];
}

/** Mirror generation-resume.test.mts DOM so runChatTurn reaches the tool loop. */
function installDom(): void {
  const window = new Window();
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.performance = window.performance;
  globalThis.localStorage = window.localStorage;
  globalThis.window = window as unknown as Window & typeof globalThis;

  const modelSelect = document.createElement('select');
  modelSelect.id = 'modelSelect';
  const opt = document.createElement('option');
  opt.value = 'm1';
  modelSelect.appendChild(opt);
  modelSelect.value = 'm1';
  document.body.appendChild(modelSelect);

  const temperature = document.createElement('input');
  temperature.id = 'temperature';
  temperature.value = '0.7';
  document.body.appendChild(temperature);

  const maxTokens = document.createElement('input');
  maxTokens.id = 'maxTokens';
  maxTokens.value = '512';
  document.body.appendChild(maxTokens);

  const systemPrompt = document.createElement('textarea');
  systemPrompt.id = 'systemPrompt';
  document.body.appendChild(systemPrompt);

  const chatArea = document.createElement('div');
  chatArea.id = 'chatArea';
  document.body.appendChild(chatArea);

  const sDot = document.createElement('span');
  sDot.id = 'sDot';
  document.body.appendChild(sDot);
  const sText = document.createElement('span');
  sText.id = 'sText';
  document.body.appendChild(sText);
}

describe('runChatTurn boot resume tool loop (MIN-187)', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    getChatAbort(CHAT_ID)?.abort();
    setChatAbort(CHAT_ID, null);
    setStreaming(false, CHAT_ID);
    endChatTurnSetup(CHAT_ID);
    globalThis.fetch = originalFetch;
    setSessionStateForTests(null);
  });

  test('post-tool round calls createGeneration instead of re-subscribing', async () => {
    installDom();

    const toolConfig = defaultToolConfig();
    toolConfig.permissions.default.get_datetime = 'full';
    setToolConfigForTests(toolConfig);

    const subscribeUrls: string[] = [];
    let createGenerationCalls = 0;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      // runChatTurn remaps My Models via cached/serves before the resume subscribe.
      if (url.includes('/api/models/cached')) {
        return Response.json({ models: [] });
      }
      if (url.includes('/api/models/serve')) {
        return Response.json({ serves: [] });
      }
      if (url.includes('/api/memory/')) {
        return Response.json({ enabled: false });
      }
      if (url.includes(GEN_RESUME) && url.includes('/stream')) {
        subscribeUrls.push(url);
        return sseResponse(toolCallsSse('get_datetime', TOOL_CALL_ID));
      }
      if (url.endsWith('/api/generations') && init?.method === 'POST') {
        createGenerationCalls += 1;
        return Response.json({ generationId: GEN_ROUND2 });
      }
      if (url.includes(GEN_ROUND2) && url.includes('/stream')) {
        subscribeUrls.push(url);
        return sseResponse(proseSse('The time is noon.'));
      }

      return new Response('not found', { status: 404 });
    };

    const chat = makeChat(GEN_RESUME);
    setSessionStateForTests({
      version: 2,
      activeId: CHAT_ID,
      sidebarCollapsed: false,
      chats: [chat],
    });

    const { runChatTurn } = await import('../../src/chat/run-turn-chat.ts');

    await runChatTurn({
      chat,
      pushUser: false,
      rawText: '',
      userText: '',
      skillId: null,
      displayText: '',
      historyContent: '',
      validAttachments: [],
      resumeGenerationId: GEN_RESUME,
      ownsGlobalStreaming: false,
    });

    const resumeSubscribes = subscribeUrls.filter((u) => u.includes(GEN_RESUME));
    assert.equal(resumeSubscribes.length, 1, 'boot resume should subscribe once');
    assert.equal(createGenerationCalls, 1, 'post-tool round must POST a new generation');
    assert.ok(
      subscribeUrls.some((u) => u.includes(GEN_ROUND2)),
      'second round should subscribe to the new generation',
    );
    assert.equal(chat.currentGenerationId, undefined);
  });
});
