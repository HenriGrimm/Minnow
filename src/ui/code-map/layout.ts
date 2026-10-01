/**
 * Code map layouts: card positions, layer frames and link paths for the three views.
 *
 * Architecture stacks layers top to bottom (callers above callees); files and calls flow
 * left to right. Links leave and enter cards through spread-out ports on the facing sides
 * and are drawn as smooth curves; links that run against the flow loop round the outside.
 */

import type { ArchModel, CallModel, FolderModel, MapLink, MapNode } from './model';

export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Frame {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  path: string;
  /** Layer colour index; -1 for neutral frames. */
  tone: number;
  external: boolean;
}

export interface SceneLabel {
  x: number;
  y: number;
  text: string;
}

export interface SceneLayout {
  boxes: Map<string, Box>;
  frames: Frame[];
  labels: SceneLabel[];
  /** SVG path data per link id. */
  paths: Map<string, string>;
  width: number;
  height: number;
}

type Side = 'top' | 'bottom' | 'left' | 'right';

const MARGIN = 64;

export const ARCH_LAYOUT = {
  cardW: 216,
  cardH: 76,
  gapX: 24,
  gapY: 20,
  padX: 28,
  padTop: 48,
  padBottom: 28,
  layerGap: 112,
  maxCols: 6,
} as const;

export const FILES_LAYOUT = { cardW: 212, cardH: 60, colGap: 128, rowGap: 18 } as const;

export const CALLS_LAYOUT = { cardW: 232, cardH: 56, centerW: 260, centerH: 96, colGap: 120, rowGap: 14 } as const;

