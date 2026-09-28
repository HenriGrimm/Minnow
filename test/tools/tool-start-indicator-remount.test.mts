/**
 * Switching chats mid-tool-call must not lose the "Calling {tool}…" indicator.
 *
 * The stream announces a tool name once per round, and a file write streams the whole
 * file as arguments — so a shell mounted after the announcement used to sit on a bare
 * "Generating response…" caret for the rest of the call.
 */

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

const OTHER_CHAT_ID = '33333333-3333-4333-8333-333333333333';
const TOOL_CALL_ID = 'call_indicator_remount';

/** Each case gets its own chat and generation ids — the stores behind both are global. */
interface TurnIds {
  chatId: string;
  genResume: string;
  genRound2: string;
}

const VISIBLE: TurnIds = {
  chatId: '22222222-2222-4222-8222-222222222222',
  genResume: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  genRound2: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
};

const HIDDEN: TurnIds = {
  chatId: '44444444-4444-4444-8444-444444444444',
  genResume: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  genRound2: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
};

function makeChat(ids: TurnIds): Chat {
  return {
    id: ids.chatId,
    name: 'indicator-remount',
    workspacePath: '',
    modelId: 'm1',
    history: [{ role: 'user', content: 'What time is it?' }],
    lastStats: null,
    modelInfo: {},
    updatedAt: 1710000000000,
    currentGenerationId: ids.genResume,
  };
}

/** Mirror loop-resume.test.mts DOM so runChatTurn reaches the tool loop. */
function installDom(): void {
  const window = new Window();
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
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

  for (const [id, value] of [
    ['temperature', '0.7'],
    ['maxTokens', '512'],
  ] as const) {
    const el = document.createElement('input');
    el.id = id;
    el.value = value;
    document.body.appendChild(el);
  }

  const systemPrompt = document.createElement('textarea');
  systemPrompt.id = 'systemPrompt';
  document.body.appendChild(systemPrompt);

  const area = document.createElement('div');
  area.id = 'chatArea';
  document.body.appendChild(area);

  for (const id of ['sDot', 'sText']) {
    const el = document.createElement('span');
    el.id = id;
    document.body.appendChild(el);
  }
}

/** Stream the test drives chunk by chunk, so assertions can land mid-tool-call. */
function scriptedSseResponse(): {
  response: Response;
  push: (chunk: string) => void;
  close: () => void;
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }),
    push: (chunk) => controller?.enqueue(encoder.encode(chunk)),
    close: () => controller?.close(),
  };
}

function dataChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** Let the SSE reader drain everything queued so far. */
async function settle(): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** runChatTurn does a lot of setup before it subscribes; poll instead of a short tick budget. */
async function waitUntil(pred: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function chatArea(): HTMLElement | null {
  return document.getElementById('chatArea');
}

function toolIndicatorLabel(): string | null {
  return chatArea()?.querySelector('.tool-start-indicator__label')?.textContent ?? null;
}

interface PendingToolCallTurn {
  toolRound: ReturnType<typeof scriptedSseResponse>;
  postToolRound: ReturnType<typeof scriptedSseResponse>;
  turn: Promise<void>;
}

/** Start a turn and stream a tool name, leaving its arguments unfinished. */
async function startTurnWithPendingToolCall(
  chat: Chat,
  ids: TurnIds,
): Promise<PendingToolCallTurn> {
  const toolConfig = defaultToolConfig();
  toolConfig.permissions.default.get_datetime = 'full';
  setToolConfigForTests(toolConfig);

  const toolRound = scriptedSseResponse();
  // The post-tool round parks on an open stream; each case ends by aborting the turn.
  const postToolRound = scriptedSseResponse();

  let resumeStreamOpened = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/models/cached')) return Response.json({ models: [] });
    if (url.includes('/api/models/serve')) return Response.json({ serves: [] });
    if (url.includes('/api/memory/')) return Response.json({ enabled: false });
    if (url.includes('/api/config/ping')) return Response.json({ ok: true });
    if (url.includes('/api/config/meta')) return Response.json({ titles: { enabled: false } });
    if (url.includes('/models/load')) return Response.json({ ok: true });
    if (url.includes(ids.genResume) && url.includes('/stream')) {
      resumeStreamOpened = true;
      return toolRound.response;
    }
    if (url.endsWith('/api/generations') && init?.method === 'POST') {
      return Response.json({ generationId: ids.genRound2 });
    }
    if (url.includes(ids.genRound2) && url.includes('/stream')) {
      return postToolRound.response;
    }
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;

  const { runChatTurn } = await import('../../src/chat/run-turn-chat.ts');
  const { getMainTurnActivity } = await import('../../src/chat/main-turn-activity.ts');

  const turn = runChatTurn({
    chat,
    pushUser: false,
    rawText: '',
    userText: '',
    skillId: null,
    displayText: '',
    historyContent: '',
    validAttachments: [],
    resumeGenerationId: ids.genResume,
    ownsGlobalStreaming: true,
  });

  await waitUntil(() => resumeStreamOpened, 'resume stream subscribe');
  // The model names the tool, then streams its arguments — the long window for a file write.
  toolRound.push(
    dataChunk({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: TOOL_CALL_ID,
                type: 'function',
                function: { name: 'get_datetime', arguments: '' },
              },
            ],
          },
        },
      ],
    }),
  );
  await waitUntil(
    () => getMainTurnActivity(ids.chatId)?.currentTool === 'get_datetime',
    'tool_streaming currentTool',
  );

  return { toolRound, postToolRound, turn };
}

