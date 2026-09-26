import { ensureAppInitialized } from './app-modules';
import { isOsShellEnabled, syncLegacyChromeVisibility } from './page-bridge';
import {
  getForegroundAppId,
  getInstanceSnapshot,
  subscribeInstances,
  type InstanceSnapshot,
} from './instances';
import { getCurrentRoute } from './router';
import type { AppId, LaunchOptions } from './types';
import type { SettingsSectionId } from '../ui/settings-page-types';
import { shouldSuppressDesktopChrome } from './shell-chrome';
import { mountOsMobileDrawerBackdrops } from '../ui/mobile-drawer-portal';

// ── Layers ───────────────────────────────────────────────────────────────────

const APP_LAYER_IDS: Record<AppId, string> = {
  home: 'homeView',
  'source-control': 'sourceControlView',
  code: 'osAppLayer-code',
  settings: 'settingsView',
  research: 'researchView',
  bench: 'benchmarkView',
  compare: 'compareView',
  models: 'modelsView',
  brain: 'brainView',
  scheduler: 'schedulerView',
  issues: 'issuesView',
  experts: 'expertsView',
};

let initialized = false;
let lastForegroundApp: AppId | null = null;
/** Last Settings section applied via openAppPage (window deep-links). */
let lastAppliedSettingsSection: string | undefined;
/** Last Brain section/path applied to its mounted window. */
let lastAppliedBrainNavigation: string | undefined;
/** Last hash/options pair applied to each mounted app surface. */
const lastAppliedNavigation = new Map<AppId, string>();
/** Bumps on each syncFromSnapshot so stale openAppPage work cannot relaunch apps. */
let syncGeneration = 0;

function appNavigationKey(appId: AppId, options?: LaunchOptions): string {
  return `${appId}\n${window.location.hash}\n${JSON.stringify(options ?? null)}`;
}

function brainNavigationKey(options?: LaunchOptions): string {
  const route = getCurrentRoute();
  const section = options?.brainSection ?? route.brainSection ?? 'graph';
  const editPath = section === 'edit' ? (options?.brainEditPath ?? '') : '';
  return `${section}\n${editPath}`;
}

/** Expose the Brain route cache key for focused app-host regression tests. */
export const brainNavigationKeyForTests = brainNavigationKey;

function getAppsLayer(): HTMLElement | null {
  return document.getElementById('osAppsLayer');
}

function getStage(): HTMLElement | null {
  return document.getElementById('osStage');
}

function mountAppLayers(): void {
  const appsLayer = getAppsLayer();
  if (!appsLayer || appsLayer.dataset.mounted === '1') return;
  appsLayer.dataset.mounted = '1';

  const topbar = document.querySelector('header.topbar');
  const appBody = document.getElementById('appBody');

  if (appBody) {
    const codeWrap = document.createElement('div');
    codeWrap.id = 'osAppLayer-code';
    codeWrap.className = 'mn-os-app-layer mn-os-code-layer';
    codeWrap.dataset.osApp = 'code';
    if (topbar) codeWrap.appendChild(topbar);
    codeWrap.appendChild(appBody);
    const statusBar = document.getElementById('codeStatusBar');
    if (statusBar) codeWrap.appendChild(statusBar);
    const welcome = document.getElementById('welcomeView');
    if (welcome) codeWrap.appendChild(welcome);
    appsLayer.appendChild(codeWrap);
  }

  mountOsMobileDrawerBackdrops();

  for (const [appId, elId] of Object.entries(APP_LAYER_IDS)) {
    if (appId === 'code') continue;
    const el = document.getElementById(elId);
    if (el) {
      el.classList.add('mn-os-app-layer');
      el.dataset.osApp = appId;
      appsLayer.appendChild(el);
    }
  }
}

function layerForApp(appId: AppId): HTMLElement | null {
  return document.getElementById(APP_LAYER_IDS[appId]);
}

/** Page apps that mark readiness with `is-open` on their root layer. */
const PAGE_OPEN_LAYER_APPS = new Set<AppId>([
  'home',
  'settings',
  'models',
  'brain',
  'bench',
  'compare',
  'issues',
  'research',
  'experts',
  'scheduler',
]);

/**
 * Apps whose layer must stay hidden until openAppPage has finished loading and
 * mounting their first coherent frame. Code is not a PAGE_OPEN_LAYER_APP (its
 * shell has no `is-open` state), but its file-panel layout CSS is intentionally
 * lazy with the rest of the workspace bundle. Revealing the layer before that
 * import resolves briefly collapses the chat and stacks the Files toolbar.
 */
