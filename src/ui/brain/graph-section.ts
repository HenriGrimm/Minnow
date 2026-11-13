import { fetchBrainTree } from '../../brain/client';
import type { BrainPageMeta } from '../../brain/types';
import { scheduleAnimationFrame } from '../../lib/schedule-animation-frame';
import { flattenBrainTree, filterBrainTreeForDisplay, isBrainArchivePagePath } from './tree-utils';
import { buildPageGraph, filterGraphByQuery } from './graph/graph-data';
import { createForceGraph, type ForceGraphApi, type ForceGraphStats } from './graph/force-graph';
import type { GraphEmphasisKey } from './graph/types';
import { closeBrainInspector, renderBrainInspector } from './inspector';
import { initBrainGraphSidebarResize, restoreBrainGraphSidebarWidth } from './graph-sidebar-resize';
import { restoreBrainInspectorWidth } from './inspector-resize';

const SHOW_ARCHIVES_KEY = 'minnow.brain.showArchives';
const READOUT_COLLAPSED_KEY = 'minnow.brain.readoutCollapsed';
const LAYOUT_KEY = 'minnow.brain.graphLayout';
const TAGS_KEY = 'minnow.brain.graphTags';

// ── Prefs ────────────────────────────────────────────────────────────────────

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Preferences are optional in browsing contexts without local storage.
  }
}

function readShowArchivesPref(): boolean {
  return readPref(SHOW_ARCHIVES_KEY) === '1';
}

function filterCatalogPages(pages: BrainPageMeta[]): BrainPageMeta[] {
  if (readShowArchivesPref()) return pages;
  return pages.filter((p) => !isBrainArchivePagePath(p.path));
}

let selectedPath: string | null = null;
let catalogPages: BrainPageMeta[] = [];
let graphApi: ForceGraphApi | null = null;
let renderGeneration = 0;

/** Stop graph interaction when leaving Graph; leaving Brain also clears the reader. */
export function teardownGraphSection(options?: { clearSelection?: boolean }): void {
  renderGeneration += 1;
  if (options?.clearSelection) {
    setGraphSelectedPath(null);
    const inspector = document.getElementById('brainInspector');
    if (inspector) closeBrainInspector(inspector);
    syncTreeSelection();
  }
  document.body.style.removeProperty('cursor');
  const canvas = document.getElementById('brainGraphCanvas');
  canvas?.style.removeProperty('cursor');
  graphApi?.destroy();
  graphApi = null;
  overlayOffsetObserver?.disconnect();
  overlayOffsetObserver = null;
  sidebarObserver?.disconnect();
  sidebarObserver = null;
}
// Tags are on by default so the graph opens in the tag view; the toggle still lets users hide them.
let includeTags = readPref(TAGS_KEY) !== '0';
let layoutMode: 'graph' | 'tree' = readPref(LAYOUT_KEY) === 'tree' ? 'tree' : 'graph';
let highlightOrphans = false;
let orphanPaths = new Set<string>();
let searchQuery = '';
// Node classes faded out from the legend chips (view-only; never changes the data).
const mutedKinds = new Set<GraphEmphasisKey>();
let bindingsDone = false;
let firstRunHint = true;
let overlayOffsetObserver: ResizeObserver | null = null;
let sidebarObserver: ResizeObserver | null = null;
let graphStageWidth = 0;

// ── Overlay ──────────────────────────────────────────────────────────────────

/** Deferred layout sync for ResizeObserver callbacks (avoids observer feedback loops). */
const scheduleGraphLayoutSync = scheduleAnimationFrame(() => {
  if (graphApi) syncGraphOverlayOffsets();
});

