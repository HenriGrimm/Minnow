/**
 * Code map page: a pannable map of the workspace at three depths — architecture (layers
 * and modules), files (one folder) and calls (one symbol) — with an inspector, search,
 * and index controls. Hosted by the Brain "Code" section and the Code app overlay.
 */

import '../../styles/code-map.css';

import { appConfirm } from '../app-dialog';
import {
  clearBrainCodeIndex,
  fetchBrainCodeCallsOf,
  fetchBrainCodeExplain,
  fetchBrainCodeReadSymbol,
  fetchBrainCodeStatus,
  fetchBrainCodeWhoCalls,
  fetchCodeMapArchitecture,
  fetchCodeMapFile,
  fetchCodeMapFolder,
  findBrainCodeSymbol,
  reindexBrainCode,
  searchCodeMapPaths,
} from '../../brain/client';
import type {
  BrainCodeIndexRun,
  BrainCodeStatus,
  BrainCodeSymbolMatch,
  BrainCodeSymbolRef,
  CodeMapArchitecture,
  CodeMapFolder,
} from '../../brain/types';
import { brainWorkspaceKeyFromPath } from '../../lib/brain-workspace-key';
import { getWorkspacePath } from '../../state/workspace';
import { openCodeRefInViewer } from '../code-ref-link';
import { sceneToPng } from './export';
import {
  PICKER_GLYPHS,
  hasFolderIconOverride,
  kindBadge,
  languageTag,
  packageIcon,
  renderIcon,
  setFolderIconOverride,
} from './icons';
import {
  renderFileInspector,
  renderFolderInspector,
  renderIdleInspector,
  renderMoreInspector,
  renderPackageInspector,
  renderSymbolInspector,
  type InspectorActions,
  type LinkRow,
} from './inspector';
import { layoutArchitecture, layoutCalls, layoutFolder, type SceneLayout } from './layout';
import {
  COMMON_CALL_NAMES,
  buildArchModel,
  buildCallModel,
  buildFolderModel,
  folderDisplayPath,
  linksOf,
  toMermaid,
  type ArchModel,
  type CallModel,
  type FolderModel,
  type LinkFilter,
  type MapLink,
  type MapNode,
} from './model';
import { nodeIcon, renderScene, toneVar, type SceneApi } from './scene';
import { createViewport, type ViewportApi } from './viewport';
import { renderSymbolPicker } from './symbol-picker';

type View = 'architecture' | 'files' | 'calls';

interface CurrentScene {
  nodes: Map<string, MapNode>;
  links: MapLink[];
  layout: SceneLayout;
}

const state = {
  view: 'architecture' as View,
  repoKey: '',
  arch: null as CodeMapArchitecture | null,
  archModel: null as ArchModel | null,
  folderPath: null as string | null,
  folder: null as CodeMapFolder | null,
  folderModel: null as FolderModel | null,
  symbolId: null as string | null,
  callPickerFile: null as string | null,
  symbol: null as BrainCodeSymbolMatch | null,
  symbolSource: '',
  callModel: null as CallModel | null,
  callDepth: 1 as 1 | 2,
  hideCommon: true,
  selected: null as string | null,
  showTests: false,
  links: 'strong' as LinkFilter,
  expanded: new Set<string>(),
  status: null as BrainCodeStatus | null,
  scene: null as CurrentScene | null,
};

let bound = false;
let viewport: ViewportApi | null = null;
let sceneApi: SceneApi | null = null;
let renderToken = 0;
let inspectToken = 0;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let searchToken = 0;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let statusPoll: ReturnType<typeof setTimeout> | null = null;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;

/** Workspace scope for code index calls (matches the tool workspace). */
function ctx(): { workspaceRoot?: string; repo?: string } {
  const workspaceRoot = getWorkspacePath().trim();
  if (!workspaceRoot) return {};
  return { workspaceRoot, repo: brainWorkspaceKeyFromPath(workspaceRoot) || undefined };
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}

function toast(kind: 'ok' | 'err' | 'spin', message: string): void {
  const el = $('brainCodeActionStatus');
  if (!el) return;
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = !message;
  if (toastTimer) clearTimeout(toastTimer);
  if (kind !== 'spin' && message) {
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 4500);
  }
}

// ── Status ───────────────────────────────────────────────────────────────────

