import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  initCodeViewsOrchestrateButton,
  resetCodeViewsOrchestrateButtonForTests,
  syncCodeViewsOrchestrateButton,
  updateV2BoardActivityFromSummaries,
} from '../../src/ui/code-views-orchestrate-button.ts';
import { ORCHESTRATE_HUB_ROOT_ID } from '../../src/ui/orchestrate-hub.ts';
import { initRenderIdleTracking } from '../../src/boot/render-idle.ts';
import {
  createEmptyChatObject,
  sessionState,
  setSessionStateForTests,
} from '../../src/state/sessions.ts';
import { getOrCreateBoardGroup } from '../../src/state/chat-groups.ts';
import { resetWorkspaceStateForTests, setWorkspaceFromServer } from '../../src/state/workspace.ts';
import { installHappyDomGlobals, teardownHappyDomAsync } from '../os/dom-helpers.mts';

describe('code views orchestrate button', () => {
  let happyDomWindow: import('happy-dom').Window | undefined;
  let previousFetch: typeof globalThis.fetch | undefined;

  beforeEach(async () => {
    previousFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ boards: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    const { Window } = await import('happy-dom');
    const win = new Window();
    happyDomWindow = win;
    installHappyDomGlobals(win);
    resetCodeViewsOrchestrateButtonForTests();

    win.document.body.innerHTML = `
      <nav class="code-views" id="codeViews">
        <button type="button" class="code-views__btn" id="btnOrchestrate" title="Orchestrate"></button>
      </nav>
    `;
  });

  afterEach(async () => {
    resetCodeViewsOrchestrateButtonForTests();
    resetWorkspaceStateForTests();
    setSessionStateForTests(null);
    if (previousFetch) globalThis.fetch = previousFetch;
    if (happyDomWindow) await teardownHappyDomAsync(happyDomWindow);
  });

  test('hidden windows skip board requests and refresh when visible again', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    const stopVisibility = initRenderIdleTracking();
    let requests = 0;
    let resolveRequest: () => void;
    const requested = new Promise<void>((resolve) => { resolveRequest = resolve; });
    globalThis.fetch = async () => {
      requests++;
      resolveRequest();
      return new Response(JSON.stringify({ boards: [] }), { status: 200 });
    };
    try {
      initCodeViewsOrchestrateButton();
      t.mock.timers.tick(30_000);
      assert.equal(requests, 0, 'six hidden polling ticks do not issue requests');
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new window.Event('visibilitychange'));
      await requested;
      assert.equal(requests, 1, 'resume refreshes immediately');
    } finally {
      resetCodeViewsOrchestrateButtonForTests();
      stopVisibility();
    }
  });

  test('shows a live dot when a V2 board is running and boards view is closed', () => {
    initCodeViewsOrchestrateButton();
    updateV2BoardActivityFromSummaries([
      {
        boardId: 'board-1',
        name: 'Demo',
        planPath: 'documentation/plans/demo.md',
        status: 'running',
        concurrency: 1,
        taskCount: 3,
        finished: false,
      },
    ]);

    const btn = document.getElementById('btnOrchestrate');
    assert.ok(btn);
    const dot = btn.querySelector('.code-views__activity-dot');
    assert.ok(dot);
    assert.equal(dot.hidden, false);
    assert.equal(dot.classList.contains('is-live'), true);
    assert.equal(btn.title, 'Orchestrate (board running)');
    assert.equal(btn.getAttribute('aria-pressed'), 'false');
  });

  test('hides the dot while the boards surface is open', () => {
    initCodeViewsOrchestrateButton();
    updateV2BoardActivityFromSummaries([
      {
        boardId: 'board-1',
        name: 'Demo',
        planPath: 'documentation/plans/demo.md',
        status: 'running',
        concurrency: 1,
        taskCount: 3,
        finished: false,
      },
    ]);

    const root = document.createElement('div');
    root.id = 'orchestratorBoardsRoot';
    document.body.appendChild(root);
    syncCodeViewsOrchestrateButton();

    const btn = document.getElementById('btnOrchestrate');
    assert.ok(btn);
    const dot = btn.querySelector('.code-views__activity-dot');
    assert.ok(dot);
    assert.equal(dot.hidden, true);
    assert.equal(btn.getAttribute('aria-pressed'), 'true');
    assert.equal(btn.title, 'Orchestrate');
  });

  test('shows a dot for a V1 board folder with running status', () => {
    const ws = 'C:\\workspace\\demo';
    setWorkspaceFromServer({ path: ws, label: 'demo', isDefault: false });
    const planner = createEmptyChatObject('', ws);
    planner.id = '11111111-1111-1111-1111-111111111111';
    planner.modeId = 'orchestrate';
    setSessionStateForTests({
      version: 5,
      activeId: planner.id,
      sidebarCollapsed: false,
      groups: [],
      chats: [planner],
    });
    const group = getOrCreateBoardGroup(planner);
    group.orchestrateBoard = {
      status: 'running',
      tasks: [],
      lastUpdatedAt: 1,
    };

    initCodeViewsOrchestrateButton();
    syncCodeViewsOrchestrateButton();

    const btn = document.getElementById('btnOrchestrate');
    assert.ok(btn);
    const dot = btn.querySelector('.code-views__activity-dot');
    assert.ok(dot);
    assert.equal(dot.hidden, false);
  });

  test('marks the hub root as an open orchestrate view', () => {
    const hub = document.createElement('div');
    hub.id = ORCHESTRATE_HUB_ROOT_ID;
    document.body.appendChild(hub);
    syncCodeViewsOrchestrateButton();

    const btn = document.getElementById('btnOrchestrate');
    assert.ok(btn);
    assert.equal(btn.getAttribute('aria-pressed'), 'true');
  });
});
