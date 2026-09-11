import '../styles/settings-page.css';
import '../styles/settings-agent-center.css';

import { loadPromptMetaSettings, savePromptMetaSettings } from '../config/prompt-meta';
import { detectLocalServer } from '../tools/client';
import { refreshSettingsSection } from './settings-sections';
import {
  initSettingsPromptEstimate,
  refreshPromptTokenEstimate,
  schedulePromptTokenEstimateRefresh,
} from './settings-prompt-estimate';
import { setStatus } from './status';
import type { PromptProfile } from '../chat/prompts/types';
import {
  SETTINGS_CATEGORY_AREAS,
  SETTINGS_CATEGORIES,
  SETTINGS_INTEGRATIONS_HUBS,
  categoryForArea,
  hubForArea,
  type SettingsCategoryId,
  type SettingsIntegrationsHubId,
  type SettingsSectionId,
} from './settings-page-types';
import { initSettingsSearchFinder } from './settings-search-finder';
import {
  applySettingsPageFilter,
  clearSettingsPageFilter,
  refreshSettingsPageFilterForCategory,
} from './settings-filter';
import { restoreReparentedSettingsSections } from './models/settings-reparent';
import {
  activateIntegrationsHub,
  flashSettingsSearchTarget,
  resolveSettingsSearchDomTarget,
  scrollSettingsTargetIntoView,
  scrollToSettingsArea,
  updateSettingsNavActive,
} from './settings-search-navigate';
import { upgradeSettingsCheckboxes } from './settings-switch';
import { initSettingsMobileNav } from './settings-mobile-nav';
import { isOsAppHash, isOsEmbedded } from '../os/page-bridge';
import {
  closeInstance,
  getForegroundAppId,
  getInstanceSnapshot,
} from '../os/instances';
import { requestCloseWindowApp, registerWindowTeardown } from '../os/window-mounted-apps';
import { isBoardTestingSettingsVisible } from '../config/dev-surfaces';
import { fieldByKey } from './settings-catalog';
import { resolveBrainMemoryRoute } from './brain-memory-routing';
import { resolveSettingsSectionNavigation } from './settings-section-navigation';
import { getCurrentRoute, launchApp, navigateToDesktop } from '../os/router';
import type { LaunchOptions } from '../os/types';

export type { SettingsSectionId, SettingsCategoryId } from './settings-page-types';
export { categoryForArea } from './settings-page-types';
export { isOsEmbedded };

const CATEGORIES = SETTINGS_CATEGORIES;

let activeCategory: SettingsCategoryId = 'general';
let activeArea: SettingsSectionId = 'general';
let staticBindingsDone = false;
/** Guards against duplicate back/hash listeners (HMR, races, or double ensureAppInitialized). */
let pageInitialized = false;
/** Pending area scroll after category panel opens (legacy hash or deep link). */
let pendingScrollArea: SettingsSectionId | null = null;
/** Pending field flash after navigation. */
let pendingSearchKey: string | null = null;

// ── Queries ──────────────────────────────────────────────────────────────────

function getSettingsRoot(): HTMLElement | null {
  return document.getElementById('settingsView');
}

function getChatShell(): HTMLElement | null {
  return document.getElementById('appBody');
}

function isSettingsSectionId(value: string): value is SettingsSectionId {
  return CATEGORIES.some((cat) =>
    SETTINGS_CATEGORY_AREAS[cat].includes(value as SettingsSectionId),
  );
}

function isSettingsCategoryId(value: string): value is SettingsCategoryId {
  return CATEGORIES.includes(value as SettingsCategoryId);
}

// ── Hash ─────────────────────────────────────────────────────────────────────

/** Write area hash unless OS-embedded (no hash mutation). */
function writeSettingsHash(slug: string): void {
  if (isOsEmbedded()) return;
  const nextHash = `#/settings/${slug}`;
  if (window.location.hash !== nextHash) {
    window.location.hash = nextHash;
  }
}

/** Class on #settingsView while it is mounted in a floating OS window frame. */
export const SETTINGS_IN_OS_WINDOW_CLASS = 'settings-page--in-os-window';

