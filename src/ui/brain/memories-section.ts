/**
 * Brain app — Memories. The graph is the home view: one hub for this project and one
 * for you across projects, a cluster per memory kind, and each memory hanging off its
 * cluster. A list view shows the same memories grouped. Both share one inspector for
 * reading, adding, editing and forgetting.
 */

import {
  readConfigFile,
  writeConfigFile,
} from '../../config/config-file-cache';
import {
  createMemoryRecord,
  fetchMemories,
  forgetMemoryRecord,
  updateMemoryRecord,
} from '../../brain/client';
import type { MemoryKind, MemoryListing, MemoryRecord, MemoryScope } from '../../brain/types';
import { fetchMemoryEnabled } from '../../memory/client';
import { appConfirm } from '../app-dialog';
import { createForceGraph, type ForceGraphApi } from './graph/force-graph';
import {
  MEMORY_KIND_ORDER,
  MEMORY_KIND_PLURAL,
  buildMemoryGraph,
  clusterId,
  filterMemories,
  hubId,
  memoryNodeId,
} from './graph/graph-data';
import type { GraphData, GraphNode } from './graph/types';

type StatusKind = 'idle' | 'ok' | 'err' | 'spin';
type ViewMode = 'graph' | 'list';

export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = MEMORY_KIND_PLURAL;

const KIND_SINGULAR: Record<MemoryKind, string> = {
  decision: 'Decision',
  constraint: 'Constraint',
  gotcha: 'Gotcha',
  preference: 'Preference',
  reference: 'Reference',
};

const KIND_HINT: Record<MemoryKind, string> = {
  decision: 'A choice that was made and why.',
  constraint: 'A rule the code or product must keep.',
  gotcha: 'A verified trap and how to avoid it.',
  preference: 'How you like things done.',
  reference: 'Where to find something.',
};

export interface MemoryGroup {
  scope: MemoryScope;
  title: string;
  count: number;
  cap: number;
  kinds: { kind: MemoryKind; label: string; items: MemoryRecord[] }[];
}

/** Group a listing by scope (project first), then by kind in a stable order. */
export function groupMemories(listing: MemoryListing, memories: MemoryRecord[] = listing.memories): MemoryGroup[] {
  const scopes: { scope: MemoryScope; title: string; cap: number }[] = [];
  if (listing.project) {
    scopes.push({ scope: 'project', title: `Project · ${listing.project.label}`, cap: listing.limits.projectCap });
  }
  scopes.push({ scope: 'user', title: 'Your preferences · all projects', cap: listing.limits.userCap });
  return scopes.map(({ scope, title, cap }) => {
    const rows = memories.filter((memory) => memory.scope === scope);
    return {
      scope,
      title,
      cap,
      count: listing.memories.filter((memory) => memory.scope === scope).length,
      kinds: MEMORY_KIND_ORDER
        .map((kind) => ({
          kind,
          label: MEMORY_KIND_LABELS[kind],
          items: rows.filter((memory) => (memory.kind ?? 'reference') === kind),
        }))
        .filter((group) => group.items.length > 0),
    };
  });
}

// ── State ────────────────────────────────────────────────────────────────────

let bindingsDone = false;
let refreshGen = 0;
let listing: MemoryListing | null = null;
let view: ViewMode = 'graph';
let query = '';
const hiddenScopes = new Set<MemoryScope>();
const hiddenKinds = new Set<MemoryKind>();
/** Selected graph node id (hub, cluster or memory). */
let selectedNode: string | null = null;
let editingId: string | null = null;
let composing = false;
let graph: ForceGraphApi | null = null;
let graphUnavailable = false;
let graphData: GraphData = { nodes: [], edges: [] };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;

let statusTimer: ReturnType<typeof setTimeout> | undefined;

