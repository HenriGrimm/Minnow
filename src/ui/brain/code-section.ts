import { appAlert, appConfirm, appPrompt } from '../app-dialog';
/**
 * Brain app — Code section: repo map, symbol search, index status (MIN-B8).
 */

import {
  clearBrainCodeIndex,
  fetchBrainCodeCallsOf,
  fetchBrainCodeExplain,
  fetchBrainCodeReadSymbol,
  fetchBrainCodeRepoMap,
  fetchBrainCodeStatus,
  fetchBrainCodeWhoCalls,
  findBrainCodeSymbol,
  reindexBrainCode,
} from '../../brain/client';
import type {
  BrainCodeIndexRun,
  BrainCodeStatus,
  BrainCodeRepoMap,
  BrainCodeRepoMapEntry,
  BrainCodeSymbolMatch,
  BrainCodeSymbolRef,
  BrainCodeExplainPage,
} from '../../brain/types';
import { navigateBrainGraphPage } from './graph-section';
import { buildCallGraph } from './graph/graph-data';
import { createForceGraph, type ForceGraphApi } from './graph/force-graph';
import { renderSymbolInspector } from './inspector';
import { renderBrainEmptyState, renderBrainLoading } from './empty-state';
import { openCodeRefInViewer } from '../code-ref-link';
import { brainWorkspaceKeyFromPath } from '../../lib/brain-workspace-key';
import { getWorkspacePath } from '../../state/workspace';
let bindingsDone = false;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let focusTimer: ReturnType<typeof setTimeout> | null = null;
let lastStatus: BrainCodeStatus | null = null;
let selectedSymbolId: string | null = null;
let codeGraphApi: ForceGraphApi | null = null;

type ActionStatusFn = (kind: 'ok' | 'err' | 'spin', message: string) => void;

const setActionStatus: ActionStatusFn = (kind, message) => {
  const el = document.getElementById('brainCodeActionStatus');
  if (!el) return;
  el.textContent = message;
  el.dataset.kind = kind;
};

/** Resolve the Code app workspace for brain code API calls (matches tool workspace). */
function codeIndexRequestContext(): { workspaceRoot?: string; repo?: string } {
  const workspaceRoot = getWorkspacePath().trim();
  if (!workspaceRoot) return {};
  const repo = brainWorkspaceKeyFromPath(workspaceRoot) || undefined;
  return { workspaceRoot, repo };
}

/** Format index stats for the toolbar line. */
function formatStatusLine(status: BrainCodeStatus): string {
  if (status.indexing) {
    const done = status.filesDone ?? 0;
    const total = status.filesTotal ?? 0;
    const phase = status.phase && status.phase !== 'idle' ? status.phase : 'indexing';
    return `${status.repo} · ${phase} · ${done}/${total} files`;
  }
  const when = status.lastIndexedAt
    ? new Date(status.lastIndexedAt).toLocaleString()
    : 'never';
  return `${status.repo} · ${status.symbolCount} symbols · ${status.fileCount} files · last indexed ${when}`;
}

// ── Repo map ─────────────────────────────────────────────────────────────────

/** Render repo map entries into the map panel (clickable symbols). */
function renderRepoMapPanel(map: BrainCodeRepoMap): void {
  const mapEl = document.getElementById('brainCodeMap');
  if (!mapEl) return;

  mapEl.replaceChildren();

  const entries = map.entries;
  if (!entries?.length) {
    mapEl.replaceChildren();
    for (const line of map.text.split(/\r?\n/)) {
      const row = document.createElement('div');
      row.className = 'brain-code-map-line';
      row.textContent = line;
      mapEl.append(row);
    }
    return;
  }

  for (const entry of entries) {
    mapEl.append(renderRepoMapEntry(entry));
  }

  if (selectedSymbolId) highlightRepoMapSymbol(selectedSymbolId);
}

