/**
 * Resume digest: what an interrupted builder attempt had done, condensed from
 * its recorded transcript so a `continue` seed can pick up where it stopped.
 *
 * Built from the on-disk transcript rather than replayed as messages: it
 * survives a Minnow restart (the in-memory transcript does not), stays a few
 * thousand characters instead of the ~190k tokens a long attempt reaches, and
 * does not hand a looping trajectory back to the model verbatim.
 *
 * `formatResumeDigest` is pure; `loadResumeDigest` does the reads.
 */

import { readTranscript } from './transcripts.js';

/** Outcomes a `continue` resumes from. */
const RESUMABLE = new Set(['crashed', 'timeout', 'no_report']);

/** How many interrupted attempts in a row the digest looks back over. */
const MAX_CHAIN = 3;

const MAX_ACTIONS = 25;
const MAX_SUMMARY_CHARS = 3000;
const MAX_NOTES_CHARS = 1500;
const MAX_DIGEST_CHARS = 8000;

const EDIT_TOOLS = new Set([
  'save_file',
  'write_file',
  'edit_file',
  'replace_text_in_file',
  'replace_text_in_string_in_file',
  'delete_path',
]);
const SKIP_TOOLS = new Set(['report_outcome', 'search_tools', 'recall_history']);

/**
 * @param {unknown} raw
 * @returns {Record<string, unknown>}
 */
