import { expandGitmojiShortcodes } from '../lib/gitmoji-shortcodes.mjs';
import { gitLog, type GitCommitEntry } from '../state/git-api';

const LOG_COUNT = 200;
const BRANCH_COLORS = 7;
/** Horizontal distance between lane centers. */
const LANE_STEP = 14;
/** The marker column stops growing past this many lanes; lanes squeeze closer instead. */
const MAX_FULL_LANES = 8;
/** Dot center distance from the row top; must match --git-dot-center-y in git-panel.css. */
const DOT_CENTER_Y = 13;
/** Vertical run a merge curve takes below the dot before straightening out. */
const CURVE_DROP = 14;
/** Collapsed view: spacing between branch sub-dot centers. */
const SUBDOT_STEP = 7;
/** Collapsed view: sub-dots shown per row before the +N overflow. */
const MAX_SUBDOTS = 3;

const COLLAPSED_PREF_KEY = 'minnow.git-graph.collapsed';

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface GitGraphOptions {
  cwd?: string;
  onSelectCommit?: (sha: string) => void;
  /** Right-click handler for commit rows. */
  onContextMenu?: (visual: CommitVisual, event: MouseEvent) => void;
  /** Highlight the selected commit row (e.g. open in diff panel). */
  selectedSha?: string | null;
  /** Max commits to fetch (default 200). */
  logCount?: number;
}

export interface GitGraphHandle {
  refresh: () => Promise<void>;
  destroy: () => void;
}

/** Vertical rail through a row: full height, top→dot, or dot→bottom. */
export interface GraphRail {
  lane: number;
  colorIndex: number;
  kind: 'through' | 'up' | 'down';
}

/** Rounded connector between lanes. */
export interface GraphCurve {
  kind: 'in' | 'out';
  fromLane: number;
  toLane: number;
  colorIndex: number;
  /** `out` only: the target lane already has a rail this row, so no tail is drawn. */
  joins?: boolean;
}

/** Visual metadata attached to each commit row. */
export interface CommitVisual {
  commit: GitCommitEntry;
  branchKey: string;
  isMain: boolean;
  colorIndex: number;
  isHead: boolean;
  /** Lane (column) the commit dot sits on. */
  lane: number;
  /** Vertical rails behind this row. */
  rails: GraphRail[];
  /** Fork/merge connectors on this row. */
  curves: GraphCurve[];
}

/** Collapsed view: branch commits summarized on their mainline fork base. */
export interface BranchCluster {
  branchKey: string;
  colorIndex: number;
  count: number;
  /** True when HEAD is one of the summarized commits. */
  hasHead: boolean;
}

export interface CollapsedRow {
  visual: CommitVisual;
  clusters: BranchCluster[];
  /** Commits in clusters beyond MAX_SUBDOTS, shown as +N. */
  extraCount: number;
}

// ── Refs ─────────────────────────────────────────────────────────────────────

function commitIsHead(refs: string[]): boolean {
  return refs.some((r) => /\bHEAD\b/.test(r));
}

/** Parse a git log ref string into a short branch name, when possible. */
export function normalizeBranchRef(ref: string): string | null {
  const trimmed = ref.trim().replace('HEAD -> refs/heads/', 'HEAD -> ')
    .replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, 'remotes/');
  if (!trimmed || trimmed.startsWith('tag:')) return null;

  const headMatch = trimmed.match(/^HEAD -> (.+)$/);
  if (headMatch) return headMatch[1];

  if (trimmed.startsWith('origin/')) {
    const remote = trimmed.slice('origin/'.length);
    if (remote === 'HEAD') return null;
    return remote;
  }

  if (trimmed.startsWith('remotes/origin/')) {
    const remote = trimmed.slice('remotes/origin/'.length);
    if (remote === 'HEAD') return null;
    return remote;
  }

  if (trimmed.startsWith('remotes/')) {
    const name = trimmed.replace(/^remotes\/[^/]+\//, '');
    return name === 'HEAD' ? null : name;
  }
  return trimmed;
}