/** Build one repo-map row (file headers are static; symbols are buttons). */
function renderRepoMapEntry(entry: BrainCodeRepoMapEntry): HTMLElement {
  const line = document.createElement('div');
  line.className = `brain-code-map-line brain-code-map-line--${entry.type}`;

  if (entry.type === 'symbol') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'brain-code-map-symbol-btn';
    btn.dataset.symbolId = entry.symbolId;
    btn.textContent = entry.text;
    btn.addEventListener('click', () => {
      void selectSymbol(entry.symbolId);
    });
    line.append(btn);
    return line;
  }

  line.textContent = entry.text;
  return line;
}

/** Open the symbol definition in the Code file viewer with the line range selected. */
function openSymbolInEditor(sym: BrainCodeSymbolMatch): void {
  openCodeRefInViewer({
    workspacePath: sym.file.replace(/\\/g, '/'),
    startLine: sym.line_start,
    endLine: sym.line_end,
  });
}

/** Primary action to jump from Brain code search into the workspace editor. */
function buildOpenInEditorButton(sym: BrainCodeSymbolMatch): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'brain-action-btn is-ghost brain-code-detail-open';
  btn.textContent = 'Open in editor';
  const range =
    sym.line_start === sym.line_end
      ? `line ${sym.line_start}`
      : `lines ${sym.line_start}–${sym.line_end}`;
  btn.title = `Open ${sym.file} (${range}) in the file viewer`;
  btn.setAttribute('aria-label', `Open ${sym.file} in editor, ${range}`);
  btn.addEventListener('click', () => openSymbolInEditor(sym));
  return btn;
}

/** Mark the active symbol row in the repo map. */
function highlightRepoMapSymbol(symbolId: string): void {
  const mapEl = document.getElementById('brainCodeMap');
  if (!mapEl) return;
  for (const btn of mapEl.querySelectorAll<HTMLButtonElement>('.brain-code-map-symbol-btn')) {
    const active = btn.dataset.symbolId === symbolId;
    btn.setAttribute('aria-current', active ? 'true' : 'false');
  }
}

/** Render repo map text into the map panel. */
async function refreshRepoMap(): Promise<void> {
  const mapEl = document.getElementById('brainCodeMap');
  const budgetEl = document.getElementById('brainCodeMapBudget');
  const focusEl = document.getElementById('brainCodeFocus') as HTMLInputElement | null;
  if (!mapEl) return;

  const focus = focusEl?.value.trim() ?? '';
  const ctx = codeIndexRequestContext();
  const map = await fetchBrainCodeRepoMap({
    ...ctx,
    focus: focus || undefined,
    tokenBudget: lastStatus?.repoMapTokenBudget,
    ensureIndexed: true,
  });

  if (!map) {
    mapEl.replaceChildren();
    mapEl.textContent = 'Repo map unavailable. Open Minnow and reindex.';
    if (budgetEl) budgetEl.textContent = '';
    return;
  }

  renderRepoMapPanel(map);
  if (budgetEl) {
    const budget = lastStatus?.repoMapTokenBudget ?? '—';
    const truncated = map.truncated ? ' · truncated' : '';
    budgetEl.textContent = `~${map.tokenEstimate} / ${budget} tokens${truncated}`;
  }
}

/** Refresh index status line and offline banner. */
async function refreshCodeStatus(): Promise<void> {
  const line = document.getElementById('brainCodeStatusLine');
  const offlineEl = document.getElementById('brainCodeOffline');
  const status = await fetchBrainCodeStatus(codeIndexRequestContext());
  lastStatus = status;

  offlineEl?.classList.toggle('hidden', status !== null);
  if (!line) return;

  if (!status) {
    line.textContent = 'Offline — open Minnow.';
    return;
  }

  if (!status.enabled) {
    line.textContent = `${status.repo} · code index disabled in Settings`;
    return;
  }

  line.textContent = formatStatusLine(status);
  if (status.indexing) {
    setActionStatus('spin', formatStatusLine(status));
    return;
  }

  const run = status.lastRun;
  if (run && !run.running && status.symbolCount === 0) {
    const outcome = describeReindexRun(run, status.repo);
    if (outcome.kind === 'err') setActionStatus('err', outcome.text);
  }
}

