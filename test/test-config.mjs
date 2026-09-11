/**
 * Test runner profiles, path-based runner overrides, scoped suites, and exclusions.
 * Used by test/run-all.mjs and test/check-test-coverage.mjs.
 */

import { availableParallelism } from 'node:os';

/** @typedef {'node' | 'tsx-mocks' | 'tsx-mocks-loader' | 'node-tsx'} RunnerId */

/** Full parallelism (~31 workers on a 32-core box) exhausted system RAM; cap it. */
export const MAX_TEST_CONCURRENCY = 26;

/** Resolve node:test worker count (env override or capped availableParallelism). */
export function resolveTestConcurrency() {
  const raw = process.env.MINNOW_TEST_CONCURRENCY;
  if (raw) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return Math.max(1, Math.min(MAX_TEST_CONCURRENCY, availableParallelism()));
}

/**
 * Preload applied by every runner. Stops node:assert from inspecting/diffing a
 * happy-dom node on a failed assertion — that path allocates unbounded typed
 * arrays synchronously and takes the whole machine down. See the module header.
 */
export const ASSERT_GUARD_IMPORT = ['--import', './test/assert-dom-safe.mjs'];

/** How each runner invokes node:test. */
export const RUNNERS = {
  node: {
    command: 'node',
    prefixArgs: [
      ...ASSERT_GUARD_IMPORT,
      '--test',
      '--test-force-exit',
      '--test-timeout=120000',
    ],
  },
  'tsx-mocks': {
    command: 'node',
    prefixArgs: [
      '--experimental-test-module-mocks',
      '--import',
      'tsx',
      ...ASSERT_GUARD_IMPORT,
      '--test',
      '--test-force-exit',
      '--test-timeout=120000',
    ],
  },
  // Registers test-loader.mjs's CSS/@xterm stubs (--import composes with tsx
  // and --experimental-test-module-mocks). Avoid node_modules/tsx/dist/cli.mjs —
  // that wrapper respawns node and silently drops --experimental-test-module-mocks.
  'tsx-mocks-loader': {
    command: 'node',
    prefixArgs: [
      '--experimental-test-module-mocks',
      '--import',
      'tsx',
      '--import',
      './test/test-loader.mjs',
      ...ASSERT_GUARD_IMPORT,
      '--test',
      '--test-force-exit',
      '--test-timeout=120000',
    ],
  },
  'node-tsx': {
    command: 'node',
    prefixArgs: [
      '--import',
      'tsx',
      '--import',
      './test/test-loader.mjs',
      ...ASSERT_GUARD_IMPORT,
      '--test',
      '--test-force-exit',
      '--test-timeout=120000',
    ],
  },
};

/** Default runner when no path rule matches. */
export const DEFAULT_RUNNER_BY_EXT = {
  '.test.js': 'node',
  // .mjs suites often import ../../src/*.ts; plain node cannot resolve TS dependency chains.
  '.test.mjs': 'tsx-mocks-loader',
  '.test.ts': 'tsx-mocks-loader',
  '.test.mts': 'tsx-mocks-loader',
};

/**
 * Path-specific runner overrides (first match wins).
 * Patterns use forward slashes and support `*` / `**` globs via fs.globSync.
 */