function relativeAge(iso: string | null): string {
  if (!iso) return 'never indexed';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return 'indexed';
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'indexed just now';
  if (min < 60) return `indexed ${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `indexed ${h} h ago`;
  return `indexed ${Math.round(h / 24)} days ago`;
}

function renderStatus(): void {
  const el = $('brainCodeStatusLine');
  if (!el) return;
  const status = state.status;
  el.replaceChildren();
  const dot = document.createElement('span');
  dot.className = 'code-map-status__dot';
  const text = document.createElement('span');
  const counts = document.createElement('span');
  counts.className = 'code-map-status__counts';
  if (!status) {
    dot.dataset.kind = 'off';
    text.textContent = 'Offline';
  } else if (!status.enabled) {
    dot.dataset.kind = 'off';
    text.textContent = 'Code index is off in Settings';
  } else if (status.indexing) {
    dot.dataset.kind = 'busy';
    const done = status.filesDone ?? 0;
    const total = status.filesTotal ?? 0;
    text.textContent = total ? `Indexing ${done.toLocaleString()} / ${total.toLocaleString()} files` : 'Indexing…';
  } else {
    dot.dataset.kind = status.symbolCount ? 'ok' : 'off';
    const age = relativeAge(status.lastIndexedAt);
    text.textContent = age.charAt(0).toUpperCase() + age.slice(1);
    counts.textContent = `${plural(status.fileCount, 'file')} · ${plural(status.symbolCount, 'symbol')}`;
  }
  el.append(dot, text, counts);
}

async function refreshStatus(): Promise<BrainCodeStatus | null> {
  state.status = await fetchBrainCodeStatus(ctx());
  renderStatus();
  if (statusPoll) clearTimeout(statusPoll);
  if (state.status?.indexing) {
    statusPoll = setTimeout(() => {
      void refreshStatus().then((s) => {
        if (s && !s.indexing) void reloadArchitecture();
      });
    }, 2000);
  }
  return state.status;
}

// ── Empty / loading overlay ──────────────────────────────────────────────────

function showOverlay(title: string, message: string, action?: { label: string; onClick: () => void }): void {
  const el = $('codeMapEmpty');
  if (!el) return;
  el.replaceChildren();
  el.hidden = false;
  const card = document.createElement('div');
  card.className = 'code-map-empty__card';
  const h = document.createElement('h2');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = message;
  card.append(h, p);
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'code-map-btn is-primary';
    btn.textContent = action.label;
    btn.addEventListener('click', action.onClick);
    card.append(btn);
  }
  el.append(card);
}

function hideOverlay(): void {
  const el = $('codeMapEmpty');
  if (el) el.hidden = true;
}

// ── Scene ────────────────────────────────────────────────────────────────────

function ensureViewport(): ViewportApi | null {
  if (viewport) return viewport;
  const vp = $('codeMapViewport');
  const scene = $('codeMapScene');
  if (!vp || !scene) return null;
  viewport = createViewport(vp, scene, $<HTMLCanvasElement>('codeMapMinimap'));
  viewport.onChange((s) => {
    const label = $('codeMapZoomLabel');
    if (label) label.textContent = `${Math.round(s.k * 100)}%`;
  });
  return viewport;
}

function drawScene(scene: CurrentScene, opts: { fit: boolean }): void {
  const svg = document.getElementById('codeMapEdges') as SVGSVGElement | null;
  const nodesEl = $('codeMapNodes');
  const vp = ensureViewport();
  if (!svg || !nodesEl || !vp) return;
  state.scene = scene;
  sceneApi = renderScene(svg, nodesEl, {
    repo: state.repoKey,
    nodes: scene.nodes,
    links: scene.links,
    layout: scene.layout,
    onSelect: (id) => select(id),
    onOpen: (id) => openNode(id),
    onContextMenu: (id, ev) => showNodeMenu(id, ev),
    wasDrag: () => vp.consumeDrag(),
  });
  vp.setContent(scene.layout.width, scene.layout.height);
  vp.setMinimapShapes([
    ...scene.layout.frames.map((f) => ({ x: f.x, y: f.y, w: f.w, h: f.h, frame: true })),
    ...[...scene.layout.boxes.values()].map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h, frame: false })),
  ]);
  if (opts.fit) vp.fit({ maxScale: 1 });
  sceneApi.setSelection(state.selected);
  hideOverlay();
}

function clearScene(): void {
  state.scene = null;
  sceneApi = null;
  ($('codeMapNodes') as HTMLElement | null)?.replaceChildren();
  (document.getElementById('codeMapEdges') as SVGSVGElement | null)?.replaceChildren();
  viewport?.setMinimapShapes([]);
}

// ── Views ────────────────────────────────────────────────────────────────────

async function loadArchitecture(force = false): Promise<CodeMapArchitecture | null> {
  if (state.arch && !force) return state.arch;
  const arch = await fetchCodeMapArchitecture(ctx());
  state.arch = arch;
  return arch;
}

async function reloadArchitecture(): Promise<void> {
  state.arch = null;
  await loadArchitecture(true);
  await render({ fit: true });
}

function archOptions() {
  return { showTests: state.showTests, links: state.links, expandedGroups: state.expanded };
}

async function renderArchitecture(fit: boolean, token: number): Promise<void> {
  if (!state.arch) showOverlay('Loading the map…', 'Reading the code index for this workspace.');
  const arch = await loadArchitecture();
  if (token !== renderToken) return;
  if (!arch) {
    clearScene();
    showOverlay('Map unavailable', 'Start Minnow’s tool server, then reindex this workspace.', {
      label: 'Reindex',
      onClick: () => void runReindex(),
    });
    return;
  }
  if (!arch.fileCount) {
    clearScene();
    showOverlay(
      state.status?.indexing ? 'Indexing this workspace…' : 'No code index yet',
      state.status?.indexing
        ? 'The map appears when indexing finishes.'
        : 'Index the workspace to map its modules, files and calls.',
      state.status?.indexing ? undefined : { label: 'Index workspace', onClick: () => void runReindex() },
    );
    return;
  }
  state.repoKey = arch.repo;
  const model = buildArchModel(arch, archOptions());
  state.archModel = model;
  drawScene({ nodes: model.nodes, links: model.links, layout: layoutArchitecture(model) }, { fit });
}

async function renderFiles(fit: boolean, token: number): Promise<void> {
  if (state.folderPath === null) state.folderPath = state.arch?.base ?? '';
  const path = state.folderPath;
  if (!state.folder || state.folder.path !== path) {
    showOverlay('Loading files…', folderDisplayPath(path));
    state.folder = await fetchCodeMapFolder(path, ctx());
    if (token !== renderToken) return;
  }
  const folder = state.folder;
  if (!folder) {
    clearScene();
    showOverlay('Folder unavailable', 'This folder could not be read from the code index.');
    return;
  }
  if (!folder.nodes.length) {
    clearScene();
    showOverlay('Nothing indexed here', `${folderDisplayPath(path)} has no indexed files.`);
    return;
  }
  const model = buildFolderModel(folder, state.links);
  const layout = layoutFolder(model);
  state.folderModel = model;
  drawScene({ nodes: model.nodes, links: model.links, layout }, { fit });
}

async function loadOuterRing(
  refs: BrainCodeSymbolRef[],
  fetcher: (id: string) => Promise<BrainCodeSymbolRef[]>,
): Promise<Map<string, BrainCodeSymbolRef[]>> {
  const picked = refs.filter((r) => !(state.hideCommon && COMMON_CALL_NAMES.has(r.name))).slice(0, 8);
  const results = await Promise.all(picked.map(async (r) => [r.symbolId, await fetcher(r.symbolId)] as const));
  return new Map(results);
}

async function renderCalls(fit: boolean, token: number): Promise<void> {
  const id = state.symbolId;
  if (!id) {
    clearScene();
    const root = $('codeMapEmpty');
    if (root) await renderSymbolPicker(root, {
      file: state.callPickerFile,
      context: ctx(),
      isCurrent: () => token === renderToken,
      onPick: showSymbol,
    });
    return;
  }
  showOverlay('Loading calls…', '');
  const c = ctx();
  const [read, who, calls] = await Promise.all([
    fetchBrainCodeReadSymbol(id, c),
    fetchBrainCodeWhoCalls(id, c),
    fetchBrainCodeCallsOf(id, c),
  ]);
  if (token !== renderToken) return;
  const sym = read?.symbol ?? who?.symbol ?? calls?.symbol ?? null;
  if (!sym) {
    clearScene();
    showOverlay('Symbol not found', read?.error ?? 'It may have been renamed since the last index.');
    return;
  }
  state.symbol = sym;
  state.symbolSource = read?.text ?? '';
  const callers = who?.callers ?? [];
  const callees = calls?.callees ?? [];
  let outerCallers: Map<string, BrainCodeSymbolRef[]> | undefined;
  let outerCallees: Map<string, BrainCodeSymbolRef[]> | undefined;
  if (state.callDepth === 2) {
    [outerCallers, outerCallees] = await Promise.all([
      loadOuterRing(callers, async (sid) => (await fetchBrainCodeWhoCalls(sid, c))?.callers ?? []),
      loadOuterRing(callees, async (sid) => (await fetchBrainCodeCallsOf(sid, c))?.callees ?? []),
    ]);
    if (token !== renderToken) return;
  }
  const model = buildCallModel(
    { id: sym.id, name: sym.name, kind: sym.kind, file: sym.file, line: sym.line_start },
    callers,
    callees,
    { hideCommon: state.hideCommon, outerCallers, outerCallees },
  );
  state.callModel = model;
  if (!state.selected) state.selected = sym.id;
  drawScene({ nodes: model.nodes, links: model.links, layout: layoutCalls(model) }, { fit });
  renderToolbar();
}

async function render(opts: { fit: boolean }): Promise<void> {
  const token = ++renderToken;
  renderTabs();
  renderToolbar();
  renderCrumbs();
  renderHint();
  if (state.view === 'architecture') await renderArchitecture(opts.fit, token);
  else if (state.view === 'files') await renderFiles(opts.fit, token);
  else await renderCalls(opts.fit, token);
  if (token !== renderToken) return;
  renderCrumbs();
  // The inspector opens synchronously; refit so the map clears it.
  const inspecting = renderInspector();
  if (opts.fit && state.scene) viewport?.fit({ maxScale: 1 });
  void inspecting;
}

function setView(view: View, opts: { selected?: string | null } = {}): void {
  state.view = view;
  state.selected = opts.selected ?? null;
  void render({ fit: true });
}

// ── Navigation ───────────────────────────────────────────────────────────────

function showFolder(path: string, selected: string | null = null): void {
  state.folderPath = path;
  state.folder = null;
  setView('files', { selected });
}

function showFile(path: string): void {
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  showFolder(dir, path);
}

function showSymbol(symbolId: string): void {
  state.symbolId = symbolId;
  state.symbol = null;
  setView('calls', { selected: symbolId });
}

function select(id: string | null): void {
  state.selected = id;
  sceneApi?.setSelection(id);
  void renderInspector();
  if (id) {
    const box = state.scene?.layout.boxes.get(id);
    if (box) viewport?.reveal(box, { padding: 32 });
  }
}

function openNode(id: string): void {
  const node = state.scene?.nodes.get(id);
  if (!node) return;
  switch (node.kind) {
    case 'module':
    case 'folder':
      if (node.path !== undefined) showFolder(node.path);
      break;
    case 'more':
      expandLayer(id.slice('more:'.length));
      break;
    case 'file':
      if (node.path) openInEditor(node.path);
      break;
    case 'symbol':
      if (node.symbolId) showSymbol(node.symbolId);
      break;
    case 'center':
      if (state.symbol) openInEditor(state.symbol.file, state.symbol.line_start, state.symbol.line_end);
      break;
    default:
      break;
  }
}

function expandLayer(groupId: string): void {
  state.expanded.add(groupId);
  state.selected = null;
  void render({ fit: false });
}

function openInEditor(path: string, line?: number, endLine?: number): void {
  openCodeRefInViewer({
    workspacePath: path,
    ...(line ? { startLine: line, endLine: endLine ?? line } : {}),
  });
}

async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('ok', `${what} copied.`);
  } catch {
    toast('err', 'Could not copy. Check clipboard access.');
  }
}

/** Open a fresh sidebar conversation without leaving the map. */
async function askInChat(subject: string, question: string): Promise<void> {
  const map = await import('../code-brain-map');
  if (!map.isCodeBrainMapOpen()) return;
  const where = describeSelection() || (subject ? `\`${subject}\`` : '');
  const prompt = where && !question.includes(where) ? `${question}\n\n(Asked from the code map about ${where}.)` : question;
  await map.openCodeMapChat(prompt);
}

