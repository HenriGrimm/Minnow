import '../styles/models-page.css';
import '../styles/settings-sampler.css';

import { getForegroundAppId } from '../os/instances';
import { isOsAppHash, isOsEmbedded } from '../os/page-bridge';
import { requestCloseWindowApp, registerWindowTeardown } from '../os/window-mounted-apps';
import { launchApp, navigateToDesktop } from '../os/router';
import { renderModelsSection } from './models-sections';
import { revealInTabStrip } from './mobile-layout';
import {
  DEFAULT_MODELS_SECTION,
  MODELS_SECTIONS as SECTIONS,
  MODELS_SECTION_LABELS as SECTION_LABELS,
  WORKBENCH_SECTIONS,
  type ModelsSectionId,
} from './models-section-ids';
import { initInspector } from './models/inspector';
import {
  readModelsInspectorPreference,
  setModelsInspectorOpen,
} from './models/inspector-visibility';
import { restoreReparentedSettingsSections } from './models/settings-reparent';
import { formatModelsHeaderLoadingLabel, getModelsState, runningServes, subscribeModelsStore, teardownModelsStore } from './models/store';
import { teardownServerSection } from './models/server-panel';

export type { ModelsSectionId };
export { DEFAULT_MODELS_SECTION };

let activeSection: ModelsSectionId = DEFAULT_MODELS_SECTION;
let staticBindingsDone = false;
let statusBound = false;

// ── DOM helpers ──────────────────────────────────────────────────────────────

function getModelsRoot(): HTMLElement | null {
  return document.getElementById('modelsView');
}

function getChatShell(): HTMLElement | null {
  return document.getElementById('appBody');
}

function parseHashSection(): ModelsSectionId {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const match = hash.match(/^(?:app\/models|models)(?:\/([\w-]+))?/);
  const id = match?.[1] as ModelsSectionId | undefined;
  if (id && SECTIONS.includes(id)) return id;
  return DEFAULT_MODELS_SECTION;
}

// ── Header status ────────────────────────────────────────────────────────────

/** Mirror runtime state into the app header so it reads from any section. */
function renderHeaderStatus(): void {
  const host = document.getElementById('modelsHeaderStatus');
  if (!host) return;
  const serves = runningServes();
  const running = serves.filter((s) => s.status === 'running');
  const loads = getModelsState().loads;
  const crashed = getModelsState().serves.filter((s) => s.status === 'crashed');
  const unhealthy = serves.filter((s) => s.status === 'unhealthy');
  const loading = loads.some((l) => !l.error) || serves.some((s) => s.status === 'starting');
  const failed = !loading && loads.some((l) => l.error);

  host.replaceChildren();
  const dot = document.createElement('span');
  const tone = running.length
    ? 'running'
    : loading
      ? 'starting'
      : unhealthy.length
        ? 'unhealthy'
        : crashed.length
          ? 'crashed'
          : failed
            ? 'error'
            : 'stopped';
  dot.className = `models-dot models-dot--${tone}`;
  const label = document.createElement('span');
  label.className = 'models-header-status__label';

  if (running.length) {
    label.textContent =
      running.length === 1
        ? `${running[0].modelLabel} · ${running[0].baseUrl}`
        : `${running.length} models serving`;
  } else if (loading) {
    label.textContent = formatModelsHeaderLoadingLabel(loads);
  } else if (unhealthy.length) {
    label.textContent = 'Runtime unhealthy';
  } else if (crashed.length) {
    label.textContent = crashed.length === 1 ? `${crashed[0].modelLabel} crashed` : 'Runtime crashed';
  } else if (failed) {
    label.textContent = 'Load failed';
  } else {
    label.textContent = 'No model loaded';
  }
  host.append(dot, label);
}

// ── Sections ─────────────────────────────────────────────────────────────────

function setActiveSection(section: ModelsSectionId): void {
  activeSection = section;
  const root = getModelsRoot();
  root?.classList.toggle('is-workbench', WORKBENCH_SECTIONS.has(section));
  root?.classList.toggle('is-discover', section === 'recommend');

  for (const id of SECTIONS) {
    const panel = document.getElementById(`modelsSection-${id}`);
    const nav = document.querySelector(
      `[data-models-nav="${id}"]`,
    ) as HTMLButtonElement | null;
    panel?.classList.toggle('is-active', id === section);
    nav?.setAttribute('aria-current', id === section ? 'page' : 'false');
    if (id === section) revealInTabStrip(nav);
  }

  if (!isOsEmbedded()) {
    const nextHash = `#/app/models/${section}`;
    if (window.location.hash !== nextHash) {
      window.location.hash = nextHash;
    }
  }

  void renderModelsSection(section);
}

