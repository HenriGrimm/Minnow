/** Policy table: what happens after a stage fact, and at a gate. */

/**
 * @returns {{ kind: 'accept' }}
 */
const accept = () => ({ kind: 'accept' });

/**
 * @param {import('./types').SeedKind} [seedKind]
 * @returns {{ kind: 'retry', seedKind: import('./types').SeedKind }}
 */
const retry = (seedKind = 'continue') => ({ kind: 'retry', seedKind });

/**
 * @returns {{ kind: 'skip' }}
 */
const skip = () => ({ kind: 'skip' });

/**
 * @returns {{ kind: 'fail' }}
 */
const fail = () => ({ kind: 'fail' });

/**
 * @returns {{ kind: 'stop' }}
 */
const stop = () => ({ kind: 'stop' });

/**
 * The routing table, as data. Rows are matched top to bottom; the first whose
 * stage, outcome, and attempt bound match wins. `under: n` means
 * `attemptCount < n`; `under: null` is that row's fallback.
 *
 * `attemptCount` counts *ended* attempts of the stage including the one being
 * decided (and, for the accept gate, rejections including the current one), so
 * `under: 3` means the first two failures retry and the third is terminal —
 * matching "crashed/timeout < 3 attempts → retry".
 *
 * Routing summary:
 * - ok → accept
 * - crashed/timeout < 3 attempts → retry (continue seed)
 * - interview/spec/draft retries exhausted → fail run
 * - research/polish/review retries exhausted → skip
 * - draft rejected by the accept gate < 2 → retry with the errors in the seed
 * - gate expired → stop
 */
export const POLICY_TABLE = /** @type {const} */ ([
  { stage: 'interview', outcome: 'ok', under: null, action: accept() },
  { stage: 'interview', outcome: 'crashed', under: 3, action: retry('continue') },
  { stage: 'interview', outcome: 'crashed', under: null, action: fail() },
  { stage: 'interview', outcome: 'timeout', under: 3, action: retry('continue') },
  { stage: 'interview', outcome: 'timeout', under: null, action: fail() },
  { stage: 'interview', outcome: 'rejected', under: null, action: fail() },

  { stage: 'spec', outcome: 'ok', under: null, action: accept() },
  { stage: 'spec', outcome: 'crashed', under: 3, action: retry('continue') },
  { stage: 'spec', outcome: 'crashed', under: null, action: fail() },
  { stage: 'spec', outcome: 'timeout', under: 3, action: retry('continue') },
  { stage: 'spec', outcome: 'timeout', under: null, action: fail() },
  { stage: 'spec', outcome: 'rejected', under: null, action: fail() },

  { stage: 'research', outcome: 'ok', under: null, action: accept() },
  { stage: 'research', outcome: 'crashed', under: 3, action: retry('continue') },
  { stage: 'research', outcome: 'crashed', under: null, action: skip() },
  { stage: 'research', outcome: 'timeout', under: 3, action: retry('continue') },
  { stage: 'research', outcome: 'timeout', under: null, action: skip() },
  { stage: 'research', outcome: 'rejected', under: null, action: skip() },

  { stage: 'draft', outcome: 'ok', under: null, action: accept() },
  { stage: 'draft', outcome: 'rejected', under: 2, action: retry('errors') },
  { stage: 'draft', outcome: 'rejected', under: null, action: fail() },
  { stage: 'draft', outcome: 'crashed', under: 3, action: retry('continue') },
  { stage: 'draft', outcome: 'crashed', under: null, action: fail() },
  { stage: 'draft', outcome: 'timeout', under: 3, action: retry('continue') },
  { stage: 'draft', outcome: 'timeout', under: null, action: fail() },

  { stage: 'review', outcome: 'ok', under: null, action: accept() },
  { stage: 'review', outcome: 'crashed', under: 3, action: retry('continue') },
  { stage: 'review', outcome: 'crashed', under: null, action: skip() },
  { stage: 'review', outcome: 'timeout', under: 3, action: retry('continue') },
  { stage: 'review', outcome: 'timeout', under: null, action: skip() },
  { stage: 'review', outcome: 'rejected', under: null, action: skip() },

  { stage: 'polish', outcome: 'ok', under: null, action: accept() },
  { stage: 'polish', outcome: 'crashed', under: 3, action: retry('continue') },
  { stage: 'polish', outcome: 'crashed', under: null, action: skip() },
  { stage: 'polish', outcome: 'timeout', under: 3, action: retry('continue') },
  { stage: 'polish', outcome: 'timeout', under: null, action: skip() },
  { stage: 'polish', outcome: 'rejected', under: null, action: skip() },

  { stage: 'gate', outcome: 'expired', under: null, action: stop() },
  { stage: '*', outcome: '*', under: null, action: fail() },
]);

/**
 * @param {{
 *   stage: string,
 *   outcome: string,
 *   attemptCount: number,
 * }} input
 * @returns {import('./types').Action}
 */
export function decide(input) {
  const stage = input?.stage;
  const outcome = input?.outcome;
  const attemptCount = Number.isFinite(input?.attemptCount) ? Number(input.attemptCount) : 0;

  const row = POLICY_TABLE.find(
    (r) =>
      (r.stage === '*' || r.stage === stage) &&
      (r.outcome === '*' || r.outcome === outcome) &&
      (r.under === null || attemptCount < r.under),
  );

  if (!row) return { kind: 'fail' };
  return { ...row.action };
}

/**
 * Render the table as markdown so a test can compare it cell for cell.
 *
 * @returns {string}
 */
export function formatPolicyTable() {
  const lines = ['| stage | outcome | attempts | action |', '| --- | --- | --- | --- |'];
  for (const row of POLICY_TABLE) {
    const attempts = row.under === null ? '—' : `< ${row.under}`;
    lines.push(`| ${row.stage} | ${row.outcome} | ${attempts} | ${describeAction(row.action)} |`);
  }
  return lines.join('\n');
}

/**
 * @param {{ kind: string, [k: string]: unknown }} action
 * @returns {string}
 */
function describeAction(action) {
  if (action.kind === 'retry') return `retry, ${action.seedKind} seed`;
  if (action.kind === 'accept') return 'accept';
  if (action.kind === 'skip') return 'skip';
  if (action.kind === 'fail') return 'fail run';
  if (action.kind === 'stop') return 'stop';
  return `unknown (${action.kind})`;
}
