/** What happens after a stage attempt fails. Pure. */

import { OPTIONAL_STAGES } from './events.js';

/** Failed attempts a stage gets before the policy stops retrying it. */
export const RETRY_LIMIT = 3;

/**
 * The routing table, as data. `under: n` applies while `attemptCount < n`;
 * `under: null` is the fallback for that stage class.
 *
 * `attemptCount` counts failed attempts of the stage since its budget last
 * reset, including the one being decided, so `under: 3` retries the first two
 * failures and routes the third.
 *
 * - any failure < 3 → retry (the next attempt continues the same transcript)
 * - optional stage (research, review, polish) exhausted → skip it
 * - required stage (interview, draft) exhausted → halt the run for the user
 *
 * A halted run is not finished: the user can retry it with a fresh budget.
 */
export const POLICY_TABLE = /** @type {const} */ ([
  { stages: 'any', under: RETRY_LIMIT, action: { kind: 'retry' } },
  { stages: 'optional', under: null, action: { kind: 'skip' } },
  { stages: 'required', under: null, action: { kind: 'halt' } },
]);

/**
 * @param {{ stage: string, outcome: string, attemptCount: number }} input
 * @returns {import('./types').Action}
 */
export function decide(input) {
  const attemptCount = Number.isFinite(input?.attemptCount) ? Number(input.attemptCount) : 0;
  const optional = OPTIONAL_STAGES.includes(/** @type {any} */ (input?.stage));
  for (const row of POLICY_TABLE) {
    if (row.stages === 'optional' && !optional) continue;
    if (row.stages === 'required' && optional) continue;
    if (row.under !== null && attemptCount >= row.under) continue;
    return { ...row.action };
  }
  return { kind: 'halt' };
}

/**
 * Render the table as markdown so a test can compare it cell for cell.
 * @returns {string}
 */
export function formatPolicyTable() {
  const lines = ['| stages | failed attempts | action |', '| --- | --- | --- |'];
  for (const row of POLICY_TABLE) {
    const attempts = row.under === null ? '—' : `< ${row.under}`;
    lines.push(`| ${row.stages} | ${attempts} | ${row.action.kind} |`);
  }
  return lines.join('\n');
}