function describeSelection(): string {
  const node = state.selected ? state.scene?.nodes.get(state.selected) : undefined;
  if (!node) return '';
  if (node.kind === 'package') return `the \`${node.label}\` package`;
  if (node.kind === 'symbol' || node.kind === 'center') return `\`${node.label}\` (${node.meta})`;
  if (node.path !== undefined) return `\`${node.path || '.'}\``;
  return node.label;
}

// ── Inspector ────────────────────────────────────────────────────────────────

function inspectorActions(): InspectorActions {
  let canAsk = false;
  try {
    canAsk = Boolean(document.getElementById('chatArea')?.classList.contains('chat-area--code-brain-map'));
  } catch {
    canAsk = false;
  }
  return {
    drillInto: (path) => showFolder(path),
    selectNode: (id) => {
      if (state.scene?.nodes.has(id)) select(id);
    },
    showFile,
    showSymbol,
    openInEditor,
    expandLayer,
    ask: (subject, q) => void askInChat(subject, q),
    copy: (text, what) => void copyText(text, what),
    openWikiPage: (path) => {
      void import('../brain/graph-section').then((m) => m.navigateBrainGraphPage(path));
    },
    close: () => select(null),
    canAsk,
  };
}

function linkRowsFor(links: MapLink[], pick: (l: MapLink) => string, unit: string): LinkRow[] {
  const nodes = state.scene?.nodes;
  return links.map((l) => {
    const id = pick(l);
    return { id, label: nodes?.get(id)?.label ?? id, n: l.n, unit };
  });
}