/** Build a clickable edge list (callers or callees). */
function renderEdgeList(
  mount: HTMLElement,
  title: string,
  edges: BrainCodeSymbolRef[],
  emptyText: string,
): void {
  const section = document.createElement('section');
  section.className = 'brain-code-edge-group';
  const heading = document.createElement('h4');
  heading.className = 'brain-section-subtitle';
  heading.textContent = title;
  section.append(heading);

  if (!edges.length) {
    const empty = document.createElement('p');
    empty.className = 'brain-muted';
    empty.textContent = emptyText;
    section.append(empty);
    mount.append(section);
    return;
  }

  const list = document.createElement('ul');
  list.className = 'brain-code-edge-list';
  for (const edge of edges) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'brain-inline-link';
    btn.textContent = `${edge.name} (${edge.file}:${edge.line})`;
    btn.addEventListener('click', () => {
      void selectSymbol(edge.symbolId);
    });
    li.append(btn);
    if (edge.signature && edge.signature !== edge.name) {
      const sig = document.createElement('span');
      sig.className = 'brain-code-edge-sig';
      sig.textContent = ` — ${edge.signature}`;
      li.append(sig);
    }
    list.append(li);
  }
  section.append(list);
  mount.append(section);
}

// ── Symbols ──────────────────────────────────────────────────────────────────

/** Show definition + call graph for one symbol. */
async function selectSymbol(symbolId: string): Promise<void> {
  selectedSymbolId = symbolId;
  const detail = document.getElementById('brainCodeDetail');
  if (!detail) return;

  detail.hidden = false;
  detail.replaceChildren();
  renderBrainLoading(detail, 'Loading symbol…');

  const ctx = codeIndexRequestContext();

  const [def, callers, callees] = await Promise.all([
    fetchBrainCodeReadSymbol(symbolId, ctx),
    fetchBrainCodeWhoCalls(symbolId, ctx),
    fetchBrainCodeCallsOf(symbolId, ctx),
  ]);

  detail.replaceChildren();

  const sym = def?.symbol ?? callers?.symbol ?? callees?.symbol;
  if (!sym) {
    const err = document.createElement('p');
    err.className = 'brain-error';
    err.textContent = def?.error ?? callers?.error ?? callees?.error ?? 'Symbol not found';
    detail.append(err);
    return;
  }

  const head = document.createElement('div');
  head.className = 'brain-code-detail-head';
  const headText = document.createElement('div');
  headText.className = 'brain-code-detail-head__text';
  const title = document.createElement('h3');
  title.className = 'brain-code-detail-title';
  title.textContent = sym.name;
  const meta = document.createElement('p');
  meta.className = 'brain-code-detail-meta';
  meta.textContent = `${sym.kind} · ${sym.file}:${sym.line_start}-${sym.line_end}`;
  headText.append(title, meta);
  if (sym.signature) {
    const sig = document.createElement('p');
    sig.className = 'brain-code-detail-signature';
    sig.textContent = sym.signature;
    headText.append(sig);
  }
  head.append(headText, buildOpenInEditorButton(sym));
  detail.append(head);

  if (def?.text) {
    const pre = document.createElement('pre');
    pre.className = 'brain-code-def';
    pre.textContent = def.text;
    detail.append(pre);
  }

  renderEdgeList(
    detail,
    'Called by',
    callers?.callers ?? [],
    'No indexed callers.',
  );
  renderEdgeList(
    detail,
    'Calls',
    callees?.callees ?? [],
    'No indexed callees.',
  );

  void renderCallGraph(sym, callers?.callers ?? [], callees?.callees ?? [], def?.text);
  void refreshExplainPanel(symbolId);
  highlightSearchResult(symbolId);
  highlightRepoMapSymbol(symbolId);
}

