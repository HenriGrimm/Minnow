export type GraphNodeKind = 'page' | 'tag';

/** Edge relationship between graph vertices. */
export type GraphEdgeKind = 'wikilink' | 'tag' | 'similar';

/** One node in the force-directed graph (simulation mutates x/y/vx/vy). */
export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  sublabel?: string;
  /** Wiki page path when kind === 'page'. */
  path?: string;
  /** Lint orphan highlight flag. */
  orphan?: boolean;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}

/** Directed edge between two node ids. */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: GraphEdgeKind;
}

/** Theme colors resolved from CSS custom properties. */
export interface ForceGraphTheme {
  stageBg: string;
  /** Callout card / label bubble fill. */
  surface: string;
  border: string;
  nodePage: string;
  nodePageMuted: string;
  nodeTag: string;
  nodeTagMuted: string;
  nodeActive: string;
  nodeOrphan: string;
  nodeOrphanMuted: string;
  /** Node core fill — reads as the hollow center of a hub ring. */
  nodeCore: string;
  edge: string;
  edgeHighlight: string;
  /** Dashed `similarTo` relations. */
  edgeSimilar: string;
  /** Faint page→tag membership relations. */
  edgeTag: string;
  label: string;
  labelMuted: string;
  /** Raw family accent, flattened to sRGB for gradient stops. */
  accent: string;
  glow: string;
  /** Ambient background lattice dots. */
  grid: string;
}

/** Node classes the legend can mute. */
export type GraphEmphasisKey = 'page' | 'tag' | 'orphan';

/** User interaction callbacks from the canvas renderer. */
export interface ForceGraphCallbacks {
  onSelect?: (node: GraphNode | null) => void;
  onDoubleClick?: (node: GraphNode) => void;
  onHover?: (node: GraphNode | null) => void;
}

/** Options passed when creating a force graph instance. */
export interface ForceGraphOptions extends ForceGraphCallbacks {
  reducedMotion?: boolean;
  /** Soft cap before clustering message (default 250). */
  maxNodes?: number;
}

/** Result of pure graph builders. */
export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated?: boolean;
  hiddenCount?: number;
}
