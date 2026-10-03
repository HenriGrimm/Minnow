import { expandGitmojiShortcodes } from '../../lib/gitmoji-shortcodes.mjs';
import { el } from '../scc-shared';
import type { ViewState } from '../spatial-viewport';
import { routeGitHistoryEdges, type GitHistoryBox, type GitHistoryLayout } from './layout';
import type { GitHistoryModel, GitHistoryNode } from './model';

export interface GitHistorySceneApi {
  setSelection(hash: string | null): void;
  setFocus(hash: string | null): void;
  nodeElement(hash: string): HTMLButtonElement | null;
  renderVisible(state: ViewState, width: number, height: number): void;
  destroy(): void;
}
export interface GitHistorySceneOptions {
  onSelect(node: GitHistoryNode): void;
  onFocus(node: GitHistoryNode): void;
  onKey(node: GitHistoryNode, event: KeyboardEvent): void;
  onContextMenu?(node: GitHistoryNode, event: MouseEvent): void;
  consumeDrag(): boolean;
}

export function intersects(a: GitHistoryBox, b: GitHistoryBox): boolean {
  return a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
}

export function gitHistoryColorToken(node: GitHistoryNode): string {
  return node.colorIndex === 0 ? '--mn-accent' : `--git-lane-${node.colorIndex}`;
}