/** Local branch names from git log refs (excludes tags and remote-tracking refs). */
export function extractLocalBranchRefs(refs: string[]): string[] {
  const names: string[] = [];
  for (const ref of refs) {
    const trimmed = ref.trim().replace('HEAD -> refs/heads/', 'HEAD -> ')
      .replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, 'remotes/');
    if (!trimmed || trimmed.startsWith('tag:')) continue;
    if (trimmed === 'HEAD') continue;
    if (trimmed.startsWith('origin/') || trimmed.startsWith('remotes/')) continue;

    const headMatch = trimmed.match(/^HEAD -> (.+)$/);
    if (headMatch) {
      names.push(headMatch[1]);
      continue;
    }
    names.push(trimmed);
  }
  return [...new Set(names)];
}

function extractBranchRefs(refs: string[]): string[] {
  const names: string[] = [];
  for (const ref of refs) {
    const name = normalizeBranchRef(ref);
    if (name) names.push(name);
  }
  return names;
}

// ── Layout ───────────────────────────────────────────────────────────────────

/** Prefer `main`, then `master`, otherwise the branch at HEAD. */
export function detectTrunkBranch(commits: GitCommitEntry[]): string {
  for (const trunk of ['main', 'master']) {
    for (const commit of commits) {
      if (extractBranchRefs(commit.refs).includes(trunk)) return trunk;
    }
  }

  const headCommit = commits.find((c) => commitIsHead(c.refs));
  const headBranches = headCommit ? extractBranchRefs(headCommit.refs) : [];
  return headBranches[0] ?? 'main';
}

/** Hashes on the trunk via first-parent walk from the newest trunk tip. */
export function buildMainlineSet(commits: GitCommitEntry[], trunkBranch: string): Set<string> {
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  const tip =
    commits.find((c) => commitIsHead(c.refs) && extractBranchRefs(c.refs).includes(trunkBranch)) ??
    commits.find((c) => extractBranchRefs(c.refs).includes(trunkBranch)) ??
    commits[0];

  const mainline = new Set<string>();
  let hash: string | undefined = tip?.hash;
  while (hash) {
    mainline.add(hash);
    hash = byHash.get(hash)?.parents[0];
  }
  return mainline;
}

/** Assign each commit a branch key and dot color. */
export function assignCommitVisuals(
  commits: GitCommitEntry[],
  trunkBranch = detectTrunkBranch(commits),
): CommitVisual[] {
  const mainline = buildMainlineSet(commits, trunkBranch);
  const assigned = new Map<string, string>();
  const branchColor = new Map<string, number>();
  let nextColor = 1;

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];

    const namedRefs = extractBranchRefs(commit.refs).filter((name) => name !== trunkBranch);
    if (namedRefs.length > 0) {
      assigned.set(commit.hash, namedRefs[0]);
      continue;
    }

    if (mainline.has(commit.hash)) {
      assigned.set(commit.hash, trunkBranch);
      continue;
    }

    if (i > 0) {
      const newer = commits[i - 1];
      const newerBranch = assigned.get(newer.hash);
      if (newerBranch && newerBranch !== trunkBranch && newer.parents.includes(commit.hash)) {
        assigned.set(commit.hash, newerBranch);
        continue;
      }
    }

    const parent = commit.parents[0];
    const parentBranch = parent ? assigned.get(parent) : undefined;
    if (parentBranch && parentBranch !== trunkBranch) {
      assigned.set(commit.hash, parentBranch);
      continue;
    }

    assigned.set(commit.hash, `detached:${commit.hash.slice(0, 7)}`);
  }

  return commits.map((commit) => {
    const branchKey = assigned.get(commit.hash) ?? trunkBranch;
    const isMain = branchKey === trunkBranch;

    if (!isMain && !branchColor.has(branchKey)) {
      branchColor.set(branchKey, nextColor++);
    }

    return {
      commit,
      branchKey,
      isMain,
      colorIndex: isMain ? 0 : (branchColor.get(branchKey) ?? 1),
      isHead: commitIsHead(commit.refs),
      lane: 0,
      rails: [],
      curves: [],
    };
  });
}

