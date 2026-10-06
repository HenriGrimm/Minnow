/**
 * Brain wiki + code index API types (MIN-B5 / MIN-B8).
 */

/** Page metadata from catalog.json / readPage. */
export interface BrainPageMeta {
  id: string;
  title: string;
  path: string;
  folder: string;
  slug: string;
  tags: string[];
  source: string;
  summary: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  links: string[];
  /** Archive similarity neighbors (from frontmatter similarTo). */
  similarTo?: string[];
  status?: string;
}

/** Full page payload from GET /api/brain/page. */
export interface BrainPage {
  meta: BrainPageMeta;
  body: string;
  path: string;
  /** Hash of the complete saved Markdown source for conditional updates. */
  revision?: string;
}

/** Leaf node in GET /api/brain/tree. */
export interface BrainTreePageNode extends BrainPageMeta {
  type: 'page';
}

/** Folder node in the page tree. */
export interface BrainTreeFolderNode {
  type: 'folder';
  children: Record<string, BrainTreeNode>;
}

export type BrainTreeNode = BrainTreePageNode | BrainTreeFolderNode;

/** Server status from GET /api/brain/status. */
export interface BrainStatus {
  enabled: boolean;
  pageCount: number;
  home: string;
  brainDir: string;
}

/** POST /api/brain/ingest result. */
export interface BrainIngestResult {
  sourcePath: string;
  pages: string[];
}

/** POST /api/brain/lint health report. */
export interface BrainLintReport {
  generatedAt: string;
  pageCount: number;
  orphans: Array<{ path: string; title: string; status?: string }>;
  stale: Array<{ path: string; title: string; status?: string }>;
  anchorDrift?: Array<{
    path: string;
    title: string;
    symbolIds: string[];
    summary: string;
  }>;
  missingLinks: Array<{ from: string; target: string; summary: string }>;
  contradictions: Array<{ pages: string[]; summary: string }>;
  embeddingsEnabled: boolean;
  applied?: Array<{ path: string; action: string }>;
}

/** POST /api/brain/prune-links result — weak `similarTo` edge cleanup. */
export interface BrainPruneLinksReport {
  generatedAt: string;
  dryRun: boolean;
  pagesScanned: number;
  edgesScanned: number;
  removals: Array<{ path: string; dropped: string[]; kept: string[] }>;
  applied: string[];
}

/** Structured counts / actions in a cleanup plan summary. */
export interface BrainCleanupPlanSummary {
  deletes: Array<{ path: string; reason: string }>;
  merges: Array<{ from: string[]; into: string; reason: string }>;
  linkFixes: Array<{
    from: string;
    target: string;
    suggestion?: string;
    reason: string;
  }>;
  staleActions: Array<{ path: string; action: string; reason: string }>;
  anchorDrift: Array<{
    path: string;
    symbolIds: string[];
    action: string;
    reason: string;
  }>;
  risks: Array<{ summary: string; mitigation?: string }>;
}

/** LLM cleanup plan payload (planVersion 1). */
export interface BrainCleanupPlan {
  planVersion: 1;
  planMarkdown: string;
  summary: BrainCleanupPlanSummary;
}

/** POST /api/brain/cleanup/plan result. */
export interface BrainCleanupPlanResult {
  planId: string;
  createdAt: string;
  snapshotHash: string;
  diagnostics: BrainLintReport & {
    weakSimilarLinks?: {
      dryRun: boolean;
      pagesScanned: number;
      edgesScanned: number;
      removals: BrainPruneLinksReport['removals'];
    };
    definitions?: { orphans?: string };
  };
  plan: BrainCleanupPlan;
}

/** Action counts for confirm dialogs (derived from {@link BrainCleanupPlanSummary}). */
export interface BrainCleanupPlanSummaryCounts {
  deletes: number;
  merges: number;
  linkFixes: number;
  staleActions: number;
  anchorDrift: number;
  risks: number;
}

/** Flat plan payload used by the Brain lint UI. */
export interface BrainCleanupPlanResponse {
  planId: string;
  planMarkdown: string;
  planVersion: number;
  summary: BrainCleanupPlanSummaryCounts;
  createdAt?: string;
  snapshotHash?: string;
}

/** One line in POST /api/brain/cleanup/execute log. */
export interface BrainCleanupExecuteLogEntry {
  message: string;
  tool?: string;
  path?: string;
}

