/**
 * Leaving Boards and opening it again must reconnect the last journal.
 * A leftover selected id with no client paints a skeleton until another click.
 */
import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, test } from 'node:test';
import { mock } from 'node:test';

// Keep the UI fixture independent of the transport; wire tests cover the real socket.
mock.module('../../src/api/stream-event-source.ts', {
  namedExports: { StreamEventSource: class {
    constructor(url: string) { return new globalThis.EventSource(url); }
  } },
});
import { Window } from 'happy-dom';
import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import { derive } from '../../server/orchestrator/core/derive.js';
import { canonicalise } from '../../server/orchestrator/core/snapshot.js';
import { focusableWithin } from '../../src/ui/components/internal.ts';
const {
  openBoardsView,
  resetBoardsViewForTests,
  showBoard,
  teardownBoardsView,
} = await import('../../src/orchestrator/boards-view.ts');
const { setWorkspaceFromServer, resetWorkspaceStateForTests } = await import('../../src/state/workspace.ts');
const { createEmptyChatObject, setSessionStateForTests } = await import('../../src/state/sessions.ts');
const { launchBoardFromPlan } = await import('../../src/ui/orchestrate-launch.ts');

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

function setupDom(boardState: unknown = BOARD_STATE): void {
  previousFetch = globalThis.fetch;
  activeWindow?.close();
  const win = new Window();
  activeWindow = win;
  installHappyDomGlobals(win, {
    fetch: (async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (/\/api\/boards\/[^/?#]+/.test(url)) {
        return jsonResponse({ state: boardState, seq: 1 });
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
  g.CSS = win.CSS;
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
  test('task dialog contains focus and restores the task when closed', async () => {
    setupDom(canonicalise(derive([{
      v: 1, seq: 1, type: 'board.created', boardId: BOARD_ID, name: BOARD_SUMMARY.name,
      planPath: BOARD_SUMMARY.planPath, waves: [{ n: 1, name: 'Fixture' }],
      tasks: [{ id: 'W1-A', title: 'Audit task', wave: 1, dependsOn: [], touches: ['README.md'] }],
    }])));
    const outside = document.createElement('button');
    outside.textContent = 'Metrics';
    document.body.append(outside);
    await openBoardsView();
    showBoard(BOARD_ID);
    await waitForBoardHeader();

    const taskSelector = '[data-focus-key="task:W1-A"]';
    document.querySelector<HTMLButtonElement>(taskSelector)!.click();
    const panel = document.querySelector<HTMLElement>('.ov2-detail[aria-modal="true"]')!;
    assert.equal(panel.querySelector('summary button'), null);
    const [first, ...rest] = focusableWithin(panel);
    const last = rest.at(-1) ?? first;
    assert.equal(outside.inert, true);
    assert.ok(panel.contains(document.activeElement));

    last.focus();
    last.dispatchEvent(new activeWindow!.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    assert.ok(document.activeElement === first);
    first.dispatchEvent(new activeWindow!.KeyboardEvent('keydown', {
      key: 'Tab', shiftKey: true, bubbles: true, cancelable: true,
    }));
    assert.ok(document.activeElement === last);
    last.dispatchEvent(new activeWindow!.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(panel.isConnected, false);
    assert.equal(outside.inert, false);
    assert.ok(document.activeElement === document.querySelector(taskSelector));
  });

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

  test('Boards hides the chat panels, restores their layout, and opens task files in Code', async () => {
    setupDom(canonicalise(derive([{
      v: 1, seq: 1, type: 'board.created', boardId: BOARD_ID, name: BOARD_SUMMARY.name,
      planPath: BOARD_SUMMARY.planPath, waves: [{ n: 1, name: 'Fixture' }],
      tasks: [{ id: 'W1-A', title: 'Audit task', wave: 1, dependsOn: [], touches: ['README.md'] }],
    }])));
    const markup = new activeWindow!.DOMParser().parseFromString(
      readFileSync(new URL('../../index.html', import.meta.url), 'utf8'), 'text/html',
    );
    const stage = document.importNode(markup.getElementById('workspaceSplit')!, true) as HTMLElement;
    document.getElementById('chatArea')!.remove();
    document.getElementById('mainColumn')!.replaceWith(stage);
    const main = document.getElementById('mainColumn')!;
    Object.defineProperty(stage, 'getClientRects', { value: () => [{}] });

    const { closeOtherCodeStageViews, showCodeStageSection } = await import('../../src/ui/main-column-overlay');
    const { splitGraphitePanel } = await import('../../src/ui/surfaces/surface-bridge');
    const { mountSurfacePanels, openSurface, registerSurface, toggleSurfaceMaximize } =
      await import('../../src/ui/surfaces/surfaces-column');
    const { createWorkbenchContent } = await import('../../src/ui/surfaces/workbench-content');
    const files = document.createElement('div');
    const terminal = document.createElement('div');
    registerSurface('files', { render: () => files });
    registerSurface('terminal', { render: () => terminal });
    mountSurfacePanels(stage, { content: createWorkbenchContent(stage) });
    openSurface('terminal');
    openSurface('files');
    assert.equal(splitGraphitePanel(), true);
    const side = document.getElementById('surfaceSide')!;
    const bottom = document.getElementById('surfaceBottom')!;
    const split = document.getElementById('surfaceSplit')!;
    assert.deepEqual([side.hidden, bottom.hidden, split.hidden], [false, false, false]);

    for (const maximized of ['', 'side'] as const) {
      if (maximized) toggleSurfaceMaximize(maximized);
      assert.equal(stage.dataset.surfaceMax, maximized);
      await showCodeStageSection('boards');

      const board = document.getElementById('orchestratorBoardsRoot')!;
      assert.ok(main.contains(board));
      assert.deepEqual([side.hidden, bottom.hidden, split.hidden], [true, true, true]);
      assert.equal(stage.dataset.surfaceSide, 'false');
      assert.equal(stage.dataset.surfaceBottom, 'false');
      assert.equal(stage.dataset.surfaceMax, '');
      assert.equal(main.inert, false);
      const shortcut = new activeWindow!.KeyboardEvent('keydown', {
        key: 'j', ctrlKey: true, bubbles: true, cancelable: true,
      });
      board.dispatchEvent(shortcut);
      assert.equal(shortcut.defaultPrevented, false);

      await closeOtherCodeStageViews();
      assert.equal(board.isConnected, false);
      assert.equal(stage.dataset.surfaceMax, maximized);
      assert.deepEqual([side.hidden, bottom.hidden, split.hidden], [false, Boolean(maximized), false]);
      assert.ok(side.contains(files));
      assert.ok(bottom.contains(terminal));
    }

    await showCodeStageSection('boards');
    showBoard(BOARD_ID);
    await waitForBoardHeader();
    document.querySelector<HTMLButtonElement>('[data-focus-key="task:W1-A"]')!.click();
    document.querySelector<HTMLButtonElement>('.ov2-detail [role="tab"][id$="-files"]')!.click();
    const fileLink = () => document.querySelector<HTMLButtonElement>('[aria-label="Open README.md"]');
    for (let attempt = 0; attempt < 50 && !fileLink(); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const file = fileLink();
    assert.ok(file);
    file.click();
    const activeFile = () => stage.querySelector('[role="tab"][aria-selected="true"][title="README.md"]');
    for (let attempt = 0; attempt < 50 && !activeFile(); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(document.getElementById('orchestratorBoardsRoot'), null);
    assert.ok(activeFile());
  });

  test('opens the timeline in an anchored popover instead of below the board', async () => {
    setupDom();
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      requested.push(url);
      if (url.includes(`/api/boards/${BOARD_ID}/journal`)) {
        return jsonResponse({
          events: [{ seq: 1, type: 'board.created', data: { name: 'Controller tests' } }],
          truncated: false,
        });
      }
      if (/\/api\/boards\/[^/?#]+/.test(url)) return jsonResponse({ state: BOARD_STATE, seq: 1 });
      if (url.includes('/api/boards')) return jsonResponse({ boards: [BOARD_SUMMARY] });
      return jsonResponse({});
    }) as typeof fetch;

    await openBoardsView();
    showBoard(BOARD_ID);
    await waitForBoardHeader();
    const trigger = document.querySelector<HTMLButtonElement>('.board-timeline-btn');
    assert.ok(trigger, 'timeline trigger should be present');
    trigger.click();

    const popover = document.querySelector<HTMLElement>('.ov2-timeline-popover');
    assert.ok(popover, 'timeline should open in a popover');
    assert.equal(popover.getAttribute('role'), 'dialog');
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(document.querySelector('.ov2__board .ov2-journal'), null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(requested.some((url) => url.includes(`/api/boards/${BOARD_ID}/journal`)));
    assert.match(popover.textContent ?? '', /board\.created/);
  });

  test('the header inbox survives switching between report and board and closes on teardown', async () => {
    setupDom();
    const state = {
      ...BOARD_STATE, status: 'stopped', finished: true,
      finalTest: { outcome: 'fail', runInstructions: 'npm test', evidence: { output: 'Assertion failed' } },
    };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.endsWith('/report')) return jsonResponse({ markdown: 'Recovery report' });
      if (/\/api\/boards\/[^/?#]+/.test(url)) return jsonResponse({ state, seq: 1 });
      if (url.includes('/api/boards')) return jsonResponse({ boards: [{ ...BOARD_SUMMARY, status: 'stopped', finished: true }] });
      return jsonResponse({});
    }) as typeof fetch;
    await openBoardsView();
    showBoard(BOARD_ID);
    await waitForBoardHeader();
    assert.ok(document.querySelector('.ov2-report-screen'), document.querySelector('.ov2__board')?.textContent ?? 'No board pane');
    assert.equal(document.querySelector('.ov2__board .ov2-attention__row'), null);
    const trigger = document.querySelector<HTMLButtonElement>('.board-header .ov2-inbox-trigger')!;
    assert.ok(trigger);
    trigger.click();
    const popover = document.querySelector('.ov2-inbox-popover')!;
    const output = popover.querySelector<HTMLDetailsElement>('.ov2-integration-output')!;
    output.open = true;
    document.querySelector<HTMLButtonElement>('.board-header__dashboard-toggle')!.click();
    assert.equal(document.querySelector('.ov2-report-screen'), null);
    assert.ok(document.querySelector('.ov2-tasks'));
    assert.equal(document.querySelector('.ov2-inbox-trigger'), trigger);
    assert.equal(document.querySelector('.ov2-inbox-popover'), popover);
    assert.equal(document.querySelector('.ov2-integration-output'), output);
    assert.equal(output.open, true);
    assert.equal(document.querySelector('.ov2__board > .ov2-errors, .ov2__board > .ov2-recovery, .ov2__board > .ov2-notice'), null);
    document.querySelector<HTMLButtonElement>('.board-header__dashboard-toggle')!.click();
    assert.ok(document.querySelector('.ov2-report-screen'));
    assert.equal(document.querySelector('.ov2-inbox-popover'), popover);
    teardownBoardsView();
    assert.equal(document.querySelector('.ov2-inbox-popover'), null);
  });
});


for (const paused of [false, true]) {
  test(`board control sends ${paused ? 'resume' : 'pause'} and retains Stop`, async () => {
    setupDom();
    const posted: string[] = [];
    const state = { ...BOARD_STATE, status: paused ? 'stopped' : 'running', stopReason: paused ? 'paused' : null };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (init?.method === 'POST') posted.push(url);
      if (/\/api\/boards\/[^/?#]+/.test(url)) return jsonResponse({ state, seq: 1 });
      if (url.includes('/api/boards')) return jsonResponse({ boards: [{ ...BOARD_SUMMARY, status: state.status, stopReason: state.stopReason }] });
      return jsonResponse({});
    }) as typeof fetch;
    await openBoardsView();
    showBoard(BOARD_ID);
    await waitForBoardHeader();
    const button = document.querySelector<HTMLButtonElement>(`[aria-label="${paused ? 'Resume' : 'Pause'} board"]`);
    assert.ok(button);
    if (paused) assert.match(document.querySelector('.ov2__board-meta')!.textContent!, /paused/);
    assert.ok([...document.querySelectorAll('button')].some(node => node.textContent === 'Stop'));
    button.click();
    for (let i = 0; i < 100 && !posted.some(url => url.endsWith(paused ? '/start' : '/pause')); i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(posted.some(url => url.endsWith(paused ? '/start' : '/pause')));
  });
}
