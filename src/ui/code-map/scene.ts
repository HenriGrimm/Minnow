/**
 * Draws a laid-out code map: layer frames, link curves (SVG) and node cards (buttons),
 * plus the focus state — the selected or hovered card lights its links and neighbours
 * and dims the rest, revealing quiet links that only show on focus.
 */

import { folderIcon, kindBadge, languageTag, packageIcon, renderIcon, type CodeMapIcon } from './icons';
import type { SceneLayout } from './layout';
import type { MapLink, MapNode } from './model';
import type { GitCommitReview } from '../git-commit-review';
import { commitFilesForNode, commitNodeLabel } from './commit-review';

export interface SceneOptions {
  repo: string;
  nodes: Map<string, MapNode>;
  links: MapLink[];
  layout: SceneLayout;
  commitReview?: GitCommitReview | null;
  onSelect(id: string): void;
  onOpen(id: string): void;
  onContextMenu?(id: string, ev: MouseEvent): void;
  /** Ignore the click that ends a pan. */
  wasDrag(): boolean;
}

export interface SceneApi {
  setSelection(id: string | null): void;
  cardElement(id: string): HTMLElement | null;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Layer colour tokens, cycled by layer index. */
export const LAYER_TONES = [
  'var(--mn-label-apricot)',
  'var(--mn-label-moss)',
  'var(--mn-label-tide)',
  'var(--mn-label-fig)',
  'var(--mn-label-kelp)',
  'var(--mn-label-dusk)',
  'var(--mn-label-pollen)',
  'var(--mn-label-clay)',
] as const;

export function toneVar(tone: number): string {
  return tone < 0 ? 'var(--mn-fg-muted)' : LAYER_TONES[tone % LAYER_TONES.length]!;
}

/** Icon for a node card. */
export function nodeIcon(repo: string, node: MapNode): CodeMapIcon {
  switch (node.kind) {
    case 'module': {
      const mod = node.module;
      const name = mod?.loose ? mod.path.split('/').pop() || node.label : node.label;
      return folderIcon(repo, node.path ?? '', name);
    }
    case 'folder':
      return folderIcon(repo, node.path ?? '', node.label.replace(/\/$/, ''));
    case 'package':
      return packageIcon(node.packageName ?? node.label);
    case 'more':
      return { kind: 'glyph', cls: 'fi-rr-apps' };
    case 'file':
      return { kind: 'mono', text: languageTag(node.label) || 'F' };
    default:
      return { kind: 'mono', text: node.symbolKind ? kindBadge(node.symbolKind) : 'fn' };
  }
}

function linkWidth(n: number): number {
  return Math.round(Math.min(4.5, 1.25 + Math.log2(Math.max(1, n)) * 0.45) * 10) / 10;
}

function markerDefs(svg: SVGSVGElement): void {
  const defs = document.createElementNS(SVG_NS, 'defs');
  for (const [id, cls] of [
    ['cmArrow', 'code-map-arrow'],
    ['cmArrowActive', 'code-map-arrow code-map-arrow--active'],
    ['cmArrowBack', 'code-map-arrow code-map-arrow--back'],
  ] as const) {
    const marker = document.createElementNS(SVG_NS, 'marker');
    marker.setAttribute('id', id);
    marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '9');
    marker.setAttribute('refY', '5');
    marker.setAttribute('markerWidth', '7');
    marker.setAttribute('markerHeight', '7');
    marker.setAttribute('markerUnits', 'userSpaceOnUse');
    marker.setAttribute('orient', 'auto-start-reverse');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M0 1L10 5L0 9z');
    path.setAttribute('class', cls);
    marker.append(path);
    defs.append(marker);
  }
  svg.append(defs);
}

