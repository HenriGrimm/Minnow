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
  isSuperPlanPipelineResumable,
  isSuperPlanPlanScreenRestorable,
  buildRevisePlanComposerDraft,
  openOrchestratePlanScreen,
  renderOrchestratePlanScreen,
  resetOrchestratePlanScreenForTests,
  resolveOrchestratePlanScreenQuestionHost,
  restoreOrchestratePlanScreenSessionFromChat,
  shouldRouteComposerSendToSuperPlan,
  suspendOrchestratePlanScreenOnLeave,
} from '../../src/ui/orchestrate-plan-screen.ts';
import { SUPER_PLAN_PAGE_ROOT_ID } from '../../src/ui/super-plan-page.ts';
import { switchChat } from '../../src/ui/sidebar.ts';
import { createInitialSuperPlanStages } from '../helpers/super-plan-fixture.ts';
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

  test('spec_confirm phase presents build spec preview and checkpoint actions', () => {
    installTestWindow();

    const area = mountCodeChatAreaForTests();
    document.body.appendChild(
      Object.assign(document.createElement('div'), { id: 'mainColumn' }),
    );

    const chat = createEmptyChatObject('sp-spec');
    chat.modeId = 'super-plan';
    const specStages = createInitialSuperPlanStages();
    specStages.grill.status = 'done';
    specStages.spec_confirm.status = 'blocked_user';
    specStages.spec_confirm.artifactPath =
      'documentation/plans/references/oauth-spec.md';
    chat.superPlanRunId = 'fixture';
  chat.superPlanView = {
    runId: 'fixture', stage: 'research', stageIndex: 3, stageTotal: 7, state: 'running', finished: false, atMs: 1,
      slug: 'oauth',
      prompt: 'Add OAuth login',
      activeStage: 'spec_confirm',
      gate: { gateId: 'fixture:1', kind: 'spec', question: 'Confirm specification' },
      specPath: 'documentation/plans/references/oauth-spec.md',
      stages: specStages,
    };
    setSessionStateForTests({
      version: 5,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    renderOrchestratePlanScreen({
      phase: 'spec_confirm',
      chatId: chat.id,
      planPath: 'documentation/plans/references/oauth-spec.md',
      savedPrompt: 'Add OAuth login',
    });

    // Super Plan renders its own library-first page, not the centered overlay.
    assert.ok(document.getElementById(SUPER_PLAN_PAGE_ROOT_ID));
    assert.equal(document.getElementById(ORCHESTRATE_PLAN_SCREEN_ROOT_ID), null);
    assert.ok(
      document.getElementById('chatArea')?.classList.contains('chat-area--super-plan'),
      'the chat area hands back its centering for the Super Plan page',
    );
    const dock = document.querySelector('.sp-dock');
    assert.ok(dock, 'a blocked checkpoint docks its actions under the artifact');
    assert.equal((dock as HTMLElement).hidden, false);
    assert.ok(
      [...document.querySelectorAll('.sp-btn')].some(
        (btn) => btn.textContent === 'Confirm spec',
      ),
    );
    assert.ok(
      [...document.querySelectorAll('.sp-btn')].some(
        (btn) => btn.textContent === 'Revise spec',
      ),
    );
    assert.ok(
      [...document.querySelectorAll('.sp-segment')].some(
        (seg) => seg.textContent?.trim() === 'Spec' && seg.classList.contains('is-on'),
      ),
      'the spec checkpoint opens on the Spec segment',
    );

    const session = getOrchestratePlanScreenSession();
    assert.equal(session?.phase, 'spec_confirm');
    assert.equal(session?.planPath, 'documentation/plans/references/oauth-spec.md');
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

  test('restore session from spec_confirm checkpoint keeps spec path for resume', () => {
    const chat = createEmptyChatObject('sp-spec-restore');
    chat.modeId = 'super-plan';
    chat.history.push({ role: 'user', content: 'Add OAuth login' });
    const stages = createInitialSuperPlanStages();
    const specPath = 'documentation/plans/references/oauth-spec.md';
    stages.spec_confirm.status = 'blocked_user';
    stages.spec_confirm.artifactPath = specPath;
    chat.superPlanRunId = 'fixture';
  chat.superPlanView = {
    runId: 'fixture', stage: 'research', stageIndex: 3, stageTotal: 7, state: 'running', finished: false, atMs: 1,
      slug: 'oauth',
      prompt: 'Add OAuth login',
      activeStage: 'spec_confirm',
      gate: { gateId: 'fixture:1', kind: 'spec', question: 'Confirm specification' },
      stages,
      specPath,
      researchPath: 'documentation/plans/references/oauth-research.md',
      planPath: 'documentation/plans/oauth.md',
      uiInvolved: false,
    };
    setSessionStateForTests({
      version: 5,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    assert.equal(restoreOrchestratePlanScreenSessionFromChat(chat), true);
    const session = getOrchestratePlanScreenSession();
    assert.equal(session?.phase, 'spec_confirm');
    assert.equal(session?.planPath, specPath);
    assert.equal(session?.planScreenSuspended, true);
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

  test('shouldRouteComposerSendToSuperPlan routes first super-plan composer send', () => {
    const chat = createEmptyChatObject('sp1');
    chat.modeId = 'super-plan';
    assert.equal(
      shouldRouteComposerSendToSuperPlan(chat, {
        userText: 'Add OAuth login',
        skillId: null,
        attachmentCount: 0,
      }),
      true,
    );
  });

  test('shouldRouteComposerSendToSuperPlan skips when pipeline already active', () => {
    const chat = createEmptyChatObject('sp2');
    chat.modeId = 'super-plan';
    chat.superPlanRunId = 'fixture';
  chat.superPlanView = {
    runId: 'fixture', stage: 'research', stageIndex: 3, stageTotal: 7, state: 'running', finished: false, atMs: 1,
      slug: 'oauth',
      prompt: 'Add OAuth login',
      activeStage: 'grill',
      stages: {} as never,
      specPath: 'documentation/plans/references/oauth-spec.md',
      researchPath: 'documentation/plans/references/oauth-research.md',
      planPath: 'documentation/plans/oauth.md',
      uiInvolved: false,
    };
    assert.equal(
      shouldRouteComposerSendToSuperPlan(chat, {
        userText: 'Add OAuth login',
        skillId: null,
        attachmentCount: 0,
      }),
      false,
    );
  });

  test('shouldRouteComposerSendToSuperPlan skips non-super-plan modes', () => {
    const chat = createEmptyChatObject('sp3');
    chat.modeId = 'plan';
    assert.equal(
      shouldRouteComposerSendToSuperPlan(chat, {
        userText: 'Plan feature X',
        skillId: null,
        attachmentCount: 0,
      }),
      false,
    );
  });

  test('switching away from a super-plan chat drops its surface and paints the next chat', () => {
    installTestWindow();

    mountCodeChatAreaForTests();
    document.body.appendChild(
      Object.assign(document.createElement('div'), { id: 'mainColumn' }),
    );

    const chat = createEmptyChatObject('sp-switch-away');
    chat.modeId = 'super-plan';
    chat.history.push({ role: 'user', content: 'Add OAuth login' });
    const stages = createInitialSuperPlanStages();
    stages.research.status = 'running';
    chat.superPlanRunId = 'fixture';
  chat.superPlanView = {
    runId: 'fixture', stage: 'research', stageIndex: 3, stageTotal: 7, state: 'running', finished: false, atMs: 1,
      slug: 'oauth',
      prompt: 'Add OAuth login',
      activeStage: 'research',
      stages,
      specPath: 'documentation/plans/references/oauth-spec.md',
      researchPath: 'documentation/plans/references/oauth-research.md',
      planPath: 'documentation/plans/oauth.md',
      uiInvolved: false,
    };
    const otherChat = createEmptyChatObject('other-switch-away');
    otherChat.id = 'other-switch-away-chat';
    otherChat.history.push({ role: 'user', content: 'Hello from another chat' });
    setSessionStateForTests({
      version: 5,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat, otherChat],
    });

    assert.equal(restoreOrchestratePlanScreenSessionFromChat(chat), true);
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
    assert.equal(document.getElementById(ORCHESTRATE_PLAN_BANNER_ID), null);
    assert.match(
      document.getElementById('chatArea')?.textContent ?? '',
      /Hello from another chat/,
    );
  });

  test('restore session from persisted superPlan reopens the surface after reload', () => {
    installTestWindow();

    const area = mountCodeChatAreaForTests();
    document.body.appendChild(
      Object.assign(document.createElement('div'), { id: 'mainColumn' }),
    );

    const chat = createEmptyChatObject('sp-reload');
    chat.modeId = 'super-plan';
    chat.history.push({ role: 'user', content: 'Add OAuth login' });
    const stages = createInitialSuperPlanStages();
    stages.research.status = 'running';
    chat.superPlanRunId = 'fixture';
  chat.superPlanView = {
    runId: 'fixture', stage: 'research', stageIndex: 3, stageTotal: 7, state: 'running', finished: false, atMs: 1,
      slug: 'oauth',
      prompt: 'Add OAuth login',
      activeStage: 'research',
      stages,
      specPath: 'documentation/plans/references/oauth-spec.md',
      researchPath: 'documentation/plans/references/oauth-research.md',
      planPath: 'documentation/plans/oauth.md',
      uiInvolved: false,
    };
    setSessionStateForTests({
      version: 5,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    assert.equal(isSuperPlanPipelineResumable(chat), true);
    assert.equal(restoreOrchestratePlanScreenSessionFromChat(chat), true);

    const session = getOrchestratePlanScreenSession();
    assert.equal(session?.chatId, chat.id);
    assert.equal(session?.phase, 'super-plan-working');
    assert.equal(session?.planScreenSuspended, true);

    renderChatFromHistory(chat);
    assert.ok(
      area.querySelector(`#${SUPER_PLAN_PAGE_ROOT_ID}`),
      'reload lands back on the planning surface, not the transcript',
    );
    assert.equal(document.getElementById(ORCHESTRATE_PLAN_BANNER_ID), null);
    assert.equal(document.getElementById(ORCHESTRATE_PLAN_SCREEN_ROOT_ID), null);
    assert.equal(
      document.documentElement.classList.contains('mn-super-plan-open'),
      true,
      'the shell hides the chat list while the surface is up',
    );
  });

  test('restore session from cancelled superPlan reopens the surface after reload', () => {
    installTestWindow();

    const area = mountCodeChatAreaForTests();
    document.body.appendChild(
      Object.assign(document.createElement('div'), { id: 'mainColumn' }),
    );

    const chat = createEmptyChatObject('sp-cancelled-reload');
    chat.modeId = 'super-plan';
    chat.history.push({ role: 'user', content: 'Add OAuth login' });
    const stages = createInitialSuperPlanStages();
    stages.draft1.status = 'error';
    stages.draft1.error = 'Cancelled by user';
    chat.superPlanRunId = 'fixture';
  chat.superPlanView = {
    runId: 'fixture', stage: 'research', stageIndex: 3, stageTotal: 7, state: 'running', finished: false, atMs: 1,
      slug: 'oauth',
      prompt: 'Add OAuth login',
      activeStage: 'draft1',
      stages,
      cancelled: true,
      finished: true,
      specPath: 'documentation/plans/references/oauth-spec.md',
      researchPath: 'documentation/plans/references/oauth-research.md',
      planPath: 'documentation/plans/oauth.md',
      uiInvolved: false,
    };
    setSessionStateForTests({
      version: 5,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    assert.equal(isSuperPlanPipelineResumable(chat), false);
    assert.equal(isSuperPlanPlanScreenRestorable(chat), true);
    assert.equal(restoreOrchestratePlanScreenSessionFromChat(chat), true);

    const session = getOrchestratePlanScreenSession();
    assert.equal(session?.chatId, chat.id);
    assert.equal(session?.phase, 'super-plan-working');
    assert.equal(session?.planScreenSuspended, true);

    renderChatFromHistory(chat);
    assert.ok(
      area.querySelector(`#${SUPER_PLAN_PAGE_ROOT_ID}`),
      'a stopped run still opens on the surface, where the rail offers a fresh plan',
    );
    assert.equal(document.getElementById(ORCHESTRATE_PLAN_BANNER_ID), null);
  });

  test('the run surface offers no route to the transcript', async () => {
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

    const chat = createEmptyChatObject('sp-grill');
    chat.modeId = 'super-plan';
    chat.history.push({ role: 'user', content: 'Add OAuth login' });
    setSessionStateForTests({
      version: 5,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    renderOrchestratePlanScreen({
      phase: 'questions',
      chatId: chat.id,
      savedPrompt: 'Add OAuth login',
    });

    const planHost = document.getElementById(ORCHESTRATE_PLAN_SCREEN_QUESTIONS_ID);
    assert.ok(planHost);

    const { showQuestionCardsModal, resetQuestionCardsModalForTests } = await import(
      '../../src/ui/question-cards-modal.ts'
    );

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

    assert.equal(
      document.querySelector('[data-plan-action="viewChat"]'),
      null,
      'Super Plan is a screen, not a conversation — nothing offers to swap it for one',
    );
    assert.ok(
      document.getElementById(SUPER_PLAN_PAGE_ROOT_ID),
      'the surface stays up while the interview runs',
    );
    assert.equal(isOrchestratePlanScreenSuspended(), false);
    assert.equal(
      composerHost.querySelector('.question-cards-panel'),
      null,
      'interview questions stay inline in the ledger column',
    );

    const session = getOrchestratePlanScreenSession();
    assert.equal(session?.phase, 'questions');

    resetQuestionCardsModalForTests();
    settled = true;
    await modalPromise.catch(() => undefined);
    assert.equal(settled, true);
  });

  test('sidebar switch during grill questions migrates strip to composer without cancelling', async () => {
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

    const chat = createEmptyChatObject('sp-grill-sidebar');
    chat.modeId = 'super-plan';
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

  test('renderChatFromHistory for other chat preserves suspended grill questions', async () => {
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

    const chat = createEmptyChatObject('sp-grill-render');
    chat.modeId = 'super-plan';
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
    chat.modeId = 'super-plan';
    chat.history.push({ role: 'user', content: 'Add OAuth login' });
    const stages = createInitialSuperPlanStages();
    stages.research.status = 'running';
    chat.superPlanRunId = 'fixture';
  chat.superPlanView = {
    runId: 'fixture', stage: 'research', stageIndex: 3, stageTotal: 7, state: 'running', finished: false, atMs: 1,
      slug: 'oauth',
      prompt: 'Add OAuth login',
      activeStage: 'research',
      stages,
      specPath: 'documentation/plans/references/oauth-spec.md',
      researchPath: 'documentation/plans/references/oauth-research.md',
      planPath: 'documentation/plans/oauth.md',
      uiInvolved: false,
    };
    setSessionStateForTests({
      version: 5,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    renderOrchestratePlanScreen({
      phase: 'super-plan-working',
      chatId: chat.id,
      savedPrompt: 'Add OAuth login',
    });
    assert.ok(document.getElementById(SUPER_PLAN_PAGE_ROOT_ID));

    await switchChat(chat.id);

    assert.ok(
      area.querySelector(`#${SUPER_PLAN_PAGE_ROOT_ID}`),
      'the surface survives a click on the chat that owns it',
    );
    assert.equal(isOrchestratePlanScreenSuspended(), false);
    assert.equal(document.getElementById(ORCHESTRATE_PLAN_BANNER_ID), null);
  });

  test('skip interview button shows only while the grill stage is active', () => {
    installTestWindow();

    const area = mountCodeChatAreaForTests();
    document.body.appendChild(
      Object.assign(document.createElement('div'), { id: 'mainColumn' }),
    );

    const chat = createEmptyChatObject('sp-skip');
    chat.modeId = 'super-plan';
    const stages = createInitialSuperPlanStages();
    stages.grill.status = 'running';
    chat.superPlanRunId = 'fixture';
  chat.superPlanView = {
    runId: 'fixture', stage: 'research', stageIndex: 3, stageTotal: 7, state: 'running', finished: false, atMs: 1,
      slug: 'oauth',
      prompt: 'Add OAuth login',
      activeStage: 'grill',
      stages,
    };
    setSessionStateForTests({
      version: 5,
      activeId: chat.id,
      sidebarCollapsed: false,
      chats: [chat],
    });

    renderOrchestratePlanScreen({
      phase: 'super-plan-working',
      chatId: chat.id,
      savedPrompt: 'Add OAuth login',
    });

    const skipBtn = document.querySelector(
      '[data-plan-action="skipInterview"]',
    ) as HTMLButtonElement | null;
    assert.ok(skipBtn, 'skip interview button should render');
    assert.equal(skipBtn?.hidden, false, 'skip button visible during the interview');

    // Advancing past the interview hides the button.
    chat.superPlanView.activeStage = 'spec_confirm';
    renderOrchestratePlanScreen({
      phase: 'super-plan-working',
      chatId: chat.id,
      savedPrompt: 'Add OAuth login',
    });
    const skipAfter = document.querySelector(
      '[data-plan-action="skipInterview"]',
    ) as HTMLButtonElement | null;
    assert.equal(skipAfter?.hidden, true, 'skip button hidden once past the interview');
  });
});
