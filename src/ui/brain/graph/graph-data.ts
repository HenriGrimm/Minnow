import type { BrainPageMeta } from '../../../brain/types';
import type { GraphData, GraphEdge, GraphNode } from './types';

const DEFAULT_MAX_NODES = 250;

/** Normalize wiki paths for stable comparison. */
function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\.md$/i, '');
}

/** Build nodes/edges from catalog pages, wikilinks, and optional tag vertices. */
export function buildPageGraph(
  pages: BrainPageMeta[],
  options?: {
    includeTags?: boolean;
    orphanPaths?: Set<string>;
    maxNodes?: number;
  },
): GraphData {
  const includeTags = options?.includeTags !== false;
  const maxNodes = options?.maxNodes ?? DEFAULT_MAX_NODES;
  const pathSet = new Set(pages.map((p) => p.path));
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  const ensurePage = (page: BrainPageMeta): void => {
    const id = `page:${page.path}`;
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        kind: 'page',
        label: page.title || page.path,
        sublabel: page.path,
        path: page.path,
        orphan: options?.orphanPaths?.has(page.path),
      });
    }
  };

  for (const page of pages) ensurePage(page);

  for (const page of pages) {
    const fromId = `page:${page.path}`;
    for (const raw of page.links ?? []) {
      const targetPath = raw.includes('.md') ? raw : `${raw}.md`;
      const normalized = normPath(targetPath);
      let resolved = pages.find((p) => normPath(p.path) === normalized)?.path;
      if (!resolved && pathSet.has(targetPath)) resolved = targetPath;
      const toId = resolved ? `page:${resolved}` : `page:missing:${normalized}`;
      if (!nodes.has(toId)) {
        nodes.set(toId, {
          id: toId,
          kind: 'page',
          label: resolved ? resolved.split('/').pop()?.replace(/\.md$/i, '') ?? normalized : normalized,
          path: resolved,
        });
      }
      edges.push({
        id: `link:${fromId}->${toId}`,
        source: fromId,
        target: toId,
        kind: 'wikilink',
      });
    }

    if (includeTags) {
      for (const tag of page.tags ?? []) {
        const tagId = `tag:${tag}`;
        if (!nodes.has(tagId)) {
          nodes.set(tagId, {
            id: tagId,
            kind: 'tag',
            label: tag,
          });
        }
        edges.push({
          id: `tag:${fromId}->${tagId}`,
          source: fromId,
          target: tagId,
          kind: 'tag',
        });
      }
    }

    for (const rawSimilar of page.similarTo ?? []) {
      const targetPath = String(rawSimilar).includes('.md') ? rawSimilar : `${rawSimilar}.md`;
      const normalized = normPath(targetPath);
      let resolved = pages.find((p) => normPath(p.path) === normalized)?.path;
      if (!resolved && pathSet.has(targetPath)) resolved = targetPath;
      if (!resolved) continue;
      const toId = `page:${resolved}`;
      if (!nodes.has(toId)) {
        nodes.set(toId, {
          id: toId,
          kind: 'page',
          label: resolved.split('/').pop()?.replace(/\.md$/i, '') ?? normalized,
          path: resolved,
        });
      }
      edges.push({
        id: `similar:${fromId}->${toId}`,
        source: fromId,
        target: toId,
        kind: 'similar',
      });
    }
  }

  let nodeList = [...nodes.values()];
  let truncated = false;
  let hiddenCount = 0;
  if (nodeList.length > maxNodes) {
    truncated = true;
    // Keep each catalog page beside its tags in the budget order. Page-only
    // pruning erased every tag as soon as the graph crossed the node limit.
    const orderedIds = new Set<string>();
    for (const page of pages) {
      orderedIds.add(`page:${page.path}`);
      if (includeTags) {
        for (const tag of page.tags ?? []) orderedIds.add(`tag:${tag}`);
      }
    }
    for (const node of nodeList) orderedIds.add(node.id);
    const keepIds = new Set([...orderedIds].slice(0, maxNodes));
    nodeList = nodeList.filter((n) => keepIds.has(n.id));
    hiddenCount = nodes.size - nodeList.length;
    const prunedEdges = edges.filter((e) => keepIds.has(e.source) && keepIds.has(e.target));
    edges.length = 0;
    edges.push(...prunedEdges);
  }

  return { nodes: nodeList, edges, truncated, hiddenCount };
}

/** Filter page graph nodes by search query (label/path/tag). */
export function filterGraphByQuery(data: GraphData, query: string): GraphData {
  const q = query.trim().toLowerCase();
  if (!q) return data;
  const matchIds = new Set(
    data.nodes
      .filter(
        (n) =>
          n.label.toLowerCase().includes(q) ||
          (n.path?.toLowerCase().includes(q) ?? false) ||
          (n.sublabel?.toLowerCase().includes(q) ?? false),
      )
      .map((n) => n.id),
  );
  const nodes = data.nodes.filter((n) => matchIds.has(n.id));
  const keep = new Set(nodes.map((n) => n.id));
  const edges = data.edges.filter((e) => keep.has(e.source) && keep.has(e.target));
  return { nodes, edges };
}

/** Return neighbor ids for hover highlighting. */
export function neighborIds(edges: GraphEdge[], nodeId: string): Set<string> {
  const set = new Set<string>([nodeId]);
  for (const e of edges) {
    if (e.source === nodeId) set.add(e.target);
    if (e.target === nodeId) set.add(e.source);
  }
  return set;
}