function setInspectorOpen(open: boolean): void {
  const el = $('codeMapInspector');
  if (!el) return;
  el.hidden = !open;
  const stage = $('codeMapStage');
  stage?.classList.toggle('has-inspector', open);
  // Keep cards clear of a side panel; a bottom sheet (narrow hosts) needs no inset.
  const vp = $('codeMapViewport')?.getBoundingClientRect();
  const panel = el.getBoundingClientRect();
  const side = open && vp && panel.width > 0 && panel.left > vp.left + vp.width / 2;
  viewport?.setRightInset(side && vp ? vp.right - panel.left + 8 : 0);
}

async function renderInspector(): Promise<void> {
  const root = $('codeMapInspector');
  if (!root) return;
  const token = ++inspectToken;
  const isCurrent = () => token === inspectToken;
  const node = state.selected ? state.scene?.nodes.get(state.selected) : undefined;
  const actions = inspectorActions();
  if (!node) {
    renderIdleInspector(root);
    setInspectorOpen(false);
    return;
  }
  setInspectorOpen(true);
  const scene = state.scene!;
  const { out, in: incoming } = linksOf(scene.links, node.id);

  if (node.kind === 'module' || node.kind === 'folder') {
    const path = node.path ?? '';
    const layer = node.kind === 'module' ? state.archModel?.layers[node.layer] : undefined;
    const meta =
      node.kind === 'module' && node.module
        ? [folderDisplayPath(path), plural(node.module.files, 'file'), plural(node.module.symbols, 'symbol')]
        : [folderDisplayPath(path), node.detail];
    await renderFolderInspector(
      root,
      {
        icon: nodeIcon(state.repoKey, node),
        title: node.label,
        path,
        meta,
        layerLabel: layer?.label,
        dependsOn: linkRowsFor(out.filter((l) => !l.external), (l) => l.dst, 'call'),
        usedBy: linkRowsFor(incoming, (l) => l.src, 'call'),
        packages: linkRowsFor(out.filter((l) => l.external), (l) => l.dst, 'file'),
        folder: fetchCodeMapFolder(path, ctx()),
        isCurrent,
      },
      actions,
    );
    return;
  }
  if (node.kind === 'more') {
    const groupId = node.id.slice('more:'.length);
    const layer = state.archModel?.layers.find((l) => l.id === groupId);
    const modules = (node.folded ?? [])
      .map((id) => state.arch?.modules.find((m) => m.id === id))
      .filter((m): m is NonNullable<typeof m> => Boolean(m))
      .map((m) => ({ id: m.id, name: m.loose ? `${m.name} files` : m.name, path: m.path, files: m.files }));
    renderMoreInspector(root, { groupId, layerLabel: layer?.label ?? 'this layer', modules }, actions);
    return;
  }
  if (node.kind === 'package') {
    const ext = state.arch?.externals.find((e) => e.name === node.packageName);
    renderPackageInspector(
      root,
      {
        icon: packageIcon(node.label),
        name: node.label,
        files: node.weight,
        testFiles: ext?.testFiles ?? 0,
        usedBy: linkRowsFor(incoming, (l) => l.src, 'file'),
      },
      actions,
    );
    return;
  }
  if (node.kind === 'file') {
    await renderFileInspector(root, { path: node.path ?? node.id, detail: fetchCodeMapFile(node.path ?? node.id, ctx()), isCurrent }, actions);
    return;
  }
  // Symbols: the centre is already loaded; others are read on demand.
  const symbolId = node.symbolId ?? node.id;
  let symbol = node.kind === 'center' ? state.symbol : null;
  let source: Promise<string> = Promise.resolve(state.symbolSource);
  if (!symbol) {
    root.hidden = false;
    root.replaceChildren();
    const loadingEl = document.createElement('p');
    loadingEl.className = 'code-map-insp__muted code-map-insp__loading';
    loadingEl.textContent = `Loading ${node.label}…`;
    root.append(loadingEl);
    const read = await fetchBrainCodeReadSymbol(symbolId, ctx());
    if (!isCurrent()) return;
    symbol = read?.symbol ?? null;
    source = Promise.resolve(read?.text ?? '');
    if (!symbol) {
      loadingEl.textContent = 'Symbol not found in the index.';
      return;
    }
  }
  await renderSymbolInspector(
    root,
    {
      symbol,
      source,
      pages: fetchBrainCodeExplain(symbolId, ctx()).then((r) => r?.pages ?? null),
      isCurrent,
    },
    actions,
  );
}

