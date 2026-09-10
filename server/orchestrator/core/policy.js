/** Policy table: what happens after an attempt ends. */

/**
 * Every retry targets the builder.
 */
const RETRY_ROLE = 'builder';

/**
 * @typedef {'pass' | 'fail' | 'blocked' | 'no_report' | 'crashed' | 'timeout' | 'conflicted'
 *   | 'merge_failed'} PolicyOutcome
 */

/**
 * @param {string} seedKind
 * @param {boolean} [sameWorktree]
 * @returns {{ kind: 'retry', role: 'builder', seedKind: string, sameWorktree: boolean }}
 */
const retry = (seedKind, sameWorktree = false) => ({
  kind: 'retry',
  role: RETRY_ROLE,
  seedKind,
  sameWorktree,
});

/**
 * @param {'tester' | 'merge' | 'done'} to
 * @returns {{ kind: 'advance', to: 'tester' | 'merge' | 'done' }}
 */
const advance = (to) => ({ kind: 'advance', to });

/**
 * @param {string} reason
 * @returns {{ kind: 'abandon', reason: string }}
 */
const abandon = (reason) => ({ kind: 'abandon', reason });

/**
 * The table, as data.
 */
export const POLICY_TABLE = /** @type {const} */ ([
  { role: 'builder', outcome: 'pass', under: null, action: advance('tester') },
  { role: 'builder', outcome: 'fail', under: 2, action: retry('failure-aware') },
  { role: 'builder', outcome: 'fail', under: null, action: abandon('builder-failed') },
  { role: 'builder', outcome: 'blocked', under: 1, action: retry('repair', true) },
  { role: 'builder', outcome: 'blocked', under: null, action: abandon('builder-blocked') },
  { role: 'builder', outcome: 'no_report', under: 1, action: retry('continue', true) },
  { role: 'builder', outcome: 'no_report', under: null, action: abandon('builder-no-report') },
  { role: 'builder', outcome: 'crashed', under: 2, action: retry('continue', true) },
  { role: 'builder', outcome: 'crashed', under: null, action: abandon('builder-crashed') },
  { role: 'builder', outcome: 'timeout', under: 2, action: retry('continue', true) },
  { role: 'builder', outcome: 'timeout', under: null, action: abandon('builder-timeout') },

  { role: 'tester', outcome: 'pass', under: null, action: advance('merge') },
  { role: 'tester', outcome: 'fail', under: 2, action: retry('fix', true) },
  { role: 'tester', outcome: 'fail', under: null, action: abandon('tester-failed') },
  { role: 'tester', outcome: 'blocked', under: 1, action: retry('repair', true) },
  { role: 'tester', outcome: 'blocked', under: null, action: abandon('tester-blocked') },
  { role: 'tester', outcome: 'no_report', under: 1, action: retry('continue', true) },
  { role: 'tester', outcome: 'no_report', under: null, action: abandon('tester-no-report') },
  { role: 'tester', outcome: 'crashed', under: 2, action: retry('continue', true) },
  { role: 'tester', outcome: 'crashed', under: null, action: abandon('tester-crashed') },
  { role: 'tester', outcome: 'timeout', under: 2, action: retry('continue', true) },
  { role: 'tester', outcome: 'timeout', under: null, action: abandon('tester-timeout') },

  { role: 'merge', outcome: 'pass', under: null, action: advance('done') },
  { role: 'merge', outcome: 'conflicted', under: 2, action: retry('rebase', true) },
  { role: 'merge', outcome: 'conflicted', under: null, action: abandon('merge-conflicted') },
  // No retry rung: an operational merge failure is not something rebuilding the
  // work can fix, so re-seeding a builder only burns a full attempt's tokens.
  { role: 'merge', outcome: 'merge_failed', under: null, action: abandon('merge-failed') },
  { role: 'merge', outcome: '*', under: 2, action: retry('rebase', true) },
  { role: 'merge', outcome: '*', under: null, action: abandon('merge-failed') },

  { role: 'final', outcome: 'pass', under: null, action: advance('done') },
  { role: 'final', outcome: '*', under: null, action: abandon('final-test-failed') },

  { role: '*', outcome: '*', under: null, action: abandon('unhandled-outcome') },
]);

/**
 * @param {{
 *   role: string,
 *   outcome: string,
 *   attemptCount: number,
 *   summary?: string | null,
 *   evidence?: Record<string, unknown> | null,
 * }} input
 * @returns {import('./types').Action}
 */
export function decide(input) {
  const { role, outcome } = input;
  const attemptCount = Number.isFinite(input.attemptCount) ? Number(input.attemptCount) : 0;

  const row = POLICY_TABLE.find(
    (r) =>
      (r.role === '*' || r.role === role) &&
      (r.outcome === '*' || r.outcome === outcome) &&
      (r.under === null || attemptCount < r.under),
  );

  if (!row) return { kind: 'abandon', reason: 'unhandled-outcome', evidence: evidenceFor(input) };

  if (row.action.kind !== 'abandon') return { ...row.action };
  return { ...row.action, evidence: evidenceFor(input) };
}

/**
 * The last-attempt inputs to the decision.
 * @param {{ role: string, outcome: string, attemptCount: number, summary?: string | null,
 *           evidence?: Record<string, unknown> | null }} input
 * @returns {Record<string, unknown>}
 */
function evidenceFor(input) {
  /** @type {Record<string, unknown>} */
  const evidence = {
    role: input.role,
    outcome: input.outcome,
    attemptCount: Number.isFinite(input.attemptCount) ? Number(input.attemptCount) : 0,
  };
  if (input.summary != null) evidence.summary = input.summary;
  if (input.evidence != null) evidence.detail = input.evidence;
  return evidence;
}

export const SAME_WORKTREE_SEED_KINDS = /** @type {const} */ (['repair', 'continue', 'rebase', 'fix']);

/**
 * Does this seed kind repair in place rather than in a fresh worktree?
 * @param {string | null | undefined} seedKind
 * @returns {boolean}
 */
export function wantsSameWorktree(seedKind) {
  return SAME_WORKTREE_SEED_KINDS.includes(seedKind);
}

/**
 * Render the table as markdown, so a test can compare it to the documented one cell for cell rather than restating it.
 * @returns {string}
 */
export function formatPolicyTable() {
  const lines = ['| role | outcome | attempts | action |', '| --- | --- | --- | --- |'];
  for (const row of POLICY_TABLE) {
    const attempts = row.under === null ? '—' : `< ${row.under}`;
    lines.push(`| ${row.role} | ${row.outcome} | ${attempts} | ${describeAction(row.action)} |`);
  }
  return lines.join('\n');
}

/**
 * @param {{ kind: string, [k: string]: unknown }} action
 * @returns {string}
 */
function describeAction(action) {
  if (action.kind === 'advance') return `advance → ${action.to}`;
  if (action.kind === 'retry') {
    return `retry ${action.role}, ${action.seedKind} seed${action.sameWorktree ? ' (same worktree)' : ''}`;
  }
  return `abandon (${action.reason})`;
}
