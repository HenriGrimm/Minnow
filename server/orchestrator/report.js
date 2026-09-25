/** End-of-run report writer. */

import fs from 'node:fs/promises';
import path from 'node:path';

import { queryAbandonments } from './core/evidence.js';
import { summarizeTouchesOverflow } from './core/overflow-report.js';
import { boardDir } from './journal.js';

/** Opaque journal type. Derive ignores it so the report cannot feed decisions. */
export const REPORT_EVENT_TYPE = 'run.report.written';

/** Filename next to `journal.jsonl`. */
export const REPORT_FILE = 'report.md';

/** Abort a hung LLM writer so Stop / workspace switch cannot wait forever. */
export const REPORT_COMPLETE_TIMEOUT_MS = 60_000;

/**
 * @param {Promise<string>} promise
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
function completeWithTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`report writer timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** How many times this process has written a report tmp file (Windows rename uniqueness). */
let reportWrites = 0;

/**
 * @param {string} boardId
 * @returns {string}
 */
export function reportPath(boardId) {
  return path.join(boardDir(boardId), REPORT_FILE);
}

/**
 * True when a report was written after the latest outcome or lifecycle change.
 *
 * @param {Iterable<{ type?: unknown }>} events
 * @returns {boolean}
 */
export function journalHasReport(events) {
  let current = false;
  for (const event of events ?? []) {
    if (event?.type === REPORT_EVENT_TYPE) current = true;
    else if (REPORT_INVALIDATING_EVENTS.has(event?.type)) current = false;
  }
  return current;
}

const REPORT_INVALIDATING_EVENTS = new Set([
  'board.started', 'board.reopened', 'board.stopped', 'run.finished',
  'task.added', 'task.reset', 'board.rewound', 'task.attempt.started',
  'task.attempt.ended', 'task.abandoned', 'task.skipped',
  'merge.succeeded', 'merge.conflicted', 'merge.failed', 'final.test.ended',
]);

/**
 * The slice of the journal after the last `board.reopened`.
 * @param {Iterable<{ type?: unknown }>} events
 * @returns {Array<{ type?: unknown }>}
 */
export function eventsSinceReopen(events) {
  const list = [...(events ?? [])];
  let last = -1;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i]?.type === 'board.reopened') last = i;
  }
  return last === -1 ? list : list.slice(last + 1);
}

/**
 * A concrete next step for an abandoned task, derived from its evidence bundle.
 * @param {{ taskId?: unknown, reason?: unknown, evidence?: unknown }} abandonment
 * @returns {string}
 */
export function suggestedNextStep(abandonment) {
  const taskId = typeof abandonment?.taskId === 'string' && abandonment.taskId
    ? abandonment.taskId
    : 'the abandoned task';
  const reason = abandonment?.reason != null ? String(abandonment.reason) : '';
  const evidence =
    abandonment?.evidence && typeof abandonment.evidence === 'object' && !Array.isArray(abandonment.evidence)
      ? /** @type {Record<string, unknown>} */ (abandonment.evidence)
      : {};
  const attempts = Array.isArray(evidence.attempts) ? evidence.attempts : [];
  const last =
    attempts.length > 0 && attempts[attempts.length - 1] && typeof attempts[attempts.length - 1] === 'object'
      ? /** @type {Record<string, unknown>} */ (attempts[attempts.length - 1])
      : {};
  const blockers = Array.isArray(last.blockers) ? last.blockers.map(String).filter(Boolean) : [];
  const needs = Array.isArray(last.needs) ? last.needs.map(String).filter(Boolean) : [];
  const testOutput = last.testOutput != null ? String(last.testOutput).trim() : '';
  const outcome = last.outcome != null ? String(last.outcome) : '';

  if (outcome === 'blocked' || blockers.length > 0 || needs.length > 0) {
    const what = blockers[0] || needs[0] || String(last.summary || reason || 'the environment blocker');
    return `Unblock ${taskId} by resolving ${what}, then start that task again.`;
  }
  if (testOutput) {
    const snippet = testOutput.length > 120 ? `${testOutput.slice(0, 117)}…` : testOutput;
    return `Fix the failure recorded in testOutput for ${taskId} (${snippet}), then retry the task.`;
  }
  if (reason.includes('fail') || outcome === 'fail') {
    return `Inspect the last ${String(last.role || 'builder')} attempt on ${taskId} and retry once that failure is fixed.`;
  }
  return `Review the attempt history for ${taskId} and retry from the last seed (${String(last.seedKind || 'initial')}).`;
}

/**
 * Shape the one payload the model is allowed to see.
 * @param {Iterable<Record<string, unknown>>} events
 * @param {import('./core/types').BoardState} state
 * @returns {Record<string, unknown>}
 */