/** Squash-merge PR subjects: "PR title (#123)". */
const SQUASH_SUFFIX = /\s*\(#\d+\)$/;

/** Heuristic links from squash-merge commits to the branch they merged. */
export function computeSquashLinks(visuals: CommitVisual[]): Map<string, string> {
  const links = new Map<string, string>();
  const linkedBranches = new Set<string>();

  const branchBySubject = new Map<string, CommitVisual[]>();
  for (const visual of visuals) {
    if (visual.isMain) continue;
    const subject = visual.commit.subject.trim().toLowerCase();
    const list = branchBySubject.get(subject) ?? [];
    list.push(visual);
    branchBySubject.set(subject, list);
  }

  visuals.forEach((visual, index) => {
    if (!visual.isMain) return;
    const subject = visual.commit.subject.trim();
    if (!SQUASH_SUFFIX.test(subject)) return;

    const title = subject.replace(SQUASH_SUFFIX, '').trim().toLowerCase();
    for (const candidate of branchBySubject.get(title) ?? []) {
      if (linkedBranches.has(candidate.branchKey)) continue;
      const target = visuals.find(
        (v, i) => i > index && !v.isMain && v.branchKey === candidate.branchKey,
      );
      if (!target) continue;
      links.set(visual.commit.hash, target.commit.hash);
      linkedBranches.add(candidate.branchKey);
      break;
    }
  });

  return links;
}

interface ActiveLane {
  /** Parent hash this lane's edge is heading toward. */
  expecting: string;
  colorIndex: number;
}

/** Assign lanes and per-row rails/curves by walking commits in display order. */
export function computeGraphLayout(
  visuals: CommitVisual[],
  squashLinks: Map<string, string> = new Map(),
): CommitVisual[] {
  const lanes: (ActiveLane | null)[] = [];
  const colorByHash = new Map(visuals.map((v) => [v.commit.hash, v.colorIndex]));
  const isMainByHash = new Map(visuals.map((v) => [v.commit.hash, v.isMain]));

  const takeFreeLane = (): number => {
    const free = lanes.findIndex((l) => l === null);
    if (free >= 0) return free;
    lanes.push(null);
    return lanes.length - 1;
  };

  return visuals.map((visual) => {
    const { commit } = visual;
    const rails: GraphRail[] = [];
    const curves: GraphCurve[] = [];

    const matches: number[] = [];
    lanes.forEach((laneState, index) => {
      if (laneState?.expecting === commit.hash) matches.push(index);
    });

    let lane: number;
    if (matches.length > 0) {
      lane = matches[0];
      rails.push({ lane, colorIndex: lanes[lane]!.colorIndex, kind: 'up' });
      for (const other of matches.slice(1)) {
        curves.push({
          kind: 'in',
          fromLane: other,
          toLane: lane,
          colorIndex: lanes[other]!.colorIndex,
        });
        lanes[other] = null;
      }
    } else {
      lane = takeFreeLane();
    }

    lanes.forEach((laneState, index) => {
      if (laneState && index !== lane) {
        rails.push({ lane: index, colorIndex: laneState.colorIndex, kind: 'through' });
      }
    });

    const [firstParent, ...mergeParents] = commit.parents;
    if (firstParent) {
      const mainlineLane =
        !visual.isMain && isMainByHash.get(firstParent) === true
          ? lanes.findIndex((l) => l !== null && isMainByHash.get(l.expecting) === true)
          : -1;
      if (mainlineLane >= 0) {
        curves.push({
          kind: 'out',
          fromLane: lane,
          toLane: mainlineLane,
          colorIndex: visual.colorIndex,
          joins: true,
        });
        lanes[lane] = null;
      } else {
        lanes[lane] = { expecting: firstParent, colorIndex: visual.colorIndex };
        rails.push({ lane, colorIndex: visual.colorIndex, kind: 'down' });
      }
    } else {
      lanes[lane] = null;
    }

    const phantomParent = squashLinks.get(commit.hash);
    const outParents =
      phantomParent && !commit.parents.includes(phantomParent)
        ? [...mergeParents, phantomParent]
        : mergeParents;

    for (const parent of outParents) {
      const existing = lanes.findIndex((l) => l?.expecting === parent);
      if (existing >= 0) {
        curves.push({
          kind: 'out',
          fromLane: lane,
          toLane: existing,
          colorIndex: lanes[existing]!.colorIndex,
          joins: true,
        });
        continue;
      }
      const target = takeFreeLane();
      const colorIndex = colorByHash.get(parent) ?? visual.colorIndex;
      lanes[target] = { expecting: parent, colorIndex };
      curves.push({ kind: 'out', fromLane: lane, toLane: target, colorIndex });
    }

    return { ...visual, lane, rails, curves };
  });
}

/** Widest lane index one row touches (dot, rail, or curve). */
export function maxLaneIndexForRow(visual: CommitVisual): number {
  let max = visual.lane;
  for (const rail of visual.rails) max = Math.max(max, rail.lane);
  for (const curve of visual.curves) max = Math.max(max, curve.fromLane, curve.toLane);
  return max;
}

/** Widest lane index any row in the graph touches. */
export function maxLaneIndex(visuals: CommitVisual[]): number {
  let max = 0;
  for (const visual of visuals) {
    max = Math.max(max, maxLaneIndexForRow(visual));
  }
  return max;
}

/** Marker column width for one row: lanes used on this row plus collapsed sub-dots. */
export function graphMarkerWidthPx(
  visual: CommitVisual,
  step: number,
  clusters: BranchCluster[] = [],
  extraCount = 0,
): number {
  const laneWidth = Math.max(LANE_STEP, step * (maxLaneIndexForRow(visual) + 1));
  if (clusters.length === 0 && !extraCount) return laneWidth;
  const subdotWidth =
    LANE_STEP +
    (clusters.length > 0 ? 4 + clusters.length * SUBDOT_STEP : 0) +
    (extraCount ? 16 : 0);
  return Math.max(laneWidth, subdotWidth);
}

/** Collapsed view model: mainline rows with branch commits clustered onto the mainline commit that squash-merged them (via squashLinks), falling back to the mainline commit their first-parent chain forks from. */
export function computeCollapsedRows(
  visuals: CommitVisual[],
  squashLinks: Map<string, string> = new Map(),
): CollapsedRow[] {
  const byHash = new Map(visuals.map((v) => [v.commit.hash, v]));
  const clustersByBase = new Map<string, Map<string, BranchCluster>>();

  const squashBaseByBranch = new Map<string, string>();
  for (const [squashHash, branchHash] of squashLinks) {
    const branchVisual = byHash.get(branchHash);
    if (branchVisual) squashBaseByBranch.set(branchVisual.branchKey, squashHash);
  }

  for (const visual of visuals) {
    if (visual.isMain) continue;

    let base: string | null = squashBaseByBranch.get(visual.branchKey) ?? null;

    let cursor = base ? null : visual.commit.parents[0];
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const node = byHash.get(cursor);
      if (!node) break;
      if (node.isMain) {
        base = cursor;
        break;
      }
      cursor = node.commit.parents[0];
    }
    if (!base) continue;

    let clusters = clustersByBase.get(base);
    if (!clusters) {
      clusters = new Map();
      clustersByBase.set(base, clusters);
    }
    const cluster = clusters.get(visual.branchKey) ?? {
      branchKey: visual.branchKey,
      colorIndex: visual.colorIndex,
      count: 0,
      hasHead: false,
    };
    cluster.count += 1;
    cluster.hasHead = cluster.hasHead || visual.isHead;
    clusters.set(visual.branchKey, cluster);
  }

  return visuals
    .filter((visual) => visual.isMain)
    .map((visual) => {
      const all = [...(clustersByBase.get(visual.commit.hash)?.values() ?? [])];
      const clusters = all.slice(0, MAX_SUBDOTS);
      const extraCount = all
        .slice(MAX_SUBDOTS)
        .reduce((total, cluster) => total + cluster.count, 0);
      return { visual, clusters, extraCount };
    });
}