/** Render an expandable call graph for the active symbol. */
async function renderCallGraph(
  sym: BrainCodeSymbolMatch,
  callers: BrainCodeSymbolRef[],
  callees: BrainCodeSymbolRef[],
  sourceText?: string,
): Promise<void> {
  const panel = document.getElementById('brainCodeGraphPanel');
  const canvas = document.getElementById('brainCodeGraphCanvas') as HTMLCanvasElement | null;
  if (!panel || !canvas) return;

  panel.hidden = false;
  const data = buildCallGraph(sym.id, sym.name, callers, callees);

  if (!codeGraphApi) {
    codeGraphApi = createForceGraph(canvas, {
      onSelect: (node) => {
        if (!node?.symbolId) return;
        void selectSymbol(node.symbolId);
      },
      onDoubleClick: (node) => {
        if (node?.symbolId) void selectSymbol(node.symbolId);
      },
    });
  }

  codeGraphApi.setData(data.nodes, data.edges);

  const inspector = document.getElementById('brainInspector');
  if (inspector) {
    renderSymbolInspector(
      inspector,
      sym.name,
      `${sym.kind} · ${sym.file}:${sym.line_start}`,
      sourceText,
    );
  }
}

// ── Explain ──────────────────────────────────────────────────────────────────

/** Show the default Explain panel empty state. */
function showExplainEmpty(message: string, options?: { icon?: 'search' | 'offline' }): void {
  const emptyEl = document.getElementById('brainCodeExplainEmpty');
  const listEl = document.getElementById('brainCodeExplainList');
  listEl?.replaceChildren();
  if (!emptyEl) return;
  renderBrainEmptyState(emptyEl, {
    icon: options?.icon ?? 'search',
    title: options?.icon === 'offline' ? 'Explain unavailable' : 'Select a symbol',
    message,
  });
}

/** Show wiki pages that anchor the selected symbol. */
async function refreshExplainPanel(symbolId: string): Promise<void> {
  const panel = document.getElementById('brainCodeExplain');
  const listEl = document.getElementById('brainCodeExplainList');
  const emptyEl = document.getElementById('brainCodeExplainEmpty');
  if (!panel || !listEl || !emptyEl) return;

  panel.removeAttribute('aria-disabled');
  listEl.replaceChildren();
  emptyEl.replaceChildren();
  renderBrainLoading(emptyEl, 'Loading anchored pages…');

  const result = await fetchBrainCodeExplain(symbolId, codeIndexRequestContext());
  listEl.replaceChildren();
  emptyEl.replaceChildren();

  if (!result) {
    showExplainEmpty('Explain unavailable. Open Minnow.', { icon: 'offline' });
    return;
  }

  if (!result.pages.length) {
    showExplainEmpty('No wiki pages anchor this symbol yet. Link symbols from wiki pages to see them here.');
    return;
  }

  for (const page of result.pages) {
    listEl.append(renderExplainPageItem(page));
  }
}

/** Build one clickable anchored-page row for the Explain panel. */
function renderExplainPageItem(page: BrainCodeExplainPage): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'brain-code-explain-item';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'brain-inline-link brain-code-explain-link';
  btn.textContent = page.title;
  btn.addEventListener('click', () => {
    navigateBrainGraphPage(page.path);
  });
  li.append(btn);

  if (page.status === 'stale') {
    const badge = document.createElement('span');
    badge.className = 'brain-code-explain-stale';
    badge.textContent = 'stale';
    li.append(badge);
  }

  if (page.summary?.trim()) {
    const summary = document.createElement('p');
    summary.className = 'brain-code-explain-summary';
    summary.textContent = page.summary;
    li.append(summary);
  }

  const path = document.createElement('span');
  path.className = 'brain-muted brain-code-explain-path';
  path.textContent = page.path;
  li.append(path);
  return li;
}

