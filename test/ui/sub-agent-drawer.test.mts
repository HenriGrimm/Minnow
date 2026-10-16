/**
 * Overlay outcome / Activity rules: a blank fold summary must not paint the
 * placeholder as a structured answer or collapse the tool log.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import DOMPurify from 'dompurify';
import {
  adoptSubAgentRunForTests,
  resetSubAgentOrchestrator,
  setSubAgentApiFetchForTests,
  setSubAgentOpenStreamForTests,
} from '../../src/agents/orchestrator.ts';
import type { SubAgentRun } from '../../src/agents/types.ts';
import { createEmptyChatObject, resetSessionPersistenceForTests, setSessionStateForTests } from '../../src/state/sessions.ts';
import { persistSubAgentRunSnapshot } from '../../src/state/sub-agent-session-sync.ts';
import { setStorageModeForTests } from '../../src/config/storage-mode.ts';
import { FIXED_RUN_ID } from '../sub-agents/test-helpers.mts';

const PLACEHOLDER = 'Sub-agent completed with no text output.';
const CHAT_ID = '11111111-1111-1111-1111-222222222222';

const { closeSubAgentDrawer, openSubAgentDrawer, resolveOutcome } =
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
  DOMPurify.sanitize = DOMPurify(window as unknown as globalThis.Window).sanitize;
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

describe('sub-agent Conversation inspector', { concurrency: false }, () => {
  afterEach(() => {
    closeSubAgentDrawer();
    resetSubAgentOrchestrator();
    setSubAgentOpenStreamForTests(null);
    setSubAgentApiFetchForTests(null);
    setSessionStateForTests(null);
    resetSessionPersistenceForTests();
    setStorageModeForTests(null);
  });

  test('resolveOutcome ignores a blank summary', () => {
    const run = completedRun();
    assert.equal(resolveOutcome(run), null);
    assert.equal(resolveOutcome(completedRun({ summary: 'FIXED_SUMMARY' }) )?.summary, 'FIXED_SUMMARY');
  });

  test('open overlay does not paint the placeholder or collapse Activity', async () => {
    setupOverlayDom();
    setSubAgentOpenStreamForTests(() => ({ addEventListener() {}, close() {} }));
    const fetchResolvers: Array<(response: Response) => void> = [];
    let stall = true;
    const response = () => Response.json({ ok: true, events: [], state: { runs: [] } });
    setSubAgentApiFetchForTests(() => stall
      ? new Promise<Response>((resolve) => { fetchResolvers.push(resolve); })
      : Promise.resolve(response()));
    adoptSubAgentRunForTests(completedRun({ status: 'running', endedAt: null, livePhase: 'generating' }));
    const opening = openSubAgentDrawer(FIXED_RUN_ID, CHAT_ID);

    const overlay = document.querySelector('.sub-agent-overlay');
    assert.ok(overlay);
    const text = overlay?.textContent ?? '';
    assert.equal(text.includes(PLACEHOLDER), false);
    const activity = overlay?.querySelector('.sub-agent-overlay__body');
    assert.ok(activity);
    assert.equal((activity as HTMLElement).hidden, false);
    const summary = overlay?.querySelector('.sub-agent-overlay__summary')?.textContent ?? '';
    assert.notEqual(summary, PLACEHOLDER);

    const activityBody = overlay?.querySelector('.sub-agent-overlay__body');
    const firstToolRow = activityBody?.querySelector('.tool-call-msg');
    const group = activity?.querySelector<HTMLDetailsElement>('.sub-agent-conversation__tools');
    assert.ok(group);
    group.open = true;
    group.dispatchEvent(new window.Event('toggle'));
    for (let i = 0; i < 100; i += 1) {
      adoptSubAgentRunForTests({
        ...completedRun(),
        status: 'running',
        endedAt: null,
        livePhase: 'generating',
        livePartialText: `Streaming without remounting ${i}`,
      });
    }
    assert.equal(group.open, true);
    assert.equal(activityBody?.querySelector('.tool-call-msg'), firstToolRow);
    assert.ok(activityBody?.textContent?.includes('Streaming without remounting 99'));

    stall = false;
    for (const resolve of fetchResolvers) resolve(response());
    await opening;
  });

  test('full live thoughts and responses remain visible through settling and a persisted reopen', async () => {
    setupOverlayDom();
    setStorageModeForTests('localStorage');
    const chat = createEmptyChatObject('test-model', 'C:/scratch');
    chat.id = CHAT_ID;
    setSessionStateForTests({ chats: [chat], activeId: CHAT_ID, sidebarCollapsed: false });
    setSubAgentOpenStreamForTests(() => ({ addEventListener() {}, close() {} }));
    setSubAgentApiFetchForTests(async () => Response.json({ ok: true, events: [], state: { runs: [] } }));
    const reasoning = 'Beginning of the actual reasoning. ' + 'Verify upstream evidence. '.repeat(50) + 'End of reasoning.';
    const response = 'Beginning of the actual response. ' + 'The source is verified. '.repeat(50) + 'End of response.';
    const thinking = completedRun({ status: 'running', endedAt: null, livePhase: 'thinking', livePartialReasoning: reasoning,
      messages: [{ role: 'assistant', content: '', reasoning }] as SubAgentRun['messages'] });
    adoptSubAgentRunForTests(thinking);
    await openSubAgentDrawer(FIXED_RUN_ID, CHAT_ID);
    assert.ok(document.querySelector('.sub-agent-overlay__body')?.textContent?.includes(reasoning));
    const thought = document.querySelector('.thoughts-panel-wrap');
    const grown = reasoning + ' One more observation.';
    adoptSubAgentRunForTests({ ...thinking, livePartialReasoning: grown, messages: [{ role: 'assistant', content: '', reasoning: grown }] as SubAgentRun['messages'] });
    assert.equal(document.querySelector('.thoughts-panel-wrap'), thought, 'growing thoughts keep their mounted disclosure');
    assert.ok(document.querySelector('.sub-agent-overlay__body')?.textContent?.includes(grown));
    adoptSubAgentRunForTests({ ...thinking, livePhase: 'generating', livePartialReasoning: '', livePartialText: response });
    assert.ok(document.querySelector('.transcript-view__assistant--partial')?.textContent?.includes(response));
    const settled = completedRun({ summary: 'Short handoff summary', messages: [
      { role: 'assistant', content: '', reasoning: grown },
      ...completedRun().messages,
      { role: 'assistant', content: response },
    ] as SubAgentRun['messages'] });
    adoptSubAgentRunForTests(settled);
    const body = document.querySelector<HTMLElement>('.sub-agent-overlay__body')!;
    assert.equal(body.hidden, false);
    assert.ok(body.textContent?.includes(response));
    assert.equal(body.querySelectorAll('.sub-agent-conversation__final').length, 1);
    assert.equal(body.querySelector('.transcript-view__live-tail'), null);
    document.getElementById('sub-agent-tab-result')?.click();
    assert.ok(document.querySelector('.sub-agent-overlay__structured')?.textContent?.includes(response));
    persistSubAgentRunSnapshot(settled);
    const saved = JSON.parse(JSON.stringify(chat));
    closeSubAgentDrawer();
    resetSubAgentOrchestrator();
    setSessionStateForTests({ chats: [saved], activeId: CHAT_ID, sidebarCollapsed: false });
    setSubAgentApiFetchForTests(async (input) => Response.json(String(input).includes('/transcript')
      ? { ok: true, events: [] }
      : { ok: true, state: { runs: [{ runId: FIXED_RUN_ID, parentChatId: CHAT_ID, type: settled.type,
          task: settled.task, phase: 'passed', attempts: [{ ended: true, summary: settled.summary, outcome: 'pass' }], delivered: true }] } }));
    await openSubAgentDrawer(FIXED_RUN_ID, CHAT_ID);
    const reopened = document.querySelector<HTMLElement>('.sub-agent-overlay__body')!;
    assert.equal(reopened.hidden, false);
    assert.ok(reopened.textContent?.includes(grown));
    assert.ok(reopened.textContent?.includes(response));
    assert.equal(reopened.querySelectorAll('.sub-agent-conversation__final').length, 1);
  });

  test('same-role agents have task titles and selection follows the chosen run', async () => {
    setupOverlayDom();
    setSubAgentApiFetchForTests(async () => Response.json({ ok: true, events: [], state: { runs: [] } }));
    adoptSubAgentRunForTests(completedRun({ type: 'researcher', task: 'Verify model sources' }));
    adoptSubAgentRunForTests(completedRun({ runId: 'second-run', type: 'researcher', task: 'Check Windows runtime' }));
    await openSubAgentDrawer(FIXED_RUN_ID, CHAT_ID);
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.sub-agent-overlay__chip')];
    assert.ok(buttons[0].textContent?.includes('Verify model sources'));
    assert.ok(buttons[1].textContent?.includes('Check Windows runtime'));
    buttons[1].click();
    assert.equal(document.querySelector('.sub-agent-overlay__title')?.textContent, 'Check Windows runtime');
    assert.equal(document.querySelector('.sub-agent-overlay__chip[aria-pressed="true"]')?.getAttribute('data-run-id'), 'second-run');
  });

  test('queued agents show a waiting state without claiming to generate a response', async () => {
    setupOverlayDom();
    setSubAgentOpenStreamForTests(() => ({ addEventListener() {}, close() {} }));
    setSubAgentApiFetchForTests(async () => Response.json({ ok: true, events: [], state: { runs: [] } }));
    adoptSubAgentRunForTests(completedRun({ status: 'queued', endedAt: null, messages: [] }));
    await openSubAgentDrawer(FIXED_RUN_ID, CHAT_ID);
    assert.ok(document.querySelector('.sub-agent-overlay__notice')?.textContent?.includes('Waiting'));
    assert.equal(document.querySelector('.transcript-view__stream-status'), null);
  });

  test('equal-length settled text corrections repaint the visible response', async () => {
    setupOverlayDom();
    setSubAgentApiFetchForTests(async () => Response.json({ ok: true, events: [], state: { runs: [] } }));
    adoptSubAgentRunForTests(completedRun({ messages: [{ role: 'assistant', content: 'Alpha' }] }));
    await openSubAgentDrawer(FIXED_RUN_ID, CHAT_ID);
    adoptSubAgentRunForTests(completedRun({ messages: [{ role: 'assistant', content: 'Bravo' }] }));
    assert.equal(document.querySelector('.sub-agent-overlay__body .transcript-view__assistant')?.textContent?.trim(), 'Bravo');
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