function bindStaticSections(): void {
  if (staticBindingsDone) return;
  staticBindingsDone = true;

  for (const id of SECTIONS) {
    document
      .querySelector(`[data-models-nav="${id}"]`)
      ?.addEventListener('click', () => setActiveSection(id));
  }

  const toggle = document.getElementById('btnModelsInspector');
  toggle?.addEventListener('click', () => {
    const hidden = getModelsRoot()?.classList.contains('is-inspector-hidden');
    setModelsInspectorOpen(Boolean(hidden));
  });

  const stored = readModelsInspectorPreference();
  const wideEnough = (getModelsRoot()?.clientWidth ?? window.innerWidth) >= 1040;
  setModelsInspectorOpen(stored ? stored !== '0' : wideEnough);

  initInspector();
  if (!statusBound) {
    statusBound = true;
    subscribeModelsStore(() => renderHeaderStatus());
  }
  renderHeaderStatus();
}

// ── Page lifecycle ───────────────────────────────────────────────────────────

function closeOtherFullPages(): void {
  void import('./experts/experts-hub').then((m) => {
    if (m.isExpertsPageOpen()) m.closeExpertsHub({ skipNavigate: true });
  });
  void import('./welcome-page').then((m) => {
    if (m.isWelcomePageOpen()) m.closeWelcome({ skipHash: true });
  });
  void import('../research/panel').then((m) => {
    if (m.isResearchPageOpen()) m.closeResearch({ skipNavigate: true });
  });
  void import('./compare-page').then((m) => {
    if (m.isComparePageOpen()) m.closeCompare({ skipNavigate: true });
  });
  void import('./benchmark-page').then((m) => {
    const root = document.getElementById('benchmarkView');
    if (root?.classList.contains('is-open')) m.closeBenchmark({ skipNavigate: true });
  });
  void import('./brain-page').then((m) => {
    if (m.isBrainPageOpen()) m.closeBrain({ skipNavigate: true });
  });
  void import('./settings-page').then((m) => {
    const settingsRoot = document.getElementById('settingsView');
    if (settingsRoot?.classList.contains('is-open')) m.closeSettings({ skipNavigate: true });
  });
}

/** Open the Models app (optional section deep link). */
export function openModels(section?: ModelsSectionId): void {
  // Settings cross-links (Tools → Open Providers, search hits, Voice) call this
  // while another app is foreground. Toggle `is-open` alone leaves the OS host
  // on Settings, so Providers never becomes the visible layer.
  if (isOsEmbedded()) {
    const foreground = getForegroundAppId();
    if (foreground !== 'models') {
      launchApp('models', { modelsSection: section ?? DEFAULT_MODELS_SECTION });
      return;
    }
  }

  const root = getModelsRoot();
  const shell = getChatShell();
  if (!root || !shell) return;

  closeOtherFullPages();

  const wasAlreadyOpen = root.classList.contains('is-open');
  root.classList.add('is-open');

  if (!isOsEmbedded()) {
    shell.classList.add('hidden');
    document.querySelector('header.topbar')?.classList.add('hidden');
  }

  void import('./preview-electron-visibility').then((m) =>
    m.syncElectronPreviewHostVisibility(),
  );

  bindStaticSections();

  const target = section ?? parseHashSection();
  if (wasAlreadyOpen && target === activeSection) {
    void renderModelsSection(target);
    return;
  }
  setActiveSection(target);
}

/** Close Models and return to chat or desktop. */
export function closeModels(options?: { skipNavigate?: boolean }): void {
  const root = getModelsRoot();
  const shell = getChatShell();
  if (!root || !shell) return;

  root.classList.remove('is-open');
  restoreReparentedSettingsSections();
  teardownServerSection();
  teardownModelsStore();

  if (!isOsEmbedded()) {
    shell.classList.remove('hidden');
    document.querySelector('header.topbar')?.classList.remove('hidden');
    if (!options?.skipNavigate && window.location.hash.includes('/models')) {
      window.location.hash = '#/';
    }
  } else if (!options?.skipNavigate) {
    if (!requestCloseWindowApp('models')) {
      navigateToDesktop();
    }
  }

  void import('./preview-electron-visibility').then((m) =>
    m.syncElectronPreviewHostVisibility(),
  );
}

export function openModelsFromTopbar(): void {
  openModels(DEFAULT_MODELS_SECTION);
}

export function isModelsPageOpen(): boolean {
  return Boolean(getModelsRoot()?.classList.contains('is-open'));
}

function onHashChange(): void {
  const hash = window.location.hash;
  if (hash.startsWith('#/app/models') || hash.startsWith('#/models')) {
    openModels(parseHashSection());
    return;
  }
  if (isOsEmbedded() && isOsAppHash(hash)) return;
  if (getModelsRoot()?.classList.contains('is-open')) {
    closeModels();
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────

export function initModelsPage(): void {
  registerWindowTeardown('models', () => closeModels({ skipNavigate: true }));
  bindStaticSections();
  window.addEventListener('hashchange', onHashChange);
  if (window.location.hash.includes('/models')) {
    openModels(parseHashSection());
  }
}

export { SECTION_LABELS };
