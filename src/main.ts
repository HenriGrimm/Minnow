import './styles/tokens.css';
import './styles/theme-transitions.css';
import './styles/global.css';
import './styles/icons.css';
import './styles/motion.css';
import './styles/topbar.css';
import './styles/model-select.css';
import './styles/shell-keyboard-help.css';
import './styles/command-palette.css';
import './styles/context-menu.css';
import './styles/issue-capture.css';
import './styles/sidebar.css';
import './styles/code-chrome.css';
import './styles/chat-search.css';
import './styles/messages.css';
import './styles/context-notice.css';
import './styles/message-actions.css';
import './styles/voice.css';
import './styles/branch-picker.css';
import './styles/thoughts.css';
import './styles/code-change-strip.css';
import './styles/tool-call-diff.css';
import './styles/input.css';
import './styles/code-ref-link.css';
import './styles/chat-link-chips.css';
import './styles/context-usage.css';
import './styles/settings.css';
import './styles/stats.css';
import './styles/agent-activity-panel.css';
import './styles/responsive.css';
import './styles/mode-selector.css';
import './styles/mode-icons.css';
import './styles/composer-controls.css';
import './styles/composer-expand.css';
import './styles/composer-message-queue.css';
import './styles/editor-quick-edit.css';
import './styles/editor-intent-mode.css';
import './styles/preview-panel.css';
import './styles/design-mode.css';
import './styles/skill-picker.css';
import './styles/skill-chip.css';
import './styles/composer-tools-popover.css';
import './styles/composer-overflow.css';
import './styles/workspace-menu.css';
import './styles/workspace-folder-picker.css';
import './styles/research-panel.css';
import './styles/git-help-lightbox.css';
import './styles/tool-approval.css';
import './styles/question-cards.css';
import './styles/transcript-view.css';
import './styles/sub-agent-drawer.css';
import './styles/composer-pinned-skill.css';
import './styles/composer-model-trigger.css';
import './styles/view-mode-toggle.css';
import './styles/toast.css';
import './styles/git-activity-overlay.css';
import './styles/memory-saved-toast.css';
import './styles/plan-progress.css';
import './styles/minnowos-shell.css';
import './styles/minnowos-responsive.css';
import './styles/chat-app.css';
import './styles/app-picker.css';
import './styles/app-dialog.css';
import './styles/mobile.css';

import 'highlight.js/styles/github.min.css';