/** Keep window chrome classes in sync after reparent between apps layer and window body. */
function syncSettingsOsWindowChrome(): void {
  const root = getSettingsRoot();
  if (!root) return;
  const inWindow = Boolean(root.closest('.mn-os-window-body'));
  if (inWindow) {
    root.classList.add(SETTINGS_IN_OS_WINDOW_CLASS);
    const osWindow = root.closest('.mn-os-window');
    if (osWindow instanceof HTMLElement) {
      osWindow.scrollTop = 0;
    }
  }
  document
    .getElementById('btnSettingsPageBack')
    ?.classList.toggle('hidden', isOsEmbedded());
}

/** Parse `#/settings/<category|legacy-area>`. */
function parseHashRoute(): {
  category: SettingsCategoryId;
  scrollArea?: SettingsSectionId;
  searchKey?: string;
} {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const match = hash.match(/^settings(?:\/([\w-]+))?/);
  const slug = match?.[1];
  if (!slug || slug === 'voice') {
    return { category: 'general' };
  }
  if (slug === 'knowledge') {
    return { category: 'agents', scrollArea: 'rules' };
  }
  if (slug === 'experts') {
    return { category: 'agents', scrollArea: 'agent-center' };
  }
  if (isSettingsCategoryId(slug)) {
    return { category: slug };
  }
  if (slug && isSettingsSectionId(slug)) {
    const resolved = resolveSettingsSectionNavigation(slug);
    return {
      category: categoryForArea(resolved.sectionId),
      scrollArea: resolved.sectionId,
      searchKey: resolved.searchKey,
    };
  }
  return { category: 'general' };
}

async function refreshCategoryAreas(category: SettingsCategoryId): Promise<void> {
  const areas = SETTINGS_CATEGORY_AREAS[category];
  await Promise.all(areas.map((area) => refreshSettingsSection(area)));
}

function getSectionRoot(sectionId: SettingsSectionId): HTMLElement | null {
  return document.getElementById(`settingsSection-${sectionId}`);
}

/** Toggle area panels: one page per area; integrations keep hub stacks. */
function syncAreaVisibility(area: SettingsSectionId): void {
  const category = categoryForArea(area);
  const panel = document.querySelector(
    `.settings-category[data-category="${category}"]`,
  );
  if (!panel) return;

  if (category === 'integrations') {
    const hubId = hubForArea(area);
    if (hubId) activateIntegrationsHub(hubId);
    panel.querySelectorAll<HTMLElement>('.settings-area').forEach((section) => {
      section.classList.remove('is-active');
    });
    getSectionRoot(area)?.classList.add('is-active');
    return;
  }

  panel.querySelectorAll<HTMLElement>('.settings-area').forEach((section) => {
    section.classList.toggle('is-active', section.dataset.area === area);
  });
}

// ── Area ─────────────────────────────────────────────────────────────────────

/** Activate a settings area (primary navigation). */
export function setActiveArea(
  area: SettingsSectionId,
  options?: { searchKey?: string; skipHash?: boolean },
): void {
  activeArea = area;
  const category = categoryForArea(area);
  activeCategory = category;

  for (const cat of CATEGORIES) {
    const catPanel = document.querySelector(
      `.settings-category[data-category="${cat}"]`,
    );
    catPanel?.classList.toggle('is-active', cat === category);
  }

  syncAreaVisibility(area);
  refreshSettingsPageFilterForCategory();

  const hubId =
    category === 'integrations' ? hubForArea(area) : undefined;
  updateSettingsNavActive(area, hubId);

  if (!options?.skipHash) {
    writeSettingsHash(area);
  }

  void refreshCategoryAreas(category).then(() => {
    void detectLocalServer().then(() => refreshPromptTokenEstimate());
    const searchKey = options?.searchKey ?? pendingSearchKey;
    pendingSearchKey = null;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (searchKey) {
          const target = resolveSettingsSearchDomTarget(area, searchKey);
          if (target) {
            scrollSettingsTargetIntoView(target, { block: 'center', behavior: 'smooth' });
            flashSettingsSearchTarget(target);
            return;
          }
        }
        scrollToSettingsArea(area, { skipActivation: true });
      });
    });
  });
}

