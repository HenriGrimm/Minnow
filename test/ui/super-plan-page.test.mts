import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

import {
  buildSuperPlanPageDom,
  seedSuperPlanLedgerForTests,
  syncSuperPlanPage,
  teardownSuperPlanPage,
  type SuperPlanPageHandlers,
} from '../../src/ui/super-plan-page.ts';
import {
  collectSuperPlanRuns,
  formatRelativeTime,
  groupPlanLibraryEntries,
  titleFromPlanPath,
  type PlanLibraryEntry,
} from '../../src/chat/super-plan/plan-library.ts';
import {
  createInitialSuperPlanStages,
  hydrateFixture,
  initSuperPlanState,
  markSuperPlanStageStatus,
  setSuperPlanActiveStage,
} from '../helpers/super-plan-fixture.ts';
import { createEmptyChatObject, setSessionStateForTests } from '../../src/state/sessions.ts';
import { resetWorkspaceStateForTests, setWorkspaceFromServer } from '../../src/state/workspace.ts';
import type { Chat } from '../../src/types.ts';
import { streamingChatIds } from '../../src/app-state.ts';
import {
  ActivityLogBuffer,
  type ActivityLogEntry,
} from '../../src/research/activity-log.ts';
import { PlanActivityCollector } from '../../src/ui/plan-activity-collector.ts';
import {
  notifySuperPlanControllerForTests,
  pauseSuperPlan,
  resetSuperPlanControllerForTests,
} from '../helpers/super-plan-fixture.ts';

let activeWindow: Window | undefined;
/** Restored after this file so a 404 stub cannot leak into later tests in the worker. */
const originalFetch = globalThis.fetch;

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for condition');
}

function installTestWindow(): void {
  activeWindow?.close();
  const window = new Window();
  activeWindow = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.HTMLButtonElement = window.HTMLButtonElement;
  globalThis.HTMLTextAreaElement = window.HTMLTextAreaElement;
  stubPreviewFetch(async () => new Response('', { status: 404 }));
}

/** Stub `globalThis.fetch` so preview reads cannot hang the test process. */
function stubPreviewFetch(handler: typeof fetch): void {
  globalThis.fetch = handler;
}

/** `resolvePreviewLoadUrl` reads `window.location.origin` — not the happy-dom window. */
function stubPreviewOrigin(): void {
  globalThis.window = { location: { origin: 'http://localhost:9473' } } as typeof globalThis.window;
}

const calls: string[] = [];

function stubHandlers(): SuperPlanPageHandlers {
  const record =
    (name: string) =>
    (...args: unknown[]): void => {
      calls.push(args.length ? `${name}:${String(args[0])}` : name);
    };
  return {
    onStart: record('onStart'),
    onPause: record('onPause'),
    onResume: record('onResume'),
    onStop: record('onStop'),
    onSkipInterview: record('onSkipInterview'),
    onConfirmSpec: record('onConfirmSpec'),
    onReviseSpec: record('onReviseSpec'),
    onRetryStage: record('onRetryStage'),
    onSkipStage: record('onSkipStage'),
    onCancelPipeline: record('onCancelPipeline'),
    onRework: record('onRework'),
    onOrchestrate: record('onOrchestrate'),
    onBuild: record('onBuild'),
    onRevisePlan: record('onRevisePlan'),
    onSelectRun: record('onSelectRun'),
    onOpenPlanFile: record('onOpenPlanFile'),
    onNewPlan: record('onNewPlan'),
    onDeleteEntry: record('onDeleteEntry'),
  };
}

/** Super-plan chat parked on `activeStage`, with everything before it done. */
function makeRunChat(
  id: string,
  activeStage: Parameters<typeof createInitialSuperPlanStages> extends never
    ? never
    : Chat['superPlanView'] extends { activeStage: infer S } | undefined
      ? S
      : never,
  overrides: Partial<NonNullable<Chat['superPlanView']>> = {},
): Chat {
  const chat = createEmptyChatObject(id);
  chat.modeId = 'super-plan';
  const stages = createInitialSuperPlanStages();
  chat.superPlanView = {
    slug: 'offline-queue',
    prompt: 'Add offline queueing to the sync layer',
    activeStage,
    stages,
    ...overrides,
  };
  return chat;
}

function mountPage(chat: Chat, mode: 'compose' | 'run' = 'run'): HTMLElement {
  hydrateFixture(chat);
  setSessionStateForTests({
    version: 5,
    activeId: chat.id,
    sidebarCollapsed: false,
    chats: [chat],
  });
  const root = buildSuperPlanPageDom({ chatId: chat.id, mode, handlers: stubHandlers() });
  document.body.appendChild(root);
  return root;
}

