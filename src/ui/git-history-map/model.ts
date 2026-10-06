import type { GitCommitEntry } from '../../state/git-api';
import type { CommitVisual } from '../git-graph';

export type GitHistoryRefKind = 'head' | 'local' | 'remote' | 'tag';
export interface GitHistoryRef {
  name: string;
  kind: GitHistoryRefKind;
  hash: string;
}
export interface GitHistoryNode {
  commit: GitCommitEntry;
  refs: GitHistoryRef[];
  lane: number;
  branchKey: string;
  isHead: boolean;
  isMain: boolean;
  colorIndex: number;
}
export interface GitHistoryEdge {
  child: string;
  parent: string;
  firstParent: boolean;
  boundary: boolean;
  hiddenCount?: number;
}
export interface GitHistoryFilter {
  query?: string;
  refKind?: GitHistoryRefKind | 'all';
}
export interface GitHistoryModel {
  nodes: GitHistoryNode[];
  edges: GitHistoryEdge[];
  refs: GitHistoryRef[];
  matches: Set<string>;
  hiddenCount: number;
}

function parseRefs(commit: GitCommitEntry): GitHistoryRef[] {
  return commit.refs.flatMap((raw): GitHistoryRef[] => {
    const ref = raw.trim();
    const hash = commit.hash;
    if (ref === 'HEAD') return [{ name: 'HEAD', kind: 'head', hash }];
    if (ref.startsWith('HEAD -> ')) return [
      { name: 'HEAD', kind: 'head', hash },
      { name: ref.slice(8).replace(/^refs\/heads\//, ''), kind: 'local', hash },
    ];
    if (ref.startsWith('tag: ')) return [{ name: ref.slice(5).replace(/^refs\/tags\//, ''), kind: 'tag', hash }];
    if (/^(refs\/)?remotes\//.test(ref)) return [{ name: ref.replace(/^(refs\/)?remotes\//, ''), kind: 'remote', hash }];
    if (ref.startsWith('refs/heads/')) return [{ name: ref.slice(11), kind: 'local', hash }];
    return ref ? [{ name: ref, kind: ref.startsWith('origin/') ? 'remote' : 'local', hash }] : [];
  });
}

/** Assign lanes online in Git's topological order, without inspecting older pages. */
export function buildGitHistoryModel(commits: GitCommitEntry[]): GitHistoryModel {
  const unique = [...new Map(commits.map((c) => [c.hash, c])).values()];
  const hashes = new Set(unique.map((c) => c.hash));
  const lanes: Array<{ hash: string; branch: string } | null> = [];
  const nodes: GitHistoryNode[] = [];
  const edges: GitHistoryEdge[] = [];
  const free = () => {
    const index = lanes.indexOf(null);
    return index < 0 ? lanes.length : index;
  };
  for (const commit of unique) {
    const refs = parseRefs(commit);
    const waiting: number[] = [];
    lanes.forEach((slot, lane) => { if (slot?.hash === commit.hash) waiting.push(lane); });
    const lane = waiting[0] ?? free();
    const inherited = lanes[lane]?.branch;
    const branchKey = (inherited && inherited !== commit.hash ? inherited : undefined) ?? refs.find((r) => r.kind === 'local')?.name
      ?? refs.find((r) => r.kind === 'remote')?.name ?? commit.hash;
    const isHead = refs.some((r) => r.kind === 'head');
    nodes.push({ commit, refs, lane, branchKey, isHead, isMain: lane === 0, colorIndex: lane % 8 });
    for (const occupied of waiting) lanes[occupied] = null;
    lanes[lane] = null;
    commit.parents.forEach((parent, index) => {
      edges.push({ child: commit.hash, parent, firstParent: index === 0, boundary: !hashes.has(parent) });
      if (lanes.some((slot) => slot?.hash === parent)) return;
      const target = index === 0 ? lane : free();
      lanes[target] = { hash: parent, branch: index === 0 ? branchKey : parent };
    });
  }
  return { nodes, edges, refs: nodes.flatMap((n) => n.refs), matches: hashes, hiddenCount: 0 };
}

/** Keep neighboring topology and the selected commit alongside search matches. */
export function filterGitHistoryModel(model: GitHistoryModel, filter: GitHistoryFilter, selected?: string | null): GitHistoryModel {
  const query = filter.query?.trim().toLocaleLowerCase() ?? '';
  if (!query && (!filter.refKind || filter.refKind === 'all')) return model;
  const matches = new Set(model.nodes.filter((node) => {
    const c = node.commit;
    const text = [c.hash, c.subject, c.author, ...node.refs.map((r) => r.name)].join(' ').toLocaleLowerCase();
    return (!query || text.includes(query)) && (!filter.refKind || filter.refKind === 'all'
      || node.refs.some((r) => r.kind === filter.refKind));
  }).map((n) => n.commit.hash));
  const keep = new Set(matches);
  if (selected) keep.add(selected);
  for (const edge of model.edges) {
    if (matches.has(edge.child)) keep.add(edge.parent);
    if (matches.has(edge.parent)) keep.add(edge.child);
  }
  const nodes = model.nodes.filter((n) => keep.has(n.commit.hash));
  return { ...model, nodes, matches,
    edges: model.edges.filter((e) => keep.has(e.child)).map((e) => ({ ...e, boundary: e.boundary || !keep.has(e.parent) })),
    hiddenCount: model.nodes.length - nodes.length };
}

/** Collapse branch interiors, keeping tips, joins, forks, HEAD, and selection. */
export function collapseGitHistoryBranches(model: GitHistoryModel, collapsed: Set<string>, selected?: string | null): GitHistoryModel {
  if (!collapsed.size) return model;
  const children = new Map<string, number>();
  const parents = new Map<string, GitHistoryEdge[]>();
  for (const edge of model.edges) {
    children.set(edge.parent, (children.get(edge.parent) ?? 0) + 1);
    const list = parents.get(edge.child) ?? [];
    list.push(edge);
    parents.set(edge.child, list);
  }
  const nodes = model.nodes.filter((n) => !collapsed.has(n.branchKey) || n.isMain || n.isHead
    || n.refs.length > 0 || n.commit.hash === selected || n.commit.parents.length !== 1
    || (children.get(n.commit.hash) ?? 0) > 1);
  const visible = new Set(nodes.map((n) => n.commit.hash));
  const loaded = new Set(model.nodes.map((n) => n.commit.hash));
  const edges = model.edges.filter((e) => visible.has(e.child)).map((edge) => {
    let parent = edge.parent;
    let hiddenCount = 0;
    const seen = new Set<string>();
    while (loaded.has(parent) && !visible.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      const next = parents.get(parent)?.[0];
      if (!next) break;
      parent = next.parent;
      hiddenCount++;
    }
    return { ...edge, parent, hiddenCount, boundary: !visible.has(parent) };
  });
  return { ...model, nodes, edges, hiddenCount: model.hiddenCount + model.nodes.length - nodes.length };
}

export function commitVisual(node: GitHistoryNode): CommitVisual {
  return { ...node, rails: [], curves: [] };
}
