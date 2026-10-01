import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import { drag } from 'd3-drag';
import { select } from 'd3-selection';
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from 'd3-zoom';
import { scheduleAnimationFrame } from '../../../lib/schedule-animation-frame';
import type {
  ForceGraphCallbacks,
  ForceGraphOptions,
  ForceGraphTheme,
  GraphEdge,
  GraphEmphasisKey,
  GraphNode,
  GraphNodeKind,
} from './types';

/** Canvas edges hidden behind floating overlay panels, in CSS pixels. */
export interface ViewportInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Aggregate readout for the graph HUD. */
export interface ForceGraphStats {
  nodeCount: number;
  edgeCount: number;
  kinds: Record<GraphNodeKind, number>;
  orphanCount: number;
  /** Mean edges per node — how densely woven the wiki is. */
  density: number;
  /** Highest-degree nodes, most connected first. */
  hubs: Array<{ id: string; label: string; path?: string; degree: number }>;
}

export interface ForceGraphApi {
  setData(nodes: GraphNode[], edges: GraphEdge[]): void;
  selectNode(id: string | null): void;
  setHoverNode(id: string | null): void;
  fitToView(): void;
  /** Fit the viewport to a subset of nodes (or all nodes when `ids` is omitted). */
  fitToNodes(ids?: Set<string>): void;
  /** Pan to a specific node while preserving the current zoom level. */
  centerOnNode(id: string): void;
  /** Zoom to a node's neighborhood and make that highlight sticky (design brief "focus subtree"). */
  focusNode(id: string): void;
  /** Remove the sticky focus highlight; reverts to normal selection highlight. */
  clearFocus(): void;
  /** Fade out whole node classes (legend filtering). */
  setMutedKinds(keys: Set<GraphEmphasisKey>): void;
  /** Reserve edge space covered by floating panels so fits land in clear canvas. */
  setViewportInsets(insets: Partial<ViewportInsets>): void;
  /** Degree-derived summary for the HUD readout. */
  getStats(): ForceGraphStats;
  zoomBy(factor: number): void;
  resize(): void;
  destroy(): void;
  getTransform(): ZoomTransform;
}

type SimNode = GraphNode &
  SimulationNodeDatum & {
    /** Number of incident edges — drives radius, charge, and label priority. */
    degree: number;
    /** World-space draw radius. */
    radius: number;
    /** Eased 0–1 emphasis; 1 = fully lit, low = pushed into the background. */
    emphasis: number;
    /** Eased 0–1 entrance progress. */
    appear: number;
  };
type SimEdge = SimulationLinkDatum<SimNode> & { kind: GraphEdge['kind']; id: string; seed: number };

/** Base world-space radius before degree weighting. */
const KIND_BASE_RADIUS: Record<GraphNodeKind, number> = { page: 5.5, tag: 4 };

/** Emphasis floor for nodes outside the active neighborhood. */
const DIM_EMPHASIS_HOVER = 0.18;
const DIM_EMPHASIS_SELECTED = 0.42;
/** Emphasis floor for node classes muted from the legend. */
const MUTED_EMPHASIS = 0.08;
/** A node needs this many edges before it earns a permanent label. */
const HUB_LABEL_DEGREE = 3;

/** Alpha ramp for the ambient field, as [offset, alpha] pairs. */
/** Field opacity at the centre — depth cue, not a wash. */
const FIELD_PEAK_ALPHA = 0.085;

const FIELD_STOPS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [0.16, 0.79],
  [0.32, 0.56],
  [0.48, 0.35],
  [0.64, 0.19],
  [0.78, 0.087],
  [0.9, 0.027],
  [1, 0],
];

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Swamp accent, used only if a theme colour fails to resolve. */
const FALLBACK_ACCENT: Rgb = { r: 158, g: 197, b: 167 };