export const PATH_RUNNER_RULES = [
  // Orchestrator V2. The core is plain .js + .d.ts because the server ships
  // untranspiled; running these on bare `node` is part of the assertion.
  { pattern: 'test/orchestrator/**/*.test.mjs', runner: 'node' },
  // Shared runner package (MIN-698). Plain node — same untranspiled contract as the core.
  { pattern: 'test/runner/**/*.test.mjs', runner: 'node' },
  { pattern: 'test/headless/preflight.test.mts', runner: 'node-tsx' },
  // persist-chat imports server config helpers + headless TS (no CSS).
  { pattern: 'test/headless/persist-chat.test.mts', runner: 'node-tsx' },
  { pattern: 'test/headless/sampler.test.mts', runner: 'node-tsx' },
  { pattern: 'test/sub-agents/scheduler-drain-reject.test.mts', runner: 'tsx-mocks' },
  { pattern: 'test/research/*.test.mts', runner: 'tsx-mocks-loader' },
  // Parity imports src/state/sessions.ts (CSS/@xterm via UI); other config tests stay on tsx-mocks.
  { pattern: 'test/config/session-shape-parity.test.js', runner: 'tsx-mocks-loader' },
  { pattern: 'test/config/*.test.js', runner: 'tsx-mocks' },
  { pattern: 'test/providers/fetch-chat-shim.test.mjs', runner: 'tsx-mocks' },
  // Both use mock.module and transitively pull in UI code that imports CSS.
  { pattern: 'test/ui/orchestrate-plan-screen.test.mts', runner: 'tsx-mocks-loader' },
  { pattern: 'test/ui/settings-layout-links.test.mjs', runner: 'tsx-mocks-loader' },
  { pattern: 'test/server/**/*.test.mjs', runner: 'tsx-mocks' },
  { pattern: 'test/brain/synthesis-run-route.test.mjs', runner: 'tsx-mocks' },
  { pattern: 'test/workspace/*.test.js', runner: 'tsx-mocks' },
  { pattern: 'test/terminal/shell-profiles.test.mjs', runner: 'tsx-mocks' },
  { pattern: 'test/terminal/pty-protocol.test.mjs', runner: 'tsx-mocks' },
  { pattern: 'test/terminal/sandbox/*.test.mjs', runner: 'tsx-mocks' },
  // mock.module wraps profiles.js / gguf-metadata.js + llama-args.js (Phase 1a GGUF plumbing).
  { pattern: 'test/models/llama-args-gguf-meta.test.mjs', runner: 'tsx-mocks' },
  { pattern: 'test/models/serve-gguf-meta.test.mjs', runner: 'tsx-mocks' },
  { pattern: 'test/models/mlx-serve.test.mjs', runner: 'tsx-mocks' },
  { pattern: 'test/models/mlx-serve-crash.test.mjs', runner: 'tsx-mocks' },
  { pattern: 'test/models/serve-crash.test.mjs', runner: 'tsx-mocks' },
  { pattern: 'test/models/serve-heartbeat.test.mjs', runner: 'tsx-mocks' },
  { pattern: 'test/models/serve-residency.test.mjs', runner: 'tsx-mocks' },
  { pattern: 'test/models/admit-serve.test.mjs', runner: 'node' },
  { pattern: 'test/providers/local-completion-admission.test.mjs', runner: 'tsx-mocks' },
  { pattern: 'test/settings/**', runner: 'node-tsx' },
];

/**
 * Test files that exist on disk but are not node:test modules.
 * They are excluded from npm test and orphan detection.
 */
export const EXCLUDED_TESTS = [
  {
    path: 'test/product-wiki/product-wiki.test.mjs',
    reason: 'catalog + manual copy gate (use npm run test:product-wiki; CI job product wiki)',
  },
  {
    path: 'test/terminal/pty-session.test.mjs',
    reason: 'integration script (requires live server; use npm run test:terminal-pty)',
  },
  {
    path: 'test/terminal-stream.test.mjs',
    reason: 'integration script (requires live server)',
  },
];

/**
 * Scoped suites for `npm run test:<area>` — patterns relative to repo root.
 * `post` runs after discovered tests (e.g. smoke scripts).
 */