function center(box: Box): { x: number; y: number } {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

/**
 * Spread every link end on a card side evenly along that side, ordered by where the
 * other end sits, so parallel links do not pile onto one point.
 */
function assignPorts(
  ends: Array<{ key: string; box: Box; side: Side; other: Box }>,
): Map<string, { x: number; y: number }> {
  const bySide = new Map<string, typeof ends>();
  for (const end of ends) {
    const k = `${end.box.id}\u0000${end.side}`;
    let list = bySide.get(k);
    if (!list) bySide.set(k, (list = []));
    list.push(end);
  }
  const out = new Map<string, { x: number; y: number }>();
  for (const list of bySide.values()) {
    const { box, side } = list[0]!;
    const horizontal = side === 'top' || side === 'bottom';
    list.sort((a, b) => (horizontal ? center(a.other).x - center(b.other).x : center(a.other).y - center(b.other).y));
    const span = horizontal ? box.w : box.h;
    const lo = span * (horizontal ? 0.2 : 0.25);
    const hi = span - lo;
    list.forEach((end, i) => {
      const t = list.length === 1 ? span / 2 : lo + ((hi - lo) * i) / (list.length - 1);
      const p =
        side === 'top'
          ? { x: box.x + t, y: box.y }
          : side === 'bottom'
            ? { x: box.x + t, y: box.y + box.h }
            : side === 'left'
              ? { x: box.x, y: box.y + t }
              : { x: box.x + box.w, y: box.y + t };
      out.set(end.key, p);
    });
  }
  return out;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Cubic curve between two ports, leaving and entering perpendicular to their sides. */
function curve(a: { x: number; y: number }, sa: Side, b: { x: number; y: number }, sb: Side): string {
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const k = Math.max(36, Math.min(160, dist * 0.45));
  const push = (p: { x: number; y: number }, side: Side) =>
    side === 'top'
      ? { x: p.x, y: p.y - k }
      : side === 'bottom'
        ? { x: p.x, y: p.y + k }
        : side === 'left'
          ? { x: p.x - k, y: p.y }
          : { x: p.x + k, y: p.y };
  const c1 = push(a, sa);
  const c2 = push(b, sb);
  return `M${round(a.x)} ${round(a.y)}C${round(c1.x)} ${round(c1.y)} ${round(c2.x)} ${round(c2.y)} ${round(b.x)} ${round(b.y)}`;
}

/** Route links between placed cards. `flow` is the direction most links run. */
function routeLinks(
  links: MapLink[],
  boxes: Map<string, Box>,
  rank: (id: string) => number,
  flow: 'down' | 'right',
): Map<string, string> {
  const sides = new Map<string, { sa: Side; sb: Side }>();
  const ends: Array<{ key: string; box: Box; side: Side; other: Box }> = [];
  for (const link of links) {
    const a = boxes.get(link.src);
    const b = boxes.get(link.dst);
    if (!a || !b) continue;
    const ra = rank(link.src);
    const rb = rank(link.dst);
    let sa: Side;
    let sb: Side;
    if (flow === 'down') {
      if (ra < rb) [sa, sb] = ['bottom', 'top'];
      else if (ra > rb) [sa, sb] = ['top', 'bottom'];
      else if (Math.abs(a.y - b.y) < 1) [sa, sb] = a.x < b.x ? ['right', 'left'] : ['left', 'right'];
      else [sa, sb] = a.y < b.y ? ['bottom', 'top'] : ['top', 'bottom'];
    } else if (ra < rb) {
      [sa, sb] = ['right', 'left'];
    } else {
      // Against the flow, or within a column: loop under both cards.
      [sa, sb] = ['bottom', 'bottom'];
    }
    sides.set(link.id, { sa, sb });
    ends.push({ key: `${link.id}\u0000a`, box: a, side: sa, other: b });
    ends.push({ key: `${link.id}\u0000b`, box: b, side: sb, other: a });
  }
  const ports = assignPorts(ends);
  const paths = new Map<string, string>();
  for (const [id, { sa, sb }] of sides) {
    const pa = ports.get(`${id}\u0000a`);
    const pb = ports.get(`${id}\u0000b`);
    if (pa && pb) paths.set(id, curve(pa, sa, pb, sb));
  }
  return paths;
}

/** Layers as stacked frames of card rows; links curve between layers. */
export function layoutArchitecture(model: ArchModel): SceneLayout {
  const L = ARCH_LAYOUT;
  const widest = Math.max(1, ...model.layers.map((l) => l.nodeIds.length));
  const cols = Math.min(L.maxCols, widest);
  const innerW = cols * L.cardW + (cols - 1) * L.gapX;
  const frameW = innerW + L.padX * 2;
  const boxes = new Map<string, Box>();
  const frames: Frame[] = [];
  let y = MARGIN;
  for (const layer of model.layers) {
    const n = layer.nodeIds.length;
    const rows = Math.max(1, Math.ceil(n / cols));
    const h = L.padTop + rows * L.cardH + (rows - 1) * L.gapY + L.padBottom;
    frames.push({
      id: layer.id,
      x: MARGIN,
      y,
      w: frameW,
      h,
      label: layer.label,
      path: layer.path,
      tone: layer.tone,
      external: layer.external,
    });
    layer.nodeIds.forEach((id, idx) => {
      const row = Math.floor(idx / cols);
      const col = idx % cols;
      const inRow = row === rows - 1 ? n - row * cols : cols;
      const rowW = inRow * L.cardW + (inRow - 1) * L.gapX;
      const x = MARGIN + L.padX + (innerW - rowW) / 2 + col * (L.cardW + L.gapX);
      boxes.set(id, { id, x, y: y + L.padTop + row * (L.cardH + L.gapY), w: L.cardW, h: L.cardH });
    });
    y += h + L.layerGap;
  }
  const rank = (id: string) => model.nodes.get(id)?.layer ?? 0;
  return {
    boxes,
    frames,
    labels: [],
    paths: routeLinks(model.links, boxes, rank, 'down'),
    width: frameW + MARGIN * 2,
    height: y - L.layerGap + MARGIN,
  };
}

/**
 * Rank nodes left to right by call depth: callers before callees. Cycles are broken by a
 * depth-first pass (heaviest nodes first); links that close a cycle do not affect ranks.
 */
export function rankByCalls(nodeIds: string[], links: MapLink[], weight: (id: string) => number): Map<string, number> {
  const out = new Map<string, string[]>();
  for (const l of links) {
    let list = out.get(l.src);
    if (!list) out.set(l.src, (list = []));
    list.push(l.dst);
  }
  const state = new Map<string, 1 | 2>();
  const kept = new Set<string>();
  const order = [...nodeIds].sort((a, b) => weight(b) - weight(a));
  const visit = (id: string) => {
    state.set(id, 1);
    for (const next of out.get(id) ?? []) {
      const s = state.get(next);
      if (s === 1) continue;
      kept.add(`${id}\u0000${next}`);
      if (!s) visit(next);
    }
    state.set(id, 2);
  };
  for (const id of order) if (!state.get(id)) visit(id);

  const rank = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  // Longest-path relaxation over the acyclic subgraph.
  for (let pass = 0; pass < nodeIds.length; pass += 1) {
    let changed = false;
    for (const key of kept) {
      const [a, b] = key.split('\u0000') as [string, string];
      const next = (rank.get(a) ?? 0) + 1;
      if (next > (rank.get(b) ?? 0)) {
        rank.set(b, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return rank;
}

/** Order each column by the average position of linked nodes in the previous column. */
function orderColumns(columns: string[][], links: MapLink[]): void {
  const nbrs = new Map<string, string[]>();
  for (const l of links) {
    for (const [a, b] of [
      [l.src, l.dst],
      [l.dst, l.src],
    ] as const) {
      let list = nbrs.get(a);
      if (!list) nbrs.set(a, (list = []));
      list.push(b);
    }
  }
  const pos = new Map<string, number>();
  const index = (col: string[]) => col.forEach((id, i) => pos.set(id, col.length > 1 ? i / (col.length - 1) : 0.5));
  columns.forEach(index);
  const sweep = (cols: string[][]) => {
    for (let c = 1; c < cols.length; c += 1) {
      const prev = new Set(cols[c - 1]);
      const col = cols[c]!;
      const key = new Map(
        col.map((id, i) => {
          const ps = (nbrs.get(id) ?? []).filter((n) => prev.has(n)).map((n) => pos.get(n)!);
          return [id, ps.length ? ps.reduce((s, v) => s + v, 0) / ps.length : i / Math.max(1, col.length)];
        }),
      );
      col.sort((a, b) => key.get(a)! - key.get(b)!);
      index(col);
    }
  };
  sweep(columns);
  sweep([...columns].reverse());
  sweep(columns);
}

/** Place columns of cards, each centred on the tallest, from left to right. */
function placeColumns(
  columns: string[][],
  size: (id: string) => { w: number; h: number },
  colGap: number,
  rowGap: number,
  top: number,
): { boxes: Map<string, Box>; width: number; bottom: number; colX: number[] } {
  const heights = columns.map((col) => col.reduce((s, id) => s + size(id).h, 0) + Math.max(0, col.length - 1) * rowGap);
  const tallest = Math.max(0, ...heights);
  const boxes = new Map<string, Box>();
  const colX: number[] = [];
  let x = MARGIN;
  columns.forEach((col, c) => {
    const colW = Math.max(0, ...col.map((id) => size(id).w));
    colX.push(x);
    let y = top + (tallest - heights[c]!) / 2;
    for (const id of col) {
      const { w, h } = size(id);
      boxes.set(id, { id, x: x + (colW - w) / 2, y, w, h });
      y += h + rowGap;
    }
    x += colW + colGap;
  });
  return { boxes, width: x - colGap + MARGIN, bottom: top + tallest, colX };
}

/**
 * Files view: linked files in call-depth columns; files with no links inside the folder
 * collect in a grid underneath. Sets `layer`, `back` and `cross` on the model's nodes and links.
 */
export function layoutFolder(model: FolderModel): SceneLayout {
  const F = FILES_LAYOUT;
  const linked = new Set<string>();
  for (const l of model.links) {
    linked.add(l.src);
    linked.add(l.dst);
  }
  const ids = [...model.nodes.keys()];
  const graphIds = ids.filter((id) => linked.has(id));
  const loose = ids.filter((id) => !linked.has(id)).sort((a, b) => model.nodes.get(a)!.label.localeCompare(model.nodes.get(b)!.label));
  const rank = rankByCalls(graphIds, model.links, (id) => model.nodes.get(id)?.weight ?? 0);
  const columns: string[][] = [];
  for (const id of graphIds) {
    const r = rank.get(id) ?? 0;
    (columns[r] ??= []).push(id);
    model.nodes.get(id)!.layer = r;
  }
  for (let i = 0; i < columns.length; i += 1) columns[i] ??= [];
  for (const link of model.links) {
    const a = rank.get(link.src) ?? 0;
    const b = rank.get(link.dst) ?? 0;
    link.back = a >= b;
    link.cross = a !== b;
  }
  orderColumns(columns, model.links);

  const size = () => ({ w: F.cardW, h: F.cardH });
  const placed = placeColumns(columns, size, F.colGap, F.rowGap, MARGIN + 24);
  const boxes = placed.boxes;
  const frames: Frame[] = [];
  const labels: SceneLabel[] = [];
  let width = graphIds.length ? placed.width : MARGIN * 2 + F.cardW;
  let height = graphIds.length ? placed.bottom + MARGIN : MARGIN;

  if (loose.length) {
    const cols = Math.max(3, Math.min(6, columns.length || 4));
    const top = graphIds.length ? placed.bottom + 112 : MARGIN;
    const gap = 20;
    const innerW = cols * F.cardW + (cols - 1) * gap;
    const rows = Math.ceil(loose.length / cols);
    frames.push({
      id: '@unlinked',
      x: MARGIN,
      y: top,
      w: innerW + 56,
      h: 48 + rows * F.cardH + (rows - 1) * F.rowGap + 28,
      label: graphIds.length ? 'No calls inside this folder' : 'Files',
      path: '',
      tone: -1,
      external: false,
    });
    loose.forEach((id, i) => {
      const r = Math.floor(i / cols);
      const c = i % cols;
      boxes.set(id, { id, x: MARGIN + 28 + c * (F.cardW + gap), y: top + 48 + r * (F.cardH + F.rowGap), w: F.cardW, h: F.cardH });
      model.nodes.get(id)!.layer = -1;
    });
    width = Math.max(width, innerW + 56 + MARGIN * 2);
    height = top + 48 + rows * F.cardH + (rows - 1) * F.rowGap + 28 + MARGIN;
  }

  if (graphIds.length && columns.length > 1) {
    labels.push({ x: placed.colX[0]!, y: MARGIN, text: 'Callers' });
    labels.push({ x: placed.colX[placed.colX.length - 1]!, y: MARGIN, text: 'Called' });
  }

  return {
    boxes,
    frames,
    labels,
    paths: routeLinks(model.links, boxes, (id) => rank.get(id) ?? 0, 'right'),
    width,
    height,
  };
}

/** Calls view: caller columns left of the symbol, callee columns right of it. */
export function layoutCalls(model: CallModel): SceneLayout {
  const C = CALLS_LAYOUT;
  const keys = [...model.columns.keys()].sort((a, b) => a - b);
  const columns = keys.map((k) => [...(model.columns.get(k) ?? [])]);
  const size = (id: string) => {
    const node = model.nodes.get(id) as MapNode;
    return node.kind === 'center' ? { w: C.centerW, h: C.centerH } : { w: C.cardW, h: C.cardH };
  };
  const placed = placeColumns(columns, size, C.colGap, C.rowGap, MARGIN + 32);
  const labels: SceneLabel[] = [];
  keys.forEach((k, i) => {
    const count = model.columns.get(k)?.length ?? 0;
    const text =
      k === -2 ? 'Callers of callers' : k === -1 ? `Called by · ${count}` : k === 1 ? `Calls · ${count}` : k === 2 ? 'Calls from there' : '';
    if (text) labels.push({ x: placed.colX[i]!, y: MARGIN, text });
  });
  const rank = (id: string) => model.nodes.get(id)?.layer ?? 0;
  return {
    boxes: placed.boxes,
    frames: [],
    labels,
    paths: routeLinks(model.links, placed.boxes, rank, 'right'),
    width: placed.width,
    height: placed.bottom + MARGIN,
  };
}

/** Bounding box of everything placed. */
export function sceneBounds(layout: SceneLayout): { x: number; y: number; w: number; h: number } {
  return { x: 0, y: 0, w: layout.width, h: layout.height };
}
