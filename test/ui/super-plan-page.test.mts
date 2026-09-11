/**
 * The Super Plan surface: rail, composer, saved-plan view, and the run pane
 * with its checkpoint cards, tabs, pipeline and activity feed. Runs are fixture
 * views pushed through the renderer store; commands go to a stubbed server.
 */

// First: DOMPurify binds to the window that exists when the markdown renderer loads.
import '../tools/install-dom-before-imports.mts';
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import {
  getSuperPlanPageView,
  mountSuperPlanPage,
  resetSuperPlanPageForTests,
  type SuperPlanPageHandlers,
  type SuperPlanPageView,
} from '../../src/ui/super-plan-page.ts';
import { applySuperPlanView, resetSuperPlanStoreForTests } from '../../src/chat/super-plan/store.ts';
import type { SuperPlanRunView } from '../../src/chat/super-plan/types.ts';
import { attachSuperPlanRun, superPlanRunView, type SuperPlanScenario } from '../helpers/super-plan-fixture.ts';
import { createEmptyChatObject, setSessionStateForTests } from '../../src/state/sessions.ts';
import { resetAppDialogForTests } from '../../src/ui/app-dialog.ts';
import { resetWorkspaceStateForTests } from '../../src/state/workspace.ts';
import type { Chat } from '../../src/types.ts';

let activeWindow: Window | undefined;
const originalFetch = globalThis.fetch;

interface Call {
  method: string;
  url: string;
  body: Record<string, any> | null;
}

let requests: Call[] = [];
/** Next view the stub server answers commands with (defaults to echoing the current one). */
let respondWith: ((call: Call) => SuperPlanRunView | null) | null = null;
let currentView: SuperPlanRunView | null = null;
const files = new Map<string, string>();

function stubServer(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, any>) : null;
    const call = { method, url, body };
    requests.push(call);
    for (const [path, text] of files) {
      if (url.includes(encodeURIComponent(path)) || url.includes(path)) return new Response(text, { status: 200 });
    }
    if (url.startsWith('/api/super-plan/')) {
      if (url.includes('/transcripts/')) return Response.json({ ok: true, messages: [{ role: 'assistant', content: 'Read the sync layer. Two open questions.' }] });
      const next = respondWith?.(call) ?? currentView;
      if (!next) return Response.json({ ok: false, error: 'no run' }, { status: 404 });
      currentView = next;
      return Response.json({ ok: true, view: next });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
}

function installWindow(): void {
  activeWindow?.close();
  const window = new Window({ url: 'http://localhost:9473/' });
  activeWindow = window;
  installHappyDomGlobals(window);
  const g = globalThis as unknown as Record<string, unknown>;
  g.CustomEvent = window.CustomEvent;
  g.Event = window.Event;
  g.KeyboardEvent = window.KeyboardEvent;
  g.MouseEvent = window.MouseEvent;
  g.HTMLTextAreaElement = window.HTMLTextAreaElement;
  g.HTMLInputElement = window.HTMLInputElement;
  g.HTMLSelectElement = window.HTMLSelectElement;
  g.HTMLDetailsElement = window.HTMLDetailsElement;
  globalThis.fetch = stubServer();
  document.body.innerHTML = '<div id="mainColumn"><main id="chatArea"></main></div>';
}

const handlerCalls: string[] = [];

function handlers(overrides: Partial<SuperPlanPageHandlers> = {}): SuperPlanPageHandlers {
  const record = (name: string) => (...args: unknown[]) => {
    handlerCalls.push(args.length ? `${name}:${args.map(String).join('|')}` : name);
  };
  return {
    start: async (chatId, prompt) => {
      handlerCalls.push(`start:${chatId}|${prompt}`);
    },
    selectRun: record('selectRun'),
    openPlanFile: record('openPlanFile'),
    newPlan: record('newPlan'),
    deleteEntry: (entry) => handlerCalls.push(`deleteEntry:${entry.chatId ?? entry.path}`),
    openSettings: record('openSettings'),
    openFile: record('openFile'),
    orchestrate: record('orchestrate'),
    build: record('build'),
    revisePlanFile: record('revisePlanFile'),
    ...overrides,
  };
}

function seedChats(chats: Chat[]): void {
  setSessionStateForTests({ version: 5, activeId: chats[0]!.id, sidebarCollapsed: false, chats });
}