function buildCard(repo: string, node: MapNode, review?: GitCommitReview | null): HTMLButtonElement {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = `code-map-card code-map-card--${node.kind}`;
  if (node.test) card.classList.add('is-test');
  card.dataset.id = node.id;

  const tile = document.createElement('span');
  tile.className = 'code-map-card__icon';
  tile.append(renderIcon(nodeIcon(repo, node)));

  const text = document.createElement('span');
  text.className = 'code-map-card__text';
  const title = document.createElement('span');
  title.className = 'code-map-card__title';
  title.textContent = node.label;
  title.title = node.label;
  const detail = document.createElement('span');
  detail.className = 'code-map-card__detail';
  detail.textContent = node.detail;
  detail.title = node.kind === 'symbol' || node.kind === 'center' ? node.meta : node.detail;
  text.append(title, detail);
  if (node.kind !== 'symbol' && node.meta) {
    const meta = document.createElement('span');
    meta.className = 'code-map-card__meta';
    meta.textContent = node.kind === 'center' ? node.meta : node.meta;
    text.append(meta);
  }
  card.append(tile, text);

  const changeLabel = review ? commitNodeLabel(node, review) : null;
  if (changeLabel && review) {
    const files = commitFilesForNode(node, review);
    card.classList.add('has-commit-change');
    const status = files.length === 1 ? files[0].status : 'Modified';
    card.dataset.commitStatus = status;
    const change = document.createElement('span');
    change.className = 'code-map-card__change';
    change.textContent = changeLabel;
    card.append(change);
    if (node.kind === 'file' && files[0].oldPath) {
      detail.textContent = `was ${files[0].oldPath}`;
      detail.title = detail.textContent;
    }
  }

  if (node.usedBy) {
    const badge = document.createElement('span');
    badge.className = 'code-map-card__badge';
    badge.textContent = `used by ${node.usedBy}`;
    badge.title = `Shared by ${node.usedBy} others — select it to see those links`;
    card.append(badge);
  }

  const label =
    node.kind === 'more'
      ? `${node.label} modules: ${node.detail}. Show them`
      : `${node.label}, ${node.detail}${node.meta && node.kind !== 'symbol' ? `, ${node.meta}` : ''}${node.usedBy ? `, used by ${node.usedBy}` : ''}`;
  card.setAttribute('aria-label', changeLabel ? `${label}, ${changeLabel}` : label);
  return card;
}

