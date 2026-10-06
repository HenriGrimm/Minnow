/**
 * Code map view models: turn the server's architecture / folder / call payloads into the
 * nodes and links each view draws, and decide which links stay quiet until selected.
 *
 * Pure functions only — no DOM — so the busy-map rules (hubs, folding, link filters,
 * layer order) are unit-testable.
 */

import type {
  BrainCodeSymbolRef,
  CodeMapArchitecture,
  CodeMapFolder,
  CodeMapFolderNode,
  CodeMapGroup,
  CodeMapModule,
} from '../../brain/types';

export type LinkFilter = 'strong' | 'all' | 'cross';

export type MapNodeKind = 'module' | 'more' | 'package' | 'file' | 'folder' | 'symbol' | 'center';

export interface MapNode {
  id: string;
  kind: MapNodeKind;
  label: string;
  /** Secondary line: a path, location or package note. */
  detail: string;
  /** Third line: counts. */
  meta: string;
  /** Workspace path for folder-like and file nodes. */
  path?: string;
  /** Layer (architecture) or column (files, calls) the node belongs to. */
  layer: number;
  /** Hub badge — how many other nodes link into this one. */
  usedBy?: number;
  module?: CodeMapModule;
  packageName?: string;
  folded?: string[];
  folderNode?: CodeMapFolderNode;
  symbolId?: string;
  symbolKind?: string;
  weight: number;
  test?: boolean;
}

export interface MapLink {
  id: string;
  src: string;
  dst: string;
  n: number;
  /** Runs against the layer order (callee drawn above its caller). */
  back: boolean;
  /** Joins two different layers or columns. */
  cross: boolean;
  /** Not drawn until one of its ends is selected or hovered. */
  quiet: boolean;
  /** Module → third-party package. */
  external: boolean;
}

export interface MapLayer {
  id: string;
  label: string;
  path: string;
  /** Index into the layer colour cycle. */
  tone: number;
  nodeIds: string[];
  external: boolean;
  group?: CodeMapGroup;
}

export interface ArchModel {
  layers: MapLayer[];
  nodes: Map<string, MapNode>;
  links: MapLink[];
  hubs: string[];
  hiddenTestGroups: number;
}

export interface ArchOptions {
  showTests: boolean;
  links: LinkFilter;
  expandedGroups: ReadonlySet<string>;
  /** Modules shown per layer before the rest fold into one "N more" card. */
  perLayer?: number;
  maxPackages?: number;
}

/** Callee names that name-based resolution routinely mismatches (mirrors server/brain/code/map.js). */
export const COMMON_CALL_NAMES: ReadonlySet<string> = new Set(
  (
    'map filter reduce forEach find findIndex some every includes indexOf join split slice splice ' +
    'push pop shift unshift concat sort reverse flat flatMap keys values entries from of all any race ' +
    'then catch finally get set has add delete clear next emit on off once close open read write send ' +
    'run start stop log warn error info debug trace toString valueOf parse stringify resolve reject ' +
    'apply call bind replace trim match test exec assign create now min max round floor ceil abs fetch ' +
    'append remove update init load save render dispose destroy'
  ).split(' '),
);

const HUB_MIN_SOURCES = 4;
/** Top-level folders this small share one "Other" layer instead of a layer each. */
const SMALL_LAYER_FILES = 3;
const MAX_EXHAUSTIVE_LAYERS = 8;
/** Extra cost, in layer steps, of a link drawn pointing up. */
const BACK_LINK_COST = 1.5;
const OTHER_LAYER = '@other';
const HUB_SHARE = 0.3;
/** At most this share of cards become hubs — the most shared ones. */
const HUB_MAX_SHARE = 0.12;
/** Architecture links below this many calls stay quiet under the strong filter. */
const ARCH_MIN_STRONG = 3;
/** Above this many links per node, weak links go quiet under the "strong" filter. */
const DENSE_LINKS_PER_NODE = 2.5;
/** Most links drawn at rest per node under the "strong" filter. */
const MAX_LOUD_LINKS_PER_NODE = 3;

function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}