function textOf(root: ParentNode, selector: string): string {
  return (root.querySelector(selector)?.textContent ?? '').trim();
}

// ── super plan page ──────────────────────────────────────────────────────────

describe('super plan page', () => {
  after(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    streamingChatIds.clear();
    teardownSuperPlanPage();
    calls.length = 0;
    setSessionStateForTests(null);
    Reflect.deleteProperty(globalThis, 'window');
    activeWindow?.close();
    activeWindow = undefined;
    globalThis.fetch = originalFetch;
  });

  test('pipeline column lists every stage and marks the running one', () => {
    installTestWindow();
    const chat = makeRunChat('sp1', 'research');
    chat.superPlanView!.stages.grill.status = 'done';
    chat.superPlanView!.stages.grill.startedAt = 1_000;
    chat.superPlanView!.stages.grill.finishedAt = 61_000;
    chat.superPlanView!.stages.spec_confirm.status = 'done';
    chat.superPlanView!.stages.research.status = 'running';
    chat.superPlanView!.stages.research.startedAt = Date.now();
    // Without an in-flight turn the controller reports the run as stalled.
    streamingChatIds.add(chat.id);

    const root = mountPage(chat);
    syncSuperPlanPage(chat);

    const stages = [...root.querySelectorAll('.sp-stage')];
    assert.equal(stages.length, 7, 'five roles and two gates stay visible');
    assert.ok(stages[0]?.classList.contains('is-done'));
    assert.equal(textOf(stages[0]!, '.sp-stage__time'), '1:00');
    assert.ok(
      stages[2]?.classList.contains('is-running'),
      'the active stage reads as running',
    );
    assert.ok(
      stages[6]?.classList.contains('is-done') === false,
      'later stages are not marked done',
    );
  });

  test('a paused pipeline never renders a running stage', () => {
    installTestWindow();
    const chat = makeRunChat('sp2', 'draft1', { paused: true });
    chat.superPlanView!.stages.draft1.status = 'running';
    chat.superPlanView!.stages.draft1.startedAt = Date.now();

    const root = mountPage(chat);
    syncSuperPlanPage(chat);

    assert.equal(
      root.querySelectorAll('.sp-stage.is-running').length,
      0,
      'nothing breathes while the pipeline is standing still',
    );
    assert.equal(root.querySelectorAll('.sp-stage.is-halted').length, 1);
    assert.equal(textOf(root, '.sp-runhead__meta .sp-state'), 'paused');
  });

  test('completed stages offer rework, pending ones do not', () => {
    installTestWindow();
    const chat = makeRunChat('sp3', 'draft1');
    chat.superPlanView!.stages.grill.status = 'done';
    chat.superPlanView!.stages.spec_confirm.status = 'done';
    chat.superPlanView!.stages.research.status = 'done';

    const root = mountPage(chat);
    syncSuperPlanPage(chat);

    const clickable = [...root.querySelectorAll('.sp-stage--clickable')];
    assert.equal(clickable.length, 3);
    assert.equal(clickable[0]?.tagName, 'BUTTON');
    (clickable[0] as HTMLButtonElement).click();
    assert.deepEqual(calls, ['onRework:grill']);
  });

  test('spec checkpoint docks confirm and revise', () => {
    installTestWindow();
    const chat = makeRunChat('sp4', 'spec_confirm', {
      specPath: 'documentation/plans/references/offline-queue-spec.md',
    });
    chat.superPlanView!.stages.grill.status = 'done';
    chat.superPlanView!.stages.spec_confirm.status = 'blocked_user';
    chat.superPlanView!.stages.spec_confirm.artifactPath =
      'documentation/plans/references/offline-queue-spec.md';

    const root = mountPage(chat);
    syncSuperPlanPage(chat);

    const dock = root.querySelector('.sp-dock') as HTMLElement | null;
    assert.ok(dock);
    assert.equal(dock.hidden, false);
    const labels = [...dock.querySelectorAll('.sp-btn')].map((b) => b.textContent);
    assert.deepEqual(labels, ['Revise spec', 'Confirm spec']);
    assert.equal(textOf(root, '.sp-runhead__meta .sp-state'), 'needs you');
    assert.equal(
      (root.querySelector('[data-plan-action="pause"]') as HTMLElement | null)?.hidden,
      true,
      'there is nothing to pause while the pipeline waits on you',
    );
  });

  test('reserved spec and plan paths stay hidden until a stage writes the file', () => {
    installTestWindow();
    const chat = makeRunChat('sp-spec-reserved', 'grill', {
      specPath: 'documentation/plans/references/plan-aaaaaaaa-spec.md',
      planPath: 'documentation/plans/plan-aaaaaaaa.md',
      researchPath: 'documentation/plans/references/plan-aaaaaaaa-research.md',
    });
    chat.superPlanView!.stages.grill.status = 'running';

    const root = mountPage(chat);
    syncSuperPlanPage(chat);

    const specTab = [...root.querySelectorAll('.sp-segment')].find((node) =>
      (node.textContent ?? '').startsWith('Spec'),
    ) as HTMLElement;
    const planTab = [...root.querySelectorAll('.sp-segment')].find((node) =>
      (node.textContent ?? '').startsWith('Plan'),
    ) as HTMLElement;
    assert.equal(specTab.hidden, true, 'Spec tab waits for the written spec');
    assert.equal(planTab.hidden, true, 'Plan tab waits for a draft');
    assert.match(
      textOf(root, '.sp-artifact-list'),
      /Files appear here/,
      'reserved paths are not listed as artifacts',
    );
  });

  test('spec tab stays hidden while spec_confirm is still writing', () => {
    installTestWindow();
    const chat = makeRunChat('sp-spec-writing', 'spec_confirm', {
      specPath: 'documentation/plans/references/plan-aaaaaaaa-spec.md',
    });
    chat.superPlanView!.stages.grill.status = 'done';
    chat.superPlanView!.stages.spec_confirm.status = 'running';

    const root = mountPage(chat);
    syncSuperPlanPage(chat);

    const specTab = [...root.querySelectorAll('.sp-segment')].find((node) =>
      (node.textContent ?? '').startsWith('Spec'),
    ) as HTMLElement;
    assert.equal(specTab.hidden, true);
    assert.equal(
      root.querySelector('.sp-segment.is-on')?.textContent?.startsWith('Activity'),
      true,
    );
  });

  test('spec checkpoint loads the build spec markdown into the reading column', async () => {
    installTestWindow();
    stubPreviewOrigin();
    const specPath = 'documentation/plans/references/offline-queue-spec.md';
    const specBody = '# Offline queue\n\nDurable writes when the network returns.\n';
    stubPreviewFetch(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.includes('offline-queue-spec.md')) {
        return new Response('missing', { status: 404 });
      }
      return new Response(specBody, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    });

    const chat = makeRunChat('sp-spec-body', 'spec_confirm', { specPath });
    chat.superPlanView!.stages.grill.status = 'done';
    chat.superPlanView!.stages.spec_confirm.status = 'blocked_user';
    chat.superPlanView!.stages.spec_confirm.artifactPath = specPath;

    const root = mountPage(chat);
    syncSuperPlanPage(chat);

    await waitFor(() => (root.querySelector('.sp-doc')?.textContent ?? '').includes('Offline queue'));
    const doc = root.querySelector('.sp-doc') as HTMLElement;
    assert.equal(doc.hidden, false);
    assert.match(doc.textContent ?? '', /Offline queue/);
  });

  test('empty first spec preview is retried until the file is readable (MIN-672)', async () => {
    installTestWindow();
    stubPreviewOrigin();
    const specPath = 'documentation/plans/references/offline-queue-spec.md';
    const specBody = '# Offline queue\n\nDurable writes when the network returns.\n';
    let hits = 0;
    stubPreviewFetch(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.includes('offline-queue-spec.md')) {
        return new Response('missing', { status: 404 });
      }
      hits += 1;
      if (hits === 1) return new Response('', { status: 404 });
      return new Response(specBody, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    });

    const chat = makeRunChat('sp-spec-race', 'spec_confirm', { specPath });
    chat.superPlanView!.stages.grill.status = 'done';
    chat.superPlanView!.stages.spec_confirm.status = 'blocked_user';
    chat.superPlanView!.stages.spec_confirm.artifactPath = specPath;

    const root = mountPage(chat);
    syncSuperPlanPage(chat);

    await waitFor(() => (root.querySelector('.sp-doc')?.textContent ?? '').includes('Offline queue'));
    assert.ok(hits >= 2, 'a 404 that races the save must not be cached as final');
    assert.equal((root.querySelector('.sp-doc') as HTMLElement).hidden, false);
  });

  test('a failed stage keeps earlier work and offers retry, skip, cancel', () => {
    installTestWindow();
    const chat = makeRunChat('sp5', 'review1');
    chat.superPlanView!.stages.grill.status = 'done';
    chat.superPlanView!.stages.draft1.status = 'done';
    chat.superPlanView!.stages.review1.status = 'error';
    chat.superPlanView!.stages.review1.error = 'Plan reviewer timed out.';

    const root = mountPage(chat);
    syncSuperPlanPage(chat);

    assert.match(textOf(root, '.sp-notice'), /Plan reviewer timed out/);
    assert.ok(root.querySelector('.sp-notice--error'));
    const labels = [...root.querySelectorAll('.sp-dock .sp-btn')].map((b) => b.textContent);
    assert.deepEqual(labels, ['Cancel pipeline', 'Skip Review', 'Retry Review']);
    assert.ok(root.querySelector('.sp-stage.is-error'));
    assert.ok(root.querySelector('.sp-stage.is-done'), 'earlier stages are kept');
  });

  test('ledger renders buffered activity once and keeps arrival order', () => {
    installTestWindow();
    const chat = makeRunChat('sp6', 'research');
    const root = mountPage(chat);
    syncSuperPlanPage(chat);

    seedSuperPlanLedgerForTests([
      { id: 'e1', atMs: 1_000, kind: 'stage', label: 'Stage', detail: 'Research · running' },
      {
        id: 'e2',
        atMs: 2_000,
        kind: 'phase',
        label: 'Searching',
        detail: 'round 1 · 2 queries',
        queries: ['durable write queue', 'replay ordering'],
      },
      {
        id: 'e3',
        atMs: 3_000,
        kind: 'warning',
        label: 'Warning',
        detail: 'One source returned 403',
        tone: 'warning',
      },
    ]);

    const ids = () =>
      [...root.querySelectorAll('.sp-entry')].map((e) => (e as HTMLElement).dataset.entryId);

    // The live collector seeds its own opening stage row, so assert on the
    // rows this test appended rather than on the total.
    assert.deepEqual(
      ids().filter((id) => id?.startsWith('e')),
      ['e1', 'e2', 'e3'],
    );
    assert.equal(root.querySelectorAll('.sp-entry__queries li').length, 2);
    assert.ok(
      root.querySelector('[data-entry-id="e3"]')?.classList.contains('sp-entry--warning'),
    );
    assert.equal(
      textOf(root, '.sp-segment .sp-segment__count'),
      String(root.querySelectorAll('.sp-entry').length),
    );

    // A repaint must not duplicate rows that are already on screen.
    const before = ids().length;
    syncSuperPlanPage(chat);
    assert.equal(root.querySelectorAll('.sp-entry').length, before);
  });

  test('retarget clears the prior run ledger from the DOM', () => {
    installTestWindow();
    const first = makeRunChat('sp-retarget-a', 'research');
    const second = makeRunChat('sp-retarget-b', 'grill');
    setSessionStateForTests({
      version: 5,
      activeId: first.id,
      sidebarCollapsed: false,
      chats: [first, second],
    });
    const root = buildSuperPlanPageDom({
      chatId: first.id,
      mode: 'run',
      handlers: stubHandlers(),
    });
    document.body.appendChild(root);
    seedSuperPlanLedgerForTests([
      { id: 'old-run', atMs: 1_000, kind: 'stage', label: 'Stage', detail: 'Research · running' },
    ]);
    assert.ok(root.querySelector('[data-entry-id="old-run"]'));

    syncSuperPlanPage(second);

    assert.equal(
      root.querySelector('[data-entry-id="old-run"]'),
      null,
      'switching plans must not leave the previous Activity rows painted',
    );
  });

  test('composer offers the pipeline chips and refuses an empty prompt', () => {
    installTestWindow();
    const chat = makeRunChat('sp7', 'grill');
    chat.superPlanView = undefined;
    const root = mountPage(chat, 'compose');

    const chips = [...root.querySelectorAll('.sp-chip')].map((c) => c.textContent ?? '');
    assert.equal(chips.length, 4);
    assert.ok(chips.some((c) => c.startsWith('Interview')));
    assert.ok(chips.some((c) => c.startsWith('Research')));
    assert.ok(chips.some((c) => /review/i.test(c)));
    assert.ok(chips.some((c) => c.startsWith('UI pass')));

    const send = root.querySelector('.sp-send') as HTMLButtonElement;
    assert.equal(send.disabled, true, 'send stays off until there is a prompt');
    send.click();
    assert.deepEqual(calls, [], 'an empty prompt never starts a run');

    const field = root.querySelector('.sp-composer__field') as HTMLTextAreaElement;
    field.value = 'Add offline queueing';
    field.dispatchEvent(new activeWindow!.Event('input', { bubbles: true }));
    assert.equal(send.disabled, false);
    send.click();
    assert.deepEqual(calls, ['onStart:Add offline queueing']);
    assert.equal(field.dataset.composerAutoResizeWired, '1');
    assert.equal(field.spellcheck, false);
  });

  test('composer CSS grows with content like the chat composer', () => {
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../src/styles/super-plan-page.css'),
      'utf8',
    );
    assert.match(css, /\.sp-composer__field\s*\{[^}]*field-sizing:\s*content/);
    assert.match(css, /\.sp-composer__field\s*\{[^}]*max-height:\s*min\(40vh,\s*320px\)/);
  });

  test('seed chips fill the composer through the input event', () => {
    installTestWindow();
    const chat = makeRunChat('sp-seed', 'grill');
    chat.superPlanView = undefined;
    const root = mountPage(chat, 'compose');

    const field = root.querySelector('.sp-composer__field') as HTMLTextAreaElement;
    const send = root.querySelector('.sp-send') as HTMLButtonElement;
    const seed = root.querySelector('.sp-seed') as HTMLButtonElement;
    assert.equal(send.disabled, true);
    seed.click();
    assert.equal(field.value, seed.textContent);
    assert.equal(send.disabled, false);
  });

  test('compose surface mounts a per-chat model picker', () => {
    installTestWindow();
    document.body.innerHTML =
      '<select id="modelSelect"><option value="lm/qwen">Qwen — LM Studio</option></select>';
    const chat = makeRunChat('sp-model', 'grill');
    chat.superPlanView = undefined;
    const root = mountPage(chat, 'compose');

    const anchor = root.querySelector('#superPlanComposerModelAnchor');
    assert.ok(anchor, 'model anchor');
    assert.ok(
      anchor?.querySelector('.composer-model-trigger-wrap--super-plan'),
      'super-plan model trigger',
    );
    teardownSuperPlanPage();
  });

  test('.sp-opts must not clip popovers with overflow-x auto', () => {
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../src/styles/super-plan-page.css'),
      'utf8',
    );
    const blocks = [...css.matchAll(/\.sp-opts\s*\{[^}]+\}/g)].map((match) => match[0]);
    assert.ok(blocks.length > 0, '.sp-opts rule exists');
    assert.ok(
      blocks.some((block) => /overflow:\s*visible/.test(block)),
      'main chip row keeps overflow visible',
    );
    assert.ok(
      blocks.every((block) => !/overflow-x:\s*auto/.test(block)),
      'no .sp-opts block may scroll horizontally',
    );
  });

  test('Interview chip label updates on the first input event', () => {
    installTestWindow();
    const chat = makeRunChat('sp-interview-chip', 'grill');
    chat.superPlanView = undefined;
    const root = mountPage(chat, 'compose');

    const interviewChip = root.querySelector('#spChip-interview') as HTMLButtonElement;
    assert.ok(interviewChip);
    interviewChip.click();

    const budget = root.querySelector('.sp-pop:not([hidden]) input[type="number"]') as HTMLInputElement;
    assert.ok(budget);
    budget.value = '12';
    budget.dispatchEvent(new activeWindow!.Event('input', { bubbles: true }));

    assert.match(interviewChip.textContent ?? '', /Interview · 12/);

    const toggle = root.querySelector('.sp-pop:not([hidden]) input[type="checkbox"]') as HTMLInputElement;
    toggle.checked = false;
    toggle.dispatchEvent(new activeWindow!.Event('change', { bubbles: true }));
    assert.match(interviewChip.textContent ?? '', /Interview off/);
  });

  test('compose bar mounts Expand immediately before send', () => {
    installTestWindow();
    const chat = makeRunChat('sp-expand', 'grill');
    chat.superPlanView = undefined;
    const root = mountPage(chat, 'compose');

    const expand = root.querySelector('#btnSuperPlanExpand') as HTMLButtonElement;
    const send = root.querySelector('.sp-send') as HTMLButtonElement;
    assert.ok(expand);
    assert.ok(send);
    assert.equal(expand.nextElementSibling, send);
    assert.ok(expand.classList.contains('composer-expand-btn--bar'));
    assert.equal(expand.disabled, true);

    const field = root.querySelector('#superPlanPrompt') as HTMLTextAreaElement;
    field.value = 'Plan the sync layer';
    field.dispatchEvent(new activeWindow!.Event('input', { bubbles: true }));
    assert.equal(expand.disabled, false);
  });

  test('chip popovers open one at a time', () => {
    installTestWindow();
    const chat = makeRunChat('sp8', 'grill');
    chat.superPlanView = undefined;
    const root = mountPage(chat, 'compose');

    const chips = [...root.querySelectorAll('.sp-chip')] as HTMLButtonElement[];
    chips[0]!.click();
    assert.equal(chips[0]!.getAttribute('aria-expanded'), 'true');
    chips[1]!.click();
    assert.equal(chips[0]!.getAttribute('aria-expanded'), 'false');
    assert.equal(chips[1]!.getAttribute('aria-expanded'), 'true');
    assert.equal(root.querySelectorAll('.sp-pop:not([hidden])').length, 1);
  });
});

