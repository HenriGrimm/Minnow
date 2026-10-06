import { gitLog, type GitCommitEntry, type GitLogResult } from '../../state/git-api';
import type { CommitVisual } from '../git-graph';
import { button, el, emptyState, errorStrip, skeletonRows } from '../scc-shared';
import { createViewport, type ViewportApi, type ViewState } from '../spatial-viewport';
import { frameGitHistoryLayout, layoutGitHistory, type GitHistoryBox, type GitHistoryLayout } from './layout';
import {
  buildGitHistoryModel, collapseGitHistoryBranches, commitVisual, filterGitHistoryModel,
  type GitHistoryModel, type GitHistoryNode, type GitHistoryRefKind,
} from './model';
import { gitHistoryColorToken, renderGitHistoryScene, type GitHistorySceneApi } from './scene';

export interface GitHistoryMapOptions {
  cwd?: string;
  onSelectCommit?(sha: string): void;
  onContextMenu?(visual: CommitVisual, event: MouseEvent): void;
  onSelectionRemoved?(): void;
}
export interface GitHistoryMapHandle {
  refresh(): Promise<void>;
  setSelection(sha: string | null): void;
  destroy(): void;
}

const VIEW_KEY = 'minnow.git-history.view';
const PAGE_SIZE = 200;
const LIST_ROW_HEIGHT = 88;