/** Short-lived toast over the stage; progress stays until the next status replaces it. */
function setStatus(kind: StatusKind, message: string): void {
  const el = $('brainMemoriesStatus');
  if (!el) return;
  clearTimeout(statusTimer);
  el.textContent = message;
  el.dataset.kind = kind;
  if (kind !== 'spin' && message) {
    statusTimer = setTimeout(() => {
      if (el.textContent === message) el.textContent = '';
    }, kind === 'err' ? 6000 : 3000);
  }
}

function findMemory(id: string | null): MemoryRecord | undefined {
  return id ? listing?.memories.find((memory) => memory.id === id) : undefined;
}

function selectedMemoryId(): string | null {
  return selectedNode?.startsWith('mem:') ? selectedNode.slice(4) : null;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, className: string, data?: Record<string, string>): HTMLButtonElement {
  const btn = el('button', className, label);
  btn.type = 'button';
  for (const [key, value] of Object.entries(data ?? {})) btn.dataset[key] = value;
  return btn;
}

function kindDot(kind: MemoryKind | undefined, extra = ''): HTMLSpanElement {
  const dot = el('span', `bm-dot${extra ? ` ${extra}` : ''}`);
  dot.dataset.kind = kind ?? 'hub';
  dot.setAttribute('aria-hidden', 'true');
  return dot;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function scopeLabel(scope: MemoryScope): string {
  return scope === 'user' ? 'All projects' : listing?.project?.label ?? 'This project';
}

function visibleMemories(): MemoryRecord[] {
  return listing ? filterMemories(listing, { query, hiddenScopes, hiddenKinds }) : [];
}

// ── Inspector ────────────────────────────────────────────────────────────────

type Pane = 'overview' | 'detail' | 'edit';

function showPane(pane: Pane): void {
  const toggle = (id: string, visible: boolean) => {
    const node = $(id);
    if (!node) return;
    node.classList.toggle('hidden', !visible);
    node.toggleAttribute('hidden', !visible);
  };
  toggle('brainMemoryEmptyState', pane === 'overview');
  toggle('brainMemoryDetail', pane === 'detail');
  toggle('brainMemoryAddPanel', pane === 'edit');
  $('brainMemoryDetailPane')?.classList.toggle('is-engaged', pane !== 'overview');
}

function memoryRow(memory: MemoryRecord): HTMLElement {
  const row = el('article', 'bm-row');
  row.setAttribute('role', 'listitem');
  const btn = button('', 'bm-row__btn', { memorySelect: memory.id });
  btn.setAttribute('aria-selected', selectedMemoryId() === memory.id ? 'true' : 'false');
  btn.append(kindDot(memory.kind), el('span', 'bm-row__title', memory.title || 'Untitled'),
    el('span', 'bm-row__meta', String(memory.updatedAt ?? '').slice(0, 10)));
  row.append(btn);
  return row;
}

/** Nothing selected: what is in memory, and how it is used. */
function renderOverview(): void {
  const mount = $('brainMemoryEmptyState');
  if (!mount) return;
  mount.replaceChildren();
  if (!listing) {
    mount.append(el('p', 'bm-inspector__lead', 'Start Minnow with npm start to review memories.'));
    return;
  }
  mount.append(el('p', 'bm-eyebrow', 'Overview'));
  const scopes = el('div', 'bm-meters');
  const meters: Array<{ scope: MemoryScope; label: string; cap: number }> = [];
  if (listing.project) meters.push({ scope: 'project', label: listing.project.label, cap: listing.limits.projectCap });
  meters.push({ scope: 'user', label: 'You · all projects', cap: listing.limits.userCap });
  for (const meter of meters) {
    const count = listing.memories.filter((m) => m.scope === meter.scope).length;
    const item = button('', 'bm-meter', { memoryNode: hubId(meter.scope) });
    const head = el('span', 'bm-meter__head');
    head.append(el('span', 'bm-meter__label', meter.label), el('span', 'bm-meter__count', `${count} / ${meter.cap}`));
    const bar = el('span', 'bm-meter__bar');
    const fill = el('span', 'bm-meter__fill');
    fill.style.inlineSize = `${Math.min(100, (count / Math.max(1, meter.cap)) * 100)}%`;
    bar.append(fill);
    item.append(head, bar);
    scopes.append(item);
  }
  mount.append(scopes);

  const kinds = el('ul', 'bm-kind-list');
  for (const kind of MEMORY_KIND_ORDER) {
    const count = listing.memories.filter((m) => m.kind === kind).length;
    const li = el('li', 'bm-kind-list__item');
    const name = el('span', 'bm-kind-list__name');
    name.append(kindDot(kind), el('span', '', MEMORY_KIND_PLURAL[kind]));
    li.append(name, el('span', 'bm-kind-list__hint', KIND_HINT[kind]), el('span', 'bm-kind-list__count', String(count)));
    kinds.append(li);
  }
  mount.append(kinds);

  if (!listing.memories.length) {
    mount.append(el('p', 'bm-inspector__lead',
      'No memories yet. Agents save decisions, constraints, your preferences and verified gotchas as they work, and search them when a task calls for it. You can add one yourself too.'));
  } else {
    mount.append(el('p', 'bm-inspector__note',
      'Select a node to read it. Agents search these when a task needs them — nothing is added to prompts automatically.'));
  }
}

function renderMemoryDetail(memory: MemoryRecord): void {
  const mount = $('brainMemoryDetail');
  if (!mount) return;
  mount.replaceChildren();

  const head = el('header', 'bm-detail__head');
  const kind = el('p', 'bm-detail__kind');
  kind.append(kindDot(memory.kind), el('span', '', KIND_SINGULAR[memory.kind] ?? memory.kind));
  kind.append(el('span', 'bm-detail__scope', scopeLabel(memory.scope)));
  head.append(kind, el('h2', 'bm-detail__title', memory.title || 'Untitled'));

  const body = el('pre', 'brain-memory-detail__body bm-detail__body', memory.body?.trim() ? memory.body : '(empty)');

  const facts = el('dl', 'bm-facts');
  const fact = (label: string, value: string) => {
    facts.append(el('dt', '', label), el('dd', '', value));
  };
  if (memory.evidence) fact('Evidence', memory.evidence);
  fact('Saved by', memory.source === 'user' ? 'You' : 'An agent');
  fact('Updated', formatTimestamp(memory.updatedAt));
  const replaced = (memory.supersedes ?? []).map((id) => findMemory(id)?.title).filter(Boolean) as string[];
  if (replaced.length) fact('Replaces', replaced.join(', '));
  const replacedBy = listing?.memories.filter((m) => m.supersedes?.includes(memory.id)).map((m) => m.title) ?? [];
  if (replacedBy.length) fact('Replaced by', replacedBy.join(', '));

  const actions = el('div', 'bm-detail__actions');
  const editBtn = button('Edit', 'bm-btn', { memoryEdit: memory.id });
  editBtn.setAttribute('aria-label', `Edit memory ${memory.title}`);
  const forgetBtn = button('Forget', 'bm-btn bm-btn--danger', { memoryForget: memory.id });
  forgetBtn.setAttribute('aria-label', `Forget memory ${memory.title}`);
  actions.append(editBtn, forgetBtn);

  const close = button('', 'bm-icon-btn bm-detail__close', { memoryClose: '' });
  close.setAttribute('aria-label', 'Close');
  close.innerHTML = '<i class="fi fi-rr-cross-small icon-svg" aria-hidden="true"></i>';

  mount.append(close, head, body, facts, actions);
  showPane('detail');
}

/** A hub or cluster: the memories inside it. */
function renderGroupDetail(nodeId: string): void {
  const mount = $('brainMemoryDetail');
  if (!mount || !listing) return;
  mount.replaceChildren();
  const [type, scope, kind] = nodeId.split(':') as ['hub' | 'kind', MemoryScope, MemoryKind | undefined];
  const scopeId = type === 'hub' ? (scope as MemoryScope) : scope;
  const rows = visibleMemories().filter((m) => m.scope === scopeId && (!kind || m.kind === kind));

  const head = el('header', 'bm-detail__head');
  const eyebrow = el('p', 'bm-detail__kind');
  eyebrow.append(kindDot(kind), el('span', '', kind ? scopeLabel(scopeId) : scopeId === 'user' ? 'Across all projects' : 'This project'));
  head.append(eyebrow, el('h2', 'bm-detail__title', kind ? MEMORY_KIND_PLURAL[kind] : scopeId === 'user' ? 'Your preferences' : listing.project?.label ?? 'Project'));
  if (kind) head.append(el('p', 'bm-detail__lead', KIND_HINT[kind]));

  const list = el('div', 'bm-detail__list');
  list.setAttribute('role', 'list');
  for (const memory of rows) list.append(memoryRow(memory));
  if (!rows.length) list.append(el('p', 'bm-inspector__note', query ? 'No memories here match the search.' : 'Nothing here yet.'));

  const close = button('', 'bm-icon-btn bm-detail__close', { memoryClose: '' });
  close.setAttribute('aria-label', 'Close');
  close.innerHTML = '<i class="fi fi-rr-cross-small icon-svg" aria-hidden="true"></i>';
  const actions = el('div', 'bm-detail__actions');
  actions.append(button(`Add ${kind ? KIND_SINGULAR[kind].toLowerCase() : 'memory'}`, 'bm-btn', {
    memoryCompose: `${scopeId}:${kind ?? ''}`,
  }));
  mount.append(close, head, list, actions);
  showPane('detail');
}

/** Select a graph node (or nothing) and sync graph, list and inspector. */
function selectNode(id: string | null, options: { fromGraph?: boolean; reveal?: boolean } = {}): void {
  selectedNode = id && (graphData.nodes.some((n) => n.id === id) || id.startsWith('mem:')) ? id : null;
  editingId = null;
  composing = false;
  const memId = selectedMemoryId();
  document.querySelectorAll<HTMLButtonElement>('#brainMemoryDetailPane [data-memory-select], #brainMemoryList [data-memory-select]')
    .forEach((btn) => btn.setAttribute('aria-selected', btn.dataset.memorySelect === memId ? 'true' : 'false'));
  if (graph && !options.fromGraph) {
    const present = selectedNode && graph.hasNode(selectedNode) ? selectedNode : null;
    graph.selectNode(present);
    if (present && options.reveal) graph.centerOnNode(present);
  }
  const memory = findMemory(memId);
  if (memory) renderMemoryDetail(memory);
  else if (selectedNode) renderGroupDetail(selectedNode);
  else {
    renderOverview();
    showPane('overview');
  }
}

// ── Edit / add ───────────────────────────────────────────────────────────────

function setField(id: string, text: string): void {
  const node = $<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(id);
  if (node) node.value = text;
}

function readField(id: string): string {
  return ($<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(id)?.value ?? '').trim();
}

function showFormError(message: string): void {
  const err = $('brainMemoryAddError');
  if (!err) return;
  err.textContent = message;
  err.classList.toggle('hidden', !message);
}

function updateBodyCount(): void {
  const count = $('brainMemoryBodyCount');
  const limit = listing?.limits.body ?? 1200;
  if (count) count.textContent = `${readField('brainMemoryAddBody').length} / ${limit}`;
}

function openForm(mode: 'edit' | 'add', memory?: MemoryRecord, preset?: { scope?: MemoryScope; kind?: MemoryKind }): void {
  editingId = mode === 'edit' ? memory?.id ?? null : null;
  composing = mode === 'add';
  const heading = $('brainMemoryFormTitle');
  if (heading) heading.textContent = mode === 'edit' ? 'Edit memory' : 'Add a memory';
  setField('brainMemoryAddTitle', memory?.title ?? '');
  setField('brainMemoryAddKind', memory?.kind ?? preset?.kind ?? 'decision');
  setField('brainMemoryAddBody', memory?.body ?? '');
  setField('brainMemoryAddEvidence', memory?.evidence ?? '');
  const scopeField = $('brainMemoryScopeField');
  scopeField?.classList.toggle('hidden', mode === 'edit');
  scopeField?.toggleAttribute('hidden', mode === 'edit');
  const projectOption = document.querySelector<HTMLOptionElement>('#brainMemoryAddScope option[value="project"]');
  if (projectOption) {
    projectOption.disabled = !listing?.project;
    projectOption.textContent = listing?.project ? `This project · ${listing.project.label}` : 'This project (none open)';
  }
  setField('brainMemoryAddScope', preset?.scope ?? (listing?.project ? 'project' : 'user'));
  const submit = $('brainMemoryAddSubmit');
  if (submit) submit.textContent = mode === 'edit' ? 'Save changes' : 'Add memory';
  showFormError('');
  updateBodyCount();
  showPane('edit');
  $<HTMLInputElement>('brainMemoryAddTitle')?.focus();
}

async function submitForm(): Promise<void> {
  const title = readField('brainMemoryAddTitle');
  const body = readField('brainMemoryAddBody');
  if (!title || !body) {
    showFormError('Title and body are required.');
    return;
  }
  const submit = $<HTMLButtonElement>('brainMemoryAddSubmit');
  if (submit?.disabled) return;
  if (submit) submit.disabled = true;
  const kind = readField('brainMemoryAddKind') as MemoryKind;
  const evidence = readField('brainMemoryAddEvidence');
  let result;
  if (editingId) {
    const memory = findMemory(editingId);
    if (!memory) {
      if (submit) submit.disabled = false;
      return;
    }
    setStatus('spin', 'Saving…');
    result = await updateMemoryRecord(memory.id, { expectedRevision: memory.revision, title, body, kind, evidence });
  } else {
    setStatus('spin', 'Adding…');
    const scope = readField('brainMemoryAddScope') === 'user' ? 'user' : 'project';
    result = await createMemoryRecord({ scope, title, body, kind, evidence });
  }
  if (submit) submit.disabled = false;
  if (!result.ok) {
    const conflict = result.conflictId ? findMemory(result.conflictId) : undefined;
    showFormError(
      result.code === 'stale'
        ? 'An agent changed this memory while you were editing. Close the editor to load the new version, then apply your change again.'
        : result.code === 'duplicate' && conflict
          ? `This overlaps “${conflict.title}”. Open that memory and edit it instead of adding a second one.`
          : result.error,
    );
    setStatus('err', 'Not saved');
    return;
  }
  setStatus('ok', editingId ? `Saved “${result.memory.title}”` : `Added “${result.memory.title}”`);
  editingId = null;
  composing = false;
  selectedNode = memoryNodeId(result.memory.id);
  await refreshMemories();
}

async function forget(id: string): Promise<void> {
  const memory = findMemory(id);
  if (!memory) return;
  const ok = await appConfirm(`Forget “${memory.title}”? Agents will no longer find it.`, {
    confirmLabel: 'Forget',
    danger: true,
  });
  if (!ok) return;
  const result = await forgetMemoryRecord(id, { expectedRevision: memory.revision });
  if (!result.ok) {
    setStatus('err', result.error ?? 'Could not forget this memory');
    return;
  }
  if (selectedMemoryId() === id) selectedNode = clusterId(memory.scope, memory.kind);
  setStatus('ok', `Forgot “${memory.title}”`);
  await refreshMemories();
}

// ── Toolbar: scopes and legend ───────────────────────────────────────────────

function renderScopeChips(): void {
  const mount = $('brainMemoryScopes');
  if (!mount) return;
  mount.replaceChildren();
  if (!listing) return;
  const scopes: Array<{ scope: MemoryScope; label: string; cap: number }> = [];
  if (listing.project) scopes.push({ scope: 'project', label: listing.project.label, cap: listing.limits.projectCap });
  scopes.push({ scope: 'user', label: 'You', cap: listing.limits.userCap });
  for (const { scope, label, cap } of scopes) {
    const count = listing.memories.filter((m) => m.scope === scope).length;
    const chip = button('', 'bm-chip', { memoryScope: scope });
    chip.setAttribute('aria-pressed', hiddenScopes.has(scope) ? 'false' : 'true');
    chip.title = scope === 'user' ? 'Your preferences across all projects' : 'Memories for this project';
    chip.append(el('span', 'bm-chip__label', label), el('span', 'bm-chip__count', `${count}/${cap}`));
    mount.append(chip);
  }
}

function renderLegend(): void {
  const mount = $('brainMemoryLegend');
  if (!mount) return;
  mount.replaceChildren();
  for (const kind of MEMORY_KIND_ORDER) {
    const chip = button('', 'bm-legend__item', { memoryKind: kind });
    chip.setAttribute('aria-pressed', hiddenKinds.has(kind) ? 'false' : 'true');
    chip.title = `${hiddenKinds.has(kind) ? 'Show' : 'Hide'} ${MEMORY_KIND_PLURAL[kind].toLowerCase()}`;
    chip.append(kindDot(kind), el('span', '', MEMORY_KIND_PLURAL[kind]));
    mount.append(chip);
  }
}

// ── Views ────────────────────────────────────────────────────────────────────

function renderList(): void {
  const listEl = $('brainMemoryList');
  if (!listEl || !listing) {
    listEl?.replaceChildren();
    return;
  }
  listEl.replaceChildren();
  const groups = groupMemories(listing, visibleMemories()).filter((g) => !hiddenScopes.has(g.scope));
  for (const group of groups) {
    const section = el('section', 'bm-group');
    section.setAttribute('aria-label', group.title);
    const head = el('header', 'bm-group__head');
    head.append(el('h3', 'bm-group__title', group.title), el('span', 'bm-group__count', `${group.count} / ${group.cap}`));
    section.append(head);
    if (!group.kinds.length) {
      section.append(el('p', 'bm-group__empty', query
        ? 'No matches.'
        : group.scope === 'user' ? 'No cross-project preferences yet.' : 'No memories for this project yet.'));
    }
    for (const kindGroup of group.kinds) {
      const kindHead = el('p', 'bm-group__kind');
      kindHead.append(kindDot(kindGroup.kind), el('span', '', kindGroup.label), el('span', 'bm-group__kind-count', String(kindGroup.items.length)));
      section.append(kindHead);
      const rows = el('div', 'bm-group__rows');
      for (const memory of kindGroup.items) rows.append(memoryRow(memory));
      section.append(rows);
    }
    listEl.append(section);
  }
}

function ensureGraph(): void {
  if (graph || graphUnavailable) return;
  const canvas = $<HTMLCanvasElement>('brainMemoryCanvas');
  if (!canvas) return;
  try {
    graph = createForceGraph(canvas, {
      onSelect: (node: GraphNode | null) => selectNode(node?.id ?? null, { fromGraph: true }),
      onDoubleClick: (node: GraphNode) => {
        if (node.kind === 'memory') {
          const memory = findMemory(node.memoryId ?? null);
          if (memory) openForm('edit', memory);
        } else graph?.focusNode(node.id);
      },
    });
  } catch {
    // No 2D canvas (tests, very old WebViews): the list view still works.
    graphUnavailable = true;
    setView('list');
  }
}

function renderGraph(): void {
  if (!listing) return;
  graphData = buildMemoryGraph(listing, { query, hiddenScopes, hiddenKinds });
  if (view !== 'graph') return;
  ensureGraph();
  if (!graph) return;
  graph.setData(graphData.nodes, graphData.edges);
  if (selectedNode && graph.hasNode(selectedNode)) graph.selectNode(selectedNode);
}

function setView(next: ViewMode): void {
  view = graphUnavailable ? 'list' : next;
  const root = $('brainSection-memories');
  root?.setAttribute('data-view', view);
  document.querySelectorAll<HTMLButtonElement>('[data-memory-view]').forEach((btn) => {
    const on = btn.dataset.memoryView === view;
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
    btn.tabIndex = on ? 0 : -1;
  });
  const graphView = $('brainMemoryGraphView');
  const listView = $('brainMemoryListView');
  graphView?.toggleAttribute('hidden', view !== 'graph');
  listView?.toggleAttribute('hidden', view !== 'list');
  if (view === 'graph' && listing) renderGraph();
}

function renderAll(): void {
  renderScopeChips();
  renderLegend();
  renderList();
  renderGraph();
  const total = visibleMemories().length;
  const empty = $('brainMemoryStageEmpty');
  if (empty) {
    const nothing = Boolean(listing) && !listing!.memories.length;
    empty.toggleAttribute('hidden', !(nothing || (listing && !total)));
    const title = empty.querySelector('.bm-stage-empty__title');
    const text = empty.querySelector('.bm-stage-empty__text');
    if (title) title.textContent = nothing ? 'No memories yet' : 'Nothing matches';
    if (text) {
      text.textContent = nothing
        ? 'Agents save decisions, constraints, your preferences and verified gotchas here as they work.'
        : 'Clear the search or turn a hidden kind back on.';
    }
    empty.querySelector('[data-memory-compose]')?.toggleAttribute('hidden', !nothing);
  }
}

async function refreshMemories(): Promise<void> {
  const gen = ++refreshGen;
  const next = await fetchMemories();
  if (gen !== refreshGen) return;
  $('brainMemoryOffline')?.toggleAttribute('hidden', next !== null);
  $('brainMemoryOffline')?.classList.toggle('hidden', next !== null);
  listing = next;
  if (!next) {
    $('brainMemoryList')?.replaceChildren();
    renderScopeChips();
    selectNode(null);
    return;
  }
  renderAll();
  if (editingId || composing) return;
  if (selectedNode?.startsWith('mem:') && !findMemory(selectedMemoryId())) selectedNode = null;
  selectNode(selectedNode, { reveal: false });
}

// ── Bindings ─────────────────────────────────────────────────────────────────

function bindMemoriesSection(): void {
  if (bindingsDone) return;
  bindingsDone = true;
  const root = $('brainSection-memories');

  root?.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const pick = (attr: string) => target.closest<HTMLElement>(`[data-${attr}]`);
    const selectBtn = pick('memory-select');
    if (selectBtn?.dataset.memorySelect) {
      selectNode(memoryNodeId(selectBtn.dataset.memorySelect), { reveal: true });
      return;
    }
    const nodeBtn = pick('memory-node');
    if (nodeBtn?.dataset.memoryNode) {
      selectNode(nodeBtn.dataset.memoryNode, { reveal: true });
      return;
    }
    const editBtn = pick('memory-edit');
    if (editBtn?.dataset.memoryEdit) {
      const memory = findMemory(editBtn.dataset.memoryEdit);
      if (memory) openForm('edit', memory);
      return;
    }
    const forgetBtn = pick('memory-forget');
    if (forgetBtn?.dataset.memoryForget) {
      void forget(forgetBtn.dataset.memoryForget);
      return;
    }
    const compose = pick('memory-compose');
    if (compose) {
      const [scope, kind] = (compose.dataset.memoryCompose ?? '').split(':');
      openForm('add', undefined, {
        scope: scope === 'user' || scope === 'project' ? scope : undefined,
        kind: (MEMORY_KIND_ORDER as string[]).includes(kind) ? (kind as MemoryKind) : undefined,
      });
      return;
    }
    if (pick('memory-close')) {
      selectNode(null);
      return;
    }
    const viewBtn = pick('memory-view');
    if (viewBtn?.dataset.memoryView) {
      setView(viewBtn.dataset.memoryView as ViewMode);
      return;
    }
    const scopeChip = pick('memory-scope');
    if (scopeChip?.dataset.memoryScope) {
      const scope = scopeChip.dataset.memoryScope as MemoryScope;
      if (hiddenScopes.has(scope)) hiddenScopes.delete(scope);
      else hiddenScopes.add(scope);
      renderAll();
      return;
    }
    const kindChip = pick('memory-kind');
    if (kindChip?.dataset.memoryKind) {
      const kind = kindChip.dataset.memoryKind as MemoryKind;
      if (hiddenKinds.has(kind)) hiddenKinds.delete(kind);
      else hiddenKinds.add(kind);
      renderAll();
      return;
    }
    const zoom = pick('memory-zoom');
    if (zoom && graph) {
      const action = zoom.dataset.memoryZoom;
      if (action === 'in') graph.zoomBy(1.3);
      else if (action === 'out') graph.zoomBy(1 / 1.3);
      else graph.fitToView();
    }
  });

  $('brainMemoryAdd')?.addEventListener('click', () => openForm('add'));
  $('brainMemoryAddForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitForm();
  });
  $('brainMemoryAddBody')?.addEventListener('input', updateBodyCount);
  $('brainMemoryAddCancel')?.addEventListener('click', () => {
    const wasEditing = editingId;
    editingId = null;
    composing = false;
    // Reload after an edit so a stale draft never hides an agent's newer version.
    if (wasEditing) void refreshMemories();
    else selectNode(selectedNode);
  });
  $('brainMemoryRefresh')?.addEventListener('click', () => {
    void refreshMemories();
  });

  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  $<HTMLInputElement>('brainMemorySearch')?.addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    const value = (event.target as HTMLInputElement).value;
    searchTimer = setTimeout(() => {
      query = value;
      renderAll();
    }, 120);
  });

  root?.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const inForm = (event.target as HTMLElement).closest('#brainMemoryAddForm');
    if (inForm) {
      $('brainMemoryAddCancel')?.click();
      event.stopPropagation();
    } else if (selectedNode) {
      selectNode(null);
    }
  });

  window.addEventListener('minnow:memory-changed', () => {
    // Don't replace a draft being edited. Opening the section or Refresh reads
    // the latest revision, and a stale save is rejected by the store.
    if (!editingId && !composing && $('brainSection-memories')?.classList.contains('is-active')) {
      void refreshMemories();
    }
  });

  const enableEl = $<HTMLInputElement>('brainMemoryEnabled');
  enableEl?.addEventListener('change', async () => {
    const config = await readConfigFile({ fresh: true });
    if (!config) {
      setStatus('err', 'Memory settings need Minnow running locally');
      return;
    }
    const memory = config.memory;
    config.memory = {
      ...(memory && typeof memory === 'object' ? (memory as Record<string, unknown>) : {}),
      enabled: enableEl.checked,
    };
    if (await writeConfigFile(config)) {
      setStatus('idle', enableEl.checked ? 'Agents can use memory' : 'Agents won’t read or save memories');
    } else {
      setStatus('err', 'Memory settings need Minnow running locally');
    }
  });
}

/** Load Memories: graph (or list), scopes, legend and the inspector. */
export async function renderMemoriesSection(): Promise<void> {
  bindMemoriesSection();
  setView(view);
  const enableEl = $<HTMLInputElement>('brainMemoryEnabled');
  if (enableEl) enableEl.checked = await fetchMemoryEnabled();
  await refreshMemories();
}

/** Stop the graph simulation when Brain closes; the next open rebuilds it. */
export function teardownMemoriesSection(): void {
  graph?.destroy();
  graph = null;
}

/** Reset module state between tests. */
export function resetMemoriesSectionForTests(): void {
  teardownMemoriesSection();
  bindingsDone = false;
  listing = null;
  view = 'graph';
  query = '';
  hiddenScopes.clear();
  hiddenKinds.clear();
  selectedNode = null;
  editingId = null;
  composing = false;
  graphUnavailable = false;
  graphData = { nodes: [], edges: [] };
}