/** Display name for an architecture module. Loose files read as "<layer> files". */
export function moduleLabel(mod: CodeMapModule, group: CodeMapGroup | undefined, onlyModule: boolean): string {
  if (!mod.loose) return mod.name;
  const groupName = group?.name || '';
  if (onlyModule && groupName) return groupName;
  return groupName ? `${groupName} files` : 'Root files';
}

/** Display path with a trailing slash for folders; `./` for the repo root. */
export function folderDisplayPath(path: string): string {
  return path ? `${path}/` : './';
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * Mark hubs (nodes many others link into) and set which links stay quiet at rest.
 * Hub links, links below the strength threshold on a dense map, and — for the
 * cross-layer filter — same-layer links are quiet; selection reveals them.
 */
export function classifyLinks(
  nodes: Map<string, MapNode>,
  links: MapLink[],
  filter: LinkFilter,
  opts: { hubs?: boolean; minStrong?: number } = {},
): string[] {
  const hubs: string[] = [];
  if (opts.hubs !== false) {
    const sources = new Map<string, Set<string>>();
    for (const link of links) {
      if (link.external) continue;
      let set = sources.get(link.dst);
      if (!set) sources.set(link.dst, (set = new Set()));
      set.add(link.src);
    }
    const peers = [...nodes.values()].filter((n) => n.kind === 'module' || n.kind === 'file' || n.kind === 'folder').length;
    const minSources = Math.max(HUB_MIN_SOURCES, Math.ceil(peers * HUB_SHARE));
    const maxHubs = Math.max(1, Math.round(peers * HUB_MAX_SHARE));
    const candidates = [...sources]
      .filter(([id, set]) => {
        const node = nodes.get(id);
        return node && node.kind !== 'more' && set.size >= minSources;
      })
      .sort((a, b) => b[1].size - a[1].size)
      .slice(0, maxHubs);
    for (const [id, set] of candidates) {
      nodes.get(id)!.usedBy = set.size;
      hubs.push(id);
    }
  }
  const hubSet = new Set(hubs);
  const folded = (id: string) => nodes.get(id)?.kind === 'more';

  const internal = links.filter((l) => !l.external && !hubSet.has(l.dst));
  const dense = internal.length > nodes.size * DENSE_LINKS_PER_NODE;
  const threshold =
    filter === 'strong' ? Math.max(opts.minStrong ?? 1, dense ? Math.max(2, median(internal.map((l) => l.n))) : 0) : 0;
  const loudBudget = filter === 'strong' ? Math.max(12, nodes.size * MAX_LOUD_LINKS_PER_NODE) : Infinity;
  let loud = 0;
  for (const link of [...links].sort((a, b) => b.n - a.n)) {
    let quiet = link.external || hubSet.has(link.dst);
    if (!quiet && filter === 'cross' && !link.cross) quiet = true;
    if (!quiet && filter === 'strong' && (folded(link.src) || folded(link.dst))) quiet = true;
    if (!quiet && link.n < threshold) quiet = true;
    if (!quiet && loud >= loudBudget) quiet = true;
    link.quiet = quiet;
    if (!quiet) loud += 1;
  }
  return hubs;
}

/**
 * Order layers so links are short and point down: a layer that calls another sits above
 * it, and layers that talk a lot sit next to each other. Up to eight layers are ordered
 * exhaustively (span + back-link cost); more fall back to net outgoing calls.
 */
export function orderLayers(
  layerIds: string[],
  links: Array<{ srcLayer: string; dstLayer: string; n: number }>,
  size: (id: string) => number,
): string[] {
  const score = new Map<string, number>(layerIds.map((id) => [id, 0]));
  const weights = new Map<string, number>();
  for (const link of links) {
    if (link.srcLayer === link.dstLayer || !score.has(link.srcLayer) || !score.has(link.dstLayer)) continue;
    score.set(link.srcLayer, (score.get(link.srcLayer) ?? 0) + link.n);
    score.set(link.dstLayer, (score.get(link.dstLayer) ?? 0) - link.n);
    const key = `${link.srcLayer}\u0000${link.dstLayer}`;
    weights.set(key, (weights.get(key) ?? 0) + link.n);
  }
  const byScore = [...layerIds].sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0) || size(b) - size(a));
  if (layerIds.length < 3 || layerIds.length > MAX_EXHAUSTIVE_LAYERS || !weights.size) return byScore;

  const pairs = [...weights].map(([key, n]) => {
    const [a, b] = key.split('\u0000') as [string, string];
    return { a, b, n };
  });
  const cost = (order: string[]) => {
    const pos = new Map(order.map((id, i) => [id, i]));
    let total = 0;
    for (const p of pairs) {
      const d = pos.get(p.b)! - pos.get(p.a)!;
      total += p.n * (Math.abs(d) - 1 + (d < 0 ? BACK_LINK_COST : 0));
    }
    return total;
  };
  let best = byScore;
  let bestCost = cost(byScore);
  // Heap's algorithm over every ordering; ties keep the score order.
  const perm = [...byScore];
  const c = new Array<number>(perm.length).fill(0);
  let i = 0;
  while (i < perm.length) {
    if (c[i]! < i) {
      const j = i % 2 === 0 ? 0 : c[i]!;
      [perm[j], perm[i]] = [perm[i]!, perm[j]!];
      const next = cost(perm);
      if (next < bestCost - 1e-9) {
        bestCost = next;
        best = [...perm];
      }
      c[i]! += 1;
      i = 0;
    } else {
      c[i] = 0;
      i += 1;
    }
  }
  return best;
}