// ── super plan library ───────────────────────────────────────────────────────

describe('super plan library', () => {
  afterEach(() => {
    resetWorkspaceStateForTests();
    setSessionStateForTests(null);
  });

  test('collectSuperPlanRuns only includes chats in the requested workspace', () => {
    const wsA = '/tmp/workspace-a';
    const wsB = '/tmp/workspace-b';
    setWorkspaceFromServer({ path: wsA, label: 'A', isDefault: false });

    const chatA = makeRunChat('sp-ws-a', 'grill');
    chatA.workspacePath = wsA;
    const chatB = makeRunChat('sp-ws-b', 'research');
    chatB.workspacePath = wsB;

    setSessionStateForTests({
      version: 5,
      activeId: chatA.id,
      sidebarCollapsed: false,
      chats: [chatA, chatB],
    });

    const inA = collectSuperPlanRuns(wsA);
    assert.equal(inA.length, 1);
    assert.equal(inA[0]?.chatId, chatA.id);

    const inB = collectSuperPlanRuns(wsB);
    assert.equal(inB.length, 1);
    assert.equal(inB[0]?.chatId, chatB.id);
  });

  test('titles come from the plan slug', () => {
    assert.equal(
      titleFromPlanPath('documentation/plans/server-session-engine.md'),
      'Server session engine',
    );
    assert.equal(titleFromPlanPath('offline_queue.md'), 'Offline queue');
  });

  test('live runs group above history, stopped runs file by date', () => {
    const now = Date.UTC(2026, 7, 7, 12, 0, 0);
    const entry = (
      key: string,
      state: PlanLibraryEntry['state'],
      atMs: number,
    ): PlanLibraryEntry => ({
      key,
      path: `documentation/plans/${key}.md`,
      title: key,
      state,
      atMs,
      executable: true,
    });

    const groups = groupPlanLibraryEntries(
      [
        entry('running', 'running', now - 1000),
        entry('stopped', 'cancelled', now - 1000),
        entry('old', 'saved', now - 20 * 86_400_000),
      ],
      now,
    );

    assert.deepEqual(
      groups.map((g) => g.label),
      ['In progress', 'Today', 'Earlier'],
    );
    assert.deepEqual(groups[0]!.entries.map((e) => e.key), ['running']);
    assert.deepEqual(groups[1]!.entries.map((e) => e.key), ['stopped']);
    assert.deepEqual(groups[2]!.entries.map((e) => e.key), ['old']);
  });

  test('a library with no timestamps collapses to one group', () => {
    const rows: PlanLibraryEntry[] = [
      { key: 'a', path: 'a.md', title: 'a', state: 'saved', executable: false },
      { key: 'b', path: 'b.md', title: 'b', state: 'saved', executable: false },
    ];
    const groups = groupPlanLibraryEntries(rows, Date.now());
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.label, '');
  });

  test('relative time stays compact', () => {
    const now = Date.UTC(2026, 7, 7, 12, 0, 0);
    assert.equal(formatRelativeTime(now - 30_000, now), 'just now');
    assert.equal(formatRelativeTime(now - 5 * 60_000, now), '5m ago');
    assert.equal(formatRelativeTime(now - 3 * 3_600_000, now), '3h ago');
    assert.equal(formatRelativeTime(now - 2 * 86_400_000, now), '2d ago');
    assert.equal(formatRelativeTime(undefined, now), '');
  });
});

// ── super plan activity ──────────────────────────────────────────────────────
