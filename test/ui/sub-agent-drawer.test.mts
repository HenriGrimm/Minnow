/**
 * Overlay outcome / Activity rules: a blank fold summary must not paint the
 * placeholder as a structured answer or collapse the tool log.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import {
  adoptSubAgentRunForTests,
  resetSubAgentOrchestrator,
  setSubAgentApiFetchForTests,
  setSubAgentOpenStreamForTests,
} from '../../src/agents/orchestrator.ts';
import type { SubAgentRun } from '../../src/agents/types.ts';
import { FIXED_RUN_ID } from '../sub-agents/test-helpers.mts';

const PLACEHOLDER = 'Sub-agent completed with no text output.';
const CHAT_ID = '11111111-1111-1111-1111-222222222222';

const { closeSubAgentDrawer, openSubAgentDrawer, resolveOutcome, shouldExpandSubAgentActivity } =
  await import('../../src/ui/sub-agent-drawer.ts');

function stubMatchMedia(win: Window): void {
  win.matchMedia = (() => ({
    matches: true,
    media: '',
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
    onchange: null,
  })) as typeof win.matchMedia;
}

function setupOverlayDom(): Window {
  const window = new Window();
  stubMatchMedia(window);
  globalThis.window = window as unknown as typeof globalThis.window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement as unknown as typeof HTMLElement;
  globalThis.Node = window.Node as unknown as typeof Node;
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  };
  document.body.innerHTML = `<div id="mainColumn"></div>`;
  return window;
}

function completedRun(overrides: Partial<SubAgentRun> = {}): SubAgentRun {
  return {
    runId: FIXED_RUN_ID,
    type: 'explore',
    task: 'List files under src/',
    status: 'completed',
    parentChatId: CHAT_ID,
    parentToolCallId: null,
    parentTurnId: 'turn-1',
    summary: '',
    error: null,
    startedAt: '2026-05-20T12:00:00.000Z',
    endedAt: '2026-05-20T12:01:00.000Z',
    toolTurns: 1,
    cancelled: false,
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_read',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_read', content: 'export const a = 1;' },
    ],
    ...overrides,
  };
}

describe('sub-agent overlay outcome and Activity', { concurrency: false }, () => {
  afterEach(() => {
    closeSubAgentDrawer();
    resetSubAgentOrchestrator();
    setSubAgentOpenStreamForTests(null);
    setSubAgentApiFetchForTests(null);
  });

  test('resolveOutcome ignores a blank summary; Activity stays open', () => {
    const run = completedRun();
    assert.equal(resolveOutcome(run), null);
    assert.equal(shouldExpandSubAgentActivity(run), true);
    assert.equal(resolveOutcome(completedRun({ summary: 'FIXED_SUMMARY' }) )?.summary, 'FIXED_SUMMARY');
    assert.equal(shouldExpandSubAgentActivity(completedRun({ summary: 'FIXED_SUMMARY' })), false);
  });

  test('open overlay does not paint the placeholder or collapse Activity', async () => {
    setupOverlayDom();
    setSubAgentOpenStreamForTests(() => ({ addEventListener() {}, close() {} }));
    setSubAgentApiFetchForTests(async () => Response.json({
      ok: true,
      events: [],
      state: { runs: [] },
    }));
    adoptSubAgentRunForTests(completedRun());
    await openSubAgentDrawer(FIXED_RUN_ID, CHAT_ID);

    const overlay = document.querySelector('.sub-agent-overlay');
    assert.ok(overlay);
    const text = overlay?.textContent ?? '';
    assert.equal(text.includes(PLACEHOLDER), false);
    const activity = overlay?.querySelector('details.sub-agent-overlay__activity');
    assert.ok(activity);
    assert.equal((activity as HTMLDetailsElement).open, true);
    const summary = overlay?.querySelector('.sub-agent-overlay__summary')?.textContent ?? '';
    assert.notEqual(summary, PLACEHOLDER);

    const activityBody = overlay?.querySelector('.sub-agent-overlay__body');
    const firstToolRow = activityBody?.querySelector('.tool-call-msg');
    (activity as HTMLDetailsElement).open = false;
    for (let i = 0; i < 100; i += 1) {
      adoptSubAgentRunForTests({
        ...completedRun(),
        status: 'running',
        endedAt: null,
        livePhase: 'generating',
        livePartialText: `Streaming without remounting ${i}`,
      });
    }
    assert.equal((activity as HTMLDetailsElement).open, false);
    assert.equal(activityBody?.querySelector('.tool-call-msg'), firstToolRow);
    assert.ok(activityBody?.textContent?.includes('Streaming without remounting 99'));

  });
  test('opens from cache during stalled requests and stays closed after late responses', async () => {
    setupOverlayDom();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    setSubAgentApiFetchForTests(async () => {
      await pending;
      return Response.json({ ok: true, events: [], state: { runs: [] } });
    });
    adoptSubAgentRunForTests(completedRun());
    const opening = openSubAgentDrawer(FIXED_RUN_ID, CHAT_ID);
    assert.ok(document.querySelector('.sub-agent-overlay'), 'paint before fetch resolves');
    closeSubAgentDrawer();
    release();
    await opening;
    assert.equal(document.querySelector('.sub-agent-overlay'), null);
  });

  test('a delayed open cannot replace the more recently selected run', async () => {
    setupOverlayDom();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    setSubAgentApiFetchForTests(async () => {
      await pending;
      return Response.json({ ok: true, events: [], state: { runs: [] } });
    });
    adoptSubAgentRunForTests(completedRun());
    adoptSubAgentRunForTests(completedRun({ runId: 'second-run', task: 'Second task' }));
    const first = openSubAgentDrawer(FIXED_RUN_ID, CHAT_ID);
    const second = openSubAgentDrawer('second-run', CHAT_ID);
    release();
    await Promise.all([first, second]);
    assert.equal(document.querySelector('.sub-agent-overlay__prompt-text')?.textContent, 'Second task');
  });

});