/** Flatten any CSS colour — including the `color-mix` theme tokens — to sRGB channels, by borrowing an element's computed style. */
function resolveRgb(host: HTMLElement, value: string): Rgb {
  const previous = host.style.color;
  host.style.color = '';
  host.style.color = value;
  const computed = host.style.color ? getComputedStyle(host).color : '';
  host.style.color = previous;
  if (!computed.startsWith('rgb')) return FALLBACK_ACCENT;
  const parts = computed.match(/-?[\d.]+/g);
  if (!parts || parts.length < 3) return FALLBACK_ACCENT;
  return { r: Number(parts[0]), g: Number(parts[1]), b: Number(parts[2]) };
}

const rgba = (c: Rgb, alpha: number): string => `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`;

/** Read Brain graph theme tokens from the document root. */
export function readForceGraphTheme(root: HTMLElement = document.documentElement): ForceGraphTheme {
  const style = getComputedStyle(root);
  const pick = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;
  const nodePage = pick('--brain-node-page', 'oklch(55% 0.08 250)');
  const nodeTag = pick('--brain-node-tag', 'oklch(62% 0.1 155)');
  const nodeOrphan = pick('--brain-node-orphan', 'oklch(62% 0.16 25)');
  const edge = pick('--brain-edge', 'oklch(70% 0.02 250 / 0.45)');
  const stageBg = pick('--brain-stage-bg', pick('--mn-bg', 'oklch(97% 0 0)'));
  return {
    stageBg,
    surface: pick('--mn-surface-1', stageBg),
    border: pick('--mn-border', edge),
    nodePage,
    nodePageMuted: pick('--brain-node-page-muted', nodePage),
    nodeTag,
    nodeTagMuted: pick('--brain-node-tag-muted', nodeTag),
    nodeActive: pick('--brain-node-active', 'oklch(45% 0.14 250)'),
    nodeOrphan,
    nodeOrphanMuted: pick('--brain-node-orphan-muted', nodeOrphan),
    nodeCore: pick('--brain-node-core', stageBg),
    edge,
    edgeHighlight: pick('--brain-edge-hi', 'oklch(50% 0.06 250 / 0.85)'),
    edgeSimilar: pick('--brain-edge-similar', edge),
    edgeTag: pick('--brain-edge-tag', edge),
    label: pick('--mn-fg', 'oklch(32% 0.02 250)'),
    labelMuted: pick('--mn-fg-muted', 'oklch(52% 0.02 250)'),
    accent: pick('--mn-accent', '#9ec5a7'),
    glow: pick('--brain-glow', 'oklch(55% 0.12 250 / 0.35)'),
    grid: pick('--brain-grid', pick('--mn-fg-subtle', 'oklch(60% 0.02 250)')),
  };
}