/** Keep inspector/state banners aligned below the graph toolbar when it wraps. */
function syncGraphOverlayOffsets(): void {
  const root = document.getElementById('brainView');
  const toolbar = document.querySelector('.brain-graph-toolbar');
  if (!root || !toolbar) return;

  const stageWidth = root.querySelector('.brain-stage')?.getBoundingClientRect().width ?? 0;
  if (stageWidth > 0 && stageWidth !== graphStageWidth) {
    graphStageWidth = stageWidth;
    restoreBrainInspectorWidth();
    restoreBrainGraphSidebarWidth();
  }
  const styles = getComputedStyle(root);
  const pad = Number.parseFloat(styles.getPropertyValue('--brain-graph-overlay-pad')) || 0;
  const gap = Number.parseFloat(styles.getPropertyValue('--brain-graph-overlay-gap')) || 0;
  const below = pad + toolbar.getBoundingClientRect().height + gap;
  root.style.setProperty('--brain-graph-below-toolbar', `${Math.ceil(below)}px`);
  syncGraphViewportInsets();
}

/** Tell the renderer how much of the canvas the floating panels cover, so "Fit" and node centering land in clear space instead of behind the inspector. */
function syncGraphViewportInsets(): void {
  const canvas = document.getElementById('brainGraphCanvas');
  if (!canvas || !graphApi) return;
  const canvasRect = canvas.getBoundingClientRect();
  if (!canvasRect.width || !canvasRect.height) return;

  const overlap = (selector: string, edge: 'top' | 'right' | 'left' | 'bottom'): number => {
    const el = document.querySelector(selector);
    if (!el || el.classList.contains('hidden') || el.classList.contains('is-collapsed')) return 0;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height || rect.right <= canvasRect.left || rect.left >= canvasRect.right ||
        rect.bottom <= canvasRect.top || rect.top >= canvasRect.bottom) return 0;
    if (edge === 'top') return Math.max(0, rect.bottom - canvasRect.top);
    if (edge === 'left') return Math.max(0, rect.right - canvasRect.left);
    if (edge === 'bottom') return Math.max(0, canvasRect.bottom - rect.top);
    return Math.max(0, canvasRect.right - rect.left);
  };

  const stageWidth = canvas.closest('#brainView')?.querySelector('.brain-stage')
    ?.getBoundingClientRect().width ?? canvasRect.width;
  const isSheet = (selector: string): boolean => {
    const el = document.querySelector(selector);
    return Boolean(el && el.getBoundingClientRect().width >= stageWidth * 0.8);
  };
  const readerSheet = isSheet('#brainInspector.is-open');
  const listSheet = isSheet('.brain-graph-sidebar');
  const floatingReadout = layoutMode === 'graph' && document.documentElement.classList.contains('mn-graphite-apps');
  graphApi.setViewportInsets({
    top: Math.max(
      overlap('.brain-graph-toolbar', 'top'),
      listSheet ? overlap('.brain-graph-sidebar', 'top') : 0,
    ),
    left: listSheet || floatingReadout ? 0 : overlap('.brain-graph-sidebar', 'left'),
    right: readerSheet ? 0 : overlap('#brainInspector.is-open', 'right'),
    bottom: readerSheet ? overlap('#brainInspector.is-open', 'bottom') : 0,
  });
}

function bindOverlayOffsetObserver(): void {
  if (overlayOffsetObserver) return;
  const toolbar = document.querySelector('.brain-graph-toolbar');
  if (!toolbar) return;
  overlayOffsetObserver = new ResizeObserver(scheduleGraphLayoutSync);
  overlayOffsetObserver.observe(toolbar);
}

/** Re-measure insets when the rail changes width (tree layout, collapse). */
function bindSidebarObserver(): void {
  if (sidebarObserver) return;
  const sidebar = document.querySelector('.brain-graph-sidebar');
  if (!sidebar) return;
  sidebarObserver = new ResizeObserver(scheduleGraphLayoutSync);
  sidebarObserver.observe(sidebar);
  const inspector = document.getElementById('brainInspector');
  if (inspector) sidebarObserver.observe(inspector);
  const stage = sidebar.closest('.brain-stage');
  if (stage) sidebarObserver.observe(stage);
}