// ── Chrome: tabs, toolbar, crumbs, hint ──────────────────────────────────────

function renderTabs(): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>('#codeMapTabs [data-view]')) {
    const on = btn.dataset.view === state.view;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
    btn.tabIndex = on ? 0 : -1;
  }
}

function toolButton(label: string, icon: string, opts: { pressed?: boolean; onClick: () => void; title?: string }): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'code-map-btn is-floating';
  const i = document.createElement('i');
  i.className = `fi ${icon}`;
  i.setAttribute('aria-hidden', 'true');
  btn.append(i, document.createTextNode(label));
  if (opts.pressed !== undefined) btn.setAttribute('aria-pressed', opts.pressed ? 'true' : 'false');
  if (opts.title) btn.title = opts.title;
  btn.addEventListener('click', opts.onClick);
  return btn;
}

function linkSelect(): HTMLElement {
  const label = document.createElement('label');
  label.className = 'code-map-btn is-floating code-map-select';
  const i = document.createElement('i');
  i.className = 'fi fi-rr-network';
  i.setAttribute('aria-hidden', 'true');
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Which links to draw');
  for (const [value, text] of [
    ['strong', 'Strong links'],
    ['all', 'All links'],
    ['cross', 'Cross-layer only'],
  ] as const) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    opt.selected = state.links === value;
    select.append(opt);
  }
  select.addEventListener('change', () => {
    state.links = select.value as LinkFilter;
    void render({ fit: false });
  });
  label.append(i, select);
  return label;
}

function renderToolbar(): void {
  const tools = $('codeMapViewTools');
  if (!tools) return;
  tools.replaceChildren();
  if (state.view === 'architecture') {
    tools.append(linkSelect());
    const tests = state.arch?.groups.filter((g) => g.test).length ?? 0;
    if (tests) {
      tools.append(
        toolButton(state.showTests ? 'Tests shown' : 'Show tests', 'fi-rr-flask', {
          pressed: state.showTests,
          onClick: () => {
            state.showTests = !state.showTests;
            state.selected = null;
            void render({ fit: true });
          },
        }),
      );
    }
    if (state.expanded.size) {
      tools.append(
        toolButton('Fold small modules', 'fi-rr-compress', {
          onClick: () => {
            state.expanded.clear();
            void render({ fit: true });
          },
        }),
      );
    }
  } else if (state.view === 'files') {
    tools.append(linkSelect());
    const path = state.folderPath ?? '';
    if (path) {
      tools.append(
        toolButton('Up a folder', 'fi-rr-arrow-up', {
          onClick: () => showFolder(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''),
        }),
      );
    }
  } else {
    if (state.symbolId) tools.append(toolButton('Choose symbol', 'fi-rr-search', {
      onClick: () => {
        state.callPickerFile = state.symbol?.file ?? null;
        state.symbolId = null;
        state.symbol = null;
        state.callModel = null;
        setView('calls');
      },
    }));
    if (!state.symbolId) return;
    const depth = document.createElement('div');
    depth.className = 'code-map-btn is-floating code-map-stepper';
    depth.setAttribute('role', 'group');
    depth.setAttribute('aria-label', 'Call depth');
    const label = document.createElement('span');
    label.textContent = 'Depth';
    const value = document.createElement('span');
    value.className = 'code-map-stepper__value';
    value.textContent = String(state.callDepth);
    const mk = (text: string, aria: string, next: 1 | 2) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'code-map-icon-btn is-small';
      b.setAttribute('aria-label', aria);
      b.textContent = text;
      b.disabled = state.callDepth === next;
      b.addEventListener('click', () => {
        state.callDepth = next;
        void render({ fit: true });
      });
      return b;
    };
    depth.append(label, mk('−', 'Show direct calls only', 1), value, mk('+', 'Show two levels of calls', 2));
    tools.append(depth);
    const hidden = state.callModel?.hiddenCommon ?? 0;
    tools.append(
      toolButton(state.hideCommon ? `Common names hidden${hidden ? ` (${hidden})` : ''}` : 'Hide common names', 'fi-rr-filter', {
        pressed: state.hideCommon,
        title: 'Calls like map, push or get usually resolve to the wrong function',
        onClick: () => {
          state.hideCommon = !state.hideCommon;
          void render({ fit: true });
        },
      }),
    );
  }
}