export const SCOPED_SUITES = {
  skills: {
    patterns: [
      'test/skills-loader.test.ts',
      'test/skills/**/*.test.mts',
      'test/skills-matt-pocock.test.mjs',
      'test/skills-library-registry.test.mts',
      'test/skills-library-index.test.mjs',
      'test/skills-library-index-files.test.mts',
      'test/skills/library-api.test.mjs',
      'test/skills/library-client.test.mjs',
    ],
  },
  attachments: {
    patterns: [
      'test/attachments/**/*.test.mjs',
      'test/attachments/**/*.test.mts',
      'test/attachments/**/*.test.ts',
      'test/server/read-document.test.mjs',
      'test/server/read-file-document.test.mjs',
      'test/server/binary-sniff.test.mjs',
      'test/server/create-document.test.mjs',
      'test/server/document-html.test.mjs',
      'test/workspace-ref.test.ts',
      'test/workspace-path-composer.test.mts',
    ],
  },
  'skills-impeccable': {
    patterns: ['test/skills-impeccable.test.mjs'],
  },
  impeccable: {
    patterns: ['test/impeccable/**/*.test.mjs', 'test/skills/impeccable-client.test.mts'],
  },
  notifications: {
    patterns: ['test/notifications/**/*.test.mjs'],
  },
  memory: {
    patterns: ['test/memory/**/*.test.mjs'],
  },
  brain: {
    patterns: ['test/brain/**/*.test.mjs', 'test/brain/**/*.test.mts'],
  },
  'product-wiki': {
    patterns: ['test/product-wiki/**/*.test.mjs'],
  },
  settings: {
    patterns: ['test/settings/**/*.test.mjs', 'test/settings/**/*.test.mts'],
  },
  engine: {
    patterns: ['test/engine/**/*.test.mjs'],
  },
  lsp: {
    patterns: ['test/lsp/**/*.test.mjs'],
  },
  mcp: {
    patterns: ['test/mcp/**/*.test.mjs'],
  },
  research: {
    patterns: ['test/research/**/*.test.mjs', 'test/research/**/*.test.mts'],
  },
  servers: {
    patterns: ['test/servers/**/*.test.mjs'],
  },
  webhooks: {
    patterns: ['test/webhooks/**/*.test.mjs'],
  },
  plugins: {
    patterns: [
      'test/tools/plugin-scan.test.mjs',
      'test/tools/plugin-loader.test.mjs',
      'test/plugins/**/*.test.mjs',
    ],
  },
  'ui-designer': {
    patterns: ['test/ui-designer/**/*.test.mts'],
    post: ['node scripts/step15-smoke.mjs'],
  },
  design: {
    patterns: [
      'test/design/**/*.test.mjs',
      'test/design/**/*.test.mts',
      'test/ui/preview-design-mode-browser.test.mts',
      'test/ui/preview-design-mode-guest-strategy.test.mts',
      'test/ui/preview-electron-visibility.test.mts',
      'test/ui/preview-panel.test.mts',
      'test/server/design-*.test.mjs',
    ],
  },
  browser: {
    patterns: [
      'test/browser/**/*.test.js',
      'test/tools/browser-preview-tools.test.mts',
      'test/tools/minnow-shell.test.mts',
    ],
  },
  benchmark: {
    patterns: [
      'test/api/message-content.test.mts',
      'test/benchmark/**/*.test.mts',
      'test/ui/benchmark-stop.test.mts',
      'test/ui/benchmark-stopped-card.test.mts',
      'test/ui/benchmark-history-browse.test.mts',
      'test/ui/benchmark-nav-persistence.test.mts',
      'test/ui/benchmark-suite-toggles.test.mts',
      'test/ui/benchmark-transcript-resolve.test.mts',
      'test/ui/capability-cell-panel.test.mts',
      'test/ui/transcript-view.test.mts',
      'test/ui/benchmark-page-html.test.mjs',
      'test/benchmark-workspace/**/*.test.mjs',
    ],
  },
  evals: {
    patterns: ['test/evals/**/*.test.mjs', 'test/evals/**/*.test.mts'],
  },
  a11y: {
    patterns: [
      'test/a11y/**/*.test.mts',
      'test/theme-contrast.test.mts',
      'test/ui/question-cards-modal-focus.test.mts',
    ],
  },
  orchestrator: {
    patterns: [
      'test/orchestrator/**/*.test.mjs',
      'test/orchestrator/**/*.test.mts',
      'test/dev/**/*.test.mts',
      'test/dev/**/*.test.mjs',
      // Plan-listing keeper ported from V1 list-plans (lives next to src/chat/plans/).
      'test/chat/plans/list-plans.test.mts',
    ],
  },
  runner: {
    patterns: ['test/runner/**/*.test.mjs', 'test/runner/**/*.test.mts'],
  },
  'board-gates': {
    patterns: ['test/scripts/*.test.mjs'],
  },
  onboarding: {
    patterns: ['test/onboarding/**/*.test.mjs', 'test/onboarding/**/*.test.mts'],
  },
  issues: {
    patterns: [
      'test/issues/**/*.test.mts',
      'test/ui/issues-*.test.mts',
      'test/state/issues-store.test.mts',
      'test/tools/issue-tools.test.mts',
      'test/os/issues-app.test.mts',
      'test/server/forge-issue-ops.test.mjs',
    ],
  },
  scheduler: {
    patterns: [
      'test/scheduler/**/*.test.mjs',
      'test/scheduler/**/*.test.mts',
      'test/os/scheduler-app.test.mts',
    ],
  },
  voice: {
    patterns: ['test/voice/**/*.test.mjs', 'test/voice/**/*.test.mts'],
  },
  sandbox: {
    patterns: ['test/terminal/sandbox/**/*.test.mjs'],
  },
};

/** Glob used to discover all node:test files under test/. */
export const TEST_FILE_GLOB = 'test/**/*.test.{js,mjs,mts,ts}';
