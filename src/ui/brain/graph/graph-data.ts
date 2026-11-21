import type { MemoryKind, MemoryListing, MemoryRecord, MemoryScope } from '../../../brain/types';
import type { GraphData, GraphEdge, GraphNode } from './types';

export const MEMORY_KIND_ORDER: MemoryKind[] = ['decision', 'constraint', 'gotcha', 'preference', 'reference'];

export const MEMORY_KIND_PLURAL: Record<MemoryKind, string> = {
  decision: 'Decisions',
  constraint: 'Constraints',
  gotcha: 'Gotchas',
  preference: 'Preferences',
  reference: 'References',
};

export const hubId = (scope: MemoryScope): string => `hub:${scope}`;
export const clusterId = (scope: MemoryScope, kind: MemoryKind): string => `kind:${scope}:${kind}`;
export const memoryNodeId = (id: string): string => `mem:${id}`;

/** Related-edge tuning: shared-word overlap needed, and how many neighbors each memory keeps. */
const RELATED_MIN_JACCARD = 0.2;
const RELATED_PER_NODE = 2;

const STOPWORDS = new Set(
  ('this that with from have when then than they them their there what which while into only also '
    + 'does dont should would could will just over under about after before every each other some '
    + 'more most very been were being because always never using used uses make made like need needs').split(' '),
);

/** Significant lowercase words of a memory, for overlap scoring. */
export function memoryTokens(memory: Pick<MemoryRecord, 'title' | 'body'>): Set<string> {
  const words = `${memory.title} ${memory.body}`.toLowerCase().match(/[a-z0-9][a-z0-9_.-]{3,}/g) ?? [];
  return new Set(words.map((w) => w.replace(/[.-]+$/, '')).filter((w) => w.length >= 4 && !STOPWORDS.has(w)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export interface MemoryGraphOptions {
  /** Case-insensitive text filter over title, body and evidence. */
  query?: string;
  /** Scopes left out of the graph entirely. */
  hiddenScopes?: ReadonlySet<MemoryScope>;
  /** Memory kinds left out (the legend toggles). */
  hiddenKinds?: ReadonlySet<MemoryKind>;
}

/** Memories that pass the scope and text filters, in listing order. */
export function filterMemories(listing: MemoryListing, options: MemoryGraphOptions = {}): MemoryRecord[] {
  const q = options.query?.trim().toLowerCase() ?? '';
  return listing.memories.filter((memory) => {
    if (memory.scope === 'project' && !listing.project) return false;
    if (options.hiddenScopes?.has(memory.scope)) return false;
    if (options.hiddenKinds?.has(memory.kind ?? 'reference')) return false;
    if (!q) return true;
    return `${memory.title}\n${memory.body}\n${memory.evidence ?? ''}`.toLowerCase().includes(q);
  });
}

/**
 * Build the memory graph: one hub per scope, one cluster per kind that has memories,
 * memories hanging off their cluster, plus supersedes and shared-vocabulary links.
 * Hubs always render (even empty) so a new project still shows where memories will go.
 */
export function buildMemoryGraph(listing: MemoryListing, options: MemoryGraphOptions = {}): GraphData {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const visible = filterMemories(listing, options);

  const scopes: MemoryScope[] = [];
  if (listing.project && !options.hiddenScopes?.has('project')) scopes.push('project');
  if (!options.hiddenScopes?.has('user')) scopes.push('user');

  for (const scope of scopes) {
    const rows = visible.filter((m) => m.scope === scope);
    const total = listing.memories.filter((m) => m.scope === scope).length;
    nodes.push({
      id: hubId(scope),
      kind: 'hub',
      group: scope,
      label: scope === 'project' ? listing.project!.label : 'You',
      sublabel: `${scope === 'project' ? 'This project' : 'All projects'} · ${total} ${total === 1 ? 'memory' : 'memories'}`,
    });
    for (const kind of MEMORY_KIND_ORDER) {
      const items = rows.filter((m) => (m.kind ?? 'reference') === kind);
      if (!items.length) continue;
      const cid = clusterId(scope, kind);
      nodes.push({
        id: cid,
        kind: 'cluster',
        group: scope,
        label: MEMORY_KIND_PLURAL[kind],
        sublabel: `${items.length} ${items.length === 1 ? 'memory' : 'memories'}`,
        tone: kind,
      });
      edges.push({ id: `member:${cid}`, source: cid, target: hubId(scope), kind: 'member' });
      for (const memory of items) {
        const mid = memoryNodeId(memory.id);
        nodes.push({
          id: mid,
          kind: 'memory',
          group: scope,
          label: memory.title || 'Untitled',
          sublabel: `${MEMORY_KIND_PLURAL[kind].slice(0, -1)} · ${String(memory.updatedAt ?? '').slice(0, 10)}`,
          tone: kind,
          memoryId: memory.id,
        });
        edges.push({ id: `member:${mid}`, source: mid, target: cid, kind: 'member' });
      }
    }
  }

  const present = new Set(visible.map((m) => m.id));
  for (const memory of visible) {
    for (const old of memory.supersedes ?? []) {
      if (!present.has(old) || old === memory.id) continue;
      edges.push({
        id: `supersedes:${memory.id}->${old}`,
        source: memoryNodeId(memory.id),
        target: memoryNodeId(old),
        kind: 'supersedes',
      });
    }
  }

  // Shared vocabulary links, strongest first, each memory keeping a couple of neighbors.
  const tokens = new Map(visible.map((m) => [m.id, memoryTokens(m)]));
  const pairs: Array<{ a: string; b: string; score: number }> = [];
  for (let i = 0; i < visible.length; i++) {
    for (let j = i + 1; j < visible.length; j++) {
      const score = jaccard(tokens.get(visible[i].id)!, tokens.get(visible[j].id)!);
      if (score >= RELATED_MIN_JACCARD) pairs.push({ a: visible[i].id, b: visible[j].id, score });
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  const used = new Map<string, number>();
  const linked = new Set(edges.filter((e) => e.kind === 'supersedes').map((e) => [e.source, e.target].sort().join('|')));
  for (const { a, b } of pairs) {
    if ((used.get(a) ?? 0) >= RELATED_PER_NODE || (used.get(b) ?? 0) >= RELATED_PER_NODE) continue;
    const key = [memoryNodeId(a), memoryNodeId(b)].sort().join('|');
    if (linked.has(key)) continue;
    linked.add(key);
    used.set(a, (used.get(a) ?? 0) + 1);
    used.set(b, (used.get(b) ?? 0) + 1);
    edges.push({ id: `related:${key}`, source: memoryNodeId(a), target: memoryNodeId(b), kind: 'related' });
  }

  return { nodes, edges };
}

/** Return neighbor ids for highlighting. */
export function neighborIds(edges: GraphEdge[], nodeId: string): Set<string> {
  const set = new Set<string>([nodeId]);
  for (const e of edges) {
    if (e.source === nodeId) set.add(e.target);
    if (e.target === nodeId) set.add(e.source);
  }
  return set;
}