/** Collapsed history: one vertical lane on the mainline only. */
export function computeCollapsedMainlineLayout(visuals: CommitVisual[]): CommitVisual[] {
  const count = visuals.length;
  if (count === 0) return [];

  return visuals.map((visual, index) => {
    const rails: GraphRail[] = [];
    const colorIndex = visual.colorIndex;

    if (count > 1) {
      if (index === 0) {
        rails.push({ lane: 0, colorIndex, kind: 'down' });
      } else if (index === count - 1) {
        rails.push({ lane: 0, colorIndex, kind: 'up' });
      } else {
        rails.push({ lane: 0, colorIndex, kind: 'through' });
      }
    }

    return { ...visual, lane: 0, rails, curves: [] };
  });
}

// ── Geometry ─────────────────────────────────────────────────────────────────

/** Lane center spacing; shrinks when the graph is wider than MAX_FULL_LANES. */
function laneStep(laneCount: number): number {
  if (laneCount <= MAX_FULL_LANES) return LANE_STEP;
  return (MAX_FULL_LANES * LANE_STEP) / laneCount;
}

function laneX(lane: number, step: number): number {
  return lane * step + step / 2;
}

function branchColorVar(colorIndex: number): string {
  if (colorIndex === 0) return 'var(--mn-accent)';
  return `var(--git-lane-${((colorIndex - 1) % BRANCH_COLORS) + 1})`;
}