export function buildReportInput(events, state) {
  const list = [...(events ?? [])].map((event) => ({ ...event }));
  const compactEvents = list
    .filter((event) => !REPORT_OMITTED_EVENT_TYPES.has(String(event.type)))
    .map(compactReportEvent);
  const latestAbandonments = new Map(queryAbandonments(list).map((row) => [row.taskId, row]));
  const abandonments = [...latestAbandonments.values()]
    .filter((row) => state.tasks.get(row.taskId)?.phase === 'abandoned')
    .map((row) => ({
      taskId: row.taskId,
      reason: row.reason,
      evidence: row.evidence,
      nextStep: suggestedNextStep(row),
    }));

  /** @type {Array<Record<string, unknown>>} */
  const shipped = [];
  /** @type {Array<Record<string, unknown>>} */
  const skipped = [];
  /** @type {Array<Record<string, unknown>>} */
  const conflicted = [];
  /** @type {Array<Record<string, unknown>>} */
  const stillOpen = [];

  for (const id of state.taskOrder) {
    const task = state.tasks.get(id);
    if (!task) continue;
    const row = {
      id: task.id,
      title: task.title,
      phase: task.phase,
      outcome: task.outcome,
      wave: task.wave,
    };
    if (task.phase === 'merged') shipped.push(row);
    else if (task.phase === 'skipped') {
      skipped.push({ ...row, blockedBy: task.skippedBy });
    } else if (task.mergeConflicts && task.mergeConflicts.length > 0) {
      conflicted.push({ ...row, files: [...task.mergeConflicts] });
    } else if (task.phase !== 'abandoned') {
      stillOpen.push(row);
    }
  }

  return {
    boardId: state.boardId,
    name: state.name,
    planPath: state.planPath,
    finished: state.finished,
    stopReason: state.stopReason,
    runSummary: state.runSummary,
    shipped,
    abandoned: abandonments,
    skipped,
    mergeConflicts: conflicted,
    touchesOverflow: summarizeTouchesOverflow(list),
    finalTest: state.finalTest
      ? {
          outcome: state.finalTest.outcome,
          runInstructions: state.finalTest.runInstructions,
        }
      : null,
    stillOpen,
    events: compactEvents,
  };
}

/** Events the prompt leaves out: summarized elsewhere in the input, or pure bookkeeping. */
const REPORT_OMITTED_EVENT_TYPES = new Set(['touches.overflow', 'merge.enqueued']);
/** Per-event fields the report never needs. */
const REPORT_OMITTED_KEYS = new Set(['v', 'boardId', 'evidence', 'usage', 'worktree', 'slotId']);
/** Longest string an event field keeps in the report prompt. */
const REPORT_EVENT_STRING_CAP = 300;
/** Most items an event array keeps in the report prompt. */
const REPORT_EVENT_ARRAY_CAP = 12;

/**
 * One journal event cut down for the report prompt. A real board's journal
 * carries full diff patches, test output and plan specs — megabytes that no
 * local model can take — while the report only needs what happened.
 * Attempt evidence and worktree paths are dropped (abandonments keep their
 * evidence in `abandoned`) and every string and array is capped.
 *
 * @param {Record<string, unknown>} event
 * @returns {Record<string, unknown>}
 */
export function compactReportEvent(event) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(event)) {
    if (REPORT_OMITTED_KEYS.has(key)) continue;
    if (key === 'tasks' && Array.isArray(value)) {
      out.tasks = value.map((task) =>
        task && typeof task === 'object'
          ? { id: /** @type {any} */ (task).id, title: /** @type {any} */ (task).title }
          : task,
      );
      continue;
    }
    if (key === 'task' && value && typeof value === 'object') {
      out.task = { id: /** @type {any} */ (value).id, title: /** @type {any} */ (value).title };
      continue;
    }
    out[key] = capForPrompt(value, 0);
  }
  return out;
}

/**
 * @param {unknown} value
 * @param {number} depth
 * @returns {unknown}
 */
function capForPrompt(value, depth) {
  if (typeof value === 'string') {
    return value.length > REPORT_EVENT_STRING_CAP
      ? `${value.slice(0, REPORT_EVENT_STRING_CAP - 1)}…`
      : value;
  }
  if (Array.isArray(value)) {
    const kept = value.slice(0, REPORT_EVENT_ARRAY_CAP).map((item) => capForPrompt(item, depth + 1));
    if (value.length > REPORT_EVENT_ARRAY_CAP) kept.push(`… ${value.length - REPORT_EVENT_ARRAY_CAP} more`);
    return kept;
  }
  if (value && typeof value === 'object') {
    if (depth >= 3) return '[…]';
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[key] = capForPrompt(inner, depth + 1);
    return out;
  }
  return value;
}

/**
 * The system prompt. Outcomes only — no request for transcripts or a second turn.
 */
