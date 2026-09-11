import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import {
  closeSuperPlanScreen,
  isSuperPlanScreenOpen,
  isSuperPlanScreenShowingChat,
  openSuperPlanScreen,
  reopenSuperPlanScreenForChat,
  resetSuperPlanEntryForTests,
  shouldRouteComposerSendToSuperPlan,
  startSuperPlanFromComposer,
  teardownSuperPlanScreen,
  toggleSuperPlanScreenFromTopbar,
} from '../../src/ui/super-plan-entry.ts';
import { resetOrchestratePlanScreenForTests } from '../../src/ui/orchestrate-plan-screen.ts';
import { SUPER_PLAN_PAGE_ROOT_ID, getSuperPlanPageView } from '../../src/ui/super-plan-page.ts';
import { resetSuperPlanStoreForTests } from '../../src/chat/super-plan/store.ts';
import { attachSuperPlanRun, superPlanRunView } from '../helpers/super-plan-fixture.ts';
import { createEmptyChatObject, findChatById, sessionState, setSessionStateForTests } from '../../src/state/sessions.ts';
import type { Chat } from '../../src/types.ts';

let activeWindow: Window | undefined;
const originalFetch = globalThis.fetch;

/** Code shell reduced to the nodes the surface and its chrome touch. */
function installShellDom(fetchImpl?: typeof fetch): void {
  activeWindow?.close();
  const window = new Window();
  activeWindow = window;
  installHappyDomGlobals(window);
  // `switchChat` broadcasts the sidebar change on window; happy-dom rejects an
  // event built from a different realm's constructor.
  const g = globalThis as unknown as { CustomEvent: unknown; Event: unknown };
  g.CustomEvent = window.CustomEvent;
  g.Event = window.Event;
  globalThis.fetch = fetchImpl ?? ((async () => new Response('{}', { status: 404 })) as typeof fetch);

  const sidebar = document.createElement('aside');
  sidebar.id = 'chatSidebar';
  sidebar.className = 'chat-sidebar';
  document.body.appendChild(sidebar);

  const views = document.createElement('nav');
  views.className = 'code-views';
  views.innerHTML =
    '<button type="button" class="code-views__btn" id="btnCodeViewsChats" aria-pressed="false"></button>' +
    '<button type="button" class="code-views__btn" id="btnSuperPlan" aria-pressed="false"></button>';
  document.body.appendChild(views);

  const mainColumn = document.createElement('div');
  mainColumn.id = 'mainColumn';
  const viewport = document.createElement('div');
  viewport.className = 'chat-viewport';
  const area = document.createElement('main');
  area.id = 'chatArea';
  viewport.appendChild(area);
  mainColumn.appendChild(viewport);
  document.body.appendChild(mainColumn);
}

function makeEmptySuperPlanChat(): Chat {
  const chat = createEmptyChatObject('spare');
  chat.modeId = 'super-plan';
  return chat;
}

function makeRunChat(scenario: Parameters<typeof attachSuperPlanRun>[1], atMs = 1): Chat {
  const chat = createEmptyChatObject('live');
  attachSuperPlanRun(chat, scenario, { updatedAt: atMs });
  return chat;
}

function seed(chats: Chat[], activeId: string): void {
  setSessionStateForTests({ version: 5, activeId, sidebarCollapsed: false, chats });
}