/** One loaded history and selection shared by spatial and chronological views. */
export function createGitHistoryMap(host: HTMLElement, options: GitHistoryMapOptions = {}): GitHistoryMapHandle {
  const root = el('div', 'git-history-map');
  const toolbar = el('div', 'git-history-map__toolbar');
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'History discovery');
  const search = el('input', 'git-history-map__search');
  search.type = 'search';
  search.placeholder = 'Search loaded history';
  search.setAttribute('aria-label', 'Search loaded commits by message, author, SHA, or ref');
  const filter = el('select', 'git-history-map__filter');
  filter.setAttribute('aria-label', 'Filter by ref type');
  for (const [value, label] of [['all', 'All refs'], ['head', 'HEAD'], ['local', 'Local branches'], ['remote', 'Remote branches'], ['tag', 'Tags']]) {
    const option = el('option', '', label);
    option.value = value;
    filter.append(option);
  }
  const branches = el('select', 'git-history-map__filter');
  branches.setAttribute('aria-label', 'Branch to collapse or expand');
  const collapse = button({ label: 'Collapse', onClick: toggleBranch });
  const switcher = el('div', 'git-history-map__switch');
  switcher.setAttribute('role', 'group');
  switcher.setAttribute('aria-label', 'History view');
  const mapButton = button({ label: 'Map', onClick: () => changeView('map') });
  const listButton = button({ label: 'List', onClick: () => changeView('list') });
  switcher.append(mapButton, listButton);
  toolbar.append(switcher, search, filter);
  const branchControls = el('div', 'git-history-map__branch-controls');
  branchControls.append(branches, collapse);
  toolbar.append(branchControls);

  const message = el('div', 'git-history-map__message');
  message.hidden = true;
  const body = el('div', 'git-history-map__body');
  const canvas = el('div', 'git-history-map__viewport');
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'region');
  canvas.setAttribute('aria-label', 'Commit map, older on the left and newer on the right. Drag or scroll horizontally; pinch to zoom. Arrow keys on commits navigate; Home finds HEAD.');
  const scene = el('div', 'git-history-map__scene');
  const overview = el('canvas', 'git-history-map__overview');
  overview.setAttribute('aria-hidden', 'true');
  overview.hidden = true;
  canvas.append(scene, overview);
  const list = el('div', 'git-history-map__list');
  list.setAttribute('role', 'region');
  list.setAttribute('aria-label', 'Chronological commit list');
  const listContent = el('div', 'git-history-map__list-content');
  list.append(listContent);
  body.append(canvas, list);

  const footer = el('div', 'git-history-map__footer');
  const status = el('span', 'git-history-map__status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const older = button({ label: 'Load older', onClick: () => void loadOlder() });
  const navigation = el('div', 'git-history-map__navigation');
  navigation.setAttribute('role', 'toolbar');
  navigation.setAttribute('aria-label', 'Map navigation');
  const zoom = el('span', 'git-history-map__zoom', '100%');
  navigation.append(
    button({ label: 'Zoom out', onClick: () => viewport.zoomBy(1 / 1.25) }), zoom,
    button({ label: 'Zoom in', onClick: () => viewport.zoomBy(1.25) }),
    button({ label: 'Fit', icon: 'expand', onClick: () => viewport.fit({ maxScale: 1 }) }),
    button({ label: 'Reset', onClick: resetView }),
  );
  const minimap = el('canvas', 'git-history-map__minimap');
  minimap.setAttribute('aria-label', 'Commit map overview. Drag to pan.');
  minimap.setAttribute('role', 'img');
  const navigationRow = el('div', 'git-history-map__navigation-row');
  navigationRow.append(navigation, minimap);
  footer.append(status, older);
  root.append(toolbar, message, body, navigationRow, footer);
  host.replaceChildren(root);

  let destroyed = false;
  let generation = 0;
  let busy = false;
  let cwd = options.cwd;
  let commits: GitCommitEntry[] = [];
  let model = buildGitHistoryModel([]);
  let visibleModel = model;
  let layout: GitHistoryLayout = layoutGitHistory(model);
  let sceneApi: GitHistorySceneApi | null = null;
  let selected: string | null = null;
  let focused: string | null = null;
  let hasMore = false;
  let nextSkip = 0;
  let historyKey: string | null = null;
  let searchTimer = 0;
  let paintFrame = 0;
  let collapsed = new Set<string>();
  let view: 'map' | 'list' = 'map';
  let query = '';
  try { if (localStorage.getItem(VIEW_KEY) === 'list') view = 'list'; } catch { /* Storage can be disabled. */ }
  const viewport: ViewportApi = createViewport(canvas, scene, minimap,
    { prefix: 'git-history-map', noPanSelector: '.git-history-map__no-pan', minScale: 0.0001, horizontal: true,
      horizontalRange: (left, right) => {
        let top = Infinity;
        let bottom = -Infinity;
        for (const box of layout.boxes.values()) {
          if (box.x + box.w < left || box.x > right) continue;
          top = Math.min(top, box.y - 16);
          bottom = Math.max(bottom, box.y + box.h + 16);
        }
        return Number.isFinite(top) ? { top, bottom } : null;
      },
    });
  viewport.onChange((state) => {
    zoom.textContent = `${Math.round(state.k * 100)}%`;
    schedulePaint();
  });
  const resize = new ResizeObserver(schedulePaint);
  resize.observe(body);

  function updateStatus(): void {
    const suffix = selected ? ` · Selected ${selected.slice(0, 7)}` : '';
    status.textContent = busy ? 'Loading history…' : `${commits.length} loaded · ${visibleModel.nodes.length} shown`
      + (query || filter.value !== 'all' ? ` · ${visibleModel.matches.size} matches` : '')
      + (visibleModel.hiddenCount ? ` · ${visibleModel.hiddenCount} hidden` : '') + suffix;
    older.hidden = !hasMore;
    older.disabled = busy;
    root.setAttribute('aria-busy', String(busy));
  }

  function schedulePaint(): void {
    if (paintFrame || destroyed) return;
    paintFrame = window.requestAnimationFrame(() => { paintFrame = 0; renderVisibleScene(); });
  }

  function renderVisibleScene(): void {
    if (destroyed) return;
    if (view === 'map') sceneApi?.renderVisible(viewport.getState(), canvas.clientWidth || 800, canvas.clientHeight || 600);
    else renderList();
  }

  function select(node: GitHistoryNode): void {
    setFocus(node.commit.hash, false);
    options.onSelectCommit?.(node.commit.hash);
  }

  function focusElement(): void {
    if (!focused) return;
    const element = view === 'map' ? sceneApi?.nodeElement(focused)
      : [...listContent.querySelectorAll<HTMLButtonElement>('button')].find((n) => n.dataset.sha === focused);
    element?.focus({ preventScroll: true });
  }

  function setFocus(hash: string, move = true): void {
    focused = hash;
    sceneApi?.setFocus(hash);
    if (move) {
      if (view === 'map') {
        const box = layout.boxes.get(hash);
        if (box) viewport.reveal(box, { padding: 32, minScale: 0.65 });
      } else {
        const index = visibleModel.nodes.findIndex((n) => n.commit.hash === hash);
        const top = index * LIST_ROW_HEIGHT;
        if (top < list.scrollTop || top + LIST_ROW_HEIGHT > list.scrollTop + (list.clientHeight || 600)) list.scrollTop = top;
      }
    }
    renderVisibleScene();
    if (move) focusElement();
  }

  function onKey(node: GitHistoryNode, event: KeyboardEvent): void {
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const target = event.key === 'Home' ? visibleModel.nodes.find((n) => n.isHead) ?? visibleModel.nodes[0]
        : visibleModel.nodes.at(-1);
      if (target) setFocus(target.commit.hash);
      return;
    }
    if (!event.key.startsWith('Arrow')) return;
    event.preventDefault();
    const index = visibleModel.nodes.indexOf(node);
    let target: GitHistoryNode | undefined;
    if (view === 'list') target = visibleModel.nodes[index + (event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1)];
    else {
      const box = layout.boxes.get(node.commit.hash)!;
      let score = Infinity;
      for (const candidate of visibleModel.nodes) {
        if (candidate === node) continue;
        const other = layout.boxes.get(candidate.commit.hash)!;
        const dx = other.x - box.x;
        const dy = other.y - box.y;
        const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
        const along = horizontal ? dx : dy;
        if (along * (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) <= 0) continue;
        const distance = Math.abs(along) + Math.abs(horizontal ? dy : dx) * 2;
        if (distance < score) { score = distance; target = candidate; }
      }
    }
    if (target) setFocus(target.commit.hash);
  }

  function renderList(): void {
    const hadFocus = listContent.contains(document.activeElement);
    const start = Math.max(0, Math.floor(list.scrollTop / LIST_ROW_HEIGHT) - 3);
    const end = Math.min(visibleModel.nodes.length, start + Math.ceil((list.clientHeight || 600) / LIST_ROW_HEIGHT) + 6);
    const indices = new Set<number>();
    for (let i = start; i < end; i++) indices.add(i);
    const focusIndex = visibleModel.nodes.findIndex((n) => n.commit.hash === focused);
    if (focusIndex >= 0) indices.add(focusIndex);
    listContent.style.height = `${visibleModel.nodes.length * LIST_ROW_HEIGHT}px`;
    const fragment = document.createDocumentFragment();
    for (const index of [...indices].sort((a, b) => a - b)) {
      const node = visibleModel.nodes[index];
      const row = el('button', 'git-history-map__list-row');
      row.type = 'button';
      row.dataset.sha = node.commit.hash;
      row.style.top = `${index * LIST_ROW_HEIGHT}px`;
      row.tabIndex = node.commit.hash === focused ? 0 : -1;
      row.setAttribute('aria-pressed', String(node.commit.hash === selected));
      row.classList.toggle('is-selected', node.commit.hash === selected);
      row.classList.toggle('is-context', !visibleModel.matches.has(node.commit.hash));
      row.append(el('span', 'git-history-map__subject', node.commit.subject),
        el('span', 'git-history-map__meta', `${node.commit.hash.slice(0, 7)} · ${node.commit.author} · ${node.commit.relativeTime}`),
        el('span', 'git-history-map__refs', node.refs.map((r) => r.kind === 'tag' ? `Tag: ${r.name}` : r.name).join(' · ')));
      row.addEventListener('click', () => select(node));
      row.addEventListener('focus', () => {
        focused = node.commit.hash;
        for (const item of listContent.querySelectorAll<HTMLButtonElement>('button')) item.tabIndex = item === row ? 0 : -1;
      });
      row.addEventListener('keydown', (e) => onKey(node, e));
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); options.onContextMenu?.(commitVisual(node), e); });
      fragment.append(row);
    }
    listContent.replaceChildren(fragment);
    if (hadFocus) focusElement();
  }

  function updateMinimap(): void {
    const css = window.getComputedStyle(root);
    viewport.setMinimapShapes(visibleModel.nodes.map((n) => ({ ...layout.boxes.get(n.commit.hash)!,
      frame: false, active: n.commit.hash === selected || n.isHead,
      color: css.getPropertyValue(gitHistoryColorToken(n)).trim(),
    })));
  }

  function applyFilter(anchor?: { hash: string; box: GitHistoryBox; state: ViewState }): void {
    const restore = canvas.contains(document.activeElement) || list.contains(document.activeElement);
    visibleModel = collapseGitHistoryBranches(filterGitHistoryModel(model,
      { query, refKind: filter.value as GitHistoryRefKind | 'all' }, selected), collapsed, selected);
    layout = frameGitHistoryLayout(layoutGitHistory(model), visibleModel);
    if (!visibleModel.nodes.some((n) => n.commit.hash === focused)) focused = visibleModel.nodes.find((n) => visibleModel.matches.has(n.commit.hash))?.commit.hash
      ?? visibleModel.nodes[0]?.commit.hash ?? null;
    sceneApi?.destroy();
    sceneApi = renderGitHistoryScene(scene, overview, visibleModel, layout, {
      onSelect: select, onFocus: (node) => { focused = node.commit.hash; sceneApi?.setFocus(focused); }, onKey,
      onContextMenu: (node, event) => options.onContextMenu?.(commitVisual(node), event),
      consumeDrag: () => viewport.consumeDrag(),
    });
    sceneApi.setSelection(selected);
    sceneApi.setFocus(focused);
    const nextBox = anchor ? layout.boxes.get(anchor.hash) : undefined;
    viewport.setContent(layout.width, layout.height, anchor && nextBox ? { ...anchor.state,
      x: anchor.state.x + (anchor.box.x - nextBox.x) * anchor.state.k,
    } : undefined);
    updateMinimap();
    renderVisibleScene();
    updateStatus();
    if (restore && focused) focusElement();
    if (!busy && !visibleModel.nodes.length) {
      message.hidden = false;
      message.replaceChildren(emptyState({ title: commits.length ? 'No matching commits' : 'No commits yet',
        body: commits.length ? 'Clear the search or change the ref filter. Search covers loaded history.' : 'Commits appear here after the first commit.' }));
    } else { message.hidden = true; message.replaceChildren(); }
  }

  function updateBranches(): void {
    const previous = branches.value;
    branches.replaceChildren(el('option', '', 'Choose branch'));
    branches.options[0].value = '';
    const keys = new Map<string, string>();
    for (const node of model.nodes) {
      if (!node.isMain) keys.set(node.branchKey, node.refs.find((r) => r.kind === 'local' || r.kind === 'remote')?.name
        ?? (/^[a-f0-9]{40}$/.test(node.branchKey) ? `Branch at ${node.branchKey.slice(0, 7)}` : node.branchKey));
    }
    for (const [key, name] of keys) {
      const option = el('option', '', name);
      option.value = key;
      branches.append(option);
    }
    branches.value = keys.has(previous) ? previous : '';
    branchControls.hidden = keys.size === 0;
    updateCollapse();
  }

  function updateCollapse(): void {
    collapse.disabled = !branches.value;
    collapse.querySelector('.scc-btn__label')!.textContent = collapsed.has(branches.value) ? 'Expand' : 'Collapse';
    collapse.setAttribute('aria-expanded', String(!collapsed.has(branches.value)));
  }

  function toggleBranch(): void {
    if (!branches.value) return;
    if (collapsed.has(branches.value)) collapsed.delete(branches.value);
    else collapsed.add(branches.value);
    updateCollapse();
    applyFilter();
  }

  function changeView(next: 'map' | 'list'): void {
    const restore = canvas.contains(document.activeElement) || list.contains(document.activeElement);
    view = next;
    try { localStorage.setItem(VIEW_KEY, view); } catch { /* Storage can be disabled. */ }
    canvas.hidden = next !== 'map';
    list.hidden = next !== 'list';
    navigationRow.hidden = next !== 'map';
    mapButton.setAttribute('aria-pressed', String(next === 'map'));
    listButton.setAttribute('aria-pressed', String(next === 'list'));
    const anchor = selected ?? focused;
    if (anchor) {
      if (next === 'list') {
        const index = visibleModel.nodes.findIndex((n) => n.commit.hash === anchor);
        if (index >= 0) list.scrollTop = index * LIST_ROW_HEIGHT;
      } else if (canvas.getBoundingClientRect().width > 0) {
        const box = layout.boxes.get(anchor);
        if (box) viewport.reveal(box, { minScale: 0.65 });
      }
    }
    renderVisibleScene();
    if (restore && focused) setFocus(focused);
  }

  function resetView(): void {
    viewport.reset();
    const node = visibleModel.nodes.find((n) => n.isHead) ?? visibleModel.nodes[0];
    if (node && canvas.getBoundingClientRect().width > 0) viewport.reveal(layout.boxes.get(node.commit.hash)!, { padding: 32, minScale: 0.65 });
  }

  function appendPage(result: GitLogResult, replace: boolean): void {
    // Keep a visible commit at its screen position through polling and older pages.
    const state = viewport.getState();
    const center = { x: ((canvas.clientWidth || 800) / 2 - state.x) / state.k,
      y: ((canvas.clientHeight || 600) / 2 - state.y) / state.k };
    const anchor = visibleModel.nodes.reduce<GitHistoryNode | undefined>((best, node) => {
      const distance = (n: GitHistoryNode) => {
        const box = layout.boxes.get(n.commit.hash)!;
        return Math.hypot(box.x + box.w / 2 - center.x, box.y + box.h / 2 - center.y);
      };
      return !best || distance(node) < distance(best) ? node : best;
    }, undefined);
    const oldBox = anchor ? layout.boxes.get(anchor.commit.hash) : undefined;
    commits = [...new Map([...(replace ? [] : commits), ...(result.commits ?? [])].map((c) => [c.hash, c])).values()];
    hasMore = result.hasMore === true;
    nextSkip = result.nextSkip ?? commits.length;
    historyKey = result.historyKey ?? null;
    model = buildGitHistoryModel(commits);
    if (selected && !commits.some((c) => c.hash === selected)) {
      selected = null;
      options.onSelectionRemoved?.();
    }
    updateBranches();
    applyFilter(anchor && oldBox ? { hash: anchor.commit.hash, box: oldBox, state } : undefined);
  }

  function showFailure(error: string, retry: () => void): void {
    message.hidden = false;
    message.replaceChildren(errorStrip(error, retry));
  }

  async function refresh(): Promise<void> {
    if (destroyed) return;
    const id = ++generation;
    const changedCwd = cwd !== options.cwd;
    cwd = options.cwd;
    if (changedCwd) {
      commits = [];
      selected = focused = null;
      collapsed = new Set();
      query = search.value = '';
      filter.value = 'all';
      list.scrollTop = 0;
      options.onSelectionRemoved?.();
      model = buildGitHistoryModel([]);
      layout = layoutGitHistory(model);
      applyFilter();
    }
    const targetCount = Math.max(PAGE_SIZE, commits.length);
    const firstLoad = commits.length === 0;
    busy = true;
    updateStatus();
    if (firstLoad) { message.hidden = false; message.replaceChildren(skeletonRows(4)); }
    let offset = 0;
    const fresh: GitCommitEntry[] = [];
    let last: GitLogResult;
    let freshKey: string | null = null;
    do {
      last = await gitLog({ cwd, count: PAGE_SIZE, skip: offset, fullRefs: true, historyKey: freshKey });
      if (destroyed || id !== generation) return;
      if (!last.ok) {
        busy = false;
        updateStatus();
        showFailure(last.error ?? 'Could not load history', () => void refresh());
        return;
      }
      fresh.push(...(last.commits ?? []));
      freshKey = last.historyKey ?? null;
      const next = last.nextSkip ?? fresh.length;
      if (!last.hasMore || next <= offset) break;
      offset = next;
    } while (fresh.length < targetCount);
    busy = false;
    appendPage({ ...last, commits: fresh }, true);
    if (firstLoad || changedCwd) resetView();
  }

  async function loadOlder(): Promise<void> {
    if (destroyed || busy || !hasMore) return;
    const id = generation;
    busy = true;
    updateStatus();
    const result = await gitLog({ cwd, count: PAGE_SIZE, skip: nextSkip, fullRefs: true, historyKey });
    if (destroyed || id !== generation) return;
    busy = false;
    if (!result.ok) {
      updateStatus();
      showFailure(result.error ?? 'Could not load older history', () => result.historyChanged ? void refresh() : void loadOlder());
      return;
    }
    appendPage(result, false);
  }

  const onSearch = () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      query = search.value;
      list.scrollTop = 0;
      applyFilter();
      const match = visibleModel.nodes.find((n) => visibleModel.matches.has(n.commit.hash));
      if (match) {
        focused = match.commit.hash;
        if (view === 'map') viewport.reveal(layout.boxes.get(focused)!, { padding: 32, minScale: 0.65 });
        sceneApi?.setFocus(focused);
        renderVisibleScene();
      }
    }, 180);
  };
  const onFilter = () => { list.scrollTop = 0; applyFilter(); if (focused && view === 'map') viewport.reveal(layout.boxes.get(focused)!, { minScale: 0.65 }); };
  search.addEventListener('input', onSearch);
  filter.addEventListener('change', onFilter);
  branches.addEventListener('change', updateCollapse);
  list.addEventListener('scroll', schedulePaint);
  const onCanvasKey = (event: KeyboardEvent) => {
    if (event.target === canvas && (event.key === 'Home' || event.key === 'Enter')) {
      event.preventDefault();
      const node = visibleModel.nodes.find((n) => n.isHead) ?? visibleModel.nodes[0];
      if (node) setFocus(node.commit.hash);
    }
  };
  canvas.addEventListener('keydown', onCanvasKey);
  changeView(view);

  return {
    refresh,
    setSelection(hash) {
      selected = hash;
      sceneApi?.setSelection(hash);
      if (query || filter.value !== 'all' || collapsed.size) applyFilter();
      else {
        if (view === 'list') renderList();
        updateMinimap();
        updateStatus();
      }
    },
    destroy() {
      destroyed = true;
      generation++;
      window.clearTimeout(searchTimer);
      if (paintFrame) window.cancelAnimationFrame(paintFrame);
      resize.disconnect();
      sceneApi?.destroy();
      viewport.destroy();
      search.removeEventListener('input', onSearch);
      filter.removeEventListener('change', onFilter);
      branches.removeEventListener('change', updateCollapse);
      list.removeEventListener('scroll', schedulePaint);
      canvas.removeEventListener('keydown', onCanvasKey);
      root.remove();
    },
  };
}