function renderRefChip(ref: string, colorIndex: number): HTMLElement {
  const chip = document.createElement('span');
  chip.className = 'git-graph__ref-chip';
  chip.textContent = ref.replace(/^HEAD -> /, '');
  chip.title = ref;
  chip.style.setProperty('--branch-color', branchColorVar(colorIndex));
  return chip;
}

function svgLine(x: number, y1: string, y2: string, colorIndex: number): SVGLineElement {
  const line = document.createElementNS(SVG_NS, 'line');
  line.setAttribute('x1', String(x));
  line.setAttribute('x2', String(x));
  line.setAttribute('y1', y1);
  line.setAttribute('y2', y2);
  line.style.stroke = branchColorVar(colorIndex);
  return line;
}

function appendRail(svg: SVGSVGElement, rail: GraphRail, step: number): void {
  const x = laneX(rail.lane, step);
  const y1 = rail.kind === 'down' ? String(DOT_CENTER_Y) : '0';
  const y2 = rail.kind === 'up' ? String(DOT_CENTER_Y) : '100%';
  svg.appendChild(svgLine(x, y1, y2, rail.colorIndex));
}

function appendCurve(svg: SVGSVGElement, curve: GraphCurve, step: number): void {
  const from = laneX(curve.fromLane, step);
  const to = laneX(curve.toLane, step);
  const path = document.createElementNS(SVG_NS, 'path');

  if (curve.kind === 'in') {
    path.setAttribute('d', `M ${from} 0 Q ${from} ${DOT_CENTER_Y} ${to} ${DOT_CENTER_Y}`);
  } else {
    const endY = curve.joins ? DOT_CENTER_Y : DOT_CENTER_Y + CURVE_DROP;
    path.setAttribute('d', `M ${from} ${DOT_CENTER_Y} Q ${to} ${DOT_CENTER_Y} ${to} ${endY}`);
    if (!curve.joins) {
      svg.appendChild(svgLine(to, String(DOT_CENTER_Y + CURVE_DROP), '100%', curve.colorIndex));
    }
  }

  path.style.stroke = branchColorVar(curve.colorIndex);
  svg.appendChild(path);
}

// ── Rows ─────────────────────────────────────────────────────────────────────

function renderRails(visual: CommitVisual, step: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'git-graph__rails');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute('aria-hidden', 'true');

  for (const rail of visual.rails) appendRail(svg, rail, step);
  for (const curve of visual.curves) appendCurve(svg, curve, step);
  return svg;
}

interface RowContext {
  onSelect?: (sha: string) => void;
  selectedSha?: string | null;
  onContextMenu?: (visual: CommitVisual, event: MouseEvent) => void;
  /** Collapsed view: branch clusters shown as sub-dots after the main dot. */
  clusters?: BranchCluster[];
  extraCount?: number;
  /** Collapsed view: invoked when a sub-dot is clicked. */
  onExpand?: () => void;
}

function appendSubdots(marker: HTMLElement, ctx: RowContext): void {
  const clusters = ctx.clusters ?? [];
  const baseX = LANE_STEP + 4;

  clusters.forEach((cluster, index) => {
    const sub = document.createElement('span');
    sub.className = 'git-graph__subdot';
    if (cluster.hasHead) sub.classList.add('git-graph__subdot--head');
    sub.style.setProperty('--branch-color', branchColorVar(cluster.colorIndex));
    sub.style.setProperty('--git-dot-x', `${baseX + index * SUBDOT_STEP + 2.5}px`);
    sub.title = `${cluster.branchKey} — ${cluster.count} commit${cluster.count === 1 ? '' : 's'} (click to expand)`;
    if (ctx.onExpand) {
      sub.addEventListener('click', (e) => {
        e.stopPropagation();
        ctx.onExpand?.();
      });
    }
    marker.appendChild(sub);
  });

  if (ctx.extraCount) {
    const more = document.createElement('span');
    more.className = 'git-graph__subdot-more';
    more.textContent = `+${ctx.extraCount}`;
    more.style.setProperty('--git-dot-x', `${baseX + clusters.length * SUBDOT_STEP}px`);
    more.title = `${ctx.extraCount} more branch commit${ctx.extraCount === 1 ? '' : 's'} (click to expand)`;
    if (ctx.onExpand) {
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        ctx.onExpand?.();
      });
    }
    marker.appendChild(more);
  }
}