export const REPORT_SYSTEM_PROMPT = [
  'You write the single end-of-run report for a Minnow orchestrator board.',
  'The JSON is the condensed journal plus derived outcomes. Long fields are truncated; tokens, diffs and chat transcripts are intentionally absent.',
  'Write markdown covering, in this order:',
  '1. Summary (success, partial, or user-stopped — never call a user stop an error).',
  '2. Shipped (merged) tasks.',
  '3. Abandoned tasks: name each, quote its evidence, and give the concrete nextStep from the JSON.',
  '4. Skipped tasks and what blocked them (blockedBy is the abandoned root).',
  '5. Merge conflicts (files).',
  '6. touches.overflow occurrences.',
  '7. Final test outcome and the runInstructions string verbatim.',
  '8. Cross-task patterns worth a human looking at.',
  'Do not invent tasks or outcomes that are not in the JSON. Do not ask follow-up questions.',
  'Derived outcomes are authoritative. Historical failures in events are recovery history, not current failures when a task has since merged.',
].join(' ');

/**
 * Messages for the one completion. Deterministic given `input`.
 *
 * @param {Record<string, unknown>} input
 * @returns {Array<{ role: 'system' | 'user', content: string }>}
 */
export function buildReportMessages(input) {
  return [
    { role: 'system', content: REPORT_SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(input) },
  ];
}

/**
 * Markdown that does not need a model.
 * @param {Record<string, unknown>} input
 * @returns {string}
 */
export function formatMechanicalReport(input) {
  const stopReason = input.stopReason;
  const finished = input.finished === true;
  const headline = stopReason === 'quota' && !finished
    ? 'Run stopped: the model provider is out of usage. Partial progress below — ' +
      'the remaining tasks were not attempted and resume where they left off.'
    : stopReason === 'user' && !finished
      ? 'Run stopped by the user. Partial progress below — this is not an error.'
      : finished
        ? `Run finished. ${String(input.runSummary || '')}`.trim()
        : 'Run ended.';

  const lines = [
    '# End-of-run report',
    '',
    `**${String(input.name || input.boardId || 'board')}**`,
    '',
    '## Summary',
    '',
    headline,
    '',
    '## Shipped',
    '',
  ];
  const shipped = Array.isArray(input.shipped) ? input.shipped : [];
  if (shipped.length === 0) lines.push('_None._', '');
  else {
    for (const task of shipped) {
      const rec = /** @type {Record<string, unknown>} */ (task);
      lines.push(`- **${rec.id}** — ${rec.title ?? ''}`);
    }
    lines.push('');
  }

  lines.push('## Abandoned', '');
  const abandoned = Array.isArray(input.abandoned) ? input.abandoned : [];
  if (abandoned.length === 0) lines.push('_None._', '');
  else {
    for (const row of abandoned) {
      const rec = /** @type {Record<string, unknown>} */ (row);
      lines.push(`### ${rec.taskId}`);
      lines.push('');
      lines.push(`Reason: ${String(rec.reason ?? '')}`);
      lines.push('');
      lines.push('Evidence:');
      lines.push('');
      lines.push('```json');
      lines.push(JSON.stringify(rec.evidence ?? {}, null, 2));
      lines.push('```');
      lines.push('');
      lines.push(`Next step: ${String(rec.nextStep ?? '')}`);
      lines.push('');
    }
  }

  lines.push('## Skipped', '');
  const skipped = Array.isArray(input.skipped) ? input.skipped : [];
  if (skipped.length === 0) lines.push('_None._', '');
  else {
    for (const task of skipped) {
      const rec = /** @type {Record<string, unknown>} */ (task);
      lines.push(`- **${rec.id}** waiting on \`${rec.blockedBy}\`, which failed.`);
    }
    lines.push('');
  }

  lines.push('## Merge conflicts', '');
  const conflicts = Array.isArray(input.mergeConflicts) ? input.mergeConflicts : [];
  if (conflicts.length === 0) lines.push('_None._', '');
  else {
    for (const row of conflicts) {
      const rec = /** @type {Record<string, unknown>} */ (row);
      const files = Array.isArray(rec.files) ? rec.files.join(', ') : '';
      lines.push(`- **${rec.id}**: ${files}`);
    }
    lines.push('');
  }

  lines.push('## Touches overflow', '');
  const overflow = /** @type {Record<string, unknown>} */ (input.touchesOverflow ?? {});
  const eventCount = Number(overflow.eventCount) || 0;
  if (eventCount === 0) lines.push('_None._', '');
  else {
    lines.push(`${eventCount} overflow event(s). Hottest files:`);
    const files = Array.isArray(overflow.files) ? overflow.files : [];
    for (const file of files.slice(0, 12)) {
      const rec = /** @type {Record<string, unknown>} */ (file);
      lines.push(`- \`${rec.path}\` × ${rec.count}`);
    }
    lines.push('');
  }

  lines.push('## Final test', '');
  const finalTest = input.finalTest;
  if (!finalTest || typeof finalTest !== 'object') lines.push('_Not run._', '');
  else {
    const rec = /** @type {Record<string, unknown>} */ (finalTest);
    lines.push(`Outcome: **${rec.outcome}**`);
    lines.push('');
    if (typeof rec.runInstructions === 'string' && rec.runInstructions) {
      lines.push('Reproduction:');
      lines.push('');
      lines.push('```');
      lines.push(rec.runInstructions);
      lines.push('```');
      lines.push('');
    }
  }

  return `${lines.join('\n').trim()}\n`;
}