/**
 * Within each layer, place nodes near the nodes they link to in earlier layers
 * (barycenter ordering) so lines cross less. "More" cards stay last.
 */
export function orderWithinLayers(layers: MapLayer[], links: MapLink[], nodes: Map<string, MapNode>): void {
  const position = new Map<string, number>();
  const neighbours = new Map<string, Array<{ id: string; n: number }>>();
  for (const link of links) {
    if (link.external) continue;
    for (const [a, b] of [
      [link.src, link.dst],
      [link.dst, link.src],
    ] as const) {
      let list = neighbours.get(a);
      if (!list) neighbours.set(a, (list = []));
      list.push({ id: b, n: link.n });
    }
  }
  layers.forEach((layer, layerIndex) => {
    const count = layer.nodeIds.length;
    if (layerIndex > 0) {
      const keyed = layer.nodeIds.map((id, idx) => {
        let sum = 0;
        let weight = 0;
        for (const nb of neighbours.get(id) ?? []) {
          const pos = position.get(nb.id);
          if (pos === undefined) continue;
          sum += pos * nb.n;
          weight += nb.n;
        }
        const node = nodes.get(id);
        const last = node?.kind === 'more' ? 2 : 0;
        return { id, key: weight ? sum / weight : 1.5 + idx / Math.max(1, count), last };
      });
      keyed.sort((a, b) => a.last - b.last || a.key - b.key);
      layer.nodeIds = keyed.map((k) => k.id);
    }
    layer.nodeIds.forEach((id, idx) => position.set(id, count > 1 ? idx / (count - 1) : 0.5));
  });
}