/** Lightweight selection path: reuses the existing simulation instead of rebuilding. */
function selectGraphPage(relPath: string, opener?: HTMLElement): void {
  const inCatalog = catalogPages.some((p) => p.path === relPath);
  setGraphSelectedPath(relPath);
  if (!graphApi || !inCatalog) {
    void renderGraphSection();
    return;
  }
  const nodeId = `page:${relPath}`;
  graphApi.selectNode(nodeId);
  syncTreeSelection();
  void openInspector(relPath, opener);
  graphApi.centerOnNode(nodeId);
}

/** Open a page from graph, tree, wikilinks, or lint. */
export function navigateBrainGraphPage(relPath: string): void {
  selectGraphPage(relPath.replace(/\\/g, '/'));
}

export function getGraphSelectedPath(): string | null {
  return selectedPath;
}

export function setGraphSelectedPath(relPath: string | null): void {
  selectedPath = relPath;
}

/** Highlight orphan pages from lint. Called just before openBrain('graph'), so the
 * navigation that follows will call renderGraphSection() and apply the updated state. */
export function setGraphOrphanPaths(paths: string[]): void {
  orphanPaths = new Set(paths);
  highlightOrphans = paths.length > 0;
  const btn = document.getElementById('brainGraphOrphanToggle');
  if (btn) btn.setAttribute('aria-pressed', highlightOrphans ? 'true' : 'false');
}

// ── Toolbar ──────────────────────────────────────────────────────────────────

function bindGraphToolbar(): void {
  if (bindingsDone) return;
  bindingsDone = true;

  document.getElementById('brainGraphNewPage')?.addEventListener('click', () => {
    void import('../brain-page').then((m) => m.openBrainNewPage());
  });

  document.getElementById('brainGraphFit')?.addEventListener('click', () => {
    graphApi?.fitToView();
  });

  document.getElementById('brainGraphZoomIn')?.addEventListener('click', () => {
    graphApi?.zoomBy(1.2);
  });

  document.getElementById('brainGraphZoomOut')?.addEventListener('click', () => {
    graphApi?.zoomBy(1 / 1.2);
  });

  document.getElementById('brainGraphLayoutToggle')?.addEventListener('click', () => {
    layoutMode = layoutMode === 'graph' ? 'tree' : 'graph';
    writePref(LAYOUT_KEY, layoutMode);
    syncLayoutVisibility();
  });

  document.getElementById('brainGraphTagToggle')?.addEventListener('click', () => {
    includeTags = !includeTags;
    writePref(TAGS_KEY, includeTags ? '1' : '0');
    const btn = document.getElementById('brainGraphTagToggle');
    btn?.setAttribute('aria-pressed', includeTags ? 'true' : 'false');
    refreshGraphCanvas();
  });
  document.getElementById('brainGraphTagToggle')?.setAttribute('aria-pressed', String(includeTags));

  document.getElementById('brainGraphOrphanToggle')?.addEventListener('click', () => {
    highlightOrphans = !highlightOrphans;
    const btn = document.getElementById('brainGraphOrphanToggle');
    btn?.setAttribute('aria-pressed', highlightOrphans ? 'true' : 'false');
    refreshGraphCanvas();
  });

  document.getElementById('brainGraphArchiveToggle')?.addEventListener('click', () => {
    const next = !readShowArchivesPref();
    writePref(SHOW_ARCHIVES_KEY, next ? '1' : '0');
    const btn = document.getElementById('brainGraphArchiveToggle');
    btn?.setAttribute('aria-pressed', next ? 'true' : 'false');
    void renderGraphSection();
  });

  const archiveBtn = document.getElementById('brainGraphArchiveToggle');
  archiveBtn?.setAttribute('aria-pressed', readShowArchivesPref() ? 'true' : 'false');

  document.getElementById('brainGraphDismissHint')?.addEventListener('click', () => {
    const hint = document.getElementById('brainGraphFirstRun');
    if (hint) hint.classList.add('hidden');
    firstRunHint = false;
  });

  const searchEl = document.getElementById('brainGraphSearch') as HTMLInputElement | null;
  searchEl?.addEventListener('input', () => {
    searchQuery = searchEl.value;
    refreshGraphCanvas();
  });

  const treeToggle = document.getElementById('brainGraphTreeToggle');
  treeToggle?.addEventListener('click', () => {
    const panel = document.getElementById('brainGraphTreePanel');
    const collapsed = panel?.classList.toggle('is-collapsed') ?? false;
    treeToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    treeToggle.setAttribute(
      'aria-label',
      collapsed ? 'Expand page tree' : 'Collapse page tree',
    );
  });

  const readoutToggle = document.getElementById('brainGraphReadoutToggle');
  const readoutPanel = document.getElementById('brainGraphLegend');
  const applyReadoutCollapsed = (collapsed: boolean): void => {
    readoutPanel?.classList.toggle('is-collapsed', collapsed);
    readoutToggle?.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    readoutToggle?.setAttribute(
      'aria-label',
      collapsed ? 'Expand structure panel' : 'Collapse structure panel',
    );
    syncGraphViewportInsets();
  };
  readoutToggle?.addEventListener('click', () => {
    const collapsed = !readoutPanel?.classList.contains('is-collapsed');
    writePref(READOUT_COLLAPSED_KEY, collapsed ? '1' : '0');
    applyReadoutCollapsed(collapsed);
  });
  applyReadoutCollapsed(readPref(READOUT_COLLAPSED_KEY) === '1');
}