function crumb(label: string, onClick?: () => void, mono = false): HTMLElement {
  if (!onClick) {
    const span = document.createElement('span');
    span.className = `code-map-crumb is-current${mono ? ' is-mono' : ''}`;
    span.textContent = label;
    span.setAttribute('aria-current', 'page');
    return span;
  }
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `code-map-crumb${mono ? ' is-mono' : ''}`;
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

function renderCrumbs(): void {
  const nav = $('codeMapCrumbs');
  if (!nav) return;
  const parts: HTMLElement[] = [];
  const title = document.createElement('span');
  title.className = 'code-map-crumbs__title';
  title.textContent = 'Code map';
  parts.push(title);
  const repo = state.arch?.repo || state.status?.repo || 'workspace';
  if (state.view === 'architecture') {
    parts.push(crumb(repo, undefined, true));
  } else if (state.view === 'files') {
    parts.push(crumb(repo, () => setView('architecture'), true));
    const segs = (state.folderPath ?? '').split('/').filter(Boolean);
    segs.forEach((seg, i) => {
      const p = segs.slice(0, i + 1).join('/');
      parts.push(i === segs.length - 1 ? crumb(seg, undefined, true) : crumb(seg, () => showFolder(p), true));
    });
  } else {
    parts.push(crumb(repo, () => setView('architecture'), true));
    const sym = state.symbol;
    if (sym) {
      const dir = sym.file.includes('/') ? sym.file.slice(0, sym.file.lastIndexOf('/')) : '';
      const name = sym.file.split('/').pop() ?? sym.file;
      parts.push(crumb(dir || '.', () => showFolder(dir), true));
      parts.push(crumb(name, () => showFile(sym.file), true));
      parts.push(crumb(sym.name, undefined, true));
    }
  }
  nav.replaceChildren();
  parts.forEach((p, i) => {
    if (i) {
      const sep = document.createElement('i');
      sep.className = 'fi fi-rr-angle-small-right code-map-crumbs__sep';
      sep.setAttribute('aria-hidden', 'true');
      nav.append(sep);
    }
    nav.append(p);
  });
}

function renderHint(): void {
  const el = $('codeMapHint');
  if (!el) return;
  el.textContent =
    state.view === 'calls'
      ? state.symbolId
        ? 'Double-click a call to re-centre on it · Drag to pan · Scroll to zoom'
        : 'Choose a symbol to explore its callers and calls'
      : 'Click to inspect · Double-click to drill in · Drag to pan · Scroll to zoom';
}

// ── Node menu (icon override) ────────────────────────────────────────────────

function closeNodeMenu(): void {
  document.getElementById('codeMapNodeMenu')?.remove();
}

function showNodeMenu(id: string, ev: MouseEvent): void {
  closeNodeMenu();
  const node = state.scene?.nodes.get(id);
  if (!node || (node.kind !== 'module' && node.kind !== 'folder') || node.path === undefined) return;
  const path = node.path;
  const stage = $('codeMapStage');
  if (!stage) return;
  const menu = document.createElement('div');
  menu.id = 'codeMapNodeMenu';
  menu.className = 'code-map-menu code-map-node-menu code-map-no-pan';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', `Icon for ${node.label}`);
  const heading = document.createElement('p');
  heading.className = 'code-map-menu__heading';
  heading.textContent = 'Change icon';
  const grid = document.createElement('div');
  grid.className = 'code-map-icon-grid';
  for (const cls of PICKER_GLYPHS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.setAttribute('aria-label', cls.replace('fi-rr-', '').replace(/-/g, ' '));
    b.append(renderIcon({ kind: 'glyph', cls }));
    b.addEventListener('click', () => {
      setFolderIconOverride(state.repoKey, path, cls);
      closeNodeMenu();
      void render({ fit: false });
    });
    grid.append(b);
  }
  menu.append(heading, grid);
  if (hasFolderIconOverride(state.repoKey, path)) {
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'code-map-menu__item';
    reset.setAttribute('role', 'menuitem');
    reset.textContent = 'Use the automatic icon';
    reset.addEventListener('click', () => {
      setFolderIconOverride(state.repoKey, path, null);
      closeNodeMenu();
      void render({ fit: false });
    });
    menu.append(reset);
  }
  const rect = stage.getBoundingClientRect();
  menu.style.left = `${Math.min(ev.clientX - rect.left, rect.width - 240)}px`;
  menu.style.top = `${Math.min(ev.clientY - rect.top, rect.height - 220)}px`;
  stage.append(menu);
  (menu.querySelector('button') as HTMLButtonElement | null)?.focus();
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeNodeMenu();
      $('codeMapViewport')?.focus();
    }
  });
}

// ── Search ───────────────────────────────────────────────────────────────────

interface SearchItem {
  label: string;
  detail: string;
  badge: string;
  run: () => void;
}

function closeSearch(): void {
  const list = $('codeMapSearchResults');
  const input = $<HTMLInputElement>('codeMapSearch');
  if (list) list.hidden = true;
  input?.setAttribute('aria-expanded', 'false');
  input?.removeAttribute('aria-activedescendant');
}

function renderSearchResults(items: SearchItem[], groups: Array<{ title: string; start: number }>): void {
  const list = $('codeMapSearchResults');
  const input = $<HTMLInputElement>('codeMapSearch');
  if (!list || !input) return;
  list.replaceChildren();
  if (!items.length) {
    closeSearch();
    return;
  }
  items.forEach((item, i) => {
    const group = groups.find((g) => g.start === i);
    if (group) {
      const h = document.createElement('li');
      h.className = 'code-map-search__group';
      h.setAttribute('role', 'presentation');
      h.textContent = group.title;
      list.append(h);
    }
    const li = document.createElement('li');
    li.id = `codeMapSearchOpt${i}`;
    li.className = 'code-map-search__item';
    li.setAttribute('role', 'option');
    li.dataset.index = String(i);
    const badge = document.createElement('span');
    badge.className = 'code-map-search__badge';
    badge.textContent = item.badge;
    const label = document.createElement('span');
    label.className = 'code-map-search__label';
    label.textContent = item.label;
    const detail = document.createElement('span');
    detail.className = 'code-map-search__detail';
    detail.textContent = item.detail;
    li.append(badge, label, detail);
    li.addEventListener('mousedown', (ev) => ev.preventDefault());
    li.addEventListener('click', () => {
      closeSearch();
      input.value = '';
      item.run();
    });
    list.append(li);
  });
  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  searchItems = items;
  setActiveResult(0);
}

let searchItems: SearchItem[] = [];
let activeResult = -1;