const DEFERRED_LAYER_REVEAL_APPS = new Set<AppId>([...PAGE_OPEN_LAYER_APPS, 'code']);

export function shouldDeferAppLayerReveal(appId: AppId): boolean {
  return DEFERRED_LAYER_REVEAL_APPS.has(appId);
}

function isAppPageLayerOpen(appId: AppId): boolean {
  if (appId === 'code') {
    return layerForApp(appId)?.classList.contains('is-active') === true;
  }
  if (!PAGE_OPEN_LAYER_APPS.has(appId)) return true;
  const layer = layerForApp(appId);
  if (!layer) return false;
  return layer.classList.contains('is-open') && layer.classList.contains('is-active');
}

const APP_ENTER_CLASS = 'mn-os-app-enter';

function setLayerActive(el: HTMLElement | null, active: boolean): void {
  if (!el) return;
  el.classList.toggle('is-active', active);
}

function clearAppEnterAnimation(el: HTMLElement | null): void {
  el?.classList.remove(APP_ENTER_CLASS);
}

/** Play the app enter animation once (desktop → fullscreen app). */
function markAppEnterAnimation(el: HTMLElement | null): void {
  if (!el) return;
  el.classList.add(APP_ENTER_CLASS);
  const onEnd = (event: AnimationEvent): void => {
    if (event.target !== el || event.animationName !== 'mn-os-app-in') return;
    el.removeEventListener('animationend', onEnd);
    el.classList.remove(APP_ENTER_CLASS);
  };
  el.addEventListener('animationend', onEnd);
}

function hideAllLayers(): void {
  for (const appId of Object.keys(APP_LAYER_IDS) as AppId[]) {
    const layer = layerForApp(appId);
    clearAppEnterAnimation(layer);
    setLayerActive(layer, false);
  }
}

function closeAllAppPages(): void {
  for (const id of [
    'homeView',
    'settingsView',
    'benchmarkView',
    'compareView',
    'modelsView',
    'brainView',
    'schedulerView',
    'issuesView',
    'researchView',
    'expertsView',
    'chatView',
  ]) {
    if (id === 'expertsView') {
      const view = document.getElementById('expertsView');
      const desktopMount = document.getElementById('desktopExpertsMount');
      if (view && desktopMount?.contains(view)) {
        continue;
      }
    }
    if (id === 'issuesView') {
      const view = document.getElementById('issuesView');
      const chatArea = document.getElementById('chatArea');
      if (view && chatArea?.contains(view)) {
        const appsLayer = document.getElementById('osAppsLayer');
        appsLayer?.appendChild(view);
        view.classList.remove('issues-page--embedded', 'is-open');
        document.getElementById('btnIssuesEmbedBack')?.remove();
        chatArea.classList.remove('chat-area--issues');
        document.getElementById('mainColumn')?.classList.remove('main-column--issues');
        continue;
      }
    }
    document.getElementById(id)?.classList.remove('is-open');
  }
}

/** Defer OS layer visibility until lazy page CSS + `is-open` are applied (avoids FOUC). */
type OpenAppPageLayerReveal = { animateEnter: boolean };

// ── Open page ────────────────────────────────────────────────────────────────

