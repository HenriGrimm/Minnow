/**
 * Brain memory graph — node/edge model shared by the data builder and the canvas renderer.
 */

/** hub = a scope (this project, or you across projects); cluster = one kind inside a scope. */
export type GraphNodeKind = 'hub' | 'cluster' | 'memory';

/** member = belongs to its cluster/hub; related = shared vocabulary; supersedes = replaced an older memory. */
export type GraphEdgeKind = 'member' | 'related' | 'supersedes';

/** One node in the force-directed graph (simulation mutates x/y/vx/vy). */
export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  sublabel?: string;
  /** Memory kind (decision, gotcha, …) — drives the node color. Hubs leave it unset. */
  tone?: string;
  /** Memory id when kind === 'memory'. */
  memoryId?: string;
  /** Layout lane: nodes sharing a group are pulled toward the same side of the canvas. */
  group?: string;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}

/** Edge between two node ids. `supersedes` points from the newer memory to the one it replaced. */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: GraphEdgeKind;
}

/** Theme colors resolved from CSS custom properties. */
export interface ForceGraphTheme {
  stageBg: string;
  /** Callout card fill. */
  surface: string;
  border: string;
  shadow: string;
  nodeHub: string;
  /** Per memory kind color; unknown tones fall back to `nodeMemory`. */
  tones: Record<string, string>;
  nodeMemory: string;
  nodeActive: string;
  /** Node core fill — reads as the hollow center of a hub ring. */
  nodeCore: string;
  edge: string;
  edgeHighlight: string;
  edgeRelated: string;
  label: string;
  labelMuted: string;
  glow: string;
  /** Ambient background lattice dots. */
  grid: string;
}

/** Legend keys that can fade a group of nodes: a memory kind. */
export type GraphEmphasisKey = string;

/** User interaction callbacks from the canvas renderer. */
export interface ForceGraphCallbacks {
  onSelect?: (node: GraphNode | null) => void;
  onDoubleClick?: (node: GraphNode) => void;
  onHover?: (node: GraphNode | null) => void;
}

/** Options passed when creating a force graph instance. */
export interface ForceGraphOptions extends ForceGraphCallbacks {
  reducedMotion?: boolean;
}

/** Result of pure graph builders. */
export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