/**
 * Pull assistant text out of an OpenAI-style SSE or JSON body.
 *
 * @param {string} raw
 * @returns {string}
 */
export function extractAssistantText(raw) {
  const text = String(raw ?? '');
  let out = '';
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const json = JSON.parse(data);
      const choice = json?.choices?.[0];
      const delta = choice?.delta?.content;
      if (typeof delta === 'string') out += delta;
      const message = choice?.message?.content;
      if (typeof message === 'string') out += message;
    } catch {
    }
  }
  if (out.trim()) return out.trim();
  try {
    const json = JSON.parse(text);
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.trim()) return content.trim();
  } catch {
  }
  return text.trim();
}

/**
 * Production completion: one in-process chat/completions call, no tools, no loop.
 *
 * Uses the board's bound model, the same one its attempts run on, before
 * falling back to the Autopilot / active-chat model.
 *
 * @param {{ input: Record<string, unknown>, messages: Array<{ role: string, content: string }>, model?: { providerId?: string, id?: string } | null }} args
 * @returns {Promise<string>}
 */
export async function defaultComplete(args) {
  const { resolveAttemptModel } = await import('./model-binding.js');
  const { postChatCompletionsInProcess } = await import('../runner/node.js');
  const model = await resolveAttemptModel(args.model ?? null);
  const response = await postChatCompletionsInProcess(
    { id: model.providerId },
    {
      model: model.id,
      messages: args.messages,
      stream: true,
    },
  );
  const raw = await response.text();
  return extractAssistantText(raw);
}

/**
 * Persist markdown next to the journal (temp-then-rename).
 *
 * @param {string} boardId
 * @param {string} markdown
 * @returns {Promise<string>} absolute path written
 */
export async function persistReport(boardId, markdown) {
  const target = reportPath(boardId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${(reportWrites += 1)}`;
  await fs.writeFile(tmp, markdown, 'utf8');
  await fs.rename(tmp, target);
  return target;
}

/**
 * Read a persisted report, or null when none exists.
 *
 * @param {string} boardId
 * @returns {Promise<string | null>}
 */
export async function readReport(boardId) {
  try {
    return await fs.readFile(reportPath(boardId), 'utf8');
  } catch {
    return null;
  }
}

/**
 * One stateless call: build input, complete, persist.
 * @param {{
 *   boardId: string,
 *   events: Iterable<Record<string, unknown>>,
 *   state: import('./core/types').BoardState,
 *   complete?: (args: { input: Record<string, unknown>, messages: Array<{ role: string, content: string }> }) => Promise<string>,
 *   persist?: (boardId: string, markdown: string) => Promise<string>,
 *   completeTimeoutMs?: number,
 * }} options
 * @returns {Promise<{
 *   markdown: string,
 *   input: Record<string, unknown>,
 *   messages: Array<{ role: string, content: string }>,
 *   path: string,
 *   relativePath: string,
 *   usedFallback: boolean,
 * }>}
 */
export async function writeEndOfRunReport(options) {
  const { boardId, events, state } = options;
  const input = buildReportInput(events, state);
  const messages = buildReportMessages(input);
  const complete = options.complete ?? defaultComplete;
  const persist = options.persist ?? persistReport;
  const timeoutMs =
    typeof options.completeTimeoutMs === 'number'
      ? options.completeTimeoutMs
      : REPORT_COMPLETE_TIMEOUT_MS;

  let markdown = '';
  let usedFallback = false;
  try {
    markdown = String(
      (await completeWithTimeout(complete({ input, messages, model: state?.model ?? null }), timeoutMs)) ?? '',
    ).trim();
  } catch (err) {
    usedFallback = true;
    console.warn(
      `[orchestrator] ${boardId}: report writer complete() failed; using mechanical fallback:`,
      /** @type {Error} */ (err)?.message ?? err,
    );
  }
  if (!markdown) {
    usedFallback = true;
    markdown = formatMechanicalReport(input);
  }
  if (!markdown.endsWith('\n')) markdown = `${markdown}\n`;

  const written = await persist(boardId, markdown);
  return {
    markdown,
    input,
    messages,
    path: written,
    relativePath: REPORT_FILE,
    usedFallback,
  };
}