async function openAppPage(
  appId: AppId,
  options?: LaunchOptions,
  generation?: number,
  layerReveal?: OpenAppPageLayerReveal,
): Promise<void> {
  if (generation != null && generation !== syncGeneration) return;
  await ensureAppInitialized(appId);
  if (generation != null && generation !== syncGeneration) return;
  const route = getCurrentRoute();
  const settingsSection =
    options?.settingsSection ?? route.settingsSection ?? 'general';

  switch (appId) {
    case 'home': {
      const { openHome } = await import('../ui/home-page');
      await openHome();
      break;
    }
    case 'settings': {
      const brainRoute = (await import('../ui/brain-memory-routing')).resolveBrainMemoryRoute(
        options?.settingsSearchKey,
        options?.settingsSection ?? route.settingsSection,
      );
      if (brainRoute) {
        const { openBrain } = await import('../ui/brain-page');
        openBrain(brainRoute);
        break;
      }
      const { openSettings, navigateToSettingsField } = await import('../ui/settings-page');
      const requestedSection = options?.settingsSection ?? route.settingsSection;
      const section = (requestedSection ?? 'general') as SettingsSectionId;
      if (options?.settingsSearchKey) {
        navigateToSettingsField(options.settingsSearchKey, section);
      } else {
        openSettings(section, { phoneList: !requestedSection });
      }
      break;
    }
    case 'research': {
      const { showResearchPage } = await import('../research/panel');
      showResearchPage({
        seed: options?.seed,
        autoRun: options?.autoRun ?? Boolean(options?.seed?.trim()),
      });
      break;
    }
    case 'bench': {
      const { openBenchmark } = await import('../ui/benchmark-page');
      openBenchmark();
      break;
    }
    case 'compare': {
      const { openCompare } = await import('../ui/compare-page');
      openCompare();
      break;
    }
    case 'models': {
      const { openModels, DEFAULT_MODELS_SECTION } = await import('../ui/models-page');
      openModels(
        (route.modelsSection ??
          options?.modelsSection ??
          DEFAULT_MODELS_SECTION) as import('../ui/models-page').ModelsSectionId,
      );
      break;
    }
    case 'brain': {
      const { openBrain } = await import('../ui/brain-page');
      const section = (
        options?.brainSection ??
        route.brainSection ??
        'graph'
      ) as import('../ui/brain-page').BrainSectionId;
      openBrain(section, {
        editPath: section === 'edit' ? options?.brainEditPath : undefined,
      });
      lastAppliedBrainNavigation = brainNavigationKey(options);
      break;
    }
    case 'source-control': {
      const { mountSourceControlCenter } = await import('../ui/source-control-center');
      await mountSourceControlCenter();
      break;
    }
    case 'scheduler': {
      const { openScheduler } = await import('../ui/scheduler-page');
      await openScheduler();
      break;
    }
    case 'issues': {
      const { openIssues } = await import('../ui/issues-page');
      const route = getCurrentRoute();
      await openIssues({
        issueId: route.issueId,
        screen: options?.issuesSection ?? route.issuesSection,
        viewMode: options?.issuesViewMode,
        savedViewId: options?.issuesSavedViewId,
      });
      break;
    }
    case 'experts': {
      const { openExperts } = await import('../ui/experts/experts-hub');
      openExperts();
      break;
    }
    case 'code': {
      const { ensureCodeWorkspaceModules } = await import('../boot/code-workspace-modules');
      await ensureCodeWorkspaceModules();
      const welcome = await import('../ui/welcome-page');
      const launchWorkspacePath = options?.workspacePath?.trim();
      if (welcome.shouldPromptCodeWorkspaceWelcome(launchWorkspacePath)) {
        welcome.openWelcome({ skipHash: true });
        break;
      }
      if (welcome.isWelcomePageOpen()) {
        welcome.closeWelcome({ skipHash: true });
      }
      const route = getCurrentRoute();
      const wantsChat =
        Boolean(options?.chatId?.trim()) ||
        Boolean(options?.seed?.trim()) ||
        Boolean(options?.modeId) ||
        Boolean(options?.workspacePath?.trim()) ||
        route.codeSection === 'chat';
      const { closeOtherCodeStageViews, showCodeStageSection } = await import(
        '../ui/main-column-overlay'
      );
      const section = wantsChat ? 'chat' : (route.codeSection ?? 'chat');
      if (section !== 'chat') {
        await showCodeStageSection(section);
        break;
      }
      await closeOtherCodeStageViews();
      if (options?.chatId?.trim()) {
        const { switchToCodeChat } = await import('./chat-launch');
        await switchToCodeChat(options.chatId);
      } else if (options?.seed?.trim() || options?.modeId || options?.workspacePath?.trim()) {
        const { applyCodeLaunchOptions } = await import('./code-launch');
        await applyCodeLaunchOptions(options);
      } else {
        const { restoreCodeSessionOnForeground } = await import('./code-launch');
        await restoreCodeSessionOnForeground();
      }
      break;
    }
    default:
      break;
  }

  if (layerReveal != null) {
    const staleGeneration = generation != null && generation !== syncGeneration;
    if (!staleGeneration || getForegroundAppId() === appId) {
      showAppLayer(appId, layerReveal.animateEnter);
    }
    if (staleGeneration) return;
  }
}

/** Start a layer transition without leaking a rejected lazy initializer. */
function openAppPageInBackground(
  appId: AppId,
  options?: LaunchOptions,
  generation?: number,
  layerReveal?: OpenAppPageLayerReveal,
): void {
  void openAppPage(appId, options, generation, layerReveal).catch((err: unknown) => {
    console.error(`[app-host] ${appId} failed to open`, err);
  });
}

