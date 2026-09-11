import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, test } from 'node:test';
import { Window } from 'happy-dom';
import {
  ORCHESTRATE_PLAN_BANNER_ID,
  ORCHESTRATE_PLAN_SCREEN_PROMPT_ID,
  ORCHESTRATE_PLAN_SCREEN_QUESTIONS_ID,
  ORCHESTRATE_PLAN_SCREEN_ROOT_ID,
  getOrchestratePlanScreenSession,
  isOrchestratePlanScreenSuppressingChatDom,
  isOrchestratePlanScreenSuspended,
  buildRevisePlanComposerDraft,
  openOrchestratePlanScreen,
  renderOrchestratePlanScreen,
  resetOrchestratePlanScreenForTests,
  resolveOrchestratePlanScreenQuestionHost,
  suspendOrchestratePlanScreenOnLeave,
} from '../../src/ui/orchestrate-plan-screen.ts';
import { SUPER_PLAN_PAGE_ROOT_ID } from '../../src/ui/super-plan-page.ts';
import { switchChat } from '../../src/ui/sidebar.ts';
import { attachSuperPlanRun } from '../helpers/super-plan-fixture.ts';
import { resetSuperPlanEntryForTests } from '../../src/ui/super-plan-entry.ts';
import { resetSuperPlanStoreForTests } from '../../src/chat/super-plan/store.ts';
import { showQuestionCardsModal } from '../../src/ui/question-cards-modal.ts';
import { appendStreamingAssistantRow, renderChatFromHistory } from '../../src/ui/messages.ts';
import { isStreamDomVisible } from '../../src/chat/streaming-state.ts';
import { createEmptyChatObject, setSessionStateForTests } from '../../src/state/sessions.ts';

/** Test DOM matching Code chat: `.chat-viewport` > `#chatArea`. */
function mountCodeChatAreaForTests(): HTMLElement {
  const viewport = document.createElement('div');
  viewport.className = 'chat-viewport';
  const area = document.createElement('main');
  area.id = 'chatArea';
  viewport.appendChild(area);
  document.body.appendChild(viewport);
  return area;
}

let activeWindow: Window | undefined;
const originalFetch = globalThis.fetch;

function installTestWindow(): void {
  activeWindow?.close();
  const window = new Window();
  activeWindow = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  const rejectPreview: typeof fetch = async () => new Response('', { status: 404 });
  globalThis.fetch = rejectPreview;
}