function mount(view: SuperPlanPageView, extra: Partial<SuperPlanPageHandlers> = {}): HTMLElement {
  const page = mountSuperPlanPage(document.getElementById('chatArea')!, handlers(extra));
  page.show(view);
  return page.root;
}

/** A chat with a run in `scenario`, its view in the store, mounted in run mode. */
function mountRun(scenario: SuperPlanScenario, overrides: Partial<SuperPlanRunView> = {}): { chat: Chat; view: SuperPlanRunView; root: HTMLElement } {
  const chat = createEmptyChatObject('m');
  const view = attachSuperPlanRun(chat, scenario, overrides);
  seedChats([chat]);
  currentView = view;
  applySuperPlanView(view);
  const root = mount({ mode: 'run', chatId: chat.id, runId: view.runId });
  return { chat, view, root };
}

/** Push a newer server view for the mounted run. */
function push(view: SuperPlanRunView, changes: Partial<SuperPlanRunView>): SuperPlanRunView {
  const next = { ...view, ...changes, seq: (currentView?.seq ?? view.seq) + 1 };
  currentView = next;
  applySuperPlanView(next);
  return next;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for condition');
}

function buttonByText(root: ParentNode, text: string | RegExp): HTMLButtonElement | undefined {
  return [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    typeof text === 'string' ? b.textContent?.trim() === text : text.test(b.textContent ?? ''),
  );
}

function commandCalls(): Call[] {
  return requests.filter((r) => r.method === 'POST' && r.url.startsWith('/api/super-plan/'));
}

