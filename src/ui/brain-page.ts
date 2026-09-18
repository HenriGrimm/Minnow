import '../styles/brain-page.css';
import '../styles/brain-graph.css';

import { isOsAppHash, isOsEmbedded } from '../os/page-bridge';
import { requestCloseWindowApp, registerWindowTeardown } from '../os/window-mounted-apps';
import { launchApp, navigateToDesktop } from '../os/router';
import { closeBrainInspector } from './brain/inspector';
import { initBrainGraphSidebarResize } from './brain/graph-sidebar-resize';
import { initBrainInspectorResize } from './brain/inspector-resize';
import { teardownGraphSection } from './brain/graph-section';
import { renderBrainSection } from './brain/sections';
import { revealInTabStrip } from './mobile-layout';
import { fetchBrainUsage } from '../brain/client';

export type BrainSectionId =
  | 'graph'
  | 'edit'
  | 'log'
  | 'schema'
  | 'proposals'
  | 'memories'
  | 'ingest'
  | 'lint'
  | 'code'
  | 'settings';

/** Legacy hash segment still routed to graph home. */
const LEGACY_SECTION_ALIASES: Record<string, BrainSectionId> = {
  wiki: 'graph',
};

const SECTIONS: BrainSectionId[] = [
  'graph',
  'edit',
  'log',
  'schema',
  'proposals',
  'memories',
  'ingest',
  'lint',
  'code',
  'settings',
];

const SECTION_LABELS: Record<BrainSectionId, string> = {
  graph: 'Graph',
  edit: 'Edit',
  log: 'Log',
  schema: 'Schema',
  proposals: 'Proposals',
  memories: 'Memories',
  ingest: 'Ingest',
  lint: 'Lint',
  code: 'Code',
  settings: 'Settings',
};

/** Section titles shown in the consolidated page header. */
const SECTION_TITLES: Record<BrainSectionId, string> = {
  graph: 'Knowledge graph',
  edit: 'Edit',
  log: 'Log',
  schema: 'Schema',
  proposals: 'Proposals',
  memories: 'Memories',
  ingest: 'Ingest',
  lint: 'Lint',
  code: 'Code',
  settings: 'Settings',
};

/** One-line descriptions for the page header lead line. */
const SECTION_LEADS: Record<BrainSectionId, string> = {
  graph: 'Explore wiki pages, tags, and wikilinks on an interactive canvas.',
  edit: 'Draft markdown with a full-page preview that matches how the wiki reads.',
  log: 'Read-only changelog from log.md.',
  schema: 'View and edit the wiki taxonomy in schema.md.',
  proposals: 'Review AI-suggested memories before they enter the wiki.',
  memories: 'Browse stored facts, tune injection, and add entries that ride along on send.',
  ingest: 'Submit a raw source; the utility model synthesizes wiki pages.',
  lint: 'Health report: orphans, stale pages, broken links, contradictions.',
  code: 'Browse the indexed repo map, search symbols, and inspect call graphs.',
  settings: 'Memory synthesis cadence, semantic embeddings, and code index settings.',
};

const BRAIN_WORKSPACE_SECTIONS: BrainSectionId[] = [
  'edit',
  'memories',
  'schema',
  'log',
  'proposals',
  'ingest',
  'lint',
  'code',
];

let activeSection: BrainSectionId = 'graph';
let staticBindingsDone = false;

// ── DOM helpers ──────────────────────────────────────────────────────────────

function getBrainRoot(): HTMLElement | null {
  return document.getElementById('brainView');
}

function getChatShell(): HTMLElement | null {
  return document.getElementById('appBody');
}

function resolveSectionId(raw: string | undefined): BrainSectionId {
  if (!raw) return 'graph';
  if (SECTIONS.includes(raw as BrainSectionId)) return raw as BrainSectionId;
  return LEGACY_SECTION_ALIASES[raw] ?? 'graph';
}

function parseHashSection(): BrainSectionId {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const match = hash.match(/^(?:app\/brain|brain)(?:\/([\w-]+))?/);
  return resolveSectionId(match?.[1]);
}