function setActiveResult(i: number): void {
  const list = $('codeMapSearchResults');
  const input = $<HTMLInputElement>('codeMapSearch');
  if (!list || !input || !searchItems.length) return;
  activeResult = (i + searchItems.length) % searchItems.length;
  for (const li of list.querySelectorAll<HTMLElement>('.code-map-search__item')) {
    const on = li.dataset.index === String(activeResult);
    li.classList.toggle('is-active', on);
    li.setAttribute('aria-selected', on ? 'true' : 'false');
    if (on) li.scrollIntoView({ block: 'nearest' });
  }
  input.setAttribute('aria-activedescendant', `codeMapSearchOpt${activeResult}`);
}

async function runSearch(query: string): Promise<void> {
  const q = query.trim();
  const token = ++searchToken;
  if (!q) {
    closeSearch();
    return;
  }
  const c = ctx();
  const [paths, symbols] = await Promise.all([searchCodeMapPaths(q, c), findBrainCodeSymbol(q, 6, c)]);
  if (token !== searchToken) return;
  const items: SearchItem[] = [];
  const groups: Array<{ title: string; start: number }> = [];
  if (paths.length) {
    groups.push({ title: 'Files and folders', start: items.length });
    for (const hit of paths) {
      const name = hit.path.split('/').pop() || hit.path;
      items.push({
        label: hit.kind === 'folder' ? `${name}/` : name,
        detail: hit.path,
        badge: hit.kind === 'folder' ? 'dir' : languageTag(name) || 'F',
        run: () => (hit.kind === 'folder' ? showFolder(hit.path) : showFile(hit.path)),
      });
    }
  }
  const matches = symbols?.matches ?? [];
  if (matches.length) {
    groups.push({ title: 'Symbols', start: items.length });
    for (const m of matches) {
      items.push({
        label: m.name,
        detail: `${m.file}:${m.line_start}`,
        badge: kindBadge(m.kind),
        run: () => showSymbol(m.id),
      });
    }
  }
  if (document.getElementById('chatArea')?.classList.contains('chat-area--code-brain-map')) {
    groups.push({ title: 'Ask', start: items.length });
    items.push({ label: `Ask: ${q}`, detail: 'in a new sidebar chat', badge: '?', run: () => void askInChat('', q) });
  }
  renderSearchResults(items, groups);
}

// ── Index actions ────────────────────────────────────────────────────────────

const REINDEX_WAIT_TIMEOUT_MS = 45 * 60 * 1000;

async function waitForReindexRun(startedAt?: string): Promise<BrainCodeIndexRun | null> {
  const deadline = Date.now() + REINDEX_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const status = await refreshStatus();
    const run = status?.lastRun;
    if (run && !run.running && (!startedAt || run.startedAt === startedAt)) return run;
  }
  return null;
}

function describeRun(run: BrainCodeIndexRun, repo: string): { kind: 'ok' | 'err'; text: string } {
  if (run.ok === false) return { kind: 'err', text: `Reindex failed: ${run.error ?? 'unknown error'}` };
  if (run.skipped) return { kind: 'ok', text: `Reindex skipped in ${repo} (${run.reason ?? 'nothing to do'})` };
  const indexed = run.indexedFiles ?? 0;
  const parts = [`Indexed ${plural(indexed, 'file')} in ${repo}`];
  const symbols = run.symbolCount ?? run.symbolsIndexed;
  if (symbols) parts.push(plural(symbols, 'symbol'));
  const failed = run.failedFiles ?? 0;
  if (failed > 0) parts.push(`${plural(failed, 'file')} skipped${run.errorSummary?.[0] ? `: ${run.errorSummary[0].message}` : ''}`);
  return { kind: indexed === 0 && failed > 0 ? 'err' : 'ok', text: parts.join(' · ') };
}

async function runReindex(): Promise<void> {
  const btn = $<HTMLButtonElement>('brainCodeReindex');
  if (btn) btn.disabled = true;
  toast('spin', 'Starting reindex…');
  const ack = await reindexBrainCode(ctx());
  if (!ack?.ok) {
    if (btn) btn.disabled = false;
    toast('err', 'Could not start reindex. Is Minnow running?');
    return;
  }
  toast('spin', ack.alreadyRunning ? 'Reindex already running…' : 'Reindexing workspace…');
  const run = await waitForReindexRun(ack.startedAt);
  if (btn) btn.disabled = false;
  if (!run) {
    toast('err', 'Reindex is still running — check back shortly.');
    return;
  }
  const outcome = describeRun(run, ack.repo);
  toast(outcome.kind, outcome.text);
  await refreshStatus();
  state.folder = null;
  await reloadArchitecture();
}

async function runResetIndex(): Promise<void> {
  closeMoreMenu();
  const ok = await appConfirm('Reset the code index for this workspace? You can reindex afterward.');
  if (!ok) return;
  toast('spin', 'Resetting code index…');
  const result = await clearBrainCodeIndex(ctx());
  if (!result.ok) {
    toast('err', result.error ?? 'Reset failed');
    return;
  }
  toast('ok', 'Code index reset.');
  await refreshStatus();
  state.folder = null;
  state.selected = null;
  await reloadArchitecture();
}

// ── More menu: export ────────────────────────────────────────────────────────

function closeMoreMenu(): void {
  const menu = $('codeMapMoreMenu');
  const btn = $('codeMapMoreBtn');
  if (menu) menu.hidden = true;
  btn?.setAttribute('aria-expanded', 'false');
}

function toggleMoreMenu(): void {
  const menu = $('codeMapMoreMenu');
  const btn = $('codeMapMoreBtn');
  if (!menu || !btn) return;
  const open = menu.hidden;
  menu.hidden = !open;
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) (menu.querySelector('button') as HTMLButtonElement | null)?.focus();
}