function setActiveCategory(
  category: SettingsCategoryId,
  options?: { scrollArea?: SettingsSectionId; searchKey?: string },
): void {
  const area =
    options?.scrollArea ??
    pendingScrollArea ??
    SETTINGS_CATEGORY_AREAS[category][0]!;
  pendingScrollArea = null;

  if (options?.searchKey) {
    pendingSearchKey = options.searchKey;
  }

  setActiveArea(area, { searchKey: options?.searchKey });
}

/** Activate an integrations hub from the sidebar. */
function setActiveIntegrationsHub(hubId: SettingsIntegrationsHubId): void {
  const hubDef = SETTINGS_INTEGRATIONS_HUBS.find((hub) => hub.id === hubId);
  const firstArea = hubDef?.areas[0];
  if (!firstArea) return;

  activeArea = firstArea;
  activeCategory = 'integrations';

  for (const cat of CATEGORIES) {
    const catPanel = document.querySelector(
      `.settings-category[data-category="${cat}"]`,
    );
    catPanel?.classList.toggle('is-active', cat === 'integrations');
  }

  activateIntegrationsHub(hubId);
  refreshSettingsPageFilterForCategory();
  updateSettingsNavActive(undefined, hubId);
  writeSettingsHash(firstArea);

  void refreshCategoryAreas('integrations').then(() => {
    void detectLocalServer().then(() => refreshPromptTokenEstimate());
    requestAnimationFrame(() => {
      const hub = document.getElementById(`settingsHub-${hubId}`);
      if (hub) scrollSettingsTargetIntoView(hub, { block: 'start', behavior: 'smooth' });
    });
  });
}

/** Legacy API: open a section slug (maps to category + scroll). */
export function setActiveSection(section: SettingsSectionId): void {
  setActiveArea(section);
}

function syncDevOnlySettingsNav(): void {
  const showBoard = isBoardTestingSettingsVisible();
  document
    .querySelectorAll<HTMLElement>('[data-settings-nav-area="board-testing"]')
    .forEach((el) => {
      el.hidden = !showBoard;
    });
  const boardSection = document.getElementById('settingsSection-board-testing');
  if (boardSection) boardSection.hidden = !showBoard;
}

function bindStaticSections(): void {
  if (staticBindingsDone) return;
  staticBindingsDone = true;

  syncDevOnlySettingsNav();

  const tabs = document.querySelectorAll('[data-profile-tab]');
  tabs.forEach((tab) => {
    const el = tab as HTMLButtonElement;
    el.addEventListener('click', async () => {
      const profile = el.dataset.profileTab as PromptProfile;
      await savePromptMetaSettings({ activePromptProfile: profile });
      tabs.forEach((t) =>
        (t as HTMLButtonElement).classList.toggle(
          'is-active',
          (t as HTMLButtonElement).dataset.profileTab === profile,
        ),
      );
      setStatus('ok', `Prompt profile: ${profile}`);
      await refreshSettingsSection('agent-center');
      schedulePromptTokenEstimateRefresh();
    });
  });

  document.querySelectorAll('[data-area-jump]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const area = (link as HTMLElement).dataset.areaJump as
        | SettingsSectionId
        | undefined;
      if (area) setActiveArea(area);
    });
  });

  document.querySelectorAll('[data-hub-jump]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const hub = (link as HTMLElement).dataset.hubJump as
        | SettingsIntegrationsHubId
        | undefined;
      if (hub) setActiveIntegrationsHub(hub);
    });
  });
}

async function hydrateStaticFields(): Promise<void> {
  const meta = await loadPromptMetaSettings();
  document.querySelectorAll('[data-profile-tab]').forEach((tab) => {
    const el = tab as HTMLButtonElement;
    el.classList.toggle(
      'is-active',
      el.dataset.profileTab === meta.activePromptProfile,
    );
  });
}

function getForegroundSettingsInstance() {
  const snap = getInstanceSnapshot();
  if (snap.foregroundId == null) return null;
  const inst = snap.instances.find((i) => i.id === snap.foregroundId);
  return inst?.appId === 'settings' ? inst : null;
}