/** Tree layout hides the canvas and widens the left rail; the page tree in the rail *is* the tree view, so there is only ever one tree rendered. */
function syncLayoutVisibility(): void {
  const canvasWrap = document.getElementById('brainGraphCanvasWrap');
  const stage = document.getElementById('brainGraphStage');
  const treePanel = document.getElementById('brainGraphTreePanel');
  const treeMode = layoutMode === 'tree';
  const btn = document.getElementById('brainGraphLayoutToggle');
  if (btn) {
    btn.textContent = treeMode ? 'Graph' : 'Tree';
    btn.setAttribute('aria-pressed', String(treeMode));
  }
  canvasWrap?.classList.toggle('hidden', treeMode);
  canvasWrap?.setAttribute('aria-hidden', treeMode ? 'true' : 'false');
  stage?.classList.toggle('is-tree-layout', treeMode);
  if (treeMode) treePanel?.classList.remove('is-collapsed');
  syncInspectorGraphActions();
  syncGraphViewportInsets();
}

// ── Canvas ───────────────────────────────────────────────────────────────────

function refreshGraphCanvas(): void {
  const canvas = document.getElementById('brainGraphCanvas') as HTMLCanvasElement | null;
  const statsEl = document.getElementById('brainGraphStats');
  if (!canvas) return;

  if (!graphApi) {
    graphApi = createForceGraph(canvas, {
      onSelect: (node) => {
        if (!node?.path) return;
        setGraphSelectedPath(node.path);
        syncTreeSelection();
        void openInspector(node.path);
      },
      onDoubleClick: (node) => {
        if (!node?.path) return;
        graphApi?.focusNode(node.id);
        setGraphSelectedPath(node.path);
        syncTreeSelection();
        void openInspector(node.path);
      },
      onHover: (node) => {
        graphApi?.setHoverNode(node?.id ?? null);
      },
      onNodeActionsChange: syncInspectorGraphActions,
    });
  }

  const full = buildPageGraph(catalogPages, {
    includeTags,
    orphanPaths: highlightOrphans ? orphanPaths : undefined,
  });
  const data = searchQuery.trim() ? filterGraphByQuery(full, searchQuery) : full;

  const metrics = document.getElementById('brainGraphRailMetrics');
  if (metrics) {
    const rows = [['Pages', catalogPages.length], ['Graph links', full.edges.length]] as const;
    metrics.replaceChildren(...rows.map(([label, value]) => {
      const row = document.createElement('span');
      const count = document.createElement('b');
      count.textContent = value.toLocaleString();
      row.append(label, count);
      return row;
    }));
  }

  graphApi.setData(data.nodes, data.edges);
  graphApi.setMutedKinds(mutedKinds);

  if (statsEl) {
    const narrowed = data.nodes.length !== full.nodes.length;
    statsEl.textContent = narrowed
      ? `${data.nodes.length} of ${full.nodes.length} match`
      : '';
    statsEl.classList.toggle('hidden', !narrowed);
  }
  syncGraphReadout(graphApi.getStats());
  syncGraphOverlayOffsets();

  if (selectedPath) {
    const nodeId = `page:${selectedPath}`;
    graphApi.selectNode(nodeId);
    syncTreeSelection();
  }
  syncInspectorGraphActions();
}