/** Stable 0–1 value from an edge id, used to stagger flow particles. */
function hashUnit(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

/** Create an interactive force-directed graph on a canvas element. */
export function createForceGraph(
  canvas: HTMLCanvasElement,
  options: ForceGraphOptions = {},
): ForceGraphApi {
  const reducedMotion =
    options.reducedMotion ??
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const callbacks: ForceGraphCallbacks = options;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2d context unavailable');

  let theme = readForceGraphTheme();
  let accentRgb = resolveRgb(canvas, theme.accent);
  let nodes: SimNode[] = [];
  let edges: SimEdge[] = [];
  let nodeById = new Map<string, SimNode>();
  let simulation: Simulation<SimNode, SimEdge> | null = null;
  let transform: ZoomTransform = zoomIdentity;
  let selectedId: string | null = null;
  let hoverId: string | null = null;
  let highlightIds: Set<string> | null = null;
  let focusId: string | null = null;
  let mutedKinds = new Set<GraphEmphasisKey>();
  let insets: ViewportInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  let pendingFit = false;
  let rafId = 0;
  let destroyed = false;

  const dpr = () => window.devicePixelRatio || 1;

  const resizeCanvas = (): void => {
    const rect = canvas.getBoundingClientRect();
    const ratio = dpr();
    canvas.width = Math.max(1, Math.floor(rect.width * ratio));
    canvas.height = Math.max(1, Math.floor(rect.height * ratio));
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  };

  const emphasisKey = (node: GraphNode): GraphEmphasisKey =>
    node.orphan ? 'orphan' : node.kind;

  const nodeColor = (node: SimNode): string => {
    if (node.id === selectedId) return theme.nodeActive;
    if (node.orphan) return theme.nodeOrphan;
    if (node.kind === 'tag') return theme.nodeTag;
    return theme.nodePage;
  };

  const edgeColor = (edge: SimEdge, highlighted: boolean): string => {
    if (highlighted) return theme.edgeHighlight;
    if (edge.kind === 'similar') return theme.edgeSimilar;
    if (edge.kind === 'tag') return theme.edgeTag;
    return theme.edge;
  };

  const screenToGraph = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left - transform.x) / transform.k;
    const y = (clientY - rect.top - transform.y) / transform.k;
    return { x, y };
  };

  const pickNode = (clientX: number, clientY: number): SimNode | null => {
    const { x, y } = screenToGraph(clientX, clientY);
    const slop = 5 / transform.k;
    let best: SimNode | null = null;
    let bestDist = Infinity;
    for (const node of nodes) {
      if (node.x == null || node.y == null) continue;
      const r = node.radius + slop;
      const dx = node.x - x;
      const dy = node.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r * r && d2 < bestDist) {
        best = node;
        bestDist = d2;
      }
    }
    return best;
  };

  const computeNeighborSet = (id: string): Set<string> => {
    const set = new Set<string>([id]);
    for (const e of edges) {
      const s = e.source as SimNode;
      const t = e.target as SimNode;
      if (s.id === id) set.add(t.id);
      if (t.id === id) set.add(s.id);
    }
    return set;
  };

  /** Rounded rect path used by the hover callout. Screen-space. */
  const addRoundedRectPath = (
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
  ): void => {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  };

  const placeCallout = (
    sx: number,
    sy: number,
    nodeScreenRadius: number,
    boxWidth: number,
    boxHeight: number,
    viewWidth: number,
    viewHeight: number,
  ): { x: number; y: number } => {
    const gap = 12 + nodeScreenRadius;
    const margin = 10;
    const candidates = [
      { x: sx - boxWidth / 2, y: sy + gap },
      { x: sx - boxWidth / 2, y: sy - gap - boxHeight },
      { x: sx + gap, y: sy - boxHeight / 2 },
      { x: sx - gap - boxWidth, y: sy - boxHeight / 2 },
    ];
    const fits = candidates.find(
      (c) =>
        c.x >= margin &&
        c.y >= margin &&
        c.x + boxWidth <= viewWidth - margin &&
        c.y + boxHeight <= viewHeight - margin,
    );
    const chosen = fits ?? candidates[0];
    return {
      x: Math.max(margin, Math.min(chosen.x, viewWidth - margin - boxWidth)),
      y: Math.max(margin, Math.min(chosen.y, viewHeight - margin - boxHeight)),
    };
  };

  /** Quadratic control point that bows an edge sideways so parallel links stay readable. */
  const edgeControlPoint = (
    s: SimNode,
    t: SimNode,
  ): { cx: number; cy: number } => {
    const mx = (s.x! + t.x!) / 2;
    const my = (s.y! + t.y!) / 2;
    const dx = t.x! - s.x!;
    const dy = t.y! - s.y!;
    const len = Math.hypot(dx, dy) || 1;
    const bow = Math.min(len * 0.12, 26);
    return { cx: mx - (dy / len) * bow, cy: my + (dx / len) * bow };
  };

  /** Ease emphasis and entrance one frame forward. */
  const advanceAnimation = (): void => {
    const hovering = Boolean(hoverId);
    const active = hoverId ? computeNeighborSet(hoverId) : highlightIds;
    const dimFloor = hovering || focusId ? DIM_EMPHASIS_HOVER : DIM_EMPHASIS_SELECTED;
    const dims = Boolean(active) && (hovering || Boolean(focusId) || Boolean(selectedId));

    for (const node of nodes) {
      let target = 1;
      if (mutedKinds.has(emphasisKey(node))) target = MUTED_EMPHASIS;
      else if (dims && !active!.has(node.id)) target = dimFloor;

      node.emphasis = reducedMotion
        ? target
        : node.emphasis + (target - node.emphasis) * 0.16;
      node.appear = reducedMotion ? 1 : Math.min(1, node.appear + 0.05);
    }
  };

  /** Ambient lattice + accent field: depth cues that also make pan/zoom legible. */
  const drawBackdrop = (w: number, h: number): void => {
    ctx.fillStyle = theme.stageBg;
    ctx.fillRect(0, 0, w, h);

    const radius = Math.hypot(w, h) * 0.85;
    const field = ctx.createRadialGradient(w / 2, h * 0.45, 0, w / 2, h * 0.45, radius);
    for (const [offset, alpha] of FIELD_STOPS) {
      field.addColorStop(offset, rgba(accentRgb, alpha * FIELD_PEAK_ALPHA));
    }
    ctx.save();
    ctx.fillStyle = field;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    const latticeAlpha = Math.min(0.5, Math.max(0, (transform.k - 0.3) * 0.5));
    if (latticeAlpha <= 0.01) return;
    const spacing = 56;
    const step = spacing * transform.k;
    if (step < 14) return;
    const originX = transform.x % step;
    const originY = transform.y % step;
    ctx.save();
    ctx.globalAlpha = latticeAlpha;
    ctx.fillStyle = theme.grid;
    for (let x = originX; x < w; x += step) {
      for (let y = originY; y < h; y += step) {
        ctx.fillRect(x, y, 1, 1);
      }
    }
    ctx.restore();
  };

  const drawEdges = (now: number): void => {
    const px = 1 / transform.k;
    for (const edge of edges) {
      const s = edge.source as SimNode;
      const t = edge.target as SimNode;
      if (s.x == null || s.y == null || t.x == null || t.y == null) continue;

      const emphasis = Math.min(s.emphasis, t.emphasis) * Math.min(s.appear, t.appear);
      if (emphasis <= 0.02) continue;
      const highlighted = emphasis > 0.85 && Boolean(highlightIds || hoverId);
      const { cx, cy } = edgeControlPoint(s, t);
      const stroke = edgeColor(edge, highlighted);

      ctx.save();
      ctx.globalAlpha = (edge.kind === 'tag' ? 0.55 : 0.85) * emphasis;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = (highlighted ? 1.7 : edge.kind === 'tag' ? 0.7 : 1.05) * px;
      if (edge.kind === 'similar') ctx.setLineDash([5 * px, 5 * px]);
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.quadraticCurveTo(cx, cy, t.x, t.y);
      ctx.stroke();
      ctx.restore();

      const directed = edge.kind === 'wikilink';
      if (directed && transform.k > 0.45 && emphasis > 0.35) {
        drawArrowhead(t, cx, cy, stroke, emphasis, px, highlighted);
      }

      if (highlighted && !reducedMotion) {
        const progress = ((now / 2200) + edge.seed) % 1;
        const inv = 1 - progress;
        const bx = inv * inv * s.x + 2 * inv * progress * cx + progress * progress * t.x;
        const by = inv * inv * s.y + 2 * inv * progress * cy + progress * progress * t.y;
        ctx.save();
        ctx.globalAlpha = 0.75 * Math.sin(progress * Math.PI);
        ctx.fillStyle = theme.edgeHighlight;
        ctx.beginPath();
        ctx.arc(bx, by, 2.1 * px, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  };

  /** Arrow at the target end, aimed along the curve's exit tangent. */
  const drawArrowhead = (
    target: SimNode,
    cx: number,
    cy: number,
    color: string,
    emphasis: number,
    px: number,
    highlighted: boolean,
  ): void => {
    const dx = target.x! - cx;
    const dy = target.y! - cy;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const tipX = target.x! - ux * (target.radius + 2 * px);
    const tipY = target.y! - uy * (target.radius + 2 * px);
    const size = (highlighted ? 7 : 5.5) * px;
    ctx.save();
    ctx.globalAlpha = 0.9 * emphasis;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - ux * size + -uy * size * 0.45, tipY - uy * size + ux * size * 0.45);
    ctx.lineTo(tipX - ux * size - -uy * size * 0.45, tipY - uy * size - ux * size * 0.45);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };

  const drawNodes = (now: number): void => {
    const px = 1 / transform.k;
    for (const node of nodes) {
      if (node.x == null || node.y == null) continue;
      const emphasis = node.emphasis;
      if (emphasis <= 0.02) continue;
      const eased = 1 - Math.pow(1 - node.appear, 3);
      const r = node.radius * (0.4 + eased * 0.6);
      const active = node.id === selectedId;
      const hovered = node.id === hoverId;
      const color = nodeColor(node);

      if (active || hovered || node.degree >= HUB_LABEL_DEGREE) {
        ctx.save();
        ctx.globalAlpha = (active ? 0.5 : hovered ? 0.34 : 0.18) * emphasis;
        ctx.shadowColor = active ? theme.glow : color;
        ctx.shadowBlur = active ? 22 : 12;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      ctx.save();
      ctx.globalAlpha = emphasis;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      if (node.degree >= HUB_LABEL_DEGREE && r > 6) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, r * 0.42, 0, Math.PI * 2);
        ctx.fillStyle = theme.nodeCore;
        ctx.globalAlpha = emphasis * 0.9;
        ctx.fill();
        ctx.globalAlpha = emphasis;
      }

      ctx.strokeStyle = active ? theme.nodeActive : theme.stageBg;
      ctx.lineWidth = (active ? 1.6 : 1.2) * px;
      if (node.orphan) ctx.setLineDash([2.5 * px, 2.5 * px]);
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      if (active) {
        const phase = reducedMotion ? 0 : (Math.sin(now / 620) + 1) / 2;
        ctx.save();
        ctx.globalAlpha = 0.75 - phase * 0.35;
        ctx.strokeStyle = theme.nodeActive;
        ctx.lineWidth = 1.4 * px;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + (4 + phase * 5) * px, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      } else if (hovered) {
        ctx.save();
        ctx.globalAlpha = 0.6 * emphasis;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2 * px;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 4 * px, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  };

  /** Persistent labels for well-connected nodes, dropped where they would collide. */
  const drawHubLabels = (w: number, h: number): void => {
    if (transform.k < 0.4) return;
    const skipId = hoverId ?? selectedId;
    const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
    const ranked = [...nodes]
      .filter((n) => n.x != null && n.emphasis > 0.5 && n.id !== skipId)
      .sort((a, b) => b.degree - a.degree)
      .slice(0, 40);

    ctx.save();
    ctx.font = '500 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const node of ranked) {
      if (node.degree < HUB_LABEL_DEGREE && transform.k < 1.2) continue;
      const sx = transform.applyX(node.x!);
      const sy = transform.applyY(node.y!);
      if (sx < -80 || sy < -40 || sx > w + 80 || sy > h + 40) continue;

      const text = node.label.length > 26 ? `${node.label.slice(0, 25)}…` : node.label;
      const width = ctx.measureText(text).width;
      const top = sy + node.radius * transform.k + 6;
      const box = { x: sx - width / 2 - 3, y: top - 2, w: width + 6, h: 16 };
      const collides = placed.some(
        (p) =>
          box.x < p.x + p.w && box.x + box.w > p.x && box.y < p.y + p.h && box.y + box.h > p.y,
      );
      if (collides) continue;
      placed.push(box);

      ctx.globalAlpha = Math.min(1, node.emphasis) * (node.degree >= HUB_LABEL_DEGREE ? 0.95 : 0.7);
      ctx.lineWidth = 3;
      ctx.strokeStyle = theme.stageBg;
      ctx.strokeText(text, sx, top);
      ctx.fillStyle = node.degree >= HUB_LABEL_DEGREE ? theme.label : theme.labelMuted;
      ctx.fillText(text, sx, top);
    }
    ctx.restore();
  };

  /** Hover/selection callout card with the node's title, path, and kind swatch. */
  const drawCallout = (w: number, h: number): void => {
    const node = nodeById.get(hoverId ?? selectedId ?? '');
    if (!node || node.x == null || node.y == null) return;

    const titleFont = '600 12px system-ui, sans-serif';
    const subFont = '500 10px ui-monospace, monospace';
    const padX = 11;
    const padY = 9;
    const swatch = 7;
    const titleLine = 15;
    const subLine = 13;

    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = titleFont;
    const titleWidth = ctx.measureText(node.label).width + swatch + 7;
    let subWidth = 0;
    const sub = node.sublabel ?? (node.degree ? `${node.degree} connections` : '');
    if (sub) {
      ctx.font = subFont;
      subWidth = ctx.measureText(sub).width;
    }

    const boxWidth = Math.min(
      Math.max(150, Math.ceil(Math.max(titleWidth, subWidth) + padX * 2)),
      Math.max(160, w - 24),
    );
    const boxHeight = padY * 2 + titleLine + (sub ? subLine : 0);
    const sx = transform.applyX(node.x);
    const sy = transform.applyY(node.y);
    const pos = placeCallout(sx, sy, node.radius * transform.k, boxWidth, boxHeight, w, h);

    ctx.shadowColor = theme.glow;
    ctx.shadowBlur = 18;
    addRoundedRectPath(pos.x, pos.y, boxWidth, boxHeight, 8);
    ctx.fillStyle = theme.surface;
    ctx.globalAlpha = 0.97;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(pos.x + padX + swatch / 2, pos.y + padY + titleLine / 2, swatch / 2, 0, Math.PI * 2);
    ctx.fillStyle = nodeColor(node);
    ctx.fill();

    ctx.font = titleFont;
    ctx.fillStyle = theme.label;
    ctx.fillText(node.label, pos.x + padX + swatch + 7, pos.y + padY + 1, boxWidth - padX * 2 - swatch);
    if (sub) {
      ctx.font = subFont;
      ctx.fillStyle = theme.labelMuted;
      ctx.fillText(sub, pos.x + padX, pos.y + padY + titleLine + 1, boxWidth - padX * 2);
    }
    ctx.restore();
  };

  const draw = (now: number): void => {
    if (destroyed || !ctx) return;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    ctx.save();
    ctx.clearRect(0, 0, w, h);
    drawBackdrop(w, h);

    ctx.save();
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.k, transform.k);
    drawEdges(now);
    drawNodes(now);
    ctx.restore();

    drawHubLabels(w, h);
    drawCallout(w, h);
    ctx.restore();
  };

  const tickLoop = (): void => {
    if (destroyed) return;
    const now = performance.now();
    advanceAnimation();
    draw(now);
    rafId = requestAnimationFrame(tickLoop);
  };

  const fitToNodes = (ids?: Set<string>): void => {
    const target = ids ? nodes.filter((n) => ids.has(n.id)) : nodes;
    if (!target.length) {
      transform = zoomIdentity;
      select(canvas).call(zoomBehavior.transform, zoomIdentity);
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of target) {
      if (n.x == null || n.y == null) continue;
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x);
      maxY = Math.max(maxY, n.y);
    }
    if (!isFinite(minX)) return;
    const rect = canvas.getBoundingClientRect();
    const pad = 40;
    const availW = Math.max(120, rect.width - insets.left - insets.right - pad * 2);
    const availH = Math.max(120, rect.height - insets.top - insets.bottom - pad * 2);
    const centerX = insets.left + pad + availW / 2;
    const centerY = insets.top + pad + availH / 2;
    const gw = Math.max(1, maxX - minX);
    const gh = Math.max(1, maxY - minY);
    const k = Math.min(availW / gw, availH / gh, 2.5);
    const tx = centerX - ((minX + maxX) / 2) * k;
    const ty = centerY - ((minY + maxY) / 2) * k;
    transform = zoomIdentity.translate(tx, ty).scale(k);
    select(canvas).call(zoomBehavior.transform, transform);
  };

  const centerOnNode = (id: string): void => {
    const node = nodeById.get(id);
    if (!node || node.x == null || node.y == null) return;
    const rect = canvas.getBoundingClientRect();
    const k = transform.k;
    const tx = insets.left + (rect.width - insets.left - insets.right) / 2 - node.x * k;
    const ty = insets.top + (rect.height - insets.top - insets.bottom) / 2 - node.y * k;
    transform = zoomIdentity.translate(tx, ty).scale(k);
    select(canvas).call(zoomBehavior.transform, transform);
  };

  const restartSimulation = (): void => {
    simulation?.stop();
    const rect = canvas.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;

    simulation = forceSimulation(nodes)
      .force(
        'link',
        forceLink<SimNode, SimEdge>(edges)
          .id((d) => d.id)
          .distance((l) => {
            const s = l.source as SimNode;
            const t = l.target as SimNode;
            const base = l.kind === 'tag' ? 52 : 72;
            return base + (s.radius + t.radius) * 1.4;
          })
          .strength((l) => (l.kind === 'tag' ? 0.35 : l.kind === 'similar' ? 0.4 : 0.6)),
      )
      .force('charge', forceManyBody<SimNode>().strength((d) => -150 - d.degree * 14))
      .force('center', forceCenter(cx, cy))
      .force('collide', forceCollide<SimNode>().radius((d) => d.radius + 14))
      .alpha(reducedMotion ? 0 : 0.9)
      .alphaDecay(reducedMotion ? 1 : 0.035);

    if (reducedMotion) {
      simulation.tick(160);
      if (pendingFit) {
        pendingFit = false;
        fitToNodes();
      }
    } else {
      simulation.on('end', () => {
        if (pendingFit) {
          pendingFit = false;
          fitToNodes();
        }
      });
    }
  };

  const zoomBehavior: ZoomBehavior<HTMLCanvasElement, unknown> = zoom<HTMLCanvasElement, unknown>()
    .scaleExtent([0.15, 4])
    .on('zoom', (event) => {
      transform = event.transform;
    });

  select(canvas).call(zoomBehavior);

  let draggingNode: SimNode | null = null;

  const dragBehavior = drag<HTMLCanvasElement, unknown>()
    .filter((event) => {
      if (event.button !== 0) return false;
      const target = pickNode(event.sourceEvent.clientX, event.sourceEvent.clientY);
      return Boolean(target);
    })
    .on('start', (event) => {
      const target = pickNode(event.sourceEvent.clientX, event.sourceEvent.clientY);
      if (!target) return;
      draggingNode = target;
      draggingNode.fx = draggingNode.x;
      draggingNode.fy = draggingNode.y;
      simulation?.alphaTarget(0.25).restart();
      select(canvas).on('.zoom', null);
    })
    .on('drag', (event) => {
      if (!draggingNode) return;
      const pt = screenToGraph(event.sourceEvent.clientX, event.sourceEvent.clientY);
      draggingNode.fx = pt.x;
      draggingNode.fy = pt.y;
    })
    .on('end', () => {
      if (draggingNode) {
        draggingNode.fx = draggingNode.x ?? null;
        draggingNode.fy = draggingNode.y ?? null;
      }
      draggingNode = null;
      simulation?.alphaTarget(0);
      select(canvas).call(zoomBehavior);
    });

  select(canvas).call(dragBehavior);

  let lastClick = { id: '', at: 0 };

  const onCanvasClick = (ev: MouseEvent): void => {
    const node = pickNode(ev.clientX, ev.clientY);
    const now = Date.now();
    if (
      node &&
      node.id === lastClick.id &&
      now - lastClick.at < 320
    ) {
      callbacks.onDoubleClick?.(node);
      lastClick = { id: '', at: 0 };
      return;
    }
    lastClick = node ? { id: node.id, at: now } : { id: '', at: 0 };
    if (!node) focusId = null;
    selectedId = node?.id ?? null;
    highlightIds = selectedId ? computeNeighborSet(selectedId) : null;
    callbacks.onSelect?.(node);
  };

  const onCanvasMouseMove = (ev: MouseEvent): void => {
    const node = pickNode(ev.clientX, ev.clientY);
    const nextId = node?.id ?? null;
    if (nextId === hoverId) return;
    hoverId = nextId;
    canvas.style.cursor = node ? 'pointer' : 'grab';
    callbacks.onHover?.(node);
  };

  const onCanvasMouseLeave = (): void => {
    hoverId = null;
    canvas.style.cursor = 'grab';
    callbacks.onHover?.(null);
  };

  canvas.addEventListener('click', onCanvasClick);
  canvas.addEventListener('mousemove', onCanvasMouseMove);
  canvas.addEventListener('mouseleave', onCanvasMouseLeave);

  const themeObserver = new MutationObserver(() => {
    theme = readForceGraphTheme();
    accentRgb = resolveRgb(canvas, theme.accent);
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'class'],
  });

  const scheduleCanvasResize = scheduleAnimationFrame(() => {
    resizeCanvas();
    draw(performance.now());
  });
  const resizeObserver = new ResizeObserver(scheduleCanvasResize);
  resizeObserver.observe(canvas);

  const handleKeydown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      focusId = null;
      highlightIds = selectedId ? computeNeighborSet(selectedId) : null;
    }
  };
  document.addEventListener('keydown', handleKeydown);

  resizeCanvas();
  rafId = requestAnimationFrame(tickLoop);

  const api: ForceGraphApi = {
    setData(rawNodes, rawEdges) {
      const degrees = new Map<string, number>();
      for (const e of rawEdges) {
        degrees.set(e.source, (degrees.get(e.source) ?? 0) + 1);
        degrees.set(e.target, (degrees.get(e.target) ?? 0) + 1);
      }
      nodes = rawNodes.map((n) => {
        const degree = degrees.get(n.id) ?? 0;
        return {
          ...n,
          degree,
          radius: KIND_BASE_RADIUS[n.kind] + Math.min(9, Math.sqrt(degree) * 2.4),
          emphasis: reducedMotion ? 1 : 0,
          appear: reducedMotion ? 1 : 0,
        };
      });
      nodeById = new Map(nodes.map((n) => [n.id, n]));
      edges = rawEdges.map((e) => ({ ...e, seed: hashUnit(e.id) })) as SimEdge[];
      selectedId = null;
      hoverId = null;
      focusId = null;
      highlightIds = null;
      pendingFit = true;
      restartSimulation();
    },
    selectNode(id) {
      selectedId = id;
      focusId = null;
      highlightIds = id ? computeNeighborSet(id) : null;
    },
    setHoverNode(id) {
      hoverId = id;
    },
    fitToView() {
      fitToNodes();
    },
    fitToNodes(ids) {
      fitToNodes(ids);
    },
    centerOnNode(id) {
      centerOnNode(id);
    },
    focusNode(id) {
      focusId = id;
      selectedId = id;
      highlightIds = computeNeighborSet(id);
      fitToNodes(highlightIds);
    },
    clearFocus() {
      focusId = null;
      highlightIds = selectedId ? computeNeighborSet(selectedId) : null;
    },
    setMutedKinds(keys) {
      mutedKinds = new Set(keys);
    },
    setViewportInsets(next) {
      insets = { ...insets, ...next };
    },
    getStats() {
      const kinds: Record<GraphNodeKind, number> = { page: 0, tag: 0 };
      let orphanCount = 0;
      for (const node of nodes) {
        kinds[node.kind] += 1;
        if (node.orphan) orphanCount += 1;
      }
      const hubs = [...nodes]
        .filter((n) => n.degree > 0)
        .sort((a, b) => b.degree - a.degree)
        .slice(0, 5)
        .map((n) => ({ id: n.id, label: n.label, path: n.path, degree: n.degree }));
      return {
        nodeCount: nodes.length,
        edgeCount: edges.length,
        kinds,
        orphanCount,
        density: nodes.length ? (edges.length * 2) / nodes.length : 0,
        hubs,
      };
    },
    zoomBy(factor) {
      const rect = canvas.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      transform = transform.translate(cx, cy).scale(factor).translate(-cx, -cy);
      select(canvas).call(zoomBehavior.transform, transform);
    },
    resize() {
      resizeCanvas();
      restartSimulation();
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(rafId);
      simulation?.stop();
      themeObserver.disconnect();
      resizeObserver.disconnect();
      document.removeEventListener('keydown', handleKeydown);
      canvas.removeEventListener('click', onCanvasClick);
      canvas.removeEventListener('mousemove', onCanvasMouseMove);
      canvas.removeEventListener('mouseleave', onCanvasMouseLeave);
      canvas.style.removeProperty('cursor');
      select(canvas).on('.zoom', null).on('.drag', null);
    },
    getTransform() {
      return transform;
    },
  };

  return api;
}