// ── Show layer ───────────────────────────────────────────────────────────────

/** Show the requested app layer and hide others without a blank intermediate frame. */
export function showAppLayer(appId: AppId, animateEnter = false): void {
  const next = layerForApp(appId);
  setLayerActive(next, true);
  if (animateEnter) {
    markAppEnterAnimation(next);
  }
  for (const id of Object.keys(APP_LAYER_IDS) as AppId[]) {
    if (id === appId) continue;
    const layer = layerForApp(id);
    clearAppEnterAnimation(layer);
    setLayerActive(layer, false);
  }
  if (appId === 'code') {
    mountOsMobileDrawerBackdrops();
    syncLegacyChromeVisibility();
  }
  void import('../ui/preview-electron-visibility').then((m) =>
    m.scheduleElectronPreviewHostVisibilitySync(),
  );
}

function launchOptionsFromSnapshot(snapshot: InstanceSnapshot): LaunchOptions | undefined {
  const inst = snapshot.instances.find((i) => i.id === snapshot.foregroundId);
  if (!inst) return undefined;
  return inst.launchOptions ?? (inst.seed ? { seed: inst.seed } : undefined);
}

function ensureLayerInAppsLayer(appId: AppId): void {
  const el = layerForApp(appId);
  const appsLayer = getAppsLayer();
  if (!el || !appsLayer || el.parentElement === appsLayer) return;
  if (appId === 'settings') {
    el.classList.remove('settings-page--in-os-window');
  }
  appsLayer.appendChild(el);
}

function shouldBlurDesktop(snapshot: InstanceSnapshot): boolean {
  return snapshot.view === 'app' && Boolean(getForegroundAppId());
}

function syncFromSnapshot(snapshot: InstanceSnapshot): void {
  const stage = getStage();
  if (!stage) return;

  const generation = ++syncGeneration;

  const blur = shouldBlurDesktop(snapshot);
  const immersive = shouldSuppressDesktopChrome();
  stage.classList.toggle('is-in-app', blur);
  stage.classList.toggle('is-in-app-fullscreen', blur);
  stage.classList.toggle('is-immersive-app', immersive);

  if (snapshot.view === 'workspaces') {
    hideAllLayers();
    if (lastForegroundApp !== null) closeAllAppPages();
    lastForegroundApp = null;
    return;
  }

  const appId = getForegroundAppId();
  if (!appId) return;

  const options = launchOptionsFromSnapshot(snapshot);
  ensureLayerInAppsLayer(appId);
  const navigationKey = appNavigationKey(appId, options);
  const navigationChanged = lastAppliedNavigation.get(appId) !== navigationKey;

  const deferLayerUntilPageOpen = shouldDeferAppLayerReveal(appId);

  if (appId !== lastForegroundApp) {
    lastAppliedNavigation.set(appId, navigationKey);
    const animateEnter = lastForegroundApp === null;
    if (deferLayerUntilPageOpen) {
      openAppPageInBackground(appId, options, generation, { animateEnter });
    } else {
      showAppLayer(appId, animateEnter);
      openAppPageInBackground(appId, options, generation);
    }
    lastForegroundApp = appId;
  } else if (navigationChanged) {
    lastAppliedNavigation.set(appId, navigationKey);
    openAppPageInBackground(appId, options, generation);
  } else if (!isAppPageLayerOpen(appId)) {
    openAppPageInBackground(
      appId,
      options,
      generation,
      deferLayerUntilPageOpen ? { animateEnter: false } : undefined,
    );
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────

/** Wire app layer visibility to instance + router state. */
export function initAppHost(): void {
  if (!isOsShellEnabled() || initialized) return;
  initialized = true;
  mountAppLayers();
  subscribeInstances((snap) => syncFromSnapshot(snap));
  syncFromSnapshot(getInstanceSnapshot());
}

/** Reset app-host bindings (tests). */
export function resetAppHostForTests(): void {
  initialized = false;
  lastForegroundApp = null;
  lastAppliedSettingsSection = undefined;
  lastAppliedBrainNavigation = undefined;
  lastAppliedNavigation.clear();
  syncGeneration = 0;
  const appsLayer = getAppsLayer();
  if (appsLayer) delete appsLayer.dataset.mounted;
}

/** Re-run app-host sync from current instance snapshot (tests). */
export function syncAppHostForTests(): void {
  syncFromSnapshot(getInstanceSnapshot());
}