/** Build one label/value cell for the readout metric grid. */
function buildMetricCell(label: string, value: string, tone?: 'warn'): HTMLElement {
  const cell = document.createElement('div');
  cell.className = 'brain-graph-metric';
  if (tone) cell.dataset.tone = tone;
  const name = document.createElement('span');
  name.className = 'brain-graph-metric__label';
  name.textContent = label;
  const num = document.createElement('span');
  num.className = 'brain-graph-metric__value';
  num.textContent = value;
  cell.append(name, num);
  return cell;
}

/** Structure readout: counts, weave density, the most connected pages, and legend chips that fade a node class out of the canvas. */
function syncGraphReadout(stats: ForceGraphStats): void {
  const body = document.getElementById('brainGraphReadoutBody');
  if (!body) return;
  body.replaceChildren();
  const graphite = document.documentElement.classList.contains('mn-graphite-apps');

  const metrics = document.createElement('div');
  metrics.className = 'brain-graph-readout__metrics';
  metrics.append(
    buildMetricCell('Pages', String(stats.kinds.page)),
    buildMetricCell('Links', String(stats.edgeCount)),
  );
  if (includeTags || graphite) metrics.append(buildMetricCell('Tags', String(stats.kinds.tag)));
  if (!graphite) metrics.append(buildMetricCell('Density', stats.density.toFixed(1)));
  if (stats.orphanCount > 0 || graphite) {
    metrics.append(buildMetricCell('Orphans', String(stats.orphanCount), stats.orphanCount ? 'warn' : undefined));
  }
  body.append(metrics);

  const visibleHubs = graphite ? stats.hubs.filter(hub => hub.path).slice(0, 5) : stats.hubs.slice(0, 3);
  if (visibleHubs.length) {
    const hubs = document.createElement('div');
    hubs.className = 'brain-graph-hubs';
    const heading = document.createElement('p');
    heading.className = 'brain-graph-hubs__title';
    heading.textContent = graphite ? 'Hubs' : 'Most connected';
    hubs.append(heading);

    const max = visibleHubs[0].degree || 1;
    for (const hub of visibleHubs) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'brain-graph-hub';
      row.title = hub.path ?? hub.label;
      if (hub.path) {
        row.addEventListener('click', () => navigateBrainGraphPage(hub.path!));
      } else {
        row.disabled = true;
      }
      const name = document.createElement('span');
      name.className = 'brain-graph-hub__name';
      name.textContent = hub.label;
      const bar = document.createElement('span');
      bar.className = 'brain-graph-hub__bar';
      bar.style.setProperty('--fill', `${Math.round((hub.degree / max) * 100)}%`);
      const count = document.createElement('span');
      count.className = 'brain-graph-hub__count';
      count.textContent = String(hub.degree);
      row.append(name, bar, count);
      hubs.append(row);
    }
    body.append(hubs);
  }

  const legend = document.createElement('div');
  legend.className = 'brain-graph-legend';
  const chips: Array<{ key: GraphEmphasisKey; label: string; count: number }> = [
    { key: 'page', label: 'Pages', count: stats.kinds.page },
    { key: 'tag', label: 'Tags', count: stats.kinds.tag },
    { key: 'orphan', label: 'Orphans', count: stats.orphanCount },
  ];
  for (const chip of chips) {
    if (chip.count === 0 && chip.key !== 'page') continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'brain-graph-legend__item';
    btn.dataset.kind = chip.key;
    const muted = mutedKinds.has(chip.key);
    btn.setAttribute('aria-pressed', muted ? 'false' : 'true');
    btn.title = muted ? `Show ${chip.label.toLowerCase()}` : `Fade ${chip.label.toLowerCase()}`;
    const swatch = document.createElement('span');
    swatch.className = `brain-graph-legend__swatch brain-graph-legend__swatch--${chip.key}`;
    swatch.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.textContent = chip.label;
    const count = document.createElement('span');
    count.className = 'brain-graph-legend__count';
    count.textContent = String(chip.count);
    btn.append(swatch, text, count);
    btn.addEventListener('click', () => {
      if (mutedKinds.has(chip.key)) mutedKinds.delete(chip.key);
      else mutedKinds.add(chip.key);
      graphApi?.setMutedKinds(mutedKinds);
      if (graphApi) syncGraphReadout(graphApi.getStats());
    });
    legend.append(btn);
  }
  body.append(legend);
}