/** Close fullscreen Settings opened from another app and restore that surface. */
function closeSettingsAndReturnToCaller(): boolean {
  const settingsInst = getForegroundSettingsInstance();
  const returnApp = settingsInst?.launchOptions?.returnToApp;
  if (!settingsInst || !returnApp) return false;

  const root = getSettingsRoot();
  root?.classList.remove('is-open');
  clearSettingsPageFilter();

  const launchOpts: LaunchOptions = {};
  if (returnApp === 'code') {
    launchOpts.codeSection =
      settingsInst.launchOptions?.codeSection ?? getCurrentRoute().codeSection ?? 'chat';
  }

  closeInstance(settingsInst.id);
  launchApp(returnApp, launchOpts);
  void import('./preview-electron-visibility').then((m) =>
    m.syncElectronPreviewHostVisibility(),
  );
  return true;
}

function osEmbeddedSettingsLaunchOptions(
  section?: SettingsSectionId,
  options?: { searchKey?: string },
): LaunchOptions {
  const launchOptions: LaunchOptions = {
    settingsSection: section,
    settingsSearchKey: options?.searchKey,
  };
  const foreground = getForegroundAppId();
  if (foreground === 'code') {
    launchOptions.returnToApp = 'code';
    launchOptions.codeSection = getCurrentRoute().codeSection ?? 'chat';
  } else if (foreground && foreground !== 'settings') {
    launchOptions.returnToApp = foreground;
  }
  return launchOptions;
}

// ── Open ─────────────────────────────────────────────────────────────────────

/** Open settings; optional legacy area slug or field search key for deep link. */
export function openSettings(
  section?: SettingsSectionId,
  options?: { searchKey?: string },
): void {
  if (isOsEmbedded()) {
    const foreground = getForegroundAppId();
    if (foreground !== 'settings') {
      launchApp('settings', osEmbeddedSettingsLaunchOptions(section, options));
      return;
    }
  }

  const root = getSettingsRoot();
  const shell = getChatShell();
  if (!root || !shell) return;

  void import('./experts/experts-hub').then((m) => {
    if (m.isExpertsPageOpen()) m.closeExpertLab();
  });
  void import('./welcome-page').then((m) => {
    if (m.isWelcomePageOpen()) m.closeWelcome({ skipHash: true });
  });

  const wasAlreadyOpen = root.classList.contains('is-open');

  restoreReparentedSettingsSections();
  if (!wasAlreadyOpen) {
    const searchInput = document.getElementById(
      'settingsSearchInput',
    ) as HTMLInputElement | null;
    if (searchInput) searchInput.value = '';
    clearSettingsPageFilter();
  }

  root.classList.add('is-open');
  syncSettingsOsWindowChrome();
  requestAnimationFrame(() => syncSettingsOsWindowChrome());
  if (!isOsEmbedded()) {
    shell.classList.add('hidden');
    document.querySelector('header.topbar')?.classList.add('hidden');
  }
  document.getElementById('drawer')?.setAttribute('aria-hidden', 'true');
  void import('./preview-electron-visibility').then((m) =>
    m.syncElectronPreviewHostVisibility(),
  );

  upgradeSettingsCheckboxes();
  bindStaticSections();
  initSettingsPromptEstimate();
  void hydrateStaticFields();
  void detectLocalServer().then(() => refreshPromptTokenEstimate());

  const resolvedSection = section
    ? resolveSettingsSectionNavigation(section, options?.searchKey)
    : null;
  const route = resolvedSection
    ? {
        category: categoryForArea(resolvedSection.sectionId),
        scrollArea: resolvedSection.sectionId,
        searchKey: resolvedSection.searchKey,
      }
    : parseHashRoute();

  const effectiveSearchKey = route.searchKey ?? options?.searchKey;
  if (effectiveSearchKey) {
    pendingSearchKey = effectiveSearchKey;
  }

  if (wasAlreadyOpen && route.category === activeCategory && !section && !options?.searchKey) {
    void refreshCategoryAreas(route.category);
    return;
  }

  if (route.scrollArea ?? section) {
    setActiveArea(route.scrollArea ?? resolvedSection!.sectionId, {
      searchKey: effectiveSearchKey,
      skipHash: !section && !effectiveSearchKey,
    });
    return;
  }

  setActiveCategory(route.category, {
    searchKey: effectiveSearchKey,
  });
}