/** Layers, cards and links for the architecture view. */
export function buildArchModel(arch: CodeMapArchitecture, opts: ArchOptions): ArchModel {
  const perLayer = opts.perLayer ?? 8;
  const groups = arch.groups.filter((g) => opts.showTests || !g.test);
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const modules = arch.modules.filter((m) => groupById.has(m.group) && (opts.showTests || !m.test));
  const moduleIds = new Set(modules.map((m) => m.id));
  const edges = arch.edges.filter((e) => moduleIds.has(e.src) && moduleIds.has(e.dst));

  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.src, (degree.get(e.src) ?? 0) + e.n);
    degree.set(e.dst, (degree.get(e.dst) ?? 0) + e.n);
  }
  const weightOf = (m: CodeMapModule) => (degree.get(m.id) ?? 0) + m.symbols * 0.02 + m.files * 0.1;

  const nodes = new Map<string, MapNode>();
  const nodeOfModule = new Map<string, string>();
  const layerNodes = new Map<string, string[]>();

  // Tiny top-level folders (a lone config dir, a couple of root files) share one layer.
  const populated = groups.filter((g) => modules.some((m) => m.group === g.id));
  const small = populated.filter((g) => g.files <= SMALL_LAYER_FILES);
  const mergeSmall = small.length > 1 && populated.length - small.length >= 1;
  const layerOfGroup = new Map<string, string>(
    populated.map((g) => [g.id, mergeSmall && g.files <= SMALL_LAYER_FILES ? OTHER_LAYER : g.id]),
  );

  for (const group of groups) {
    const members = modules.filter((m) => m.group === group.id).sort((a, b) => weightOf(b) - weightOf(a));
    if (!members.length) continue;
    const layerId = layerOfGroup.get(group.id) ?? group.id;
    const limit = opts.expandedGroups.has(group.id) ? Infinity : perLayer;
    const shown = members.length > limit + 1 ? members.slice(0, limit) : members;
    const folded = members.slice(shown.length);
    const ids: string[] = [];
    for (const mod of shown) {
      nodes.set(mod.id, {
        id: mod.id,
        kind: 'module',
        label: layerId === OTHER_LAYER && mod.loose ? group.name || 'Root files' : moduleLabel(mod, group, members.length === 1),
        detail: folderDisplayPath(mod.path),
        meta: plural(mod.files, 'file'),
        path: mod.path,
        layer: 0,
        module: mod,
        weight: weightOf(mod),
        test: mod.test,
      });
      nodeOfModule.set(mod.id, mod.id);
      ids.push(mod.id);
    }
    if (folded.length) {
      const id = `more:${group.id}`;
      const names = folded.slice(0, 3).map((m) => m.name);
      nodes.set(id, {
        id,
        kind: 'more',
        label: `${folded.length} more modules`,
        detail: `${names.join(', ')}${folded.length > names.length ? '…' : ''}`,
        meta: plural(folded.reduce((sum, m) => sum + m.files, 0), 'file'),
        layer: 0,
        folded: folded.map((m) => m.id),
        weight: 0,
      });
      for (const mod of folded) nodeOfModule.set(mod.id, id);
      ids.push(id);
    }
    layerNodes.set(layerId, [...(layerNodes.get(layerId) ?? []), ...ids]);
  }

  const groupOfNode = (id: string): string | undefined => {
    const node = nodes.get(id);
    const group = node?.module ? node.module.group : node?.kind === 'more' ? id.slice('more:'.length) : undefined;
    return group === undefined ? undefined : (layerOfGroup.get(group) ?? group);
  };

  const pairs = new Map<string, MapLink>();
  for (const e of edges) {
    const src = nodeOfModule.get(e.src);
    const dst = nodeOfModule.get(e.dst);
    if (!src || !dst || src === dst) continue;
    const key = `${src}\u0000${dst}`;
    const hit = pairs.get(key);
    if (hit) hit.n += e.n;
    else pairs.set(key, { id: `${src}->${dst}`, src, dst, n: e.n, back: false, cross: false, quiet: false, external: false });
  }
  const links = [...pairs.values()];

  const order = orderLayers(
    [...layerNodes.keys()].filter((id) => id !== OTHER_LAYER),
    links.map((l) => ({ srcLayer: groupOfNode(l.src) ?? '', dstLayer: groupOfNode(l.dst) ?? '', n: l.n })),
    (id) => groupById.get(id)?.files ?? 0,
  );
  if (layerNodes.has(OTHER_LAYER)) order.push(OTHER_LAYER);

  const layers: MapLayer[] = order.map((layerId, index) => {
    const group = groupById.get(layerId);
    for (const id of layerNodes.get(layerId) ?? []) nodes.get(id)!.layer = index;
    return {
      id: layerId,
      label: layerId === OTHER_LAYER ? 'Other' : group?.name || 'Root',
      path: layerId === OTHER_LAYER ? '' : (group?.path ?? ''),
      tone: index,
      nodeIds: layerNodes.get(layerId) ?? [],
      external: false,
      group,
    };
  });

  // Third-party packages, counted over the modules still on the map.
  const maxPackages = opts.maxPackages ?? 8;
  const packages: Array<{ name: string; files: number; byNode: Map<string, number> }> = [];
  for (const ext of arch.externals ?? []) {
    const byNode = new Map<string, number>();
    let files = 0;
    for (const [moduleId, n] of Object.entries(ext.modules)) {
      const nodeId = nodeOfModule.get(moduleId);
      if (!nodeId) continue;
      byNode.set(nodeId, (byNode.get(nodeId) ?? 0) + n);
      files += n;
    }
    if (files >= 2) packages.push({ name: ext.name, files, byNode });
  }
  packages.sort((a, b) => b.files - a.files);
  const shownPackages = packages.slice(0, maxPackages);
  if (shownPackages.length) {
    const layerIndex = layers.length;
    const ids: string[] = [];
    for (const pkg of shownPackages) {
      const id = `pkg:${pkg.name}`;
      nodes.set(id, {
        id,
        kind: 'package',
        label: pkg.name,
        detail: `used by ${plural(pkg.byNode.size, 'module')}`,
        meta: `imported in ${plural(pkg.files, 'file')}`,
        layer: layerIndex,
        packageName: pkg.name,
        weight: pkg.files,
      });
      ids.push(id);
      for (const [nodeId, n] of pkg.byNode) {
        links.push({ id: `${nodeId}->${id}`, src: nodeId, dst: id, n, back: false, cross: true, quiet: true, external: true });
      }
    }
    layers.push({ id: '@external', label: 'External packages', path: '', tone: -1, nodeIds: ids, external: true });
  }

  for (const link of links) {
    const a = nodes.get(link.src)!.layer;
    const b = nodes.get(link.dst)!.layer;
    link.cross = a !== b;
    link.back = a > b;
  }
  orderWithinLayers(layers, links, nodes);
  const hubs = classifyLinks(nodes, links, opts.links, { minStrong: ARCH_MIN_STRONG });

  return {
    layers,
    nodes,
    links,
    hubs,
    hiddenTestGroups: opts.showTests ? 0 : arch.groups.filter((g) => g.test).length,
  };
}