// ── Inspector ────────────────────────────────────────────────────────────────

function syncInspectorGraphActions(): void {
  const actions = document.querySelector<HTMLElement>('.brain-inspector__graph-actions');
  if (!actions) return;
  const id = actions.dataset.nodeId!;
  actions.hidden = layoutMode !== 'graph' || !graphApi?.hasNode(id);
  actions.querySelector('[data-graph-action="focus"]')?.setAttribute('aria-pressed', String(graphApi?.isNodeFocused(id) ?? false));
  actions.querySelector('[data-graph-action="pin"]')?.setAttribute('aria-pressed', String(graphApi?.isNodePinned(id) ?? false));
}

function createInspectorGraphActions(relPath: string): HTMLElement {
  const id = `page:${relPath}`;
  const actions = document.createElement('div');
  actions.className = 'brain-inspector__graph-actions';
  actions.dataset.nodeId = id;
  actions.hidden = true;
  actions.setAttribute('role', 'group');
  actions.setAttribute('aria-label', 'Graph actions');
  for (const [action, label] of [['focus', 'Focus neighborhood'], ['pin', 'Pin node']] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'brain-action-btn';
    button.dataset.graphAction = action;
    button.textContent = label;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => {
      if (!graphApi?.hasNode(id)) return;
      if (action === 'pin') graphApi.setNodePinned(id, !graphApi.isNodePinned(id));
      else if (graphApi.isNodeFocused(id)) graphApi.clearFocus();
      else graphApi.focusNode(id);
    });
    actions.append(button);
  }
  return actions;
}

async function openInspector(relPath: string, opener?: HTMLElement): Promise<void> {
  const inspector = document.getElementById('brainInspector');
  if (!inspector) return;
  const graphActions = createInspectorGraphActions(relPath);
  const reading = renderBrainInspector(
    inspector,
    relPath,
    catalogPages,
    navigateBrainGraphPage,
    (path) => {
      void import('../brain-page').then((m) => m.openBrainEditForPath(path));
    },
    async () => {
      await renderGraphSection();
    },
    () => {
      setGraphSelectedPath(null);
      graphApi?.selectNode(null);
      syncTreeSelection();
      syncGraphOverlayOffsets();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    },
    graphActions,
  );
  syncGraphOverlayOffsets();
  await reading;
  syncInspectorGraphActions();
  if (selectedPath === relPath && opener && document.activeElement === opener) {
    inspector.querySelector<HTMLElement>('.brain-inspector__title')?.focus({ preventScroll: true });
  }
}

// ── Tree ─────────────────────────────────────────────────────────────────────

