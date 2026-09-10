/** Build the prompt seed for the next attempt. */

import { lastEndedAttempt } from './core/derive.js';

/** The kinds, in the order the policy table names them, then the rerun seed. */
export const SEED_KINDS = /** @type {const} */ ([
  'initial',
  'failure-aware',
  'repair',
  'continue',
  'fix',
  'rebase',
  'integration-fix',
]);

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function asStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string');
}

/**
 * @param {string[]} items
 * @returns {string}
 */
function bullets(items) {
  if (items.length === 0) return '(none recorded)';
  return items.map((item) => `- ${item}`).join('\n');
}

/**
 * The plan spec every seed starts from. Role is in the system prompt, not here.
 *
 * @param {import('./core/types').TaskState} task
 * @returns {string}
 */
function specBlock(task) {
  return [
    `# Task ${task.id} — ${task.title}`,
    '',
    '## Build',
    task.buildSpec || '(none)',
    '',
    '## Test',
    task.testSpec || '(none)',
    '',
    '## Accept',
    task.accept || '(none)',
  ].join('\n');
}

/**
 * @param {import('./core/types').Attempt | undefined} attempt
 * @returns {string[]}
 */
function blockersOf(attempt) {
  if (!attempt) return [];
  const fromEvidence = asStringList(attempt.evidence?.blockers);
  if (fromEvidence.length) return fromEvidence;
  return [];
}

/**
 * @param {import('./core/types').Attempt | undefined} attempt
 * @returns {string[]}
 */
function needsOf(attempt) {
  if (!attempt) return [];
  return asStringList(attempt.evidence?.needs);
}

/**
 * Tester fail carries `testOutput` on the attempt's evidence so a fix seed can quote it.
 * @param {import('./core/types').Attempt | undefined} attempt
 * @returns {string}
 */
function testOutputOf(attempt) {
  if (!attempt) return '';
  const value = attempt.evidence?.testOutput;
  if (typeof value === 'string' && value) return value;
  const blockers = blockersOf(attempt);
  return blockers[0] || attempt.summary || '';
}

/**
 * Summaries of finished attempts, oldest first — what is already done.
 *
 * @param {import('./core/types').TaskState} task
 * @returns {string[]}
 */
function alreadyDone(task) {
  /** @type {string[]} */
  const lines = [];
  for (const attempt of task.attempts) {
    if (!attempt.ended) continue;
    if (typeof attempt.summary === 'string' && attempt.summary) lines.push(attempt.summary);
  }
  return lines;
}

/**
 * @param {import('./core/types').Attempt | undefined} attempt
 * @returns {string}
 */
function endedHow(attempt) {
  if (!attempt) return 'The previous attempt ended without a recorded outcome.';
  if (attempt.outcome === 'crashed') return 'The previous attempt crashed.';
  if (attempt.outcome === 'timeout') return 'The previous attempt timed out.';
  if (attempt.outcome === 'no_report') {
    return 'The previous attempt ended without calling report_outcome.';
  }
  return `The previous attempt ended as ${attempt.outcome}.`;
}

/**
 * @param {import('./core/types').TaskState} task
 * @returns {string}
 */
function initialSeed(task) {
  return specBlock(task);
}

/**
 * @param {import('./core/types').TaskState} task
 * @returns {string}
 */
function failureAwareSeed(task) {
  const last = lastEndedAttempt(task);
  return [
    specBlock(task),
    '',
    '## Prior attempt',
    'The last attempt failed. Fix the blockers; do not expand scope.',
    '',
    `Summary: ${last?.summary || '(none recorded)'}`,
    '',
    'Blockers:',
    bullets(blockersOf(last)),
  ].join('\n');
}

/**
 * Repair stays in this worktree because it is whose worktree it is — the env-fixer agent is gone.
 * @param {import('./core/types').TaskState} task
 * @returns {string}
 */
function repairSeed(task) {
  const last = lastEndedAttempt(task);
  return [
    specBlock(task),
    '',
    '## Environment',
    'The environment cannot support the work. Fix it in this worktree — do not start a parallel repair elsewhere, and do not treat a hard build as an environment problem.',
    '',
    `Summary: ${last?.summary || '(none recorded)'}`,
    '',
    'Needs:',
    bullets(needsOf(last)),
  ].join('\n');
}

/**
 * @param {import('./core/types').TaskState} task
 * @returns {string}
 */
function continueSeed(task) {
  const last = lastEndedAttempt(task);
  const done = alreadyDone(task);
  return [
    specBlock(task),
    '',
    '## Resume',
    `${endedHow(last)} Continue from what is already done; do not redo completed work.`,
    '',
    'Already done:',
    bullets(done),
  ].join('\n');
}

/**
 * @param {import('./core/types').TaskState} task
 * @returns {string}
 */
function fixSeed(task) {
  const last = lastEndedAttempt(task);
  const output = testOutputOf(last);
  return [
    specBlock(task),
    '',
    '## Test output',
    'The tester rejected the build. Fix the failures below; do not expand scope.',
    '',
    output || '(none recorded)',
  ].join('\n');
}

/**
 * @param {import('./core/types').TaskState} task
 * @param {string | null | undefined} integrationTip
 * @returns {string}
 */
