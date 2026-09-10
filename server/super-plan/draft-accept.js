/**
 * Two-tier draft accept gate (W6-B).
 *
 * A draft stage that reports success is not accepted until its artifact passes
 * this gate:
 *
 * - **Tier 1 — always.** The file was written, it is not empty, it carries the
 *   required headings, and its sha256 differs from the prior accepted artifact.
 * - **Tier 2 — only for an executable task graph.** When the draft is an
 *   executable orchestrate plan (`documentation/plans/<name>.md`, not under
 *   `references/` or `verification/`), `parsePlan` must accept it and the
 *   formatted parse errors become the retry seed.
 *
 * Tier 2 stays conditional on purpose: most Super Plans are prose, and an
 * unconditional `parsePlan` gate would reject them forever. The predicate is
 * the server mirror of `isExecutableOrchestratePlan` in
 * `src/chat/plans/plan-path.ts`.
 *
 * The module is I/O — it hashes and imports the orchestrator parser — so it is
 * listed in the graph purity guard's `IO_MODULES`, exactly like
 * `effector-headless.js`. Reading the artifact and the prior accepted hash is
 * the caller's job; this is a pure decision over those inputs.
 */

import { createHash } from 'node:crypto';

import { formatParseErrors, isParseErrors, parsePlan } from '../orchestrator/core/parse-plan.js';
import { normalizeOrchestratePlanPath } from '../config/orchestrate-plan-path.js';

/** Headings a draft must carry before Tier 1 can pass. */
export const REQUIRED_DRAFT_HEADINGS = /** @type {const} */ (['# ', '## ']);

/**
 * Content hash of a draft artifact. The prior accepted artifact's hash is what
 * Tier 1 compares against, so an unchanged draft never re-accepts.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function draftContentSha256(markdown) {
  return createHash('sha256').update(String(markdown), 'utf8').digest('hex');
}

/**
 * Is this path an executable orchestrate plan? Mirrors
 * `isExecutableOrchestratePlan` — a top-level `documentation/plans/*.md`, not a
 * Super Plan reference (`references/`) or verification artifact.
 *
 * @param {unknown} planPath
 * @returns {boolean}
 */
export function isExecutableDraftPlan(planPath) {
  return normalizeOrchestratePlanPath(planPath) !== undefined;
}

/**
 * @param {string} markdown
 * @returns {string[]} the required headings that are missing
 */
function missingRequiredHeadings(markdown) {
  /** @type {string[]} */
  const missing = [];
  if (!/^#\s+\S/m.test(markdown)) missing.push('# ');
  if (!/^##\s+\S/m.test(markdown)) missing.push('## ');
  return missing;
}

/**
 * @param {1 | 2} tier
 * @param {string} message
 * @param {string | null} sha256
 * @returns {import('./draft-accept').DraftAcceptResult}
 */
function reject(tier, message, sha256) {
  return {
    accepted: false,
    tier,
    sha256,
    errors: [message],
    retrySeed: `The draft was rejected: ${message}`,
  };
}

/**
 * Evaluate the two-tier draft accept gate.
 *
 * @param {{
 *   markdown?: string | null,
 *   planPath?: string | null,
 *   priorAcceptedSha256?: string | null,
 * }} [input]
 * @returns {import('./draft-accept').DraftAcceptResult}
 */
export function evaluateDraftAccept(input = {}) {
  const markdown = typeof input.markdown === 'string' ? input.markdown : null;
  const prior =
    typeof input.priorAcceptedSha256 === 'string' ? input.priorAcceptedSha256.trim() : '';

  // ── Tier 1 — always ────────────────────────────────────────────────────────
  if (markdown === null) {
    return reject(1, 'the draft file was not written', null);
  }
  if (markdown.trim().length === 0) {
    return reject(1, 'the draft file is empty', draftContentSha256(markdown));
  }
  const sha256 = draftContentSha256(markdown);
  const missing = missingRequiredHeadings(markdown);
  if (missing.length > 0) {
    return reject(1, `the draft is missing required heading(s): ${missing.join(', ')}`, sha256);
  }
  if (prior && prior === sha256) {
    return reject(1, 'the draft is identical to the previously accepted artifact', sha256);
  }

  // ── Tier 2 — only for an executable task graph ─────────────────────────────
  const executable = isExecutableDraftPlan(input.planPath) && /^#{2,4}\s+Task\s+\S/im.test(markdown);
  if (executable) {
    const parsed = parsePlan(markdown);
    if (isParseErrors(parsed)) {
      const formatted = formatParseErrors(parsed);
      return {
        accepted: false,
        tier: 2,
        sha256,
        errors: [formatted],
        retrySeed: `The draft at ${String(input.planPath)} does not parse as an executable plan. Fix these problems and write it again:\n${formatted}`,
      };
    }
  }

  return { accepted: true, tier: executable ? 2 : 1, sha256, errors: [], retrySeed: null };
}