function parseArgs(raw) {
  if (raw && typeof raw === 'object') return /** @type {Record<string, unknown>} */ (raw);
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function clip(text, max) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function clipBlock(text, max) {
  const trimmed = text.trim();
  return trimmed.length > max ? `…${trimmed.slice(trimmed.length - max + 1)}` : trimmed;
}

/**
 * The argument that says what a call was about.
 * @param {Record<string, unknown>} args
 * @returns {string}
 */
function subjectOf(args) {
  for (const key of ['command', 'path', 'file_path', 'pattern', 'query', 'symbol', 'url']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

/**
 * One line for a tool result: the exit status for commands, else its first line.
 * @param {string} name
 * @param {string} content
 * @returns {string}
 */
function resultLine(name, content) {
  if (!content) return '';
  if (name === 'execute_command') {
    const exit = content.match(/\((exit -?\d+|timed out[^)]*|stopped)\)/i)?.[1] ?? '';
    const body = content.split('\n').slice(1).join('\n');
    const tail = body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && line !== 'stdout:' && line !== 'stderr:')
      .at(-1);
    return [exit, tail ? clip(tail, 100) : ''].filter(Boolean).join(': ');
  }
  const first = content.split('\n').find((line) => line.trim()) ?? '';
  return clip(first, 100);
}

/**
 * Condense one attempt's events.
 * @param {Record<string, unknown>[]} events
 */
function scan(events) {
  /** @type {Map<string, { name: string, args: Record<string, unknown> }>} */
  const calls = new Map();
  /** @type {string[]} */
  const actions = [];
  /** @type {string[]} */
  const edited = [];
  let summary = '';
  let notes = '';
  for (const event of events) {
    const type = event.type;
    if (type === 'tool_call' && typeof event.id === 'string') {
      calls.set(event.id, { name: String(event.name ?? ''), args: parseArgs(event.arguments) });
    } else if (type === 'tool_result') {
      const call = typeof event.id === 'string' ? calls.get(event.id) : undefined;
      const name = call?.name ?? String(event.name ?? '');
      if (!name || SKIP_TOOLS.has(name)) continue;
      const args = call?.args ?? {};
      const subject = subjectOf(args);
      if (EDIT_TOOLS.has(name) && subject && !edited.includes(subject)) edited.push(subject);
      const result = resultLine(name, typeof event.content === 'string' ? event.content : '');
      actions.push(
        `- ${name}${subject ? ` \`${clip(subject, 120)}\`` : ''}${result ? ` → ${result}` : ''}`,
      );
    } else if (type === 'context_compaction' && typeof event.summary === 'string' && event.summary.trim()) {
      summary = event.summary;
    } else if (type === 'thinking' && typeof event.text === 'string' && event.text.trim()) {
      notes = event.text;
    } else if (type === 'round_end') {
      const said = typeof event.text === 'string' ? event.text.trim() : '';
      const thought = typeof event.reasoning === 'string' ? event.reasoning.trim() : '';
      if (said || thought) notes = [thought, said].filter(Boolean).join('\n\n');
    }
  }
  return { actions, edited, summary, notes };
}

/**
 * Format a digest for the attempts a `continue` resumes, oldest first.
 * @param {Array<{ attemptId: string, outcome: string | null, summary?: string | null,
 *   events: Record<string, unknown>[] }>} chain
 * @returns {string} empty when there is nothing worth saying
 */
export function formatResumeDigest(chain) {
  const scanned = chain.map((entry) => ({ ...entry, ...scan(entry.events ?? []) }));
  const withWork = scanned.filter((entry) => entry.actions.length > 0 || entry.summary || entry.notes);
  if (withWork.length === 0) return '';
  const latest = withWork.at(-1);

  /** @type {string[]} */
  const edited = [];
  for (const entry of scanned) {
    for (const file of entry.edited) if (!edited.includes(file)) edited.push(file);
  }
  const actionCount = scanned.reduce((n, entry) => n + entry.actions.length, 0);

  /** @type {string[]} */
  const out = [
    `### Where the previous attempt${scanned.length > 1 ? 's' : ''} left off`,
    `${actionCount} tool call${actionCount === 1 ? '' : 's'} across ${scanned.length} attempt${scanned.length === 1 ? '' : 's'}.`,
  ];
  if (latest.summary) {
    out.push('', 'Progress summary (its own context checkpoint):', clipBlock(latest.summary, MAX_SUMMARY_CHARS));
  }
  out.push('', 'Files it changed (still in this worktree):', edited.length ? edited.map((f) => `- ${f}`).join('\n') : '- (none)');
  if (latest.actions.length) {
    const shown = latest.actions.slice(-MAX_ACTIONS);
    const skipped = latest.actions.length - shown.length;
    out.push(
      '',
      `Last actions, most recent last${skipped > 0 ? ` (${skipped} earlier omitted)` : ''}:`,
      ...shown,
    );
  }
  if (latest.notes) {
    out.push('', 'Its last notes before it stopped:', clipBlock(latest.notes, MAX_NOTES_CHARS));
  }
  out.push(
    '',
    'Start with `git status` and `git diff --stat` to confirm the worktree, then carry on from the last step. If the last actions show a command repeating with the same result, do not run it again — change approach.',
  );
  const text = out.join('\n');
  return text.length > MAX_DIGEST_CHARS ? `${text.slice(0, MAX_DIGEST_CHARS - 14)}\n…[truncated]` : text;
}

/**
 * The run of interrupted builder attempts at the end of a task, oldest first.
 * @param {import('./core/types').TaskState} task
 * @returns {import('./core/types').Attempt[]}
 */
export function resumeChain(task) {
  /** @type {import('./core/types').Attempt[]} */
  const chain = [];
  for (let i = task.attempts.length - 1; i >= 0 && chain.length < MAX_CHAIN; i -= 1) {
    const attempt = task.attempts[i];
    if (attempt.retired) continue;
    if (attempt.role !== 'builder' || !attempt.ended || !RESUMABLE.has(String(attempt.outcome))) break;
    chain.unshift(attempt);
  }
  return chain;
}

/**
 * Read the chain's transcripts and format the digest. Never throws: a missing or
 * unreadable transcript just means a thinner digest.
 * @param {string} boardId
 * @param {import('./core/types').TaskState} task
 * @returns {Promise<string>}
 */
export async function loadResumeDigest(boardId, task) {
  const chain = resumeChain(task);
  if (chain.length === 0) return '';
  const entries = [];
  for (const attempt of chain) {
    let events = [];
    try {
      events = (await readTranscript(boardId, attempt.attemptId)).events;
    } catch {
    }
    entries.push({ attemptId: attempt.attemptId, outcome: attempt.outcome, summary: attempt.summary, events });
  }
  try {
    return formatResumeDigest(entries);
  } catch {
    return '';
  }
}
