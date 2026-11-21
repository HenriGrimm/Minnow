import '../styles/brain-page.css';
import '../styles/brain-memories.css';

import { isOsAppHash, isOsEmbedded } from '../os/page-bridge';
import { requestCloseWindowApp, registerWindowTeardown } from '../os/window-mounted-apps';
import { navigateToDesktop } from '../os/router';
import { renderBrainSection } from './brain/sections';
import { teardownMemoriesSection } from './brain/memories-section';
import { revealInTabStrip } from './mobile-layout';
import { fetchBrainUsage } from '../brain/client';

export type BrainSectionId =
  | 'memories'
  | 'proposals'
  | 'code'
  | 'settings';

const SECTIONS: BrainSectionId[] = [
  'memories',
  'proposals',
  'code',
  'settings',
];

const SECTION_LABELS: Record<BrainSectionId, string> = {
  proposals: 'Proposals',
  memories: 'Memories',
  code: 'Code map',
  settings: 'Settings',
};

/** Section titles shown in the consolidated page header. */
const SECTION_TITLES: Record<BrainSectionId, string> = {
  proposals: 'Skill proposals',
  memories: 'Memories',
  code: 'Code map',
  settings: 'Settings',
};

/** One-line descriptions for the page header lead line. */
const SECTION_LEADS: Record<BrainSectionId, string> = {
  proposals: 'Review skills suggested from completed conversations.',
  memories: 'What agents remember for this project and across all your projects.',
  code: 'Browse the indexed repo map, search symbols, and inspect call graphs.',
  settings: 'Skill suggestions, semantic embeddings, and code index settings.',
};

const BRAIN_WORKSPACE_SECTIONS: BrainSectionId[] = [
  'memories',
  'proposals',
  'code',
];

let activeSection: BrainSectionId = 'memories';
let staticBindingsDone = false;

// ── DOM helpers ──────────────────────────────────────────────────────────────

function getBrainRoot(): HTMLElement | null {
  return document.getElementById('brainView');
}

function getChatShell(): HTMLElement | null {
  return document.getElementById('appBody');
}

function resolveSectionId(raw: string | undefined): BrainSectionId {
  if (!raw) return 'memories';
  if (SECTIONS.includes(raw as BrainSectionId)) return raw as BrainSectionId;
  return 'memories';
}

function parseHashSection(): BrainSectionId {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const match = hash.match(/^(?:app\/brain|brain)(?:\/([\w-]+))?/);
  return resolveSectionId(match?.[1]);
}

function updatePageHeader(section: BrainSectionId): void {
  const titleEl = document.getElementById('brainPageHeaderTitle');
  const leadEl = document.getElementById('brainPageHeaderLead');
  if (titleEl) titleEl.textContent = SECTION_TITLES[section];
  if (leadEl) leadEl.textContent = SECTION_LEADS[section];
  void refreshUsageLine();
}

// ── Usage ────────────────────────────────────────────────────────────────────

/** Weeks of history drawn in the header sparkline. */
const USAGE_SPARK_WEEKS = 10;

/** One mono counter with its caption for the header activity readout. */
function buildUsageCounter(value: number, label: string): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'brain-usage__metric';
  const num = document.createElement('b');
  num.textContent = String(value);
  wrap.append(num, document.createTextNode(` ${label}`));
  return wrap;
}

/** Bar sparkline of total weekly Brain activity, newest bar last. */
function buildUsageSpark(weeks: Array<{ week: string; total: number }>): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const width = weeks.length * 5 - 2;
  const height = 11;
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'brain-usage__spark');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('aria-hidden', 'true');

  const max = Math.max(1, ...weeks.map((w) => w.total));
  weeks.forEach((entry, index) => {
    const bar = document.createElementNS(ns, 'rect');
    const barHeight = entry.total === 0 ? 1 : Math.max(2, (entry.total / max) * height);
    bar.setAttribute('x', String(index * 5));
    bar.setAttribute('y', String(height - barHeight));
    bar.setAttribute('width', '3');
    bar.setAttribute('height', String(barHeight));
    bar.setAttribute('rx', '1');
    if (index === weeks.length - 1) bar.setAttribute('class', 'is-current');
    svg.append(bar);
  });
  return svg;
}

/** Show Brain activity in the header: this week's writes and reads plus a ten-week trend. */
async function refreshUsageLine(): Promise<void> {
  const el = document.getElementById('brainPageHeaderUsage');
  if (!el) return;

  const usage = await fetchBrainUsage();
  if (!usage) {
    el.classList.add('hidden');
    el.removeAttribute('title');
    el.removeAttribute('aria-label');
    return;
  }

  const reads = usage.thisWeek['agent-read'] ?? 0;
  const writes =
    (usage.thisWeek['agent-write'] ?? 0) +
    (usage.thisWeek['synthesis-write'] ?? 0) +
    (usage.thisWeek['proposal-accepted'] ?? 0);

  if (reads === 0 && writes === 0) {
    el.classList.add('hidden');
    el.removeAttribute('title');
    el.removeAttribute('aria-label');
    return;
  }

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const history = Object.entries(usage.weeks ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-USAGE_SPARK_WEEKS)
    .map(([week, counters]) => ({
      week,
      total: Object.values(counters).reduce((sum, n) => sum + (n || 0), 0),
    }));

  el.replaceChildren(buildUsageCounter(writes, 'writes'), buildUsageCounter(reads, 'reads'));
  if (history.length > 1) el.append(buildUsageSpark(history));

  el.setAttribute('title', 'Brain activity this week');
  el.setAttribute(
    'aria-label',
    history.length > 1
      ? `This week: ${plural(writes, 'write')}, ${plural(reads, 'read')}. Trend over the last ${history.length} weeks.`
      : `This week: ${plural(writes, 'write')}, ${plural(reads, 'read')}`,
  );
  el.classList.remove('hidden');
}

