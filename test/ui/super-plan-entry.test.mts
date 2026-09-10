import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';

import { installHappyDomGlobals } from '../os/dom-helpers.mts';
import {
  closeSuperPlanScreen,
  isSuperPlanScreenOpen,
  openSuperPlanScreen,
  resetSuperPlanEntryForTests,
  toggleSuperPlanScreenFromTopbar,
} from '../../src/ui/super-plan-entry.ts';
import {
  getOrchestratePlanScreenSession,
  resetOrchestratePlanScreenForTests,
} from '../../src/ui/orchestrate-plan-screen.ts';
import { SUPER_PLAN_PAGE_ROOT_ID } from '../../src/ui/super-plan-page.ts';
import { createInitialSuperPlanStages } from '../helpers/super-plan-fixture.ts';
import { createEmptyChatObject, setSessionStateForTests } from '../../src/state/sessions.ts';
import type { Chat } from '../../src/types.ts';

let activeWindow: Window | undefined;
const originalFetch = globalThis.fetch;

/** Code shell reduced to the nodes the surface and its chrome touch. */
function installShellDom(): void {
  activeWindow?.close();
  const window = new Window();
  activeWindow = window;
  installHappyDomGlobals(window);
  // `switchChat` broadcasts the sidebar change on window; happy-dom rejects an
  // event built from a different realm's constructor.
  const g = globalThis as unknown as { CustomEvent: unknown; Event: unknown };
  g.CustomEvent = window.CustomEvent;
  g.Event = window.Event;
  globalThis.fetch = (async () => new Response('{}', { status: 404 })) as typeof fetch;

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

/** Super-plan chat parked mid-pipeline, the way an interrupted run persists. */
function makeLiveSuperPlanChat(): Chat {
  const chat = createEmptyChatObject('live');
  chat.modeId = 'super-plan';
  const stages = createInitialSuperPlanStages();
  stages.research.status = 'running';
  stages.research.startedAt = Date.now() - 60_000;
  chat.superPlanRunId = 'fixture';
  chat.superPlanView = {
    runId: 'fixture', stage: 'research', stageIndex: 3, stageTotal: 7, state: 'running', finished: false, atMs: 1,
    slug: 'oauth',
    prompt: 'Add OAuth login',
    activeStage: 'research',
    stages,
    uiInvolved: false,
  };
  return chat;
}

function seed(chats: Chat[], activeId: string): void {
  setSessionStateForTests({
    version: 5,
    activeId,
    sidebarCollapsed: false,
    chats,
  });
}

describe('super plan top-bar entry', () => {
  afterEach(async () => {
    resetSuperPlanEntryForTests();
    resetOrchestratePlanScreenForTests();
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
    assert.equal(
      document.getElementById('btnSuperPlan')?.getAttribute('aria-pressed'),
      'true',
    );
    assert.equal(
      document.documentElement.classList.contains('mn-super-plan-open'),
      true,
      'one list only: the surface carries its own rail of plans',
    );
  });

  test('closing returns to the chat that was foreground', async () => {
    installShellDom();
    const chat = createEmptyChatObject('general');
    chat.history.push({ role: 'user', content: 'Hello from a normal chat' });
    seed([chat, makeEmptySuperPlanChat()], chat.id);

    await openSuperPlanScreen();
    await closeSuperPlanScreen();

    assert.equal(document.getElementById(SUPER_PLAN_PAGE_ROOT_ID), null);
    assert.equal(
      document.documentElement.classList.contains('mn-super-plan-open'),
      false,
    );
    assert.equal(
      document.getElementById('btnSuperPlan')?.getAttribute('aria-pressed'),
      'false',
    );
    assert.match(
      document.getElementById('chatArea')?.textContent ?? '',
      /Hello from a normal chat/,
    );
  });

  test('a pipeline still in flight outranks a blank composer', async () => {
    installShellDom();
    const chat = createEmptyChatObject('general');
    const live = makeLiveSuperPlanChat();
    seed([chat, makeEmptySuperPlanChat(), live], chat.id);

    await openSuperPlanScreen();

    assert.equal(
      getOrchestratePlanScreenSession()?.chatId,
      live.id,
      'a 20-minute run must never hide behind a new-plan composer',
    );
  });

  test('preferNew skips the last session and any live run', async () => {
    installShellDom();
    const chat = createEmptyChatObject('general');
    const live = makeLiveSuperPlanChat();
    const spare = makeEmptySuperPlanChat();
    seed([chat, spare, live], chat.id);

    // Seed a prior plan-screen session the same way a previous visit would.
    const { renderOrchestratePlanScreen } = await import(
      '../../src/ui/orchestrate-plan-screen.ts'
    );
    renderOrchestratePlanScreen({
      phase: 'super-plan-working',
      chatId: live.id,
      savedPrompt: live.superPlanView?.prompt,
    });
    assert.equal(getOrchestratePlanScreenSession()?.chatId, live.id);

    await openSuperPlanScreen({ preferNew: true });

    const session = getOrchestratePlanScreenSession();
    assert.ok(session, 'plan-screen session should exist');
    assert.notEqual(
      session?.chatId,
      live.id,
      'Make a plan must open a blank composer, not the last or live run',
    );
    assert.equal(session?.phase, 'prompt');
  });

  test('preferNew never reuses a live Super Plan chat as the composer', async () => {
    installShellDom();
    const chat = createEmptyChatObject('general');
    const live = makeLiveSuperPlanChat();
    // Empty history is what the old finder treated as a spare composer.
    assert.equal(live.history.length, 0);
    seed([chat, live], chat.id);

    await openSuperPlanScreen({ preferNew: true });

    const session = getOrchestratePlanScreenSession();
    assert.notEqual(session?.chatId, live.id);
    assert.equal(session?.phase, 'prompt');
    assert.ok(live.superPlanView, 'the prior run stays attached to its own chat');
    assert.equal(live.superPlanView?.prompt, 'Add OAuth login');
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

  test('the shell hides the session list but not the Chats control while the surface is up', () => {
    const css = readFileSync(
      new URL('../../src/styles/super-plan-page.css', import.meta.url),
      'utf8',
    );
    const rule = css.slice(
      css.indexOf('html.mn-super-plan-open #chatSidebar'),
      css.indexOf('}', css.indexOf('html.mn-super-plan-open #chatSidebar')),
    );
    assert.ok(rule.includes('#chatSidebar'), '#chatSidebar should be hidden with the surface');
    assert.ok(!rule.includes('#btnCodeViewsChats'), 'Chats toggle should stay visible');
  });
});