async function copyMermaid(): Promise<void> {
  closeMoreMenu();
  const scene = state.scene;
  if (!scene?.nodes.size) {
    toast('err', 'Nothing on the map to copy.');
    return;
  }
  await copyText(toMermaid(scene.nodes, scene.links), 'Mermaid diagram');
}

async function savePng(): Promise<void> {
  closeMoreMenu();
  const scene = state.scene;
  const host = $('codeMap');
  if (!scene?.nodes.size || !host) {
    toast('err', 'Nothing on the map to save.');
    return;
  }
  const blob = await sceneToPng(host, scene.layout, scene.nodes, scene.links, toneVar);
  if (!blob) {
    toast('err', 'Could not render the PNG.');
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${state.arch?.repo || 'code'}-map-${state.view}.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Bindings ─────────────────────────────────────────────────────────────────

function isMapVisible(): boolean {
  const root = $('codeMap');
  return Boolean(root && root.isConnected && root.offsetParent !== null);
}

function bind(): void {
  if (bound) return;
  bound = true;

  $('brainCodeReindex')?.addEventListener('click', () => void runReindex());
  $('brainCodeResetIndex')?.addEventListener('click', () => void runResetIndex());
  $('codeMapCopyMermaid')?.addEventListener('click', () => void copyMermaid());
  $('codeMapSavePng')?.addEventListener('click', () => void savePng());
  $('codeMapMoreBtn')?.addEventListener('click', toggleMoreMenu);
  $('codeMapMoreMenu')?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      closeMoreMenu();
      $('codeMapMoreBtn')?.focus();
    }
  });

  for (const btn of document.querySelectorAll<HTMLButtonElement>('#codeMapTabs [data-view]')) {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view as View;
      if (view === 'calls' && state.view !== 'calls') {
        const node = state.selected ? state.scene?.nodes.get(state.selected) : undefined;
        state.callPickerFile = node?.kind === 'file' ? node.path ?? node.id : null;
        if (state.callPickerFile) {
          state.symbolId = null;
          state.symbol = null;
          state.callModel = null;
        }
      }
      if (view === 'files' && state.view === 'architecture') {
        const node = state.selected ? state.scene?.nodes.get(state.selected) : undefined;
        if (node?.path !== undefined && node.kind === 'module') {
          showFolder(node.path);
          return;
        }
      }
      setView(view, { selected: view === 'calls' ? state.symbolId : null });
    });
  }
  $('codeMapTabs')?.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('#codeMapTabs [data-view]')];
    const i = tabs.findIndex((t) => t.dataset.view === state.view);
    const next = tabs[(i + (ev.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    next?.focus();
    next?.click();
  });

  $('codeMapZoomIn')?.addEventListener('click', () => viewport?.zoomBy(1.25));
  $('codeMapZoomOut')?.addEventListener('click', () => viewport?.zoomBy(1 / 1.25));
  $('codeMapFit')?.addEventListener('click', () => viewport?.fit({ animate: true, maxScale: 1 }));

  const vp = $('codeMapViewport');
  vp?.addEventListener('click', (ev) => {
    if (viewport?.consumeDrag()) return;
    if (!(ev.target as Element | null)?.closest('.code-map-card')) {
      closeNodeMenu();
      if (state.selected) select(null);
    }
  });
  vp?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && state.selected) {
      ev.preventDefault();
      select(null);
    }
  });

  const input = $<HTMLInputElement>('codeMapSearch');
  input?.addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      void runSearch(input.value);
    }, 180);
  });
  input?.addEventListener('keydown', (ev) => {
    const open = !$('codeMapSearchResults')?.hidden;
    if (ev.key === 'ArrowDown' && open) {
      ev.preventDefault();
      setActiveResult(activeResult + 1);
    } else if (ev.key === 'ArrowUp' && open) {
      ev.preventDefault();
      setActiveResult(activeResult - 1);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      if (searchTimer) {
        clearTimeout(searchTimer);
        searchTimer = null;
        void runSearch(input.value);
        return;
      }
      const item = open ? searchItems[activeResult] : undefined;
      if (item) {
        closeSearch();
        input.value = '';
        item.run();
      }
    } else if (ev.key === 'Escape') {
      if (open) closeSearch();
      else input.blur();
    }
  });
  input?.addEventListener('blur', () => setTimeout(closeSearch, 120));

  document.addEventListener('keydown', (ev) => {
    if (!isMapVisible()) return;
    if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 'k') {
      ev.preventDefault();
      input?.focus();
      input?.select();
    }
  });
  document.addEventListener('pointerdown', (ev) => {
    const target = ev.target as Element | null;
    if (!target?.closest('#codeMapMoreMenu, #codeMapMoreBtn')) closeMoreMenu();
    if (!target?.closest('#codeMapNodeMenu')) closeNodeMenu();
  });
}

/** Load (or refresh) the code map for the active workspace. */
export async function renderCodeMapPage(): Promise<void> {
  bind();
  ensureViewport();
  const repoKey = ctx().repo ?? '';
  if (repoKey !== state.repoKey) {
    state.repoKey = repoKey;
    state.arch = null;
    state.folder = null;
    state.folderPath = null;
    state.symbolId = null;
    state.callPickerFile = null;
    state.symbol = null;
    state.selected = null;
    state.expanded.clear();
    state.view = 'architecture';
  }
  const status = await refreshStatus();
  if (status && !status.enabled) {
    clearScene();
    showOverlay('Code index is off', 'Turn on the code index in Brain → Settings to map this workspace.');
    renderCrumbs();
    return;
  }
  // Pick up a reindex that finished elsewhere.
  state.arch = null;
  await render({ fit: true });
}