describe('tool-start indicator survives a chat switch', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    for (const { chatId } of [VISIBLE, HIDDEN]) {
      getChatAbort(chatId)?.abort();
      setChatAbort(chatId, null);
      setStreaming(false, chatId);
      endChatTurnSetup(chatId);
    }
    globalThis.fetch = originalFetch;
    setSessionStateForTests(null);
  });

  test('remount re-shows "Calling {tool}…" while arguments are still streaming', async () => {
    installDom();

    const chat = makeChat(VISIBLE);
    setSessionStateForTests({
      version: 2,
      activeId: VISIBLE.chatId,
      sidebarCollapsed: false,
      chats: [chat],
    });

    const { remountStreamDomForChat } = await import('../../src/tools/stream-chat-dom.ts');
    const { toolRound, postToolRound, turn } = await startTurnWithPendingToolCall(
      chat,
      VISIBLE,
    );

    const beforeSwitch = toolIndicatorLabel();
    assert.ok(
      beforeSwitch?.startsWith('Calling '),
      `expected a tool-start indicator while args stream, got ${beforeSwitch}`,
    );

    // Switching away wipes the transcript; switching back rebuilds it from history
    // and remounts the live shell.
    chatArea()!.innerHTML = '';
    remountStreamDomForChat(VISIBLE.chatId);

    assert.equal(
      toolIndicatorLabel(),
      beforeSwitch,
      'the remounted shell should keep showing the in-flight tool call',
    );

    toolRound.push(
      dataChunk({
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } },
        ],
      }),
    );
    toolRound.push(dataChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
    toolRound.push('event: end\ndata: {"status":"complete"}\n\n');
    toolRound.close();
    await settle();

    assert.equal(
      chatArea()?.querySelectorAll('.tool-call-msg').length,
      1,
      'the finalized call should render as a tool card',
    );
    assert.equal(
      toolIndicatorLabel(),
      null,
      'the indicator should be gone once the call is finalized',
    );

    getChatAbort(VISIBLE.chatId)?.abort();
    postToolRound.close();
    await turn.catch(() => {});
    // Let the aborted turn finish unwinding before the session state is torn down.
    await settle();
  });

  test('a round that starts in another chat still shows the call on return', async () => {
    installDom();

    const chat = makeChat(HIDDEN);
    const other: Chat = {
      ...makeChat(HIDDEN),
      id: OTHER_CHAT_ID,
      name: 'elsewhere',
      history: [],
    };
    // The user is reading another chat when the round begins, so the turn opens on a
    // stub shell and paints nothing.
    setSessionStateForTests({
      version: 2,
      activeId: OTHER_CHAT_ID,
      sidebarCollapsed: false,
      chats: [chat, other],
    });

    const { remountStreamDomForChat } = await import('../../src/tools/stream-chat-dom.ts');
    const { postToolRound, turn } = await startTurnWithPendingToolCall(chat, HIDDEN);

    assert.equal(toolIndicatorLabel(), null, 'nothing paints while the chat is hidden');

    setSessionStateForTests({
      version: 2,
      activeId: HIDDEN.chatId,
      sidebarCollapsed: false,
      chats: [chat, other],
    });
    remountStreamDomForChat(HIDDEN.chatId);

    assert.ok(
      toolIndicatorLabel()?.startsWith('Calling '),
      'returning mid-call should pick up the tool the stream already named',
    );

    getChatAbort(HIDDEN.chatId)?.abort();
    postToolRound.close();
    await turn.catch(() => {});
    // Let the aborted turn finish unwinding before the session state is torn down.
    await settle();
  });
});
