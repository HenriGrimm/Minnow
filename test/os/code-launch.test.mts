import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { resetWorkspaceStateForTests } from '../../src/state/workspace.ts';
import { setSessionStateForTests, createEmptyChatObject } from '../../src/state/sessions.ts';

const FINANCE_WS = '/home/user/finance-app';
const CURRENT_WS = '/home/user/minnow';

/** @type {import('happy-dom').Window | undefined} */
let happyDomWindow: import('happy-dom').Window | undefined;

function stubCodeAppDom(doc: Document): void {
  const statsIds = [
    'stripTPS',
    'stripTTFT',
    'stripGen',
    'stripTotal',
    'stripCost',
    'barPrompt',
    'barCompletion',
    'cntPrompt',
    'cntCompletion',
    'iArch',
    'iQuant',
    'iCtx',
    'iStop',
    'statsStrip',
    'statsExpandBtn',
    'statsExpandPreview',
  ];
  doc.body.innerHTML = `
      <header class="topbar">
        <select id="modelSelect"><option value="test::model-a" selected>model-a</option></select>
        <input id="temperature" value="0.7" />
        <input id="maxTokens" value="4096" />
        <textarea id="systemPrompt"></textarea>
      </header>
      <main id="chatArea"></main>
      <div id="mainColumn"></div>
      <ul id="chatList"></ul>
      <textarea id="msgInput"></textarea>
      <button type="button" id="sendBtn"></button>
    `;
  for (const id of statsIds) {
    if (!doc.getElementById(id)) {
      doc.body.appendChild(Object.assign(doc.createElement('div'), { id }));
    }
  }
}