/** Virtualized native buttons over SVG edges; canvas provides the distant overview. */
export function renderGitHistoryScene(
  host: HTMLElement, overview: HTMLCanvasElement, model: GitHistoryModel,
  layout: GitHistoryLayout, options: GitHistorySceneOptions,
): GitHistorySceneApi {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('git-history-map__edges');
  svg.setAttribute('width', String(layout.width));
  svg.setAttribute('height', String(layout.height));
  svg.setAttribute('aria-hidden', 'true');
  const cards = el('div', 'git-history-map__nodes');
  host.replaceChildren(svg, cards);
  const routes = routeGitHistoryEdges(model, layout);
  const nodes = new Map(model.nodes.map((n) => [n.commit.hash, n]));
  const elements = new Map<string, HTMLButtonElement>();
  let selected: string | null = null;
  let focused: string | null = null;
  let lastState: ViewState = { x: 0, y: 0, k: 1 };
  let lastWidth = 800;
  let lastHeight = 600;

  function makeCard(node: GitHistoryNode): HTMLButtonElement {
    const card = el('button', 'git-history-map__node');
    card.type = 'button';
    card.dataset.sha = node.commit.hash;
    card.dataset.lane = String(node.lane);
    card.style.setProperty('--branch-color', `var(${gitHistoryColorToken(node)})`);
    const box = layout.boxes.get(node.commit.hash)!;
    Object.assign(card.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
    const subject = expandGitmojiShortcodes(node.commit.subject);
    card.title = `${subject}\n${node.commit.author} · ${node.commit.relativeTime}\n${node.commit.hash}`;
    card.setAttribute('aria-label', `${subject}, ${node.commit.author}, ${node.commit.relativeTime}, ${node.commit.hash.slice(0, 7)}${node.refs.length ? ', ' + node.refs.map((r) => `${r.kind} ${r.name}`).join(', ') : ''}`);
    card.append(el('span', 'git-history-map__subject', subject));
    card.append(el('span', 'git-history-map__meta', `${node.commit.hash.slice(0, 7)} · ${node.commit.author} · ${node.commit.relativeTime}`));
    const refs = el('span', 'git-history-map__refs');
    for (const ref of node.refs) {
      const chip = el('span', 'git-history-map__ref', ref.kind === 'tag' ? `Tag: ${ref.name}` : ref.name);
      chip.dataset.kind = ref.kind;
      chip.title = `${ref.kind}: ${ref.name}`;
      refs.append(chip);
    }
    card.append(refs);
    card.addEventListener('click', () => { if (!options.consumeDrag()) options.onSelect(node); });
    card.addEventListener('focus', () => options.onFocus(node));
    card.addEventListener('keydown', (e) => options.onKey(node, e));
    card.addEventListener('contextmenu', (e) => { e.preventDefault(); options.onContextMenu?.(node, e); });
    return card;
  }

  function paintState(): void {
    for (const [hash, card] of elements) {
      card.tabIndex = hash === focused ? 0 : -1;
      card.setAttribute('aria-pressed', String(hash === selected));
      card.classList.toggle('is-selected', hash === selected);
      card.classList.toggle('is-context', !model.matches.has(hash));
    }
  }

  function drawOverview(state: ViewState, width: number, height: number): void {
    const dpr = window.devicePixelRatio || 1;
    overview.width = Math.round(width * dpr);
    overview.height = Math.round(height * dpr);
    const ctx = overview.getContext('2d');
    if (!ctx) return;
    const css = window.getComputedStyle(overview);
    const forced = window.matchMedia('(forced-colors: active)').matches;
    const ink = forced ? 'CanvasText' : css.getPropertyValue('--mn-fg-muted').trim() || 'CanvasText';
    const accent = forced ? 'Highlight' : css.getPropertyValue('--mn-accent').trim() || 'Highlight';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.lineWidth = 1;
    const color = (node: GitHistoryNode | undefined) => forced ? ink
      : node ? css.getPropertyValue(gitHistoryColorToken(node)).trim() || accent : accent;
    for (const route of routes) {
      const child = layout.boxes.get(route.edge.child)!;
      const parent = route.edge.boundary ? undefined : layout.boxes.get(route.edge.parent);
      const x1 = child.x * state.k + state.x;
      const y1 = (child.y + child.h / 2) * state.k + state.y;
      const x2 = (parent ? parent.x + parent.w : child.x - 64) * state.k + state.x;
      const y2 = (parent ? parent.y + parent.h / 2 : child.y + child.h / 2) * state.k + state.y;
      ctx.strokeStyle = color(nodes.get(route.edge.firstParent ? route.edge.child : route.edge.parent));
      ctx.setLineDash(route.edge.boundary || route.edge.hiddenCount ? [5, 4] : []);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.bezierCurveTo(x1 - 24 * state.k, y1, x2 + 24 * state.k, y2, x2, y2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const node of model.nodes) {
      const box = layout.boxes.get(node.commit.hash)!;
      ctx.fillStyle = color(node);
      ctx.fillRect(box.x * state.k + state.x, box.y * state.k + state.y,
        Math.max(3, box.w * state.k), Math.max(2, box.h * state.k));
      if (node.commit.hash === selected) {
        ctx.strokeStyle = accent;
        ctx.lineWidth = 2;
        ctx.strokeRect(box.x * state.k + state.x - 2, box.y * state.k + state.y - 2,
          Math.max(3, box.w * state.k) + 4, Math.max(2, box.h * state.k) + 4);
        ctx.lineWidth = 1;
      }
    }
  }

  const onOverviewClick = (e: MouseEvent) => {
    if (options.consumeDrag()) return;
    const rect = overview.getBoundingClientRect();
    const x = (e.clientX - rect.left - lastState.x) / lastState.k;
    const y = (e.clientY - rect.top - lastState.y) / lastState.k;
    let best: GitHistoryNode | undefined;
    let distance = Infinity;
    for (const node of model.nodes) {
      const box = layout.boxes.get(node.commit.hash)!;
      const dx = Math.max(box.x - x, 0, x - box.x - box.w) * lastState.k;
      const dy = Math.max(box.y - y, 0, y - box.y - box.h) * lastState.k;
      const d = Math.hypot(dx, dy);
      if (d < distance) { distance = d; best = node; }
    }
    if (best && distance <= 12) { options.onFocus(best); options.onSelect(best); }
  };
  overview.addEventListener('click', onOverviewClick);

  const api: GitHistorySceneApi = {
    setSelection(hash) {
      selected = hash;
      paintState();
      if (!overview.hidden) drawOverview(lastState, lastWidth, lastHeight);
    },
    setFocus(hash) { focused = hash; paintState(); },
    nodeElement: (hash) => elements.get(hash) ?? null,
    renderVisible(state, width, height) {
      lastState = state;
      lastWidth = width;
      lastHeight = height;
      const distant = state.k < 0.28;
      overview.hidden = !distant;
      svg.style.display = distant ? 'none' : '';
      if (distant) drawOverview(state, width, height);
      const area = { x: (-state.x - 200) / state.k, y: (-state.y - 200) / state.k,
        w: (width + 400) / state.k, h: (height + 400) / state.k };
      const visible = new Set<string>();
      if (!distant) {
        for (const node of model.nodes) {
          if (visible.size < 180 && intersects(layout.boxes.get(node.commit.hash)!, area)) visible.add(node.commit.hash);
        }
      }
      if (focused && nodes.has(focused)) visible.add(focused);
      for (const [hash, card] of elements) {
        if (!visible.has(hash)) { card.remove(); elements.delete(hash); }
      }
      for (const hash of visible) {
        if (!elements.has(hash)) {
          const card = makeCard(nodes.get(hash)!);
          elements.set(hash, card);
          cards.append(card);
        }
      }
      svg.replaceChildren();
      if (!distant) {
        let count = 0;
        for (const route of routes) {
          if (count >= 400 || !intersects(route.bounds, area)) continue;
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', route.path);
          const branch = nodes.get(route.edge.firstParent ? route.edge.child : route.edge.parent);
          if (branch) path.style.setProperty('--branch-color', `var(${gitHistoryColorToken(branch)})`);
          path.classList.toggle('is-boundary', route.edge.boundary);
          path.classList.toggle('is-secondary', !route.edge.firstParent);
          path.classList.toggle('is-collapsed', Boolean(route.edge.hiddenCount));
          const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
          title.textContent = route.edge.boundary ? 'Parent outside this view. Load older history or clear filters.'
            : route.edge.hiddenCount ? `${route.edge.hiddenCount} collapsed commits` : 'Parent commit';
          path.append(title);
          svg.append(path);
          count++;
        }
      }
      paintState();
    },
    destroy() { overview.removeEventListener('click', onOverviewClick); host.replaceChildren(); elements.clear(); },
  };
  return api;
}