/** Render the scene into its edge and node layers. */
export function renderScene(edgesSvg: SVGSVGElement, nodesEl: HTMLElement, opts: SceneOptions): SceneApi {
  const { layout, nodes, links } = opts;
  edgesSvg.replaceChildren();
  nodesEl.replaceChildren();
  edgesSvg.setAttribute('width', String(layout.width));
  edgesSvg.setAttribute('height', String(layout.height));
  edgesSvg.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
  markerDefs(edgesSvg);

  for (const frame of layout.frames) {
    const el = document.createElement('div');
    el.className = `code-map-frame${frame.external ? ' code-map-frame--external' : ''}`;
    el.style.left = `${frame.x}px`;
    el.style.top = `${frame.y}px`;
    el.style.width = `${frame.w}px`;
    el.style.height = `${frame.h}px`;
    el.style.setProperty('--tone', toneVar(frame.tone));
    const label = document.createElement('span');
    label.className = 'code-map-frame__label';
    label.textContent = frame.label;
    el.append(label);
    if (frame.path) {
      const path = document.createElement('span');
      path.className = 'code-map-frame__path';
      path.textContent = `${frame.path}/`;
      el.append(path);
    }
    nodesEl.append(el);
  }

  for (const text of layout.labels) {
    const el = document.createElement('div');
    el.className = 'code-map-col-label';
    el.style.left = `${text.x}px`;
    el.style.top = `${text.y}px`;
    el.textContent = text.text;
    nodesEl.append(el);
  }

  const pathEls = new Map<string, SVGPathElement>();
  const linksByNode = new Map<string, MapLink[]>();
  const group = document.createElementNS(SVG_NS, 'g');
  // Quiet links first so loud ones paint on top.
  for (const link of [...links].sort((a, b) => Number(b.quiet) - Number(a.quiet) || a.n - b.n)) {
    const d = layout.paths.get(link.id);
    if (!d) continue;
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', 'code-map-link');
    path.classList.toggle('is-back', link.back);
    path.classList.toggle('is-quiet', link.quiet);
    path.classList.toggle('is-external', link.external);
    path.style.strokeWidth = String(linkWidth(link.n));
    path.setAttribute('marker-end', link.back ? 'url(#cmArrowBack)' : 'url(#cmArrow)');
    const title = document.createElementNS(SVG_NS, 'title');
    const src = nodes.get(link.src)?.label ?? link.src;
    const dst = nodes.get(link.dst)?.label ?? link.dst;
    title.textContent = link.external
      ? `${src} imports ${dst} in ${link.n} file${link.n === 1 ? '' : 's'}`
      : `${src} → ${dst}: ${link.n} call${link.n === 1 ? '' : 's'}`;
    path.append(title);
    group.append(path);
    pathEls.set(link.id, path);
    for (const end of [link.src, link.dst]) {
      let list = linksByNode.get(end);
      if (!list) linksByNode.set(end, (list = []));
      list.push(link);
    }
  }
  edgesSvg.append(group);

  const cards = new Map<string, HTMLButtonElement>();
  for (const [id, box] of layout.boxes) {
    const node = nodes.get(id);
    if (!node) continue;
    const card = buildCard(opts.repo, node, opts.commitReview);
    card.style.left = `${box.x}px`;
    card.style.top = `${box.y}px`;
    card.style.width = `${box.w}px`;
    card.style.height = `${box.h}px`;
    if (node.kind === 'module' || node.kind === 'more') {
      const frame = layout.frames.find((f) => box.y >= f.y && box.y < f.y + f.h);
      if (frame) card.style.setProperty('--tone', toneVar(frame.tone));
    }
    cards.set(id, card);
    nodesEl.append(card);
  }

  let selected: string | null = null;
  let hovered: string | null = null;

  const applyFocus = () => {
    const focus = hovered ?? selected;
    const scene = nodesEl.parentElement;
    scene?.classList.toggle('has-focus', Boolean(focus));
    for (const card of cards.values()) {
      card.classList.remove('is-related', 'is-selected');
      card.removeAttribute('aria-pressed');
    }
    for (const path of pathEls.values()) {
      if (path.classList.contains('is-active')) {
        path.classList.remove('is-active');
        path.setAttribute('marker-end', path.classList.contains('is-back') ? 'url(#cmArrowBack)' : 'url(#cmArrow)');
      }
    }
    if (selected) {
      const card = cards.get(selected);
      card?.classList.add('is-selected');
      card?.setAttribute('aria-pressed', 'true');
    }
    if (!focus) return;
    cards.get(focus)?.classList.add('is-related');
    for (const link of linksByNode.get(focus) ?? []) {
      const path = pathEls.get(link.id);
      if (path) {
        path.classList.add('is-active');
        path.setAttribute('marker-end', 'url(#cmArrowActive)');
        // Repaint on top of the other links.
        path.parentNode?.append(path);
      }
      cards.get(link.src === focus ? link.dst : link.src)?.classList.add('is-related');
    }
  };

  nodesEl.onclick = (ev) => {
    const card = (ev.target as Element | null)?.closest<HTMLElement>('.code-map-card');
    if (!card?.dataset.id || opts.wasDrag()) return;
    if (ev.detail === 0 && selected === card.dataset.id) {
      // Keyboard activation of the already-selected card opens it.
      opts.onOpen(card.dataset.id);
      return;
    }
    opts.onSelect(card.dataset.id);
  };
  nodesEl.ondblclick = (ev) => {
    const card = (ev.target as Element | null)?.closest<HTMLElement>('.code-map-card');
    if (card?.dataset.id) opts.onOpen(card.dataset.id);
  };
  nodesEl.oncontextmenu = (ev) => {
    const card = (ev.target as Element | null)?.closest<HTMLElement>('.code-map-card');
    if (!card?.dataset.id || !opts.onContextMenu) return;
    ev.preventDefault();
    opts.onContextMenu(card.dataset.id, ev);
  };
  nodesEl.onpointerover = (ev) => {
    if (ev.pointerType === 'touch') return;
    const card = (ev.target as Element | null)?.closest<HTMLElement>('.code-map-card');
    const id = card?.dataset.id ?? null;
    if (id === hovered) return;
    hovered = id;
    applyFocus();
  };
  nodesEl.onpointerleave = () => {
    if (hovered === null) return;
    hovered = null;
    applyFocus();
  };

  return {
    setSelection(id) {
      selected = id && cards.has(id) ? id : null;
      applyFocus();
    },
    cardElement: (id) => cards.get(id) ?? null,
  };
}