function renderGraphTree(mount: HTMLElement, tree: Record<string, unknown>): void {
  mount.replaceChildren();
  const list = document.createElement('ul');
  list.className = 'brain-tree';

  let folderId = 0;
  const appendNodes = (parent: HTMLElement, node: Record<string, unknown>): void => {
    const entries = Object.entries(node).sort(([a], [b]) => a.localeCompare(b));
    for (const [name, value] of entries) {
      if (!value || typeof value !== 'object') continue;
      const item = document.createElement('li');
      item.className = 'brain-tree__item';
      const record = value as Record<string, unknown>;

      if (record.type === 'page') {
        const path = String(record.path ?? '');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'brain-tree__page';
        btn.dataset.path = path;
        btn.textContent = String(record.title ?? name);
        btn.setAttribute('aria-current', path === selectedPath ? 'page' : 'false');
        btn.addEventListener('click', (event) => {
          selectGraphPage(path, event.detail === 0 ? btn : undefined);
        });
        item.append(btn);
        parent.append(item);
        continue;
      }

      if (record.type === 'folder') {
        const folderBtn = document.createElement('button');
        folderBtn.type = 'button';
        folderBtn.className = 'brain-tree__folder';
        folderBtn.textContent = name;
        folderBtn.setAttribute('aria-expanded', 'true');
        const childList = document.createElement('ul');
        childList.className = 'brain-tree__children';
        childList.id = `brain-page-folder-${++folderId}`;
        folderBtn.setAttribute('aria-controls', childList.id);
        const children = record.children as Record<string, unknown> | undefined;
        if (children) appendNodes(childList, children);
        folderBtn.addEventListener('click', () => {
          const open = childList.hidden;
          childList.hidden = !open;
          folderBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
        item.append(folderBtn, childList);
        parent.append(item);
      }
    }
  };

  appendNodes(list, tree);
  mount.append(list);
}

function syncTreeSelection(): void {
  document.querySelectorAll('.brain-tree__page').forEach((btn) => {
    const path = (btn as HTMLButtonElement).dataset.path ?? '';
    btn.setAttribute('aria-current', path === selectedPath ? 'page' : 'false');
  });
}

function showFirstRunHint(): void {
  const hint = document.getElementById('brainGraphFirstRun');
  if (!hint || !firstRunHint) return;
  if (catalogPages.length > 1) {
    hint.classList.add('hidden');
    firstRunHint = false;
    return;
  }
  hint.classList.remove('hidden');
}

/** Render graph home section. */
export async function renderGraphSection(): Promise<void> {
  bindGraphToolbar();
  initBrainGraphSidebarResize();
  restoreBrainInspectorWidth();

  const treeMount = document.getElementById('brainGraphTree');
  const offlineEl = document.getElementById('brainGraphOffline');
  const emptyEl = document.getElementById('brainGraphEmpty');
  const stageEl = document.getElementById('brainGraphStage');
  if (!treeMount || !stageEl) return;
  const generation = ++renderGeneration;
  const inspector = document.getElementById('brainInspector');
  bindOverlayOffsetObserver();
  bindSidebarObserver();
  syncLayoutVisibility();

  const tree = await fetchBrainTree();
  if (generation !== renderGeneration) return;
  const online = tree !== null;
  offlineEl?.classList.toggle('hidden', online);
  stageEl.classList.toggle('is-offline', !online);

  if (!online) {
    treeMount.replaceChildren();
    graphApi?.destroy();
    graphApi = null;
    if (inspector) closeBrainInspector(inspector);
    emptyEl?.classList.add('hidden');
    return;
  }

  catalogPages = filterCatalogPages(flattenBrainTree(tree));
  if (selectedPath && !catalogPages.some((p) => p.path === selectedPath)) {
    setGraphSelectedPath(null);
  }
  const treeRecord = filterBrainTreeForDisplay(
    tree,
    readShowArchivesPref(),
  ) as Record<string, unknown>;
  renderGraphTree(treeMount, treeRecord);

  const hasPages = catalogPages.length > 0;
  emptyEl?.classList.toggle('hidden', hasPages);
  stageEl.classList.toggle('is-empty', !hasPages);

  if (!hasPages) {
    graphApi?.destroy();
    graphApi = null;
    if (inspector) closeBrainInspector(inspector);
    return;
  }

  if (selectedPath) void openInspector(selectedPath);
  else if (inspector) closeBrainInspector(inspector);
  refreshGraphCanvas();
  showFirstRunHint();
}