import { installFetchAuth } from './api/install-fetch-auth';
import {
  logBootPhaseTableIfDebug,
  markBootPhase,
  measureBootPhase,
} from './boot/boot-metrics';
import { initTheme } from './ui/theme';
import { initRenderIdleTracking } from './boot/render-idle';
import { initMobileLayout } from './ui/mobile-layout';
import { initAttachments } from './attachments/store';
import { initShellHandlers } from './ui/shell-handlers';
import { installScopedSelectAllHandler } from './ui/scoped-select-all';
import { initComposerDrop } from './ui/composer-drop';
import { initComposerPaste } from './ui/composer-paste';
import { initContextUsageRing, refreshContextUsageRing } from './ui/context-usage-ring';
import { closeContextUsageBreakdown } from './ui/context-usage-breakdown';
import {
  fetchModels,
  toggleSelectedModelLoad,
  updateModelLoadUnloadButtons,
} from './api/models';
import { initWorkAgentSystem } from './agents/init-work-agents';
import { initPromptSystem } from './chat/prompts/init-prompts';
import { detectConfigServer, refreshConfigStorageBanner } from './config/storage-mode';
import { runMigrationIfNeeded } from './config/migrate';
import { detectLocalServer } from './tools/client';
import { startSchedulerNotificationPoll } from './scheduler/notifications-poll';
import { initNotificationProducers } from './notifications/producers';
import { refreshSkillCatalog } from './skills/client';
import { loadSkillConfigFromStorage } from './skills/config';
import { initAllComposerSlashPickers } from './ui/skill-picker';
import { loadToolConfigFromStorage } from './tools/config';
import { loadToolSecurityMeta } from './config/tool-security-meta';
import { loadBrowserMeta } from './config/browser-meta';
import { loadChatMeta } from './config/chat-meta';
import { loadLibraryInferencePrefs } from './config/library-inference-meta';
import { loadLibraryLaunchPrefs } from './config/library-launch-meta';
import { applySamplerMetaToDrawer, loadSamplerMeta } from './config/sampler-meta';
import { loadAutopilotMeta } from './config/autopilot-meta';
import {
  getActiveChat,
  loadSessionsFromStorage,
  registerSessionPersistenceShutdownHandler,
  sessionState,
} from './state/sessions';
import { initChatScroll } from './ui/chat-scroll';
import { initMinnowBrowserLinkRouting } from './ui/minnow-browser-links';
import { initMarkdownLinkRouting } from './markdown/links';
import { renderChatFromHistory, renderStatsForChat } from './ui/messages';
import { refreshHubLiveData } from './ui/hub';
import {
  parkResumeCandidatesAtBoot,
  startBootResumeGate,
} from './boot/resume-gate-boot';
import {
  bindAskQuestionPlanScreenHooks,
  notifyAskQuestionDisplayContextChanged,
} from './chat/ask-question-display';
import {
  isOrchestratePlanScreenSuppressingChatDom,
  resolveOrchestratePlanScreenQuestionHost,
} from './ui/orchestrate-plan-screen';
import {
  isBoardOnboardingSuppressingChatDom,
  resolveBoardOnboardingQuestionHost,
} from './ui/orchestrate-board-onboarding-questions';
import { subscribeInstances } from './os/instances';
import { initComposerInput } from './ui/input';
import {
  applySidebarVisuals,
  closeMobileSidebar,
  isMobileLayout,
} from './ui/layout';
import { initAppSidebarResizers } from './ui/sidebar-resize';
import {
  fillSystemPromptPresetSelect,
  loadSystemPromptSettings,
  registerToolHandlers,
} from './ui/settings';
import { loadToolConfigIntoDrawer, syncWebSearchProviderFromSearchConfig } from './tools/config';
import {
  initModelSelectPicker,
  syncModelSelectPicker,
} from './ui/model-select-picker';
import {
  initComposerModelTriggers,
  syncComposerModelTriggers,
} from './ui/composer-model-trigger';
import {
  renderSidebar,
  syncModelSelectForActiveChat,
} from './ui/sidebar';
import { bootstrapActiveChatOpenedTimestamp } from './ui/chat-item-dot';
import { initStatsStrip, updateStatsExpandPreview } from './ui/stats';
import { bindExpertsSettingsCheckbox } from './ui/experts-settings';
import { syncComposerPinnedSkillFromActiveChat } from './ui/composer-pinned-skill';
import { syncChatLinkChipsFromActiveChat } from './ui/chat-link-chips';
import { syncGoalActiveHint } from './ui/goal-active-hint';
import { syncLoopActiveHint } from './ui/loop-active-hint';
import { syncTodoPanel } from './ui/todo-panel';
import {
  initOrchestratePlanSelector,
  syncOrchestratePlanStripFromActiveChat,
} from './ui/orchestrate-plan-selector';
import {
  initViewModeToggle,
  syncViewModeToggleFromActiveChat,
} from './ui/view-mode-toggle';
import { initModeSelector, syncModeSelectorFromActiveChat } from './ui/mode-selector';
import { initComposerCompact } from './ui/composer-compact';
import { initThinkingControl } from './ui/composer-thinking';
import { initCodeMapInjectionControl } from './ui/composer-code-map';
import { initBrainNotesInjectionControl } from './ui/composer-brain-notes';
import { initContextDocumentsInjectionControl } from './ui/composer-context-documents';
import {
  initComposerReasoningEffort,
  syncComposerReasoningEffortFromActiveChat,
} from './ui/composer-reasoning-effort';
import { loadThinkingMeta } from './config/thinking-meta';
import { initWorkAgentDevUi, syncWorkAgentDevFromActiveChat } from './ui/work-agent-dev';
import { initSubAgentUi } from './ui/sub-agent-cards';
import { initGoalEvalUi } from './ui/goal-eval-status';
import { initLoopStatusUi } from './ui/loop-active-hint';
import { initAgentActivityPanel } from './ui/agent-activity-panel';
import {
  closeComposerToolsPopover,
  closeAllToolsPopovers,
  initChatAppToolsPopover,
  initComposerToolsPopover,
  initDesktopToolsPopover,
} from './ui/composer-tools-popover';
import { initComposerVoice } from './ui/composer-voice';
import { initComposerExpand } from './ui/composer-expand';
import { initComposerUndo } from './ui/composer-undo';
import { initVoiceStatus } from './ui/voice-controls';
import { dismissOpenLayers } from './ui/status';
import { clearMobileFileSidebarOverlay, closeMobileFileSidebar } from './ui/file-layout';
import { initWorkspaceButton, refreshWorkspaceUi } from './ui/workspace-button';
import {
  initWelcomePage,
  markWelcomePendingIfNeeded,
  onWelcomeServerAvailabilityChanged,
  openWelcome,
  shouldShowWelcomeOnBoot,
} from './ui/welcome-page';
import { getWorkspacePath } from './state/workspace.ts';
import { bindWorkspacePathForToolCache } from './tools/result-cache.ts';
import { isPageReload } from './boot/page-navigation';
import { markChromeReady, scheduleMarkAppReady } from './boot/app-ready';
import { installRendererDiagnostics } from './boot/diagnostics';
import { installLongTaskObserver } from './boot/long-task-observer';
import { initNotificationAudioUnlock } from './notifications/sound';
import { initOsPageBridge, isOsShellEnabled } from './os/page-bridge';
import { initOsRouter } from './os/router';
import { initOsShell } from './os/shell';
import { applyAppWindowBoot } from './os/app-window';
import { initElectronTrayBridge } from './electron-tray-bridge';
import { installAppDialogs } from './ui/app-dialog';
import { initializeCompanionAccess } from './companion/bootstrap';