export interface FolderModel {
  nodes: Map<string, MapNode>;
  links: MapLink[];
  hubs: string[];
}

/** Cards and links for the files view of one folder (columns are assigned by the layout). */
export function buildFolderModel(folder: CodeMapFolder, filter: LinkFilter): FolderModel {
  const nodes = new Map<string, MapNode>();
  for (const node of folder.nodes) {
    const isFolder = node.kind === 'folder';
    nodes.set(node.id, {
      id: node.id,
      kind: isFolder ? 'folder' : 'file',
      label: isFolder ? `${node.name}/` : node.name,
      detail: isFolder ? plural(node.files, 'file') : node.lines ? plural(node.lines, 'line') : 'not parsed',
      meta: node.outside ? `${plural(node.outside, 'call')} from outside` : plural(node.symbols, 'symbol'),
      path: node.path,
      layer: 0,
      folderNode: node,
      weight: node.callsIn + node.callsOut,
    });
  }
  const links: MapLink[] = folder.edges
    .filter((e) => nodes.has(e.src) && nodes.has(e.dst))
    .map((e) => ({ id: `${e.src}->${e.dst}`, src: e.src, dst: e.dst, n: e.n, back: false, cross: true, quiet: false, external: false }));
  const hubs = classifyLinks(nodes, links, filter);
  return { nodes, links, hubs };
}

export interface CallCenter {
  id: string;
  name: string;
  kind: string;
  file: string;
  line: number;
}

export interface CallModel {
  nodes: Map<string, MapNode>;
  links: MapLink[];
  columns: Map<number, string[]>;
  hiddenCommon: number;
}

const CALL_COLUMN_MAX = 24;

function refNode(ref: BrainCodeSymbolRef, column: number): MapNode {
  return {
    id: ref.symbolId,
    kind: 'symbol',
    label: ref.name,
    detail: `${ref.file.split('/').pop()}:${ref.line}`,
    meta: ref.file,
    path: ref.file,
    layer: column,
    symbolId: ref.symbolId,
    weight: 0,
  };
}