/** Populate the header action slot (cleared on every section switch). */
export function setBrainHeaderActions(...nodes: Node[]): void {
  const mount = document.getElementById('brainPageHeaderActions');
  if (!mount) return;
  mount.replaceChildren(...nodes);
}

export function clearBrainHeaderActions(): void {
  setBrainHeaderActions();
}

// ── Sections ─────────────────────────────────────────────────────────────────

function setActiveSection(section: BrainSectionId): void {
  activeSection = section;
  updatePageHeader(section);
  clearBrainHeaderActions();
  for (const id of SECTIONS) {
    const panel = document.getElementById(`brainSection-${id}`);
    const nav = document.querySelector(
      `[data-brain-nav="${id}"]`,
    ) as HTMLButtonElement | null;
    panel?.classList.toggle('is-active', id === section);
    nav?.setAttribute('aria-current', id === section ? 'page' : 'false');
    if (id === section) revealInTabStrip(nav);
  }

  document
    .querySelector('.brain-content')
    ?.classList.toggle('is-brain-workspace', BRAIN_WORKSPACE_SECTIONS.includes(section));

  const nextHash = `#/app/brain/${section}`;
  if (!getBrainRoot()?.closest('.m-native-app-host') && window.location.hash !== nextHash) {
    window.location.hash = nextHash;
  }

  void renderBrainSection(section);
}

function bindStaticSections(): void {
  if (staticBindingsDone) return;
  staticBindingsDone = true;

  const rail = getBrainRoot()?.querySelector<HTMLElement>('.brain-rail');
  if (rail) {
    for (const id of SECTIONS) {
      const control = rail.querySelector(`[data-brain-nav="${id}"]`);
      if (!control) continue;
      control.addEventListener('click', () => setActiveSection(id));
      if (id === 'code') {
        const label = control.querySelector('.brain-rail__label');
        if (label) label.textContent = 'Code map';
      }
      rail.append(control);
    }
    const metrics = document.createElement('div');
    metrics.className = 'brain-graphite-metrics';
    metrics.id = 'brainGraphRailMetrics';
    rail.append(metrics);
  }
}

// ── Page lifecycle ───────────────────────────────────────────────────────────

function closeOtherFullPages(): void {
  void import('./models-page').then((m) => {
    if (m.isModelsPageOpen()) m.closeModels({ skipNavigate: true });
  });
  void import('./welcome-page').then((m) => {
    if (m.isWelcomePageOpen()) m.closeWelcome({ skipHash: true });
  });
  void import('./settings-page').then((m) => {
    const settingsRoot = document.getElementById('settingsView');
    if (settingsRoot?.classList.contains('is-open')) m.closeSettings({ skipNavigate: true });
  });
}

/** Open the Brain app (optional section deep link). */
export function openBrain(section?: BrainSectionId): void {
  const root = getBrainRoot();
  const shell = getChatShell();
  if (!root || !shell) return;

  if (!root.closest('.m-native-app-host')) closeOtherFullPages();
  void import('./code-brain-map').then((m) => m.closeCodeBrainMap());

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

  const target = section ? resolveSectionId(section) : parseHashSection();
  if (wasAlreadyOpen && target === activeSection) {
    updatePageHeader(target);
    void renderBrainSection(target);
    return;
  }
  setActiveSection(target);
}

/** Brain stayed open in the OS layer stack (e.g. user opened Settings from the menubar). */
export function suspendBrainAppSurface(): void {
  teardownMemoriesSection();
  document.body.style.removeProperty('cursor');
}

/** Close Brain and return to chat or desktop. */
export function closeBrain(options?: { skipNavigate?: boolean }): void {
  const root = getBrainRoot();
  const shell = getChatShell();
  if (!root || !shell) return;

  root.classList.remove('is-open');
  teardownMemoriesSection();

  if (!isOsEmbedded()) {
    shell.classList.remove('hidden');
    document.querySelector('header.topbar')?.classList.remove('hidden');
    if (!options?.skipNavigate && window.location.hash.includes('/brain')) {
      window.location.hash = '#/';
    }
  } else if (!options?.skipNavigate) {
    if (!requestCloseWindowApp('brain')) {
      navigateToDesktop();
    }
  }

  void import('./preview-electron-visibility').then((m) =>
    m.syncElectronPreviewHostVisibility(),
  );
}

export function openBrainFromTopbar(): void {
  openBrain('memories');
}

export function isBrainPageOpen(): boolean {
  return Boolean(getBrainRoot()?.classList.contains('is-open'));
}

function onHashChange(): void {
  const hash = window.location.hash;
  if (hash.startsWith('#/app/brain') || hash.startsWith('#/brain')) {
    const section = parseHashSection();
    if (isBrainPageOpen() && section === activeSection) {
      return;
    }
    openBrain(section);
    return;
  }
  if (isOsEmbedded() && isOsAppHash(hash)) return;
  if (getBrainRoot()?.classList.contains('is-open')) {
    closeBrain();
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────

export function initBrainPage(): void {
  registerWindowTeardown('brain', () => closeBrain({ skipNavigate: true }));
  bindStaticSections();
  window.addEventListener('hashchange', onHashChange);
  if (window.location.hash.includes('/brain')) {
    openBrain(parseHashSection());
  }
}

/** Reset module-local section state before mounting a fresh test document. */
export function resetBrainPageForTests(): void {
  activeSection = 'memories';
  staticBindingsDone = false;
}

export { SECTION_LABELS, SECTION_TITLES, SECTION_LEADS, SECTIONS };