// ── Service worker ───────────────────────────────────────────────────────────

/** Register shell caching only in browser-secure contexts (HTTPS or loopback). */
function registerServiceWorker(): void {
  if (window.isSecureContext && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

// ── Init app ─────────────────────────────────────────────────────────────────

/** Boot app: sessions, settings, sidebar, models, first paint. */
export async function initApp(): Promise<void> {
  let workspaceGatePending: Promise<void> | null = null;
  let workspaceGateModule: typeof import('./os/workspace-gate') | null = null;
  if (isOsShellEnabled()) {
    workspaceGateModule = await import('./os/workspace-gate');
    const gateHandle = await workspaceGateModule.beginWorkspaceGateForBoot();
    workspaceGatePending = gateHandle?.whenChosen ?? null;
  }

  markBootPhase('ui-init');
  installAppDialogs();
  bindAskQuestionPlanScreenHooks({
    resolveQuestionHost: (chatId) =>
      resolveOrchestratePlanScreenQuestionHost(chatId) ??
      resolveBoardOnboardingQuestionHost(chatId),
    isSuppressingChatDom: (chatId) =>
      isOrchestratePlanScreenSuppressingChatDom(chatId) ||
      isBoardOnboardingSuppressingChatDom(chatId),
  });
  subscribeInstances(() => {
    notifyAskQuestionDisplayContextChanged();
  });
  await detectConfigServer();
  refreshConfigStorageBanner();
  const migrated = await runMigrationIfNeeded();
  await loadToolConfigFromStorage();
  await initPromptSystem();
  await initWorkAgentSystem();
  await loadSessionsFromStorage(migrated ? { force: true } : undefined);
  registerSessionPersistenceShutdownHandler();
  const { loadIssuesTaxonomyFromStorage } = await import('./state/issues-taxonomy-store.ts');
  await loadIssuesTaxonomyFromStorage();
  const { loadIssuesFromStorage, migrateLegacyBugBoardsFromChats } = await import(
    './state/issues-store.ts'
  );
  await loadIssuesFromStorage();
  const { startGithubAutoSyncLoop } = await import('./state/issues-github-auto.ts');
  startGithubAutoSyncLoop();
  const { loadPrReviewsFromStorage } = await import('./state/pr-review-store.ts');
  await loadPrReviewsFromStorage();
  if (sessionState) {
    const chatsChanged = await migrateLegacyBugBoardsFromChats(sessionState.chats);
    if (chatsChanged) {
      const { scheduleSaveSessions } = await import('./state/sessions.ts');
      scheduleSaveSessions();
    }
  }
  initSubAgentUi();
  initGoalEvalUi();
  initLoopStatusUi();
  initAgentActivityPanel();
  fillSystemPromptPresetSelect();
  await loadSystemPromptSettings();
  registerToolHandlers();
  initComposerToolsPopover();
  initChatAppToolsPopover();
  initDesktopToolsPopover();
  initComposerVoice();
  initComposerExpand();
  initComposerUndo();
  const { initCodeChangeStripActions } = await import('./ui/code-change-strip-actions');
  initCodeChangeStripActions();
  void initVoiceStatus();
  initAttachments();
  initContextUsageRing();
  initModeSelector();
  initThinkingControl();
  initCodeMapInjectionControl();
  initBrainNotesInjectionControl();
  initContextDocumentsInjectionControl();
  initComposerReasoningEffort();
  initOrchestratePlanSelector();
  const { initComposerRunTarget } = await import('./ui/composer-run-target');
  initComposerRunTarget();
  initViewModeToggle();
  initWorkAgentDevUi();
  // Model chip lives in the trail; mount before compact parks Tools out of that row.
  initComposerModelTriggers();
  initComposerCompact();
  await bindExpertsSettingsCheckbox();
  await detectLocalServer();
  const { shouldShowOnboardingOnBoot, mountOnboarding } = await import('./onboarding');
  const showOnboarding = await shouldShowOnboardingOnBoot();
  if (showOnboarding) {
    await mountOnboarding();
  }
  startSchedulerNotificationPoll();
  initNotificationProducers();
  onWelcomeServerAvailabilityChanged();
  const { notifyCodeWorkspaceServerAvailability, ensureCodeWorkspaceModules } = await import(
    './boot/code-workspace-modules'
  );
  await notifyCodeWorkspaceServerAvailability();
  bindWorkspacePathForToolCache(getWorkspacePath);
  initWorkspaceButton();
  await refreshWorkspaceUi();
  markWelcomePendingIfNeeded();
  initWelcomePage();
  if (shouldShowWelcomeOnBoot()) {
    openWelcome();
  } else {
    document.documentElement.classList.remove('welcome-pending');
  }
  initModelSelectPicker();
  initComposerModelTriggers();
  await refreshSkillCatalog();
  const msgInput = document.getElementById('msgInput') as HTMLTextAreaElement | null;
  if (msgInput) {
    initComposerInput(msgInput);
  }
  initAllComposerSlashPickers();
  initComposerDrop();
  initComposerPaste();
  initAppSidebarResizers();
  markBootPhase('config');
  await Promise.all([
    loadSkillConfigFromStorage(),
    loadToolSecurityMeta().catch(() => undefined),
    loadBrowserMeta().catch(() => undefined),
    loadChatMeta().catch(() => undefined),
    loadSamplerMeta()
      .then(applySamplerMetaToDrawer)
      .catch(() => undefined),
    loadLibraryInferencePrefs().catch(() => undefined),
    loadLibraryLaunchPrefs().catch(() => undefined),
    loadAutopilotMeta().catch(() => undefined),
    loadThinkingMeta().catch(() => undefined),
  ]);
  try {
    performance.mark('minnow:boot:config-done');
    performance.measure(
      'minnow:phase:config-cluster',
      'minnow:boot:config',
      'minnow:boot:config-done',
    );
  } catch {}
  initStatsStrip();
  initChatScroll();
  initMinnowBrowserLinkRouting();
  initMarkdownLinkRouting();
  loadToolConfigIntoDrawer();
  void syncWebSearchProviderFromSearchConfig();

  if (workspaceGatePending) {
    await workspaceGatePending;
  }

  await refreshWorkspaceUi();
  await notifyCodeWorkspaceServerAvailability();
  if (
    workspaceGateModule?.isHoldingWorkspaceGateForAppReady() ||
    window.location.hash.startsWith('#/app/code')
  ) {
    await ensureCodeWorkspaceModules();
  } else {
    const { ensureCodeWorkspaceModulesForBoot } = await import('./boot/code-workspace-modules');
    await ensureCodeWorkspaceModulesForBoot();
  }

  applySidebarVisuals();
  renderSidebar();
  const { wireSidebarNewGroupButton } = await import('./ui/sidebar');
  wireSidebarNewGroupButton();
  const { ensureBootAppsInitialized, warmIssuesAppInBackground } = await import(
    './os/app-modules'
  );
  await ensureBootAppsInitialized();
  syncModelSelectForActiveChat();
  syncModelSelectPicker();
  syncComposerModelTriggers();
  updateModelLoadUnloadButtons();
  const { reconcileBootForegroundAwayFromSuperPlan } = await import(
    './boot/reconcile-super-plan-foreground'
  );
  reconcileBootForegroundAwayFromSuperPlan();
  renderChatFromHistory(getActiveChat());
  const { applyComposerDraftForChat } = await import('./ui/composer-draft');
  applyComposerDraftForChat(getActiveChat());
  renderStatsForChat(getActiveChat());
  refreshContextUsageRing();
  syncModeSelectorFromActiveChat();
  syncComposerReasoningEffortFromActiveChat();
  syncWorkAgentDevFromActiveChat();
  void syncOrchestratePlanStripFromActiveChat();
  syncComposerPinnedSkillFromActiveChat();
  syncChatLinkChipsFromActiveChat();
  syncViewModeToggleFromActiveChat();
  syncGoalActiveHint();
  syncLoopActiveHint();
  syncTodoPanel();
  renderSidebar();
  bootstrapActiveChatOpenedTimestamp();
  markBootPhase('first-paint');
  measureBootPhase('minnow:phase:to-first-paint', 'ui-init', 'first-paint');

  if (workspaceGateModule?.isHoldingWorkspaceGateForAppReady()) {
    await workspaceGateModule.revealAppAfterWorkspaceGate();
  }
  markChromeReady();

  void import('./ui/terminal-panel').then((m) => m.refreshTerminalHistoryForActiveChat());
  void fetchModels().then(() => {
    syncModelSelectForActiveChat();
    syncModelSelectPicker();
    syncComposerModelTriggers();
    updateModelLoadUnloadButtons();
  });
  warmIssuesAppInBackground();

  if (sessionState) {
    parkResumeCandidatesAtBoot(sessionState);
    startBootResumeGate(sessionState);
  }

  const { startLoopTicker } = await import('./chat/loop/ticker');
  const { sendProgrammaticChatText } = await import('./chat/messaging');
  startLoopTicker({
    send: (chat, text) => sendProgrammaticChatText(chat, text),
  });

  window.addEventListener('resize', () => {
    if (!isMobileLayout()) {
      closeMobileSidebar();
      clearMobileFileSidebarOverlay();
    }
    applySidebarVisuals();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAllToolsPopovers();
      closeContextUsageBreakdown();
      dismissOpenLayers();
    }
  });

  const drawerOverlay = document.getElementById('drawerOverlay');
  const sidebarBackdrop = document.getElementById('sidebarBackdrop');
  const fileSidebarBackdrop = document.getElementById('fileSidebarBackdrop');
  if (drawerOverlay) drawerOverlay.tabIndex = -1;
  if (sidebarBackdrop) sidebarBackdrop.tabIndex = -1;
  if (fileSidebarBackdrop) fileSidebarBackdrop.tabIndex = -1;
  updateStatsExpandPreview();
  markBootPhase('interactive');
  measureBootPhase('minnow:phase:init-app', 'ui-init', 'interactive');
  logBootPhaseTableIfDebug();
}

// ── Start app ────────────────────────────────────────────────────────────────

/** Start init once the document is ready (module scripts often run after `load`). */
async function startApp(): Promise<void> {
  if (!(await initializeCompanionAccess())) return;
  initShellHandlers();
  const { initShellKeyboardHelp } = await import('./ui/shell-keyboard-help');
  initShellKeyboardHelp();
  const { initShellCommands } = await import('./ui/shell-commands');
  const { initCommandPalette } = await import('./ui/command-palette');
  initShellCommands();
  initCommandPalette();
  const { initCaptureDragLayer } = await import('./ui/capture-drag');
  const { initIssueCaptureMenus } = await import('./ui/issue-capture');
  const { wireCaptureAccessors } = await import('./ui/issue-capture-wiring');
  const { initCaptureSurfaceMenus } = await import('./ui/capture-surface-menus');
  initCaptureDragLayer();
  initIssueCaptureMenus();
  initCaptureSurfaceMenus();
  wireCaptureAccessors();
  const { initIssueAgentWatcher } = await import('./chat/issues/agent-watch');
  initIssueAgentWatcher();
  installScopedSelectAllHandler();
  applyAppWindowBoot();
  if (isOsShellEnabled()) {
    initOsPageBridge();
    initOsShell();
  }
  installRendererDiagnostics();
  installLongTaskObserver();
  initNotificationAudioUnlock();
  await detectConfigServer();
  const { installAppearancePersistence, hydrateAppearanceFromServer } = await import(
    './appearance/persist'
  );
  installAppearancePersistence();
  const appearanceChanged = await hydrateAppearanceFromServer();
  if (appearanceChanged) {
    const { applyResolvedTheme } = await import('./ui/theme');
    const { getStoredTheme } = await import('./theme');
    applyResolvedTheme(getStoredTheme());
  }
  if (isOsShellEnabled() && !isPageReload()) {
    const hash = window.location.hash;
    const appWindowId = window.minnow?.viewContext?.appId?.trim();
    const bootToWorkspacePicker =
      !appWindowId &&
      (hash === '' ||
        hash === '#' ||
        hash === '#/' ||
        hash === '#/desktop' ||
        hash.startsWith('#/app/'));
    if (bootToWorkspacePicker) {
      window.location.replace('#/workspaces');
    }
  }
  await Promise.all([loadSessionsFromStorage(), detectLocalServer()]);
  markBootPhase('sessions');
  if (isOsShellEnabled()) {
    initOsRouter();
  }
  const { initWindowClosePromptBridge } = await import('./ui/window-close-prompt');
  initWindowClosePromptBridge();
  initElectronTrayBridge();
  void initApp();
}

installFetchAuth();

registerServiceWorker();

initTheme();
initRenderIdleTracking();
initMobileLayout();
scheduleMarkAppReady();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startApp, { once: true });
} else {
  startApp();
}