/**
 * Columns of callers (left) and callees (right) around one symbol. `outer` adds a second
 * ring: callers of each caller and callees of each callee.
 */
export function buildCallModel(
  center: CallCenter,
  callers: BrainCodeSymbolRef[],
  callees: BrainCodeSymbolRef[],
  opts: {
    hideCommon: boolean;
    outerCallers?: Map<string, BrainCodeSymbolRef[]>;
    outerCallees?: Map<string, BrainCodeSymbolRef[]>;
  },
): CallModel {
  const nodes = new Map<string, MapNode>();
  const links: MapLink[] = [];
  const columns = new Map<number, string[]>();
  let hiddenCommon = 0;
  const keep = (ref: BrainCodeSymbolRef) => {
    if (opts.hideCommon && COMMON_CALL_NAMES.has(ref.name)) {
      hiddenCommon += 1;
      return false;
    }
    return true;
  };
  const place = (ref: BrainCodeSymbolRef, column: number): boolean => {
    if (nodes.has(ref.symbolId)) return true;
    const list = columns.get(column) ?? [];
    if (list.length >= CALL_COLUMN_MAX) return false;
    nodes.set(ref.symbolId, refNode(ref, column));
    list.push(ref.symbolId);
    columns.set(column, list);
    return true;
  };
  const link = (src: string, dst: string) => {
    if (src === dst || links.some((l) => l.src === src && l.dst === dst)) return;
    const a = nodes.get(src)!.layer;
    const b = nodes.get(dst)!.layer;
    links.push({ id: `${src}->${dst}`, src, dst, n: 1, back: a > b, cross: a !== b, quiet: false, external: false });
  };

  nodes.set(center.id, {
    id: center.id,
    kind: 'center',
    label: center.name,
    detail: `${center.file.split('/').pop()}:${center.line}`,
    meta: center.file,
    path: center.file,
    layer: 0,
    symbolId: center.id,
    symbolKind: center.kind,
    weight: 0,
  });
  columns.set(0, [center.id]);

  for (const ref of callers.filter(keep)) if (place(ref, -1)) link(ref.symbolId, center.id);
  for (const ref of callees.filter(keep)) if (place(ref, 1)) link(center.id, ref.symbolId);
  for (const [callerId, refs] of opts.outerCallers ?? []) {
    if (!nodes.has(callerId)) continue;
    for (const ref of refs.filter(keep)) if (place(ref, -2)) link(ref.symbolId, callerId);
  }
  for (const [calleeId, refs] of opts.outerCallees ?? []) {
    if (!nodes.has(calleeId)) continue;
    for (const ref of refs.filter(keep)) if (place(ref, 2)) link(calleeId, ref.symbolId);
  }
  return { nodes, links, columns, hiddenCommon };
}

/** Links that touch a node, split by direction. */
export function linksOf(links: MapLink[], id: string): { out: MapLink[]; in: MapLink[] } {
  return {
    out: links.filter((l) => l.src === id).sort((a, b) => b.n - a.n),
    in: links.filter((l) => l.dst === id).sort((a, b) => b.n - a.n),
  };
}

/** Mermaid flowchart of the drawn nodes and links (quiet links included when asked). */
export function toMermaid(nodes: Map<string, MapNode>, links: MapLink[], includeQuiet = false): string {
  const ids = new Map<string, string>();
  let i = 0;
  for (const id of nodes.keys()) ids.set(id, `n${i++}`);
  const safe = (value: string) => value.replace(/["\\\r\n[\]]/g, ' ').slice(0, 80);
  const lines = ['flowchart TD'];
  for (const [id, node] of nodes) lines.push(`  ${ids.get(id)}["${safe(node.label)}"]`);
  for (const link of links) {
    if (link.quiet && !includeQuiet) continue;
    const a = ids.get(link.src);
    const b = ids.get(link.dst);
    if (!a || !b) continue;
    lines.push(link.back ? `  ${a} -.-> ${b}` : `  ${a} --> ${b}`);
  }
  return lines.join('\n');
}