function updatePageHeader(section: BrainSectionId): void {
  const titleEl = document.getElementById('brainPageHeaderTitle');
  const leadEl = document.getElementById('brainPageHeaderLead');
  const backBtn = document.getElementById('btnBrainPageBack');
  if (titleEl) titleEl.textContent = SECTION_TITLES[section];
  if (leadEl) leadEl.textContent = SECTION_LEADS[section];
  backBtn?.classList.toggle('hidden', isOsEmbedded());
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

function setActiveSection(section: BrainSectionId, options?: { editPath?: string }): void {
  const prevSection = activeSection;
  activeSection = section;
  updatePageHeader(section);
  clearBrainHeaderActions();
  getBrainRoot()?.classList.toggle('is-graph-canvas-bg', section === 'graph');
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

  if (prevSection !== section) {
    const inspector = document.getElementById('brainInspector');
    if (inspector) closeBrainInspector(inspector);
    if (prevSection === 'graph' && section !== 'graph') {
      teardownGraphSection();
    }
  }

  const nextHash = `#/app/brain/${section}`;
  if (window.location.hash !== nextHash) {
    window.location.hash = nextHash;
  }

  void renderBrainSection(section, options);
}

function bindStaticSections(): void {
  if (staticBindingsDone) return;
  staticBindingsDone = true;

  document.getElementById('btnBrainPageBack')?.addEventListener('click', () => {
    if (requestCloseWindowApp('brain')) return;
    closeBrain();
  });

  for (const id of SECTIONS) {
    document
      .querySelector(`[data-brain-nav="${id}"]`)
      ?.addEventListener('click', () => setActiveSection(id));
  }
}

// ── Page lifecycle ───────────────────────────────────────────────────────────

function closeOtherFullPages(): void {
  void import('./models-page').then((m) => {
    if (m.isModelsPageOpen()) m.closeModels({ skipNavigate: true });
  });
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
  void import('./settings-page').then((m) => {
    const settingsRoot = document.getElementById('settingsView');
    if (settingsRoot?.classList.contains('is-open')) m.closeSettings({ skipNavigate: true });
  });
}

/** Open the Brain app (optional section deep link). */
export function openBrain(section?: BrainSectionId, options?: { editPath?: string }): void {
  const root = getBrainRoot();
  const shell = getChatShell();
  if (!root || !shell) return;

  closeOtherFullPages();
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

  const target = section ?? parseHashSection();
  if (wasAlreadyOpen && target === activeSection && !options?.editPath) {
    updatePageHeader(target);
    void renderBrainSection(target, options);
    return;
  }
  setActiveSection(target, options);
}

/** Jump to Edit with a pre-filled wiki path. */
export function openBrainEditForPath(relPath: string): void {
  if (isOsEmbedded()) {
    launchApp('brain', { brainSection: 'edit', brainEditPath: relPath });
  }
  openBrain('edit', { editPath: relPath });
}

/** Open Edit for a new wiki page (manual creation entry point). */
export function openBrainNewPage(): void {
  openBrain('edit', { editPath: 'facts/' });
  const pathEl = document.getElementById('brainEditPath') as HTMLInputElement | null;
  pathEl?.focus();
}

/** Brain stayed open in the OS layer stack (e.g. user opened Settings from the menubar). */
export function suspendBrainAppSurface(): void {
  getBrainRoot()?.classList.remove('is-graph-canvas-bg');
  teardownGraphSection();
  document.body.style.removeProperty('cursor');
}

/** Close Brain and return to chat or desktop. */
export function closeBrain(options?: { skipNavigate?: boolean }): void {
  const root = getBrainRoot();
  const shell = getChatShell();
  if (!root || !shell) return;

  root.classList.remove('is-open');

  teardownGraphSection();

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
  openBrain('graph');
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
  initBrainInspectorResize();
  initBrainGraphSidebarResize();
  window.addEventListener('hashchange', onHashChange);
  if (window.location.hash.includes('/brain')) {
    openBrain(parseHashSection());
  }
}

/** Reset module-local section state before mounting a fresh test document. */
export function resetBrainPageForTests(): void {
  activeSection = 'graph';
  staticBindingsDone = false;
}

export { SECTION_LABELS, SECTION_TITLES, SECTION_LEADS, SECTIONS };