function renderRow(visual: CommitVisual, step: number, ctx: RowContext): HTMLElement {
  const row = document.createElement('div');
  row.className = 'git-graph__row';
  if (!visual.isMain) row.classList.add('git-graph__row--branch');
  if (
    ctx.selectedSha &&
    (visual.commit.hash === ctx.selectedSha || visual.commit.hash.startsWith(ctx.selectedSha))
  ) {
    row.classList.add('git-graph__row--selected');
  }
  row.dataset.sha = visual.commit.hash;
  // Shortcodes in the stored subject stay in git; the row shows the glyph.
  const subjectText = expandGitmojiShortcodes(visual.commit.subject);
  row.title = `${subjectText} (${visual.branchKey})`;

  const onSelect = ctx.onSelect;
  if (onSelect) {
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.addEventListener('click', () => onSelect(visual.commit.hash));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect(visual.commit.hash);
      }
    });
  }

  if (ctx.onContextMenu) {
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      ctx.onContextMenu?.(visual, e);
    });
  }

  const dot = document.createElement('span');
  dot.className = 'git-graph__dot';
  dot.setAttribute('aria-hidden', 'true');
  if (visual.isMain) dot.classList.add('git-graph__dot--main');
  else dot.classList.add('git-graph__dot--branch');
  if (visual.isHead) dot.classList.add('git-graph__dot--head');
  dot.style.setProperty('--branch-color', branchColorVar(visual.colorIndex));
  dot.style.setProperty('--git-dot-x', `${laneX(visual.lane, step)}px`);

  const body = document.createElement('div');
  body.className = 'git-graph__body';

  const marker = document.createElement('div');
  marker.className = 'git-graph__marker';
  marker.style.setProperty(
    '--git-marker-w',
    `${graphMarkerWidthPx(visual, step, ctx.clusters ?? [], ctx.extraCount ?? 0)}px`,
  );

  if (visual.rails.length > 0 || visual.curves.length > 0) {
    marker.appendChild(renderRails(visual, step));
  }
  marker.appendChild(dot);
  appendSubdots(marker, ctx);

  const content = document.createElement('div');
  content.className = 'git-graph__content';

  const subject = document.createElement('span');
  subject.className = 'git-graph__subject';
  subject.textContent = subjectText;

  const meta = document.createElement('div');
  meta.className = 'git-graph__meta';

  const author = document.createElement('span');
  author.className = 'git-graph__author';
  author.textContent = visual.commit.author;

  const time = document.createElement('span');
  time.className = 'git-graph__time';
  time.textContent = visual.commit.relativeTime;

  meta.append(author, time);

  if (visual.commit.refs.length > 0) {
    const refsEl = document.createElement('div');
    refsEl.className = 'git-graph__refs';
    for (const ref of visual.commit.refs) {
      refsEl.appendChild(renderRefChip(ref, visual.colorIndex));
    }
    content.append(subject, meta, refsEl);
  } else {
    content.append(subject, meta);
  }

  row.append(body);
  body.append(marker, content);
  return row;
}

function renderToggleRow(
  collapsed: boolean,
  hiddenCount: number,
  onToggle: () => void,
): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'git-graph__toggle';
  btn.setAttribute('aria-expanded', String(!collapsed));

  const chevron = document.createElement('span');
  chevron.className = 'git-graph__toggle-chevron';
  chevron.textContent = collapsed ? '▸' : '▾';

  const label = document.createElement('span');
  label.textContent = collapsed
    ? `${hiddenCount} branch commit${hiddenCount === 1 ? '' : 's'} hidden`
    : 'Collapse branch graph';

  btn.append(chevron, label);
  btn.addEventListener('click', onToggle);
  return btn;
}