describe('applyCodeLaunchOptions', () => {
  beforeEach(async () => {
    const { Window } = await import('happy-dom');
    const win = new Window();
    happyDomWindow = win;
    const g = globalThis as typeof globalThis & {
      window: Window;
      document: Document;
      HTMLElement: typeof HTMLElement;
      fetch: typeof fetch;
    };
    g.window = win as unknown as Window & typeof globalThis.window;
    g.document = win.document;
    g.HTMLElement = win.HTMLElement;
    g.localStorage = win.localStorage;

    stubCodeAppDom(win.document);

    let workspacePath = CURRENT_WS;
    g.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      if (path.includes('/api/workspace') && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { path: string };
        workspacePath = body.path;
        return {
          ok: true,
          json: async () => ({
            path: workspacePath,
            label: workspacePath.split('/').pop(),
            isDefault: false,
          }),
        } as Response;
      }
      if (path.includes('/api/workspace')) {
        return {
          ok: true,
          json: async () => ({
            path: workspacePath,
            label: workspacePath.split('/').pop(),
            isDefault: false,
          }),
        } as Response;
      }
      return { ok: false, status: 503, json: async () => ({ error: 'offline' }), text: async () => 'offline' } as Response;
    }) as typeof fetch;

    resetWorkspaceStateForTests();
    const { setWorkspaceFromServer } = await import('../../src/state/workspace.ts');
    setWorkspaceFromServer({
      path: CURRENT_WS,
      label: 'minnow',
      isDefault: false,
    });

    setSessionStateForTests({
      version: 5,
      activeId: 'chat-existing',
      sidebarCollapsed: false,
      lastActiveChatIdByWorkspace: {},
      lastActiveChatIdByApp: {},
      chats: [
        {
          ...createEmptyChatObject('model-a'),
          id: 'chat-existing',
          name: 'Existing',
          workspacePath: CURRENT_WS,
          modeId: 'build',
        },
      ],
    });

    const { resetInstancesForTests } = await import('../../src/os/instances.ts');
    resetInstancesForTests();
  });

  afterEach(async () => {
    const appState = await import('../../src/app-state.ts');
    for (const controller of appState.abortByChatId.values()) {
      controller.abort();
    }
    appState.abortByChatId.clear();
    appState.setStreaming(false);
    happyDomWindow?.close();
    happyDomWindow = undefined;
    setSessionStateForTests(null);
    resetWorkspaceStateForTests();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test('switches workspace without sending for navigation-only launch', async () => {
    const { applyCodeLaunchOptions } = await import('../../src/os/code-launch.ts');

    await applyCodeLaunchOptions({
      workspacePath: FINANCE_WS,
      autoRun: false,
    });

    const { getWorkspacePath } = await import('../../src/state/workspace.ts');
    assert.equal(getWorkspacePath(), FINANCE_WS);

    const input = document.getElementById('msgInput') as HTMLTextAreaElement;
    assert.equal(input.value, '');
  });

  test('does not switch when launch path is the same folder with different spelling', async () => {
    const { applyCodeLaunchOptions } = await import('../../src/os/code-launch.ts');

    await applyCodeLaunchOptions({
      workspacePath: `${CURRENT_WS}/`,
      autoRun: false,
    });

    const { getWorkspacePath } = await import('../../src/state/workspace.ts');
    assert.equal(getWorkspacePath(), CURRENT_WS);
  });

  test('switches workspace, creates debug chat, and fills composer', async () => {
    const { applyCodeLaunchOptions } = await import('../../src/os/code-launch.ts');
    await applyCodeLaunchOptions({
      seed: 'Find bugs in the finance app',
      modeId: 'debug',
      workspacePath: FINANCE_WS,
      autoRun: true,
    });

    const { getWorkspacePath } = await import('../../src/state/workspace.ts');
    assert.equal(getWorkspacePath(), FINANCE_WS);

    const { getActiveChat } = await import('../../src/state/sessions.ts');
    const chat = getActiveChat();
    assert.equal(chat.modeId, 'debug');
    assert.notEqual(chat.id, 'chat-existing');

    const input = document.getElementById('msgInput') as HTMLTextAreaElement;
    const inComposer = input.value;
    const inHistory = chat.history.some(
      (m) => m.role === 'user' && m.content === 'Find bugs in the finance app',
    );
    assert.ok(
      inComposer === 'Find bugs in the finance app' || inHistory,
      'seed should remain in composer or chat history after send attempt',
    );
  });

  test('shows the seed while managed worktree setup is still pending', async () => {
    const { setLocalServerAvailableForTests } = await import('../../src/tools/config.ts');
    setLocalServerAvailableForTests(true);
    const g = globalThis as typeof globalThis & { fetch: typeof fetch };
    const previousFetch = g.fetch;
    let worktreeRequested = false;
    let finishWorktree: (() => void) | undefined;

    g.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('/api/worktree') && init?.method === 'POST') {
        worktreeRequested = true;
        return new Promise<Response>((resolve) => {
          finishWorktree = () => resolve({
            ok: true,
            json: async () => ({
              ok: true,
              path: '/home/user/.minnow/worktrees/chat-seed',
              branch: 'seed-chat',
            }),
          } as Response);
        });
      }
      return previousFetch(url, init);
    }) as typeof fetch;

    const { applyCodeLaunchOptions } = await import('../../src/os/code-launch.ts');
    const launch = applyCodeLaunchOptions({
      seed: 'Fix the checkout race',
      modeId: 'debug',
      autoRun: true,
      runTarget: {
        kind: 'create',
        name: 'seed-chat',
        startPoint: 'HEAD',
        checkoutExisting: false,
      },
    });

    for (let i = 0; i < 20 && !worktreeRequested; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    assert.equal(worktreeRequested, true);
    assert.equal(
      (document.getElementById('msgInput') as HTMLTextAreaElement).value,
      'Fix the checkout race',
    );

    finishWorktree?.();
    await launch;
    g.fetch = previousFetch;
    setLocalServerAvailableForTests(false);
  });

  test('restoreCodeSessionOnForeground switches off desktop assistant chat', async () => {
    const CHATS_WS = '/home/user/.minnow/chats';
    const { resetChatsWorkspacePathCache } = await import('../../src/lib/chats-workspace.ts');
    resetChatsWorkspacePathCache();

    const g = globalThis as typeof globalThis & { fetch: typeof fetch };
    const prevFetch = g.fetch;
    g.fetch = (async (url: RequestInfo | URL) => {
      const path = String(url);
      if (path.includes('/api/chats-workspace')) {
        return {
          ok: true,
          json: async () => ({ path: CHATS_WS, fileCount: 0 }),
        } as Response;
      }
      return prevFetch(url);
    }) as typeof fetch;

    setSessionStateForTests({
      version: 5,
      activeId: 'assistant-chat',
      sidebarCollapsed: false,
      lastActiveChatIdByWorkspace: { [CURRENT_WS]: 'chat-existing' },
      lastActiveChatIdByApp: { chat: 'assistant-chat' },
      chats: [
        {
          ...createEmptyChatObject('model-a'),
          id: 'chat-existing',
          name: 'Project thread',
          workspacePath: CURRENT_WS,
          modeId: 'build',
          history: [{ role: 'user', content: 'Code workspace hello' }],
        },
        {
          ...createEmptyChatObject('model-a'),
          id: 'assistant-chat',
          name: 'Desktop hello',
          workspacePath: CHATS_WS,
          modeId: 'general',
          history: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hello! How can I help you today?' },
          ],
        },
      ],
    });

    const { restoreCodeSessionOnForeground } = await import('../../src/os/code-launch.ts');
    await restoreCodeSessionOnForeground();

    const { getActiveChat } = await import('../../src/state/sessions.ts');
    assert.equal(getActiveChat().id, 'chat-existing');
    assert.match(document.getElementById('chatArea')?.textContent ?? '', /Code workspace hello/);
    assert.doesNotMatch(
      document.getElementById('chatArea')?.textContent ?? '',
      /How can I help you today/,
    );

    g.fetch = prevFetch;
    resetChatsWorkspacePathCache();
  });

  test('switchChat paints Code transcript when desktop chat state is still active', async () => {
    const CHATS_WS = '/home/user/.minnow/chats';
    const { resetChatsWorkspacePathCache } = await import('../../src/lib/chats-workspace.ts');
    const { launchInstance, resetInstancesForTests } = await import('../../src/os/instances.ts');
    resetChatsWorkspacePathCache();

    const g = globalThis as typeof globalThis & { fetch: typeof fetch };
    const prevFetch = g.fetch;
    g.fetch = (async (url: RequestInfo | URL) => {
      const path = String(url);
      if (path.includes('/api/chats-workspace')) {
        return {
          ok: true,
          json: async () => ({ path: CHATS_WS, fileCount: 0 }),
        } as Response;
      }
      return prevFetch(url);
    }) as typeof fetch;

    document.body.insertAdjacentHTML(
      'beforeend',
      '<div id="desktopChatCol"></div>',
    );

    setSessionStateForTests({
      version: 5,
      activeId: 'assistant-chat',
      sidebarCollapsed: false,
      lastActiveChatIdByWorkspace: { [CURRENT_WS]: 'chat-existing' },
      lastActiveChatIdByApp: { chat: 'assistant-chat' },
      chats: [
        {
          ...createEmptyChatObject('model-a'),
          id: 'chat-existing',
          name: 'Project thread',
          workspacePath: CURRENT_WS,
          modeId: 'build',
          history: [{ role: 'user', content: 'Code workspace hello' }],
        },
        {
          ...createEmptyChatObject('model-a'),
          id: 'assistant-chat',
          name: 'Desktop hello',
          workspacePath: CHATS_WS,
          modeId: 'general',
          history: [{ role: 'user', content: 'Hello' }],
        },
      ],
    });

    launchInstance('code');

    const { switchChat } = await import('../../src/ui/sidebar.ts');
    switchChat('chat-existing');

    const { getActiveChat } = await import('../../src/state/sessions.ts');
    assert.equal(getActiveChat().id, 'chat-existing');
    assert.match(document.getElementById('chatArea')?.textContent ?? '', /Code workspace hello/);
    assert.equal(document.getElementById('desktopChatCol')?.textContent?.trim() ?? '', '');

    g.fetch = prevFetch;
    resetChatsWorkspacePathCache();
    resetInstancesForTests();
  });

  test('restoreCodeSessionOnForeground keeps an explicit workspace chat selection', async () => {
    setSessionStateForTests({
      version: 5,
      activeId: 'chat-other',
      sidebarCollapsed: false,
      lastActiveChatIdByWorkspace: { [CURRENT_WS]: 'chat-existing' },
      lastActiveChatIdByApp: {},
      chats: [
        {
          ...createEmptyChatObject('model-a'),
          id: 'chat-existing',
          name: 'Existing',
          workspacePath: CURRENT_WS,
          modeId: 'build',
          history: [{ role: 'user', content: 'Old remembered thread' }],
        },
        {
          ...createEmptyChatObject('model-a'),
          id: 'chat-other',
          name: 'Other',
          workspacePath: CURRENT_WS,
          modeId: 'build',
          history: [{ role: 'user', content: 'Selected from overview' }],
        },
      ],
    });

    const { restoreCodeSessionOnForeground } = await import('../../src/os/code-launch.ts');
    await restoreCodeSessionOnForeground();

    const { getActiveChat } = await import('../../src/state/sessions.ts');
    assert.equal(getActiveChat().id, 'chat-other');
    assert.match(document.getElementById('chatArea')?.textContent ?? '', /Selected from overview/);
    assert.doesNotMatch(
      document.getElementById('chatArea')?.textContent ?? '',
      /Old remembered thread/,
    );
  });
});
