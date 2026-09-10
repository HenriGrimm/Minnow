/**
 * Leaving Boards and opening it again must reconnect the last journal.
 * A leftover selected id with no client paints a skeleton until another click.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import {
  openBoardsView,
  resetBoardsViewForTests,
  showBoard,
  teardownBoardsView,
} from '../../src/orchestrator/boards-view.ts';
import { setWorkspaceFromServer, resetWorkspaceStateForTests } from '../../src/state/workspace.ts';
import { createEmptyChatObject, setSessionStateForTests } from '../../src/state/sessions.ts';
import { launchBoardFromPlan } from '../../src/ui/orchestrate-launch.ts';

const BOARD_ID = 'xbox-controller-tester';
const WORKSPACE = '/tmp/minnow-boards-resume';

const BOARD_SUMMARY = {
  boardId: BOARD_ID,
  name: 'xbox-controller-tester',
  planPath: 'documentation/plans/xbox.md',
  status: 'running',
  concurrency: 3,
  taskCount: 9,
  finished: false,
};

const BOARD_STATE = {
  boardId: BOARD_ID,
  name: 'xbox-controller-tester',
  planPath: 'documentation/plans/xbox.md',
  status: 'running',
  concurrency: 3,
  waves: [],
  taskOrder: [],
  mergeQueue: [],
  finished: false,
  tasks: { __map: [] },
};

let activeWindow: Window | undefined;
let previousFetch: typeof fetch | undefined;
let previousEventSource: typeof EventSource | undefined;
let streamOpens = 0;

class FakeEventSource {
  url: string;
  constructor(url: string) {
    this.url = url;
    streamOpens += 1;
  }
  addEventListener(): void {}
  close(): void {}
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return String((input as Request).url ?? input);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function setupDom(): void {
  previousFetch = globalThis.fetch;
  activeWindow?.close();
  const win = new Window();
  activeWindow = win;
  installHappyDomGlobals(win, {
    fetch: (async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (/\/api\/boards\/[^/?#]+/.test(url)) {
        return jsonResponse({ state: BOARD_STATE, seq: 1 });
      }
      if (url.includes('/api/boards')) return jsonResponse({ boards: [BOARD_SUMMARY] });
      return jsonResponse({});
    }) as typeof fetch,
  });
  const g = globalThis as typeof globalThis & {
    sessionStorage: Storage;
    EventSource: typeof EventSource;
    HTMLSelectElement: typeof HTMLSelectElement;
    MutationObserver: typeof MutationObserver;
  };
  g.sessionStorage = win.sessionStorage;
  g.HTMLSelectElement = win.HTMLSelectElement;
  if (typeof g.MutationObserver === 'undefined') {
    g.MutationObserver = class {
      observe(): void {}
      disconnect(): void {}
      takeRecords(): MutationRecord[] {
        return [];
      }
    } as typeof MutationObserver;
  }
  previousEventSource = globalThis.EventSource;
  g.EventSource = FakeEventSource as unknown as typeof EventSource;

  for (const [id, tag] of [
    ['chatArea', 'div'],
    ['mainColumn', 'div'],
    ['modelSelect', 'select'],
  ] as const) {
    const node = document.createElement(tag);
    node.id = id;
    document.body.appendChild(node);
  }
  setWorkspaceFromServer({
    path: WORKSPACE,
    label: 'resume-ws',
    isDefault: false,
    recent: [],
  });
  const chat = createEmptyChatObject('chat-boards-resume');
  chat.workspacePath = WORKSPACE;
  setSessionStateForTests({
    version: 5,
    activeId: chat.id,
    sidebarCollapsed: false,
    groups: [],
    chats: [chat],
  });
}

async function waitForBoardHeader(): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const title = document.querySelector('.board-header__title');
    if (title?.textContent === 'xbox-controller-tester') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `board header never painted; pane=${document.querySelector('.ov2__board')?.innerHTML?.slice(0, 200)}`,
  );
}

afterEach(() => {
  resetBoardsViewForTests();
  resetWorkspaceStateForTests();
  setSessionStateForTests(null);
  if (previousFetch) globalThis.fetch = previousFetch;
  if (previousEventSource) globalThis.EventSource = previousEventSource;
  document.body.innerHTML = '';
  activeWindow?.close();
  activeWindow = undefined;
  streamOpens = 0;
});

describe('V2 Boards last-opened resume', () => {
  test('plan launch opens its board even when the list still predates creation', async () => {
    setupDom();
    const posted: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes('/api/boards') && init?.method === 'POST') {
        posted.push(JSON.parse(String(init.body)).planPath);
        return jsonResponse({ boardId: BOARD_ID, state: BOARD_STATE });
      }
      if (/\/api\/boards\/[^/?#]+/.test(url)) {
        return jsonResponse({ state: BOARD_STATE, seq: 1 });
      }
      if (url.includes('/api/boards')) return jsonResponse({ boards: [] });
      return jsonResponse({});
    }) as typeof fetch;
    const result = await launchBoardFromPlan('documentation/plans/xbox.md');
    assert.deepEqual(result, { boardId: BOARD_ID });
    await waitForBoardHeader();
    assert.deepEqual(posted, ['documentation/plans/xbox.md']);
    assert.equal(document.querySelector('#orchestrateHubPlanSelect'), null);
  });

  test('reopening Boards reconnects the last journal instead of leaving a skeleton', async () => {
    setupDom();
    streamOpens = 0;

    await openBoardsView();
    showBoard(BOARD_ID);
    await waitForBoardHeader();
    assert.equal(document.querySelector('.ov2-loading'), null);
    const opensAfterFirst = streamOpens;
    assert.ok(opensAfterFirst >= 1, 'first open must attach an event stream');

    teardownBoardsView();
    assert.equal(document.getElementById('orchestratorBoardsRoot'), null);

    await openBoardsView();
    await waitForBoardHeader();
    assert.equal(document.querySelector('.ov2-loading'), null);
    const selected = document.querySelector('.ov2__board-btn.is-selected');
    assert.ok(selected, 'last board stays selected in the rail');
    assert.ok(streamOpens > opensAfterFirst, 'reopen must create a new board client stream');
  });
});