// ── Search ───────────────────────────────────────────────────────────────────

/** Mark the active row in the search results list. */
function highlightSearchResult(symbolId: string): void {
  const list = document.getElementById('brainCodeResults');
  if (!list) return;
  for (const child of list.children) {
    if (!(child instanceof HTMLLIElement)) continue;
    const btn = child.querySelector('button');
    const active = btn?.dataset.symbolId === symbolId;
    child.setAttribute('aria-selected', active ? 'true' : 'false');
  }
}

/** Render find_symbol matches. */
function renderSearchResults(matches: BrainCodeSymbolMatch[]): void {
  const list = document.getElementById('brainCodeResults');
  if (!list) return;
  list.replaceChildren();

  if (!matches.length) {
    const empty = document.createElement('li');
    empty.className = 'brain-muted';
    empty.textContent = 'No matches. Try reindex or a shorter query.';
    list.append(empty);
    return;
  }

  for (const match of matches) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'brain-code-result-btn';
    btn.dataset.symbolId = match.id;
    const nameSpan = document.createElement('span');
    nameSpan.className = 'brain-code-result-name';
    nameSpan.textContent = match.name;
    const locSpan = document.createElement('span');
    locSpan.className = 'brain-code-result-loc';
    locSpan.textContent = `${match.file}:${match.line_start}`;
    btn.append(nameSpan, locSpan);
    if (match.signature && match.signature !== match.name) {
      const sig = document.createElement('span');
      sig.className = 'brain-code-result-sig';
      sig.textContent = match.signature;
      btn.append(sig);
    }
    btn.addEventListener('click', () => {
      void selectSymbol(match.id);
    });
    li.append(btn);
    list.append(li);
  }

  if (selectedSymbolId) highlightSearchResult(selectedSymbolId);
}

/** Debounced symbol search. */
async function runSymbolSearch(query: string): Promise<void> {
  const trimmed = query.trim();
  if (!trimmed) {
    renderSearchResults([]);
    const detail = document.getElementById('brainCodeDetail');
    if (detail) {
      detail.hidden = true;
      detail.replaceChildren();
    }
    selectedSymbolId = null;
    const explainList = document.getElementById('brainCodeExplainList');
    const explainEmpty = document.getElementById('brainCodeExplainEmpty');
    explainList?.replaceChildren();
    if (explainEmpty) {
      showExplainEmpty('Select a symbol to see anchored wiki pages.');
    }
    return;
  }

  const result = await findBrainCodeSymbol(trimmed, 25, codeIndexRequestContext());
  if (!result) {
    renderSearchResults([]);
    setActionStatus('err', 'Search failed. Is Minnow running?');
    return;
  }

  renderSearchResults(result.matches);
  if (result.error && result.matches.length === 0) {
    setActionStatus('err', result.error);
  }
}

// ── Reindex ──────────────────────────────────────────────────────────────────

/** Give up waiting on a reindex job after this long (the job itself keeps running). */
const REINDEX_WAIT_TIMEOUT_MS = 45 * 60 * 1000;

/** Poll status until the background reindex job finishes; null means it outlasted the wait. */
async function waitForReindexRun(startedAt?: string): Promise<BrainCodeIndexRun | null> {
  const deadline = Date.now() + REINDEX_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await refreshCodeStatus();
    const run = lastStatus?.lastRun;
    if (run && !run.running && (!startedAt || run.startedAt === startedAt)) {
      return run;
    }
  }
  return null;
}