// ── Prefs ────────────────────────────────────────────────────────────────────

function loadCollapsedPref(): boolean {
  try {
    return (globalThis.localStorage?.getItem(COLLAPSED_PREF_KEY) ?? '1') === '1';
  } catch {
    return true;
  }
}

function saveCollapsedPref(collapsed: boolean): void {
  try {
    globalThis.localStorage?.setItem(COLLAPSED_PREF_KEY, collapsed ? '1' : '0');
  } catch {
  }
}

function renderEmpty(host: HTMLElement, message: string): void {
  host.className = 'git-graph git-panel-graph-mount';
  host.replaceChildren();
  const empty = document.createElement('p');
  empty.className = 'git-graph__empty';
  empty.textContent = message;
  host.appendChild(empty);
}

// ── Render ───────────────────────────────────────────────────────────────────

function appendExpandedRows(
  list: HTMLElement,
  visuals: CommitVisual[],
  squashLinks: Map<string, string>,
  ctx: RowContext,
): void {
  const laidOut = computeGraphLayout(visuals, squashLinks);
  const laneCount = maxLaneIndex(laidOut) + 1;
  const step = laneStep(laneCount);

  for (const visual of laidOut) {
    list.appendChild(renderRow(visual, step, ctx));
  }
}

function appendCollapsedRows(
  list: HTMLElement,
  visuals: CommitVisual[],
  squashLinks: Map<string, string>,
  ctx: RowContext,
  onExpand: () => void,
): void {
  const rows = computeCollapsedRows(visuals, squashLinks);
  if (rows.length === 0) {
    appendExpandedRows(list, visuals, squashLinks, ctx);
    return;
  }

  const laidOut = computeCollapsedMainlineLayout(rows.map(({ visual }) => visual));

  laidOut.forEach((visual, index) => {
    const { clusters, extraCount } = rows[index];
    const restored = { ...visual, commit: rows[index].visual.commit };
    list.appendChild(
      renderRow(restored, LANE_STEP, { ...ctx, clusters, extraCount, onExpand }),
    );
  });
}

function renderGraph(
  host: HTMLElement,
  visuals: CommitVisual[],
  collapsed: boolean,
  onToggle: () => void,
  ctx: RowContext,
): void {
  host.className = 'git-graph git-panel-graph-mount';
  host.replaceChildren();

  const list = document.createElement('div');
  list.className = 'git-graph__list';

  const squashLinks = computeSquashLinks(visuals);
  const branchCommitCount = visuals.filter((visual) => !visual.isMain).length;
  if (branchCommitCount > 0) {
    list.appendChild(renderToggleRow(collapsed, branchCommitCount, onToggle));
  }

  if (collapsed && branchCommitCount > 0) {
    appendCollapsedRows(list, visuals, squashLinks, ctx, onToggle);
  } else {
    appendExpandedRows(list, visuals, squashLinks, ctx);
  }

  host.appendChild(list);
}

/** Render commit history into `host`. */
export function renderGitGraph(
  host: HTMLElement,
  options: GitGraphOptions = {},
): GitGraphHandle {
  let destroyed = false;
  let commits: GitCommitEntry[] = [];
  let collapsed = loadCollapsedPref();

  const rerender = (): void => {
    if (destroyed) return;
    if (commits.length === 0) {
      renderEmpty(host, 'No commits');
      return;
    }
    renderGraph(host, assignCommitVisuals(commits), collapsed, toggle, {
      onSelect: options.onSelectCommit,
      selectedSha: options.selectedSha,
      onContextMenu: options.onContextMenu,
    });
  };

  const toggle = (): void => {
    collapsed = !collapsed;
    saveCollapsedPref(collapsed);
    rerender();
  };

  const refresh = async (): Promise<void> => {
    if (destroyed) return;

    const count = options.logCount ?? LOG_COUNT;
    const result = await gitLog({ count, cwd: options.cwd });
    if (destroyed) return;
    if (!result.ok) {
      renderEmpty(host, result.error ?? 'Could not load history');
      return;
    }

    commits = result.commits ?? [];
    rerender();
  };

  const destroy = (): void => {
    destroyed = true;
    host.replaceChildren();
    host.className = '';
  };

  void refresh();

  return { refresh, destroy };
}