describe('super plan top-bar entry', () => {
  afterEach(async () => {
    resetSuperPlanEntryForTests();
    resetOrchestratePlanScreenForTests();
    resetSuperPlanStoreForTests();
    activeWindow?.close();
    activeWindow = undefined;
    setSessionStateForTests(null);
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => setImmediate(resolve));
  });

  test('the Code view bar carries a Super Plan button beside Orchestrate', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    const bar = html.slice(
      html.indexOf('<nav class="code-views"'),
      html.indexOf('</nav>', html.indexOf('<nav class="code-views"')),
    );
    assert.ok(bar.includes('id="btnSuperPlan"'), 'button lives in the view bar');
    assert.ok(
      bar.indexOf('id="btnSuperPlan"') < bar.indexOf('id="btnOrchestrate"'),
      'plan before orchestrate: the bar reads in the order the work happens',
    );
  });

  test('opening mounts the surface and hides the chat list', async () => {
    installShellDom();
    const chat = createEmptyChatObject('general');
    chat.history.push({ role: 'user', content: 'Hello from a normal chat' });
    seed([chat, makeEmptySuperPlanChat()], chat.id);

    await openSuperPlanScreen();

    assert.ok(document.getElementById(SUPER_PLAN_PAGE_ROOT_ID));
    assert.equal(isSuperPlanScreenOpen(), true);
    assert.equal(getSuperPlanPageView()?.mode, 'compose');
    assert.equal(document.getElementById('btnSuperPlan')?.getAttribute('aria-pressed'), 'true');
    assert.equal(
      document.documentElement.classList.contains('mn-super-plan-open'),
      true,
      'one list only: the surface carries its own rail of plans',
    );
    assert.ok(document.getElementById('chatArea')?.classList.contains('chat-area--super-plan'));
  });

  test('closing returns to the chat that was foreground', async () => {
    installShellDom();
    const chat = createEmptyChatObject('general');
    chat.history.push({ role: 'user', content: 'Hello from a normal chat' });
    seed([chat, makeEmptySuperPlanChat()], chat.id);

    await openSuperPlanScreen();
    await closeSuperPlanScreen();

    assert.equal(document.getElementById(SUPER_PLAN_PAGE_ROOT_ID), null);
    assert.equal(document.documentElement.classList.contains('mn-super-plan-open'), false);
    assert.equal(document.getElementById('btnSuperPlan')?.getAttribute('aria-pressed'), 'false');
    assert.equal(document.getElementById('chatArea')?.classList.contains('chat-area--super-plan'), false);
    assert.match(document.getElementById('chatArea')?.textContent ?? '', /Hello from a normal chat/);
  });

  test('a run in flight outranks a blank composer', async () => {
    installShellDom();
    const chat = createEmptyChatObject('general');
    const live = makeRunChat('drafting');
    seed([chat, makeEmptySuperPlanChat(), live], chat.id);

    await openSuperPlanScreen();

    const view = getSuperPlanPageView();
    assert.equal(view?.chatId, live.id, 'a 20-minute run must never hide behind a new-plan composer');
    assert.equal(view?.mode, 'run');
  });

  test('a run that needs the user outranks a newer one that is still working', async () => {
    installShellDom();
    const general = createEmptyChatObject('general');
    const working = makeRunChat('drafting', 5_000);
    const waiting = makeRunChat('accept', 1_000);
    seed([general, working, waiting], general.id);

    await openSuperPlanScreen();

    assert.equal(getSuperPlanPageView()?.chatId, waiting.id);
  });

  test('preferNew opens a blank composer, never the live run', async () => {
    installShellDom();
    const chat = createEmptyChatObject('general');
    const live = makeRunChat('drafting');
    const spare = makeEmptySuperPlanChat();
    seed([chat, spare, live], chat.id);

    await openSuperPlanScreen({ preferNew: true });

    const view = getSuperPlanPageView();
    assert.equal(view?.mode, 'compose');
    assert.notEqual(view?.chatId, live.id);
    assert.equal(view?.chatId, spare.id, 'an empty Super Plan chat is reused as the composer');
  });

  test('preferNew never reuses a live Super Plan chat as the composer', async () => {
    installShellDom();
    const chat = createEmptyChatObject('general');
    const live = makeRunChat('question');
    assert.equal(live.history.length, 0, 'a run chat has no transcript of its own');
    seed([chat, live], chat.id);

    await openSuperPlanScreen({ preferNew: true });

    const view = getSuperPlanPageView();
    assert.equal(view?.mode, 'compose');
    assert.notEqual(view?.chatId, live.id);
    assert.equal(findChatById(live.id)?.superPlanRunId, `run-${live.id}`, 'the run stays attached to its own chat');
  });

  test('foregrounding a Super Plan chat shows its run; a chat without one shows the composer', async () => {
    installShellDom();
    const run = makeRunChat('reviewing');
    const spare = makeEmptySuperPlanChat();
    seed([run, spare], run.id);

    reopenSuperPlanScreenForChat(run);
    assert.deepEqual(getSuperPlanPageView(), { mode: 'run', chatId: run.id, runId: `run-${run.id}` });
    assert.equal(isSuperPlanScreenShowingChat(run.id), true);

    reopenSuperPlanScreenForChat(spare);
    assert.deepEqual(getSuperPlanPageView(), { mode: 'compose', chatId: spare.id });
    assert.equal(document.querySelectorAll(`#${SUPER_PLAN_PAGE_ROOT_ID}`).length, 1, 'the page is reused, not stacked');
  });

  test('teardown clears the surface even when #chatArea was replaced under it', async () => {
    installShellDom();
    const run = makeRunChat('drafting');
    seed([run], run.id);
    reopenSuperPlanScreenForChat(run);
    document.getElementById('chatArea')!.replaceChildren();

    teardownSuperPlanScreen();

    assert.equal(getSuperPlanPageView(), null);
    assert.equal(document.documentElement.classList.contains('mn-super-plan-open'), false);
  });

  test('closing when every chat is a plan lands on a fresh chat instead of bouncing back', async () => {
    installShellDom();
    const run = makeRunChat('done');
    seed([run], run.id);

    await openSuperPlanScreen();
    assert.equal(isSuperPlanScreenOpen(), true);
    await closeSuperPlanScreen();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(isSuperPlanScreenOpen(), false, 'the surface stays closed');
    assert.equal(document.documentElement.classList.contains('mn-super-plan-open'), false);
    const active = sessionState?.chats.find((c) => c.id === sessionState?.activeId);
    assert.notEqual(active?.modeId, 'super-plan', 'a regular chat is foreground');
    assert.equal(run.superPlanRunId, `run-${run.id}`, 'the plan chat keeps its run');
  });

  test('the button toggles the surface', async () => {
    installShellDom();
    const chat = createEmptyChatObject('general');
    chat.history.push({ role: 'user', content: 'Hello from a normal chat' });
    seed([chat, makeEmptySuperPlanChat()], chat.id);

    await toggleSuperPlanScreenFromTopbar();
    assert.equal(isSuperPlanScreenOpen(), true);

    await toggleSuperPlanScreenFromTopbar();
    assert.equal(isSuperPlanScreenOpen(), false);
  });

  test('composer sends in a Super Plan chat start a plan, text only', () => {
    const chat = makeEmptySuperPlanChat();
    const base = { userText: 'Add offline sync', skillId: null, attachmentCount: 0 };
    assert.equal(shouldRouteComposerSendToSuperPlan(chat, base), true);
    assert.equal(shouldRouteComposerSendToSuperPlan(chat, { ...base, userText: '  ' }), false);
    assert.equal(shouldRouteComposerSendToSuperPlan(chat, { ...base, skillId: 'impeccable' }), false);
    assert.equal(shouldRouteComposerSendToSuperPlan(chat, { ...base, attachmentCount: 1 }), false);
    const general = createEmptyChatObject('general');
    assert.equal(shouldRouteComposerSendToSuperPlan(general, base), false);
  });

  test('a new plan from a chat that already owns a run takes a fresh chat', async () => {
    const posts: Array<Record<string, any>> = [];
    installShellDom((async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/super-plan' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        posts.push(body);
        return Response.json({ ok: true, view: superPlanRunView('interviewing', { runId: 'run-second', chatId: body.chatId }) });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch);
    const first = makeRunChat('drafting');
    seed([first], first.id);

    await startSuperPlanFromComposer(first, 'Plan the export feature');

    assert.equal(posts.length, 1);
    assert.notEqual(posts[0]?.chatId, first.id, 'the first run keeps its chat');
    assert.equal(first.superPlanRunId, `run-${first.id}`);
    const second = sessionState?.chats.find((c) => c.superPlanRunId === 'run-second');
    assert.ok(second, 'the new run lives in its own chat');
    assert.equal(second?.modeId, 'super-plan');
    assert.deepEqual(getSuperPlanPageView(), { mode: 'run', chatId: second!.id, runId: 'run-second' });
  });

  test('the shell hides the session list but not the Chats control while the surface is up', () => {
    const css = readFileSync(new URL('../../src/styles/super-plan-page.css', import.meta.url), 'utf8');
    const rule = css.slice(
      css.indexOf('html.mn-super-plan-open #chatSidebar'),
      css.indexOf('}', css.indexOf('html.mn-super-plan-open #chatSidebar')),
    );
    assert.ok(rule.includes('#chatSidebar'), '#chatSidebar should be hidden with the surface');
    assert.ok(!rule.includes('#btnCodeViewsChats'), 'Chats toggle should stay visible');
  });

  test('no looping animation on the surface: runs are long and animation costs local tokens/s', () => {
    const css = readFileSync(new URL('../../src/styles/super-plan-page.css', import.meta.url), 'utf8');
    assert.equal(/animation\s*:/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), false);
  });
});