/** Human-readable outcome for a finished reindex job. */
function describeReindexRun(run: BrainCodeIndexRun, repo: string): { kind: 'ok' | 'err'; text: string } {
  if (run.ok === false) {
    return { kind: 'err', text: `Reindex failed: ${run.error ?? 'unknown error'}` };
  }
  if (run.skipped) {
    return { kind: 'ok', text: `Reindex skipped in ${repo} (${run.reason ?? 'nothing to do'})` };
  }

  const indexed = run.indexedFiles ?? 0;
  const parts = [`Indexed ${indexed} file${indexed === 1 ? '' : 's'} in ${repo}`];
  const symbols = run.symbolCount ?? run.symbolsIndexed;
  if (symbols) parts.push(`${symbols.toLocaleString()} symbols`);

  const failed = run.failedFiles ?? 0;
  if (failed > 0) {
    const top = run.errorSummary?.[0];
    parts.push(`${failed} file${failed === 1 ? '' : 's'} skipped${top ? `: ${top.message}` : ''}`);
  }
  if (run.usageAugmentError) parts.push(`usage scan skipped (${run.usageAugmentError})`);
  if (run.scaffold?.created) parts.push(`created ${run.scaffold.path}`);

  const kind = indexed === 0 && failed > 0 ? 'err' : 'ok';
  return { kind, text: parts.join(' · ') };
}

/** Full workspace reindex — starts a background job, then tracks it via status polling. */
async function runReindex(): Promise<void> {
  const btn = document.getElementById('brainCodeReindex') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  setActionStatus('spin', 'Starting reindex…');

  const ack = await reindexBrainCode(codeIndexRequestContext());
  if (!ack?.ok) {
    if (btn) btn.disabled = false;
    setActionStatus('err', 'Could not start reindex. Is Minnow running?');
    return;
  }

  setActionStatus('spin', ack.alreadyRunning ? 'Reindex already running…' : 'Reindexing workspace…');
  const run = await waitForReindexRun(ack.startedAt);
  if (btn) btn.disabled = false;

  if (!run) {
    setActionStatus('err', 'Reindex is still running — check back shortly.');
    return;
  }

  const outcome = describeReindexRun(run, ack.repo);
  setActionStatus(outcome.kind, outcome.text);
  await refreshCodeStatus();
  await refreshRepoMap();
}

/** Drop the SQLite code index for the active workspace. */
async function runResetIndex(): Promise<void> {
  const btn = document.getElementById('brainCodeResetIndex') as HTMLButtonElement | null;
  const ok = await appConfirm('Reset the code index for this workspace? You can reindex afterward.');
  if (!ok) return;
  if (btn) btn.disabled = true;
  setActionStatus('spin', 'Resetting code index…');
  const result = await clearBrainCodeIndex(codeIndexRequestContext());
  if (btn) btn.disabled = false;
  if (!result.ok) {
    setActionStatus('err', result.error ?? 'Reset failed');
    return;
  }
  setActionStatus('ok', `Code index reset (${result.removed ?? 0} database).`);
  await refreshCodeStatus();
  await refreshRepoMap();
}

function bindCodeSection(): void {
  if (bindingsDone) return;
  bindingsDone = true;

  document.getElementById('brainCodeReindex')?.addEventListener('click', () => {
    void runReindex();
  });

  document.getElementById('brainCodeResetIndex')?.addEventListener('click', () => {
    void runResetIndex();
  });

  const searchEl = document.getElementById('brainCodeSearch') as HTMLInputElement | null;
  searchEl?.addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      void runSymbolSearch(searchEl.value);
    }, 280);
  });
  searchEl?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      if (searchTimer) clearTimeout(searchTimer);
      void runSymbolSearch(searchEl.value);
    }
  });

  const focusEl = document.getElementById('brainCodeFocus') as HTMLInputElement | null;
  focusEl?.addEventListener('input', () => {
    if (focusTimer) clearTimeout(focusTimer);
    focusTimer = setTimeout(() => {
      void refreshRepoMap();
    }, 320);
  });
}

/** Load Code section: status, repo map, wire controls once. */
export async function renderCodeSection(): Promise<void> {
  bindCodeSection();
  showExplainEmpty('Select a symbol to see anchored wiki pages.');
  await refreshCodeStatus();
  await refreshRepoMap();
}