/** POST /api/brain/cleanup/execute result. */
export interface BrainCleanupExecuteResult {
  ok: boolean;
  log: BrainCleanupExecuteLogEntry[];
  result?: string;
  error?: string;
}

/** GET /api/brain/usage — weekly read/write counters, newest bucket in `thisWeek`. */
export interface BrainUsageReport {
  week: string;
  thisWeek: Partial<
    Record<'agent-read' | 'agent-write' | 'synthesis-write' | 'proposal-accepted', number>
  >;
  weeks: Record<string, Record<string, number>>;
}

/** When to trigger background reindex (automation wired in MIN-B10). */
export type BrainCodeReindexCadence = 'on-demand' | 'on-switch' | 'git-hook';

/** config.brain.code settings. */
export interface BrainCodeConfig {
  enabled: boolean;
  includeGlobs: string[];
  excludeGlobs: string[];
  repoMapTokenBudget: number;
  /** Per-send code-map injection cap (injection profile on server). */
  repoMapInjectionTokenBudget: number;
  reindexCadence: BrainCodeReindexCadence;
  codeEmbeddingsEnabled: boolean;
  /** Write .minnow/jsconfig.json when JS/TS sources lack ts/js config. */
  autoScaffoldIndexConfig: boolean;
}

/** One file the indexer could not process (usually a missing language server). */
export interface BrainCodeIndexError {
  file: string;
  error: string;
}

/** Per-file errors grouped by message shape, so N identical failures read as one row. */
export interface BrainCodeIndexErrorGroup {
  message: string;
  count: number;
  sample: string;
}

/** Outcome of the most recent reindex job, replayed through the status endpoint. */
export interface BrainCodeIndexRun {
  startedAt: string;
  finishedAt: string | null;
  running: boolean;
  ok: boolean | null;
  error?: string;
  indexedFiles?: number;
  filesProcessed?: number;
  failedFiles?: number;
  /** Symbols parsed this pass (sums per-file counts; ids collapse across files). */
  symbolsIndexed?: number;
  /** Distinct symbol rows the index holds for this repo after the pass. */
  symbolCount?: number;
  /** Rows PageRank actually updated — 0 here means ranking silently did nothing. */
  rankedSymbols?: number;
  edgesIndexed?: number;
  errors?: BrainCodeIndexError[];
  errorSummary?: BrainCodeIndexErrorGroup[];
  usageAugmentError?: string;
  skipped?: boolean;
  reason?: string;
  scaffold?: {
    created: boolean;
    path?: string;
    skipped?: boolean;
    reason?: string;
  };
}

/** GET /api/brain/code/status. */
export interface BrainCodeStatus extends BrainCodeConfig {
  repo: string;
  symbolCount: number;
  edgeCount: number;
  fileCount: number;
  lastIndexedAt: string | null;
  indexing?: boolean;
  filesDone?: number;
  filesTotal?: number;
  phase?: string;
  lastRun?: BrainCodeIndexRun;
}

/** Symbol row from find_symbol / graph queries. */
export interface BrainCodeSymbolMatch {
  id: string;
  repo: string;
  kind: string;
  name: string;
  file: string;
  line_start: number;
  line_end: number;
  signature: string;
  /** Doc comment captured at index time (full rows only). */
  doc?: string;
  source?: string;
}

/** GET/POST /api/brain/code/find-symbol. */
export interface BrainCodeFindResult {
  matches: BrainCodeSymbolMatch[];
  error?: string;
}

/** One structured row in the repo map (UI navigation). */
export type BrainCodeRepoMapEntry =
  | { type: 'title'; text: string }
  | { type: 'file'; file: string; text: string }
  | { type: 'symbol'; symbolId: string; file: string; text: string }
  | { type: 'truncated'; text: string }
  | { type: 'message'; text: string };

/** GET/POST /api/brain/code/repo-map. */
export interface BrainCodeRepoMap {
  text: string;
  truncated: boolean;
  tokenEstimate: number;
  /** Structured rows with symbol ids for clickable UI navigation. */
  entries?: BrainCodeRepoMapEntry[];
}

/** Edge endpoint in who_calls / calls_of. */
export interface BrainCodeSymbolRef {
  symbolId: string;
  name: string;
  file: string;
  line: number;
  signature: string;
  kind: string;
}

/** GET/POST /api/brain/code/who-calls. */
export interface BrainCodeWhoCallsResult {
  symbol: BrainCodeSymbolMatch | null;
  callers: BrainCodeSymbolRef[];
  error?: string;
}