function rebaseSeed(task, integrationTip) {
  const failure = [...task.attempts].reverse().find((a) => a.role === 'merge' && a.ended);
  const files = Array.isArray(task.mergeConflicts) ? task.mergeConflicts.filter((f) => typeof f === 'string') : [];
  const tip =
    typeof integrationTip === 'string' && integrationTip
      ? integrationTip
      : '(unknown — rebase onto the integration branch)';
  return [
    specBlock(task),
    '',
    '## Merge failed — repair required',
    'Your task passed testing, but its merge into integration failed. This builder retry must fix that integration failure before reporting pass; do not simply repeat the original build or report that it is already complete.',
    '',
    'Inspect git status in your existing task worktree. If a rebase is in progress, resolve conflicts, stage the resolved files, and continue it. Otherwise, rebase onto the current integration tip and resolve any conflicts. Diagnose the failure below even if no conflicted files are listed. Preserve both the task changes and changes already integrated, run the relevant checks, and leave the task branch clean and ready for the merge queue to retry.',
    '',
    `Merge failure: ${failure?.summary || '(no diagnostic recorded)'}`,
    '',
    `Integration tip: ${tip}`,
    '',
    'Conflicted files:',
    bullets(files),
  ].join('\n');
}

/**
 * Seed for a task that is running again after `board.reopened`.
 * @param {import('./core/types').TaskState} task
 * @param {import('./core/types').BoardState} state
 * @returns {string}
 */
function integrationFixSeed(task, state) {
  const why =
    task.reopened?.from ||
    'The previous run did not finish this task. Fix the integration failure and the task itself.';
  const merged = [...state.tasks.values()]
    .filter((item) => item.mergedSha)
    .map((item) => `${item.id}: ${item.mergedSha.slice(0, 12)}`);
  const prev = state.rerun?.previousFinalTest ?? null;
  const evidence = prev?.evidence && typeof prev.evidence === 'object' ? prev.evidence : {};
  const failedRung =
    typeof evidence.failedRung === 'string' && evidence.failedRung.trim()
      ? evidence.failedRung.trim()
      : '(not recorded)';
  const ran = Array.isArray(evidence.ran)
    ? evidence.ran.filter((item) => typeof item === 'string')
    : [];
  const output =
    typeof evidence.output === 'string' && evidence.output
      ? capSeedOutput(evidence.output)
      : '(none recorded)';
  const parsed = parseSeedCommandCwd(prev?.runInstructions ?? '');
  const commandLines = parsed
    ? [`command: ${parsed.command}`, `cwd: ${parsed.cwd}`]
    : prev?.runInstructions
      ? [prev.runInstructions]
      : ['(not recorded)'];
  const prior = alreadyDone(task);

  return [
    specBlock(task),
    '',
    '## Why this is running again',
    why,
    '',
    '## Integration',
    state.integrationSha
      ? `Tip: ${state.integrationSha}`
      : 'No integration commit yet.',
    '',
    'Merged tasks:',
    bullets(merged),
    '',
    '## What the final test found',
    `Failed rung: ${failedRung}`,
    ran.length > 0 ? `Ran: ${ran.join(', ')}` : 'Ran: (none recorded)',
    ...commandLines,
    '',
    output,
    '',
    '## What this task did before',
    bullets(prior),
  ].join('\n');
}

/**
 * @param {string} text
 * @returns {string}
 */
function capSeedOutput(text) {
  const max = 4000;
  if (text.length <= max) return text;
  return `${text.slice(0, max - 14)}\n…[truncated]`;
}

/**
 * @param {string} text
 * @returns {{ command: string, cwd: string } | null}
 */
function parseSeedCommandCwd(text) {
  const raw = String(text ?? '');
  const command = raw.match(/^command:\s*(.*)$/m)?.[1]?.trim();
  const cwd = raw.match(/^cwd:\s*(.*)$/m)?.[1]?.trim();
  if (!command || !cwd) return null;
  return { command, cwd };
}

/**
 * Build the user-message seed for one attempt.
 *
 * @param {import('./core/types').SeedKind} kind
 * @param {{
 *   state: import('./core/types').BoardState,
 *   taskId: string,
 * }} input
 * @returns {string}
 */
export function buildSeed(kind, input) {
  if (!input || typeof input !== 'object') {
    throw new Error('buildSeed: input { state, taskId } is required');
  }
  const task = input.state?.tasks?.get(input.taskId);
  if (!task) {
    throw new Error(`buildSeed: unknown task ${String(input.taskId)}`);
  }

  if (kind === 'initial') return finish(initialSeed(task));
  if (kind === 'failure-aware') return finish(failureAwareSeed(task));
  if (kind === 'repair') return finish(repairSeed(task));
  if (kind === 'continue') return finish(continueSeed(task));
  if (kind === 'fix') return finish(fixSeed(task));
  if (kind === 'rebase') return finish(rebaseSeed(task, input.state.integrationSha));
  if (kind === 'integration-fix') return finish(integrationFixSeed(task, input.state));

  throw new Error(`buildSeed: unknown seed kind ${String(kind)}`);
}

/**
 * Golden files are ordinary text files, so every seed ends in a newline.
 * @param {string} text
 * @returns {string}
 */
function finish(text) {
  return text.endsWith('\n') ? text : `${text}\n`;
}