/** Close settings and return to Code, the window stack, or desktop. */
export function closeSettings(options?: { skipNavigate?: boolean }): void {
  if (!options?.skipNavigate && isOsEmbedded() && closeSettingsAndReturnToCaller()) {
    return;
  }

  const root = getSettingsRoot();
  const shell = getChatShell();
  if (!root || !shell) return;
  const wasOpen = root.classList.contains('is-open');
  root.classList.remove('is-open');
  clearSettingsPageFilter();
  if (!isOsEmbedded()) {
    shell.classList.remove('hidden');
    document.querySelector('header.topbar')?.classList.remove('hidden');
    if (!options?.skipNavigate && window.location.hash.startsWith('#/settings')) {
      window.location.hash = '#/';
    }
  } else if (!options?.skipNavigate && wasOpen) {
    if (!requestCloseWindowApp('settings')) {
      navigateToDesktop();
    }
  }
  void import('./preview-electron-visibility').then((m) =>
    m.syncElectronPreviewHostVisibility(),
  );
}

function onHashChange(): void {
  const hash = window.location.hash;
  if (hash.startsWith('#/settings')) {
    if (hash === '#/settings/voice' || hash.startsWith('#/settings/voice/')) {
      void import('./models-page').then((m) => m.openModels('voice'));
      return;
    }
    const route = parseHashRoute();
    if (!getSettingsRoot()?.classList.contains('is-open')) {
      openSettings(route.scrollArea, { searchKey: route.searchKey });
    } else if (route.scrollArea) {
      if (route.scrollArea === activeArea && !pendingSearchKey && !route.searchKey) return;
      setActiveArea(route.scrollArea, { skipHash: true, searchKey: route.searchKey });
    } else {
      const defaultArea = SETTINGS_CATEGORY_AREAS[route.category][0];
      if (defaultArea === activeArea && !pendingSearchKey) return;
      setActiveCategory(route.category);
    }
    return;
  }
  if (isOsEmbedded() && isOsAppHash(hash)) {
    return;
  }
  if (getSettingsRoot()?.classList.contains('is-open')) {
    closeSettings();
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────

/** Wire nav, back button, hash routing, and in-page filter hooks. */
export function initSettingsPage(): void {
  if (pageInitialized) return;
  pageInitialized = true;

  const root = getSettingsRoot();
  if (root && isOsEmbedded()) {
    root.classList.add('settings-page--os-embedded');
  }
  syncSettingsOsWindowChrome();

  registerWindowTeardown('settings', () => closeSettings({ skipNavigate: true }));
  upgradeSettingsCheckboxes();
  initSettingsSearchFinder({
    onQueryChange: (query) => {
      if (query.trim()) applySettingsPageFilter(query);
      else clearSettingsPageFilter();
    },
  });

  document
    .getElementById('btnSettingsPageBack')
    ?.addEventListener('click', () => {
      closeSettings();
    });

  initSettingsMobileNav();

  window.addEventListener('hashchange', onHashChange);
  if (window.location.hash.startsWith('#/settings')) {
    openSettings(parseHashRoute().scrollArea);
  }

  void detectLocalServer();
}

/** Reset page init guards (tests). */
export function resetSettingsPageForTests(): void {
  pageInitialized = false;
  staticBindingsDone = false;
}

/** Topbar gear opens full settings instead of drawer when available. */
export function openSettingsFromTopbar(): void {
  openSettings('general');
}

/** Navigate to a catalog field key (chat deep-link). */
export function navigateToSettingsField(searchKey: string, area?: SettingsSectionId): void {
  const brainSection = resolveBrainMemoryRoute(searchKey, area);
  if (brainSection) {
    launchApp('brain', { brainSection });
    return;
  }
  const entry = fieldByKey(searchKey);
  const targetArea = area ?? entry?.area ?? 'general';
  openSettings(targetArea, { searchKey: entry?.key ?? searchKey });
}