/** GET/POST /api/brain/code/calls-of. */
export interface BrainCodeCallsOfResult {
  symbol: BrainCodeSymbolMatch | null;
  callees: BrainCodeSymbolRef[];
  error?: string;
}

/** GET/POST /api/brain/code/read-symbol. */
export interface BrainCodeReadSymbolResult {
  symbol: BrainCodeSymbolMatch | null;
  text: string;
  error?: string;
}

/** GET /api/brain/code/git-hook/status. */
export interface BrainCodeGitHookStatus {
  hookPath: string;
  installed: boolean;
  isGitRepo?: boolean;
  scriptPath: string;
}

/** POST /api/brain/code/git-hook/install. */
export interface BrainCodeGitHookInstallResult {
  ok?: boolean;
  installed?: boolean;
  hookPath?: string;
  alreadyPresent?: boolean;
  error?: string;
}

/**
 * POST /api/brain/code/reindex — 202 acknowledgement only. The job runs in the background;
 * poll /api/brain/code/status and read `lastRun` for the outcome.
 */
export interface BrainCodeReindexResult {
  ok: boolean;
  repo: string;
  started: boolean;
  alreadyRunning?: boolean;
  startedAt?: string;
  run?: BrainCodeIndexRun | null;
}

/** Wiki page anchored to a symbol (surfaced by read_symbol). */
export interface BrainCodeExplainPage {
  pageId: string;
  path: string;
  title: string;
  summary: string;
  status?: string;
  symbolId: string;
  symbolHashAtSynth?: string;
}

/** GET/POST /api/brain/code/explain. */
export interface BrainCodeExplainResult {
  symbolId?: string;
  pages: BrainCodeExplainPage[];
  error?: string;
}

/** Top-level folder (a layer) in the code map architecture view. */
export interface CodeMapGroup {
  id: string;
  path: string;
  name: string;
  test: boolean;
  files: number;
  symbols: number;
}

/** Child folder of a layer (or a layer's loose files) in the architecture view. */
export interface CodeMapModule {
  id: string;
  group: string;
  path: string;
  name: string;
  /** Files sitting directly in the group folder rather than a subfolder. */
  loose: boolean;
  test: boolean;
  files: number;
  symbols: number;
  lines: number;
}

/** Call count from one node to another, rolled up from symbol call edges. */
export interface CodeMapEdge {
  src: string;
  dst: string;
  n: number;
}

/** Third-party package and the modules that import it (file counts). */
export interface CodeMapExternal {
  name: string;
  files: number;
  testFiles: number;
  modules: Record<string, number>;
}

/** GET /api/brain/code/map/architecture. */
export interface CodeMapArchitecture {
  repo: string;
  base: string;
  fileCount: number;
  symbolCount: number;
  groups: CodeMapGroup[];
  modules: CodeMapModule[];
  edges: CodeMapEdge[];
  externals: CodeMapExternal[];
}

export interface CodeMapFolderNode {
  id: string;
  kind: 'file' | 'folder';
  path: string;
  name: string;
  symbols: number;
  lines: number;
  files: number;
  /** Calls arriving from outside the folder. */
  outside: number;
  callsIn: number;
  callsOut: number;
}

export interface CodeMapPathCount {
  path: string;
  n: number;
}

/** GET /api/brain/code/map/folder. */
export interface CodeMapFolder {
  path: string;
  nodes: CodeMapFolderNode[];
  edges: CodeMapEdge[];
  hidden: Array<{ id: string; name: string; kind: 'file' | 'folder' }>;
  calledFrom: CodeMapPathCount[];
  callsInto: CodeMapPathCount[];
  summary: { text: string; source: string } | null;
}

export interface CodeMapFileSymbol {
  id: string;
  name: string;
  kind: string;
  line: number;
  lineEnd: number;
  signature: string;
  doc: string;
  rank: number;
  usage: number;
  /** Nesting depth from line ranges; 0 = top level. */
  depth: number;
}

/** GET /api/brain/code/map/file. */
export interface CodeMapFileDetail {
  path: string;
  lines: number;
  symbolCount: number;
  summary: string;
  symbols: CodeMapFileSymbol[];
  callers: CodeMapPathCount[];
  callees: CodeMapPathCount[];
  callerCount: number;
  calleeCount: number;
  error?: string;
}

/** GET /api/brain/code/map/search. */
export interface CodeMapPathHit {
  path: string;
  kind: 'file' | 'folder';
}