describe('orchestrate plan screen', () => {
  afterEach(async () => {
    const { resetQuestionCardsModalForTests } = await import('../../src/ui/question-cards-modal.ts');
    resetQuestionCardsModalForTests();
    resetOrchestratePlanScreenForTests();
    resetSuperPlanEntryForTests();
    resetSuperPlanStoreForTests();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    activeWindow?.close();
    activeWindow = undefined;
    setSessionStateForTests(null);
    globalThis.fetch = originalFetch;
  });

  test('mount shows prompt and suppresses stream DOM', async () => {
    installTestWindow();

    const area = document.createElement('main');
    area.id = 'chatArea';
    document.body.appendChild(area);

    document.body.appendChild(
      Object.assign(document.createElement('div'), { id: 'mainColumn' }),
    );

    const chat = createEmptyChatObject('m1');
    chat.modeId = 'plan';
    setSessionStateForTests({
      version: 5,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    await openOrchestratePlanScreen();

    assert.ok(document.getElementById(ORCHESTRATE_PLAN_SCREEN_ROOT_ID));
    const prompt = document.getElementById(
      ORCHESTRATE_PLAN_SCREEN_PROMPT_ID,
    ) as HTMLTextAreaElement | null;
    assert.ok(prompt);
    assert.equal(prompt?.tagName, 'TEXTAREA');
    assert.equal(isOrchestratePlanScreenSuppressingChatDom(chat.id), true);
    assert.equal(isStreamDomVisible(chat.id), false);

    const row = appendStreamingAssistantRow(chat.id);
    assert.equal(row.wrap.isConnected, false, 'stream row should be stubbed');
  });

  test('buildRevisePlanComposerDraft references the plan file and leaves room to edit', () => {
    assert.equal(
      buildRevisePlanComposerDraft('documentation/plans/oauth.md'),
      'Revise the plan at documentation/plans/oauth.md:\n\n',
    );
    assert.equal(
      buildRevisePlanComposerDraft('documentation/plans/oauth.md', 'Add OAuth login'),
      'Revise the plan at documentation/plans/oauth.md:\n\n(Original planning request: Add OAuth login)\n',
    );
  });

  test('plan preview CSS fills column height and scrolls long artifacts', () => {
    const cssPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../src/styles/orchestrate-plan-screen.css',
    );
    const css = readFileSync(cssPath, 'utf8');
    assert.match(
      css,
      /\.orchestrate-plan-screen:has\(\.orchestrate-plan-screen__preview-wrap\)[\s\S]*justify-content:\s*flex-start/,
    );
    assert.match(
      css,
      /\.orchestrate-plan-screen:has\(\.orchestrate-plan-screen__preview-wrap\)[\s\S]*\.orchestrate-plan-screen__preview[\s\S]*max-height:\s*none/,
    );
    assert.match(
      css,
      /\.orchestrate-plan-screen:has\(\.orchestrate-plan-screen__preview-wrap\)[\s\S]*\.orchestrate-plan-screen__preview[\s\S]*overflow-y:\s*auto/,
    );
  });

  test('view chat suspends overlay and resume remounts working phase', async () => {
    installTestWindow();

    const area = mountCodeChatAreaForTests();
    document.body.appendChild(
      Object.assign(document.createElement('div'), { id: 'mainColumn' }),
    );

    const chat = createEmptyChatObject('m1');
    chat.modeId = 'plan';
    chat.history.push({ role: 'user', content: 'Build a kanban board' });
    setSessionStateForTests({
      version: 5,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    renderOrchestratePlanScreen({
      phase: 'working',
      chatId: chat.id,
      savedPrompt: 'Build a kanban board',
    });

    suspendOrchestratePlanScreenOnLeave(chat.id);
    assert.equal(isOrchestratePlanScreenSuspended(), true);
    assert.equal(document.getElementById(ORCHESTRATE_PLAN_SCREEN_ROOT_ID), null);
    assert.equal(isOrchestratePlanScreenSuppressingChatDom(chat.id), false);

    let session = getOrchestratePlanScreenSession();
    assert.equal(session?.phase, 'working');
    assert.equal(session?.chatId, chat.id);

    renderChatFromHistory(chat);
    const banner = document.getElementById(ORCHESTRATE_PLAN_BANNER_ID);
    assert.ok(banner);
    assert.equal(banner?.parentElement?.classList.contains('chat-viewport'), true);
    assert.equal(area.contains(banner), false, 'banner should float over chat, not inside scroll content');

    const resumeBtn = banner?.querySelector(
      '.orchestrate-plan-screen-banner__resume',
    ) as HTMLButtonElement | null;
    assert.ok(resumeBtn);
    resumeBtn?.click();
    assert.equal(document.getElementById(ORCHESTRATE_PLAN_BANNER_ID), null);
    assert.ok(document.getElementById(ORCHESTRATE_PLAN_SCREEN_ROOT_ID));

    session = getOrchestratePlanScreenSession();
    assert.equal(session?.phase, 'working');
    assert.equal(session?.chatId, chat.id);
  });

  test('ask_question resolves embedded host on plan screen', async () => {
    installTestWindow();
    globalThis.localStorage = activeWindow!.localStorage;
    globalThis.requestAnimationFrame = (cb: () => void) => {
      cb();
      return 0;
    };

    const area = mountCodeChatAreaForTests();
    document.body.appendChild(
      Object.assign(document.createElement('div'), { id: 'mainColumn' }),
    );

    const chat = createEmptyChatObject('m1');
    chat.modeId = 'plan';
    setSessionStateForTests({
      version: 5,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    renderOrchestratePlanScreen({
      phase: 'working',
      chatId: chat.id,
      savedPrompt: 'Plan feature X',
    });

    const host = resolveOrchestratePlanScreenQuestionHost(chat.id);
    assert.ok(host, 'plan screen should expose questions host');
    assert.equal(host?.id, ORCHESTRATE_PLAN_SCREEN_QUESTIONS_ID);
    assert.equal(host?.hidden, false);

    const modalPromise = showQuestionCardsModal(
      {
        questions: [
          {
            id: 'q1',
            prompt: 'Which scope?',
            options: [{ id: 'a', label: 'Small' }],
          },
        ],
      },
      {},
      { host: host!, embedded: true, chatId: chat.id },
    );

    const panel = host?.querySelector('.question-cards-panel--embedded');
    assert.ok(panel, 'question cards should mount inside plan screen');

    const closeBtn = host?.querySelector('.question-cards-icon-btn') as HTMLButtonElement;
    closeBtn?.click();
    const result = await modalPromise;
    assert.equal(result.status, 'cancelled');
  });

  test('switching away from a super-plan chat drops its surface and paints the next chat', () => {
    installTestWindow();

    mountCodeChatAreaForTests();
    document.body.appendChild(
      Object.assign(document.createElement('div'), { id: 'mainColumn' }),
    );

    const chat = createEmptyChatObject('sp-switch-away');
    attachSuperPlanRun(chat, 'researching');
    const otherChat = createEmptyChatObject('other-switch-away');
    otherChat.id = 'other-switch-away-chat';
    otherChat.history.push({ role: 'user', content: 'Hello from another chat' });
    setSessionStateForTests({
      version: 5,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat, otherChat],
    });

    renderChatFromHistory(chat);
    assert.ok(
      document.getElementById(SUPER_PLAN_PAGE_ROOT_ID),
      'a super-plan chat paints its planning surface, never a transcript',
    );
    assert.equal(document.getElementById(ORCHESTRATE_PLAN_BANNER_ID), null);

    setSessionStateForTests({
      version: 5,
      activeId: otherChat.id,
      sidebarCollapsed: false,
      chats: [chat, otherChat],
    });
    renderChatFromHistory(otherChat);

    assert.equal(
      document.getElementById(SUPER_PLAN_PAGE_ROOT_ID),
      null,
      'the surface should not follow other chats',
    );
    assert.equal(document.documentElement.classList.contains('mn-super-plan-open'), false);
    assert.equal(document.getElementById(ORCHESTRATE_PLAN_BANNER_ID), null);
    assert.match(
      document.getElementById('chatArea')?.textContent ?? '',
      /Hello from another chat/,
    );
  });
  test('sidebar switch during planner questions migrates strip to composer without cancelling', async () => {
    installTestWindow();
    globalThis.requestAnimationFrame = (cb: () => void) => {
      cb();
      return 0;
    };

    const area = document.createElement('main');
    area.id = 'chatArea';
    document.body.appendChild(area);
    const mainColumn = document.createElement('div');
    mainColumn.id = 'mainColumn';
    document.body.appendChild(mainColumn);
    const composerHost = document.createElement('div');
    composerHost.id = 'questionHost';
    composerHost.hidden = true;
    mainColumn.appendChild(composerHost);

    const chat = createEmptyChatObject('plan-questions-sidebar');
    chat.modeId = 'plan';
    chat.history.push({ role: 'user', content: 'Add OAuth login' });
    const otherChat = createEmptyChatObject('other');
    otherChat.id = 'other-chat';
    setSessionStateForTests({
      version: 5,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat, otherChat],
    });

    renderOrchestratePlanScreen({
      phase: 'questions',
      chatId: chat.id,
      savedPrompt: 'Add OAuth login',
    });

    const planHost = document.getElementById(ORCHESTRATE_PLAN_SCREEN_QUESTIONS_ID);
    assert.ok(planHost);

    const { showQuestionCardsModal, syncAskQuestionModalOnChatSwitch, resetQuestionCardsModalForTests } =
      await import('../../src/ui/question-cards-modal.ts');

    let settled = false;
    const modalPromise = showQuestionCardsModal(
      {
        questions: [
          {
            id: 'q1',
            prompt: 'Which auth provider?',
            options: [
              { id: 'a', label: 'Google' },
              { id: 'b', label: 'GitHub' },
            ],
          },
        ],
      },
      {},
      { host: planHost!, embedded: true, chatId: chat.id },
    );

    assert.ok(planHost?.querySelector('.question-cards-panel'));

    suspendOrchestratePlanScreenOnLeave(chat.id);
    assert.equal(isOrchestratePlanScreenSuspended(), true);
    assert.equal(document.getElementById(ORCHESTRATE_PLAN_SCREEN_ROOT_ID), null);
    assert.ok(composerHost.querySelector('.question-cards-panel'));
    assert.equal(planHost?.childElementCount, 0);

    const session = getOrchestratePlanScreenSession();
    assert.equal(session?.phase, 'questions');

    syncAskQuestionModalOnChatSwitch(chat.id, otherChat.id);
    assert.equal(composerHost.hidden, true);

    syncAskQuestionModalOnChatSwitch(otherChat.id, chat.id);
    assert.equal(composerHost.hidden, false);
    assert.ok(composerHost.querySelector('.question-cards-panel'));

    resetQuestionCardsModalForTests();
    settled = true;
    await modalPromise.catch(() => undefined);
    assert.equal(settled, true);
  });

  test('renderChatFromHistory for other chat preserves suspended planner questions', async () => {
    installTestWindow();
    globalThis.requestAnimationFrame = (cb: () => void) => {
      cb();
      return 0;
    };

    mountCodeChatAreaForTests();
    const mainColumn = document.createElement('div');
    mainColumn.id = 'mainColumn';
    document.body.appendChild(mainColumn);
    const composerHost = document.createElement('div');
    composerHost.id = 'questionHost';
    composerHost.hidden = true;
    mainColumn.appendChild(composerHost);

    const chat = createEmptyChatObject('plan-questions-render');
    chat.modeId = 'plan';
    chat.history.push({ role: 'user', content: 'Add OAuth login' });
    const otherChat = createEmptyChatObject('other-render');
    otherChat.id = 'other-render-chat';
    otherChat.history.push({ role: 'user', content: 'Hello' });
    setSessionStateForTests({
      version: 5,
      activeId: otherChat.id,
      sidebarCollapsed: false,
      chats: [chat, otherChat],
    });

    renderOrchestratePlanScreen({
      phase: 'questions',
      chatId: chat.id,
      savedPrompt: 'Add OAuth login',
    });

    const planHost = document.getElementById(ORCHESTRATE_PLAN_SCREEN_QUESTIONS_ID);
    assert.ok(planHost);

    const {
      showQuestionCardsModal,
      syncAskQuestionModalOnChatSwitch,
      isAskQuestionModalOpenForChat,
      resetQuestionCardsModalForTests,
    } = await import('../../src/ui/question-cards-modal.ts');

    let settled = false;
    const modalPromise = showQuestionCardsModal(
      {
        questions: [
          {
            id: 'q1',
            prompt: 'Which auth provider?',
            options: [
              { id: 'a', label: 'Google' },
              { id: 'b', label: 'GitHub' },
            ],
          },
        ],
      },
      {},
      { host: planHost!, embedded: true, chatId: chat.id },
    );

    suspendOrchestratePlanScreenOnLeave(chat.id);
    syncAskQuestionModalOnChatSwitch(chat.id, otherChat.id);
    assert.equal(composerHost.hidden, true);

    renderChatFromHistory(otherChat);

    assert.equal(isAskQuestionModalOpenForChat(chat.id), true);
    assert.equal(getOrchestratePlanScreenSession()?.phase, 'questions');
    assert.equal(getOrchestratePlanScreenSession()?.planScreenSuspended, true);

    resetQuestionCardsModalForTests();
    settled = true;
    await modalPromise.catch(() => undefined);
    assert.equal(settled, true);
  });

  test('clicking the active super-plan chat in the sidebar keeps the surface up', async () => {
    installTestWindow();

    const area = mountCodeChatAreaForTests();
    document.body.appendChild(
      Object.assign(document.createElement('div'), { id: 'mainColumn' }),
    );

    const chat = createEmptyChatObject('sp-sidebar-same');
    attachSuperPlanRun(chat, 'researching');
    setSessionStateForTests({
      version: 5,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    renderChatFromHistory(chat);
    const page = area.querySelector('#' + SUPER_PLAN_PAGE_ROOT_ID);
    assert.ok(page);

    await switchChat(chat.id);

    assert.equal(
      area.querySelector('#' + SUPER_PLAN_PAGE_ROOT_ID),
      page,
      'the surface survives a click on the chat that owns it, without a rebuild',
    );
    assert.equal(document.getElementById(ORCHESTRATE_PLAN_BANNER_ID), null);
  });

  test('a Plan-mode screen replaces a mounted Super Plan surface', () => {
    installTestWindow();

    mountCodeChatAreaForTests();
    document.body.appendChild(
      Object.assign(document.createElement('div'), { id: 'mainColumn' }),
    );
    const sp = createEmptyChatObject('sp-replaced');
    attachSuperPlanRun(sp, 'drafting');
    const plan = createEmptyChatObject('plan-chat');
    plan.modeId = 'plan';
    setSessionStateForTests({ version: 5, activeId: sp.id, sidebarCollapsed: false, chats: [sp, plan] });
    renderChatFromHistory(sp);
    assert.ok(document.getElementById(SUPER_PLAN_PAGE_ROOT_ID));

    renderOrchestratePlanScreen({ phase: 'prompt', chatId: plan.id });

    assert.equal(document.getElementById(SUPER_PLAN_PAGE_ROOT_ID), null);
    assert.ok(document.getElementById(ORCHESTRATE_PLAN_SCREEN_ROOT_ID));
    assert.equal(document.documentElement.classList.contains('mn-super-plan-open'), false);
    assert.equal(document.getElementById('chatArea')?.classList.contains('chat-area--super-plan'), false);
  });
});