describe('super plan page', () => {
  afterEach(async () => {
    resetSuperPlanPageForTests();
    resetSuperPlanStoreForTests();
    resetAppDialogForTests();
    resetWorkspaceStateForTests();
    setSessionStateForTests(null);
    requests = [];
    respondWith = null;
    currentView = null;
    files.clear();
    handlerCalls.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 0));
    activeWindow?.close();
    activeWindow = undefined;
    globalThis.fetch = originalFetch;
  });

  // ── Composer ───────────────────────────────────────────────────────────────

  test('the composer starts a plan with the typed brief', async () => {
    installWindow();
    const chat = createEmptyChatObject('m');
    chat.modeId = 'super-plan';
    seedChats([chat]);
    const root = mount({ mode: 'compose', chatId: chat.id });

    const field = root.querySelector<HTMLTextAreaElement>('#superPlanPrompt')!;
    const send = root.querySelector<HTMLButtonElement>('.sp-send')!;
    assert.equal(send.disabled, true, 'nothing to send yet');
    field.value = 'Add offline queueing to the sync layer';
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(send.disabled, false);

    field.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await waitFor(() => handlerCalls.length > 0);
    assert.deepEqual(handlerCalls, [`start:${chat.id}|Add offline queueing to the sync layer`]);
  });

  test('a failed start shows why, keeps the brief, and lets the user retry', async () => {
    installWindow();
    const chat = createEmptyChatObject('m');
    chat.modeId = 'super-plan';
    seedChats([chat]);
    const root = mount({ mode: 'compose', chatId: chat.id }, {
      start: async () => {
        throw new Error('The local server is not running.');
      },
    });
    const field = root.querySelector<HTMLTextAreaElement>('#superPlanPrompt')!;
    field.value = 'Plan the export feature';
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
    root.querySelector<HTMLButtonElement>('.sp-send')!.click();

    const error = root.querySelector<HTMLElement>('.sp-ask__error')!;
    await waitFor(() => !error.hidden);
    assert.match(error.textContent ?? '', /local server is not running/);
    assert.equal(field.value, 'Plan the export feature');
    assert.equal(field.readOnly, false);
    assert.equal(root.querySelector<HTMLButtonElement>('.sp-send')!.disabled, false);
  });

  test('pipeline chips describe the saved settings in words', () => {
    installWindow();
    const chat = createEmptyChatObject('m');
    chat.modeId = 'super-plan';
    seedChats([chat]);
    const root = mount({ mode: 'compose', chatId: chat.id });
    const chips = [...root.querySelectorAll('.sp-chip')].map((c) => c.textContent?.replace('▾', '').trim());
    assert.deepEqual(chips, ['Interview · up to 20', 'Research · web + code · auto', 'Review · 2 rounds', 'Polish · when UI']);
  });

  test('showing the same composer again keeps what was typed', () => {
    installWindow();
    const chat = createEmptyChatObject('m');
    chat.modeId = 'super-plan';
    seedChats([chat]);
    const page = mountSuperPlanPage(document.getElementById('chatArea')!, handlers());
    page.show({ mode: 'compose', chatId: chat.id });
    const field = page.root.querySelector<HTMLTextAreaElement>('#superPlanPrompt')!;
    field.value = 'half a thought';
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
    page.show({ mode: 'compose', chatId: chat.id });
    assert.equal(page.root.querySelector<HTMLTextAreaElement>('#superPlanPrompt'), field);
    assert.equal(field.value, 'half a thought');
  });

  // ── Rail ───────────────────────────────────────────────────────────────────

  test('the rail lists runs with a word for their state, the ones that need you first', async () => {
    installWindow();
    const running = createEmptyChatObject('a');
    attachSuperPlanRun(running, 'drafting', { title: 'Offline queue', updatedAt: 9_000 });
    const waiting = createEmptyChatObject('b');
    attachSuperPlanRun(waiting, 'spec', { title: 'Export feature', updatedAt: 1_000 });
    seedChats([running, waiting]);
    const root = mount({ mode: 'run', chatId: running.id, runId: running.superPlanRunId! });

    await waitFor(() => root.querySelectorAll('.sp-row').length === 2);
    const rows = [...root.querySelectorAll<HTMLElement>('.sp-row')];
    assert.match(rows[0]!.textContent ?? '', /Export feature/);
    assert.match(rows[0]!.textContent ?? '', /needs you/);
    assert.match(rows[1]!.textContent ?? '', /Offline queue/);
    assert.match(rows[1]!.textContent ?? '', /running/);
    assert.equal(rows[1]!.getAttribute('aria-current'), 'true', 'the shown run is marked');
    assert.equal(root.querySelector('.sp-group__label')?.textContent, 'In progress');

    rows[0]!.click();
    assert.deepEqual(handlerCalls, [`selectRun:${waiting.id}`]);
  });

  test('the rail follows run summaries without a reload', async () => {
    installWindow();
    const chat = createEmptyChatObject('a');
    const view = attachSuperPlanRun(chat, 'drafting', { title: 'Offline queue' });
    seedChats([chat]);
    const root = mount({ mode: 'compose', chatId: 'other' });
    await waitFor(() => /running/.test(root.querySelector('.sp-row')?.textContent ?? ''));

    applySuperPlanView({ ...view, seq: view.seq + 1, status: 'waiting', needsInput: 'accept', attentionKey: 'accept:1' });
    await waitFor(() => /needs you/.test(root.querySelector('.sp-row')?.textContent ?? ''));
  });

  // ── Saved plan file ────────────────────────────────────────────────────────

  test('a saved plan file shows its content and the ways to continue', async () => {
    installWindow();
    files.set('documentation/plans/export.md', '# Export\n\nShip CSV export.');
    const chat = createEmptyChatObject('m');
    chat.modeId = 'super-plan';
    seedChats([chat]);
    const root = mount({ mode: 'doc', chatId: chat.id, path: 'documentation/plans/export.md' });

    assert.equal(root.querySelector('.sp-runhead__title')?.textContent, 'Export');
    await waitFor(() => /Ship CSV export/.test(root.querySelector('.sp-doc')?.textContent ?? ''));
    buttonByText(root, 'Revise in a chat')!.click();
    buttonByText(root, 'Build in a chat')!.click();
    buttonByText(root, /Open in editor/)!.click();
    assert.deepEqual(handlerCalls, [
      'revisePlanFile:documentation/plans/export.md',
      'build:documentation/plans/export.md',
      'openFile:documentation/plans/export.md',
    ]);
  });

  // ── Run: header and tabs ───────────────────────────────────────────────────

  test('the run header says what is happening and offers what the run allows', () => {
    installWindow();
    const { root } = mountRun('drafting');
    assert.equal(root.querySelector('.sp-runhead__title')?.textContent, 'Offline sync queue');
    assert.equal(root.querySelector('.sp-runhead__meta .sp-state')?.textContent, 'running');
    assert.equal(root.querySelector('.sp-runhead__activity')?.textContent, 'Drafting the plan');
    const visible = [...root.querySelectorAll<HTMLButtonElement>('.sp-runhead__actions .sp-action')]
      .filter((b) => !b.hidden && !b.classList.contains('sp-action--rail'))
      .map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim());
    assert.deepEqual(visible, ['Pause', 'Cancel', 'More actions']);
  });

  test('view updates keep header controls in place so focus survives a streaming run', () => {
    installWindow();
    const { view, root } = mountRun('drafting');
    const pause = buttonByText(root, 'Pause')!;
    pause.focus();
    push(view, { activity: 'Drafting the plan: wave 2' });
    push(view, { activity: 'Drafting the plan: wave 3' });
    assert.equal(buttonByText(root, 'Pause'), pause);
    assert.equal(document.activeElement, pause);
    assert.equal(root.querySelector('.sp-runhead__activity')?.textContent, 'Drafting the plan: wave 3');
  });

  test('Pause sends the command and the header follows the server', async () => {
    installWindow();
    const { view, root } = mountRun('drafting');
    respondWith = () => ({ ...view, seq: view.seq + 1, status: 'paused', activity: 'Paused', actions: { ...view.actions, pause: false, resume: true } });
    buttonByText(root, 'Pause')!.click();
    await waitFor(() => root.querySelector('.sp-runhead__meta .sp-state')?.textContent === 'paused');
    assert.deepEqual(commandCalls().map((c) => c.url), [`/api/super-plan/${view.runId}/pause`]);
    assert.equal(buttonByText(root, 'Pause')?.hidden, true);
    assert.equal(buttonByText(root, 'Resume')?.hidden, false);
  });

  test('tabs appear as documents land, and the review tab counts open findings', () => {
    installWindow();
    const { view, root } = mountRun('interviewing');
    const tab = (id: string) => root.querySelector<HTMLButtonElement>(`.sp-segment[data-tab="${id}"]`)!;
    assert.equal(tab('activity').hidden, false);
    assert.equal(tab('spec').hidden, true);
    assert.equal(tab('plan').hidden, true);
    assert.equal(tab('review').hidden, true);

    const accept = superPlanRunView('accept', { runId: view.runId, chatId: view.chatId });
    push(view, accept);
    assert.equal(tab('spec').hidden, false);
    assert.equal(tab('plan').hidden, false);
    assert.equal(tab('review').hidden, false);
    assert.equal(tab('review').querySelector('.sp-segment__count')?.textContent, '1');
    assert.equal(tab('plan').getAttribute('aria-selected'), 'true', 'the plan checkpoint opens the plan');
  });

  test('a tab the user picked stays picked until the run asks for something new', () => {
    installWindow();
    const { view, root } = mountRun('reviewing', { reviews: superPlanRunView('accept').reviews });
    const tab = (id: string) => root.querySelector<HTMLButtonElement>(`.sp-segment[data-tab="${id}"]`)!;
    tab('review').click();
    push(view, { activity: 'Review round 2 of 2' });
    assert.equal(tab('review').getAttribute('aria-selected'), 'true');

    push(view, superPlanRunView('accept', { runId: view.runId, chatId: view.chatId, attentionKey: 'accept:new' }));
    assert.equal(tab('plan').getAttribute('aria-selected'), 'true');
  });

  // ── Run: checkpoints ───────────────────────────────────────────────────────

  test('interview questions: recommended answers fill in, and answers go to the server', async () => {
    installWindow();
    const { view, root } = mountRun('question');
    const card = root.querySelector<HTMLElement>('.sp-check--question')!;
    assert.ok(card, 'the question card is at the top of the run');
    assert.equal(card.querySelectorAll('.sp-q').length, 2);
    assert.equal(card.querySelectorAll('.sp-q__badge').length, 3, 'recommended options are marked');

    buttonByText(card, 'Send answers')!.click();
    assert.match(card.querySelector('.sp-check__error')?.textContent ?? '', /When a queued edit conflicts/);
    assert.equal(commandCalls().length, 0, 'nothing is sent until every question has an answer');

    buttonByText(card, 'Use recommended')!.click();
    respondWith = () => ({ ...view, seq: view.seq + 1, status: 'running', needsInput: null, attentionKey: '', question: null });
    buttonByText(card, 'Send answers')!.click();
    await waitFor(() => commandCalls().length === 1);
    const call = commandCalls()[0]!;
    assert.equal(call.url, `/api/super-plan/${view.runId}/questions/q-1/answer`);
    assert.deepEqual(call.body?.answer.answers, [
      { questionId: 'conflict', selectedIds: ['server'], otherText: null },
      { questionId: 'scope', selectedIds: ['notes', 'tasks'], otherText: null },
    ]);
    await waitFor(() => !root.querySelector('.sp-check--question'));
  });

  test('a written answer counts as Other', async () => {
    installWindow();
    const { view, root } = mountRun('question');
    const card = root.querySelector<HTMLElement>('.sp-check--question')!;
    const [first, second] = [...card.querySelectorAll<HTMLElement>('.sp-q')];
    const other = first!.querySelector<HTMLTextAreaElement>('.sp-q__other')!;
    other.value = 'Ask the user each time';
    other.dispatchEvent(new window.Event('input', { bubbles: true }));
    second!.querySelector<HTMLInputElement>('input[value="notes"]')!.checked = true;
    buttonByText(card, 'Send answers')!.click();
    await waitFor(() => commandCalls().length === 1);
    assert.deepEqual(commandCalls()[0]!.body?.answer.answers[0], {
      questionId: 'conflict',
      selectedIds: ['__other__'],
      otherText: 'Ask the user each time',
    });
    void view;
  });

  test('typed answers survive view updates while the same questions are open', () => {
    installWindow();
    const { view, root } = mountRun('question');
    const input = root.querySelector<HTMLInputElement>('.sp-check--question input[value="client"]')!;
    input.checked = true;
    push(view, { activity: 'Still waiting for your answers' });
    assert.equal(root.querySelector<HTMLInputElement>('.sp-check--question input[value="client"]'), input);
    assert.equal(input.checked, true);
  });

  test('Stop asking closes the interview', async () => {
    installWindow();
    const { view, root } = mountRun('question');
    buttonByText(root, 'Stop asking')!.click();
    await waitFor(() => commandCalls().length === 1);
    assert.equal(commandCalls()[0]!.url, `/api/super-plan/${view.runId}/questions/close`);
  });

  test('spec checkpoint: confirm, or ask for changes in words', async () => {
    installWindow();
    files.set('documentation/plans/offline-sync-queue.spec.md', '# Offline sync queue\n\nQueue edits offline.');
    const { view, root } = mountRun('spec');
    const card = root.querySelector<HTMLElement>('.sp-check--spec')!;
    assert.match(card.textContent ?? '', /Review the build spec/);
    assert.equal(root.querySelector('.sp-segment[data-tab="spec"]')?.getAttribute('aria-selected'), 'true');
    await waitFor(() => /Queue edits offline/.test(root.querySelector('.sp-doc')?.textContent ?? ''));

    buttonByText(card, 'Request changes')!.click();
    const notes = card.querySelector<HTMLTextAreaElement>('.sp-revise__field')!;
    buttonByText(card, 'Revise spec')!.click();
    assert.match(card.querySelector('.sp-revise .sp-check__error')?.textContent ?? '', /Say what should change/);
    await waitFor(() => !buttonByText(card, 'Revise spec')!.disabled);
    notes.value = 'Drop file uploads from scope.';
    buttonByText(card, 'Revise spec')!.click();
    await waitFor(() => commandCalls().length === 1);
    assert.deepEqual(commandCalls()[0]!.body, { checkpoint: 'spec', verdict: 'revise', feedback: 'Drop file uploads from scope.' });

    buttonByText(card, 'Cancel')!.click();
    buttonByText(card, 'Confirm spec')!.click();
    await waitFor(() => commandCalls().length === 2);
    assert.equal(commandCalls()[1]!.url, `/api/super-plan/${view.runId}/checkpoint`);
    assert.deepEqual(commandCalls()[1]!.body, { checkpoint: 'spec', verdict: 'confirm' });
  });

  test('plan checkpoint: open findings are called out, and accept or review again are one click', async () => {
    installWindow();
    const { root } = mountRun('accept');
    const card = root.querySelector<HTMLElement>('.sp-check--accept')!;
    assert.match(card.textContent ?? '', /7 tasks/);
    assert.match(card.textContent ?? '', /1 review finding is still open/);
    buttonByText(card, /review finding is still open/)!.click();
    assert.equal(root.querySelector('.sp-segment[data-tab="review"]')?.getAttribute('aria-selected'), 'true');
    assert.match(root.querySelector('.sp-review')?.textContent ?? '', /Replay order is undefined across tabs/);

    buttonByText(card, 'Review again')!.click();
    await waitFor(() => commandCalls().length === 1);
    buttonByText(card, 'Accept plan')!.click();
    await waitFor(() => commandCalls().length === 2);
    assert.deepEqual(commandCalls().map((c) => c.body?.verdict), ['review', 'accept']);
  });

  test('a halted stage says what failed and offers retry, skip and cancel', async () => {
    installWindow();
    const { view, root } = mountRun('halted', { actions: { ...superPlanRunView('halted').actions, skip: null } });
    const card = root.querySelector<HTMLElement>('.sp-check--halted')!;
    assert.equal(card.getAttribute('role'), 'alert');
    assert.match(card.textContent ?? '', /Plan stopped after repeated failures/);
    assert.match(card.textContent ?? '', /Task 3 has no Test step/);
    assert.equal(buttonByText(card, /^Skip/), undefined, 'draft is required, so it cannot be skipped');
    buttonByText(card, 'Retry')!.click();
    await waitFor(() => commandCalls().length === 1);
    assert.equal(commandCalls()[0]!.url, `/api/super-plan/${view.runId}/resume`);
  });

  test('an accepted plan hands off to a board or a build chat', () => {
    installWindow();
    const { root } = mountRun('done');
    const card = root.querySelector<HTMLElement>('.sp-check--done')!;
    buttonByText(card, 'Start Orchestrator')!.click();
    buttonByText(card, 'Build in a chat')!.click();
    assert.deepEqual(handlerCalls, [
      'orchestrate:documentation/plans/offline-sync-queue.md',
      'build:documentation/plans/offline-sync-queue.md',
    ]);
  });

  // ── Run: pipeline ──────────────────────────────────────────────────────────

  test('the pipeline shows each step with its state and offers Redo and Skip where they apply', () => {
    installWindow();
    const { root } = mountRun('researching');
    const steps = [...root.querySelectorAll<HTMLElement>('.sp-step')];
    assert.deepEqual(
      steps.map((s) => `${s.dataset.step}:${[...s.classList].find((c) => c.startsWith('is-'))}`),
      ['interview:is-done', 'spec:is-done', 'research:is-active', 'draft:is-pending', 'review:is-pending', 'polish:is-pending', 'accept:is-pending'],
    );
    assert.equal(steps[0]!.querySelector('.sp-step__side')?.textContent, 'Redo');
    assert.equal(steps[2]!.querySelector('.sp-step__side')?.textContent, 'Skip');
    assert.equal(steps[3]!.querySelector('.sp-step__side'), null);
  });

  // ── Run: activity ──────────────────────────────────────────────────────────

  test('activity shows the request, each stage step, and the user decisions between them', async () => {
    installWindow();
    const t0 = superPlanRunView('drafting').createdAt!;
    const { view, root } = mountRun('drafting', {
      transcripts: [
        { key: 'interview-1', stage: 'interview', iteration: 1, label: 'Interview', attempts: 1, live: false, startedAt: t0 + 1_000, endedAt: t0 + 50_000, outcome: 'ok' },
        { key: 'draft-1', stage: 'draft', iteration: 1, label: 'Draft', attempts: 1, live: true, startedAt: t0 + 180_000 },
      ],
      timeline: [{ at: t0 + 90_000, kind: 'checkpoint', label: 'You confirmed the spec' }],
    });
    const feed = root.querySelector<HTMLElement>('.sp-feed')!;
    assert.match(feed.querySelector('.sp-feed__request')?.textContent ?? '', /Add offline queueing/);
    const labels = [...feed.children].map((n) => n.querySelector('.sp-feed__label, .sp-feed__notelabel')?.textContent);
    assert.deepEqual(labels, ['Your request', 'Interview', 'You confirmed the spec', 'Research', 'Draft']);
    const live = feed.querySelector<HTMLDetailsElement>('.sp-feed__stage.is-live')!;
    assert.equal(live.open, true, 'the running step is open');
    assert.equal(feed.querySelector<HTMLDetailsElement>('.sp-feed__stage:not(.is-live)')!.open, false);
    await waitFor(() => /Read the sync layer/.test(live.textContent ?? ''));
    assert.ok(requests.some((r) => r.url === `/api/super-plan/${view.runId}/transcripts/draft-1`));
  });
});
