import { charsPerTokenFor } from '../token-estimate-core.js';
import { COMPACTION_HEADER_PREFIX, oneLine } from './segment.js';

/** Hard ceiling on the summary regardless of window. */
export const MAX_SUMMARY_BUDGET_TOKENS = 6000;
/** Share of the model window the summary may take. */
export const SUMMARY_WINDOW_SHARE = 0.12;
/** Floor so a tiny window still gets a usable summary. */
export const MIN_SUMMARY_BUDGET_TOKENS = 400;

/**
 * `min(6k, 12% of window)`, floored.
 * @param {number | null | undefined} windowTokens
 */
export function defaultSummaryBudgetTokens(windowTokens) {
  const window = Number.isFinite(windowTokens) && windowTokens > 0 ? windowTokens : 32768;
  return Math.max(MIN_SUMMARY_BUDGET_TOKENS, Math.min(MAX_SUMMARY_BUDGET_TOKENS, Math.floor(window * SUMMARY_WINDOW_SHARE)));
}

/**
 * @param {number | null} from
 * @param {number | null} through
 */
function headerLine(from, through) {
  const range = from != null && through != null ? `rows #${from}–#${through} folded` : 'earlier rows folded';
  return `${COMPACTION_HEADER_PREFIX}compacted — ${range}; full history is searchable with recall_history)`;
}

/**
 * @param {Record<string, number>} tools
 */
function toolCounts(tools) {
  const names = Object.keys(tools ?? {});
  if (names.length === 0) return '';
  return names.map((n) => (tools[n] > 1 ? `${n}×${tools[n]}` : n)).join(' ');
}

/**
 * Section bodies, stable sections first. Each is an array of lines so the
 * budget pass can drop whole lines.
 * @param {import('./index').CompactionState} state
 */
function buildSections(state) {
  /** @type {Array<{ title: string, lines: string[], shrink: 'oldest' | 'newest' | 'none' }>} */
  const sections = [];
  const goal = [];
  if (state.goal) goal.push(state.goal);
  for (const change of state.scopeChanges) goal.push(`Later (#${change.row ?? '?'}): ${change.text}`);
  sections.push({ title: 'Session goal', lines: goal, shrink: 'newest' });
  sections.push({ title: 'User notes', lines: state.notes.map((n) => `- ${n}`), shrink: 'oldest' });
  sections.push({ title: 'Working findings (assistant claims; revalidate after changes)',
    lines: (state.findings ?? []).map(f => `#${f.row ?? '?'} ${f.text}`), shrink: 'oldest' });
  sections.push({ title: 'File observations (historical source excerpts; recall rows for details)',
    lines: state.files.flatMap(f => (f.observations ?? []).map(o => `- ${f.path} #${o.row ?? '?'}: ${o.text}`)), shrink: 'oldest' });
  sections.push({
    title: 'Files',
    lines: state.files.map((f) => {
      const stats = f.additions || f.deletions ? ` (+${f.additions}/−${f.deletions})` : '';
      return `- ${f.path} — ${f.ops.join('|')}${stats}`;
    }),
    shrink: 'oldest',
  });
  sections.push({
    title: 'Commits',
    lines: state.commits.map((c) => `- ${c.hash ? `${c.hash} ` : ''}${c.subject}`),
    shrink: 'oldest',
  });
  sections.push({
    title: 'Sub-agents',
    lines: state.subAgents.map((s) => `- ${s.type}: ${s.task} → ${s.outcome}`),
    shrink: 'oldest',
  });
  sections.push({
    title: 'Earlier turns',
    lines: state.turns.map((t) => {
      const tools = toolCounts(t.tools);
      const user = t.user ? `U: ${t.user}` : 'U: (continued)';
      const answer = t.assistant ? ` → A: ${t.assistant}` : '';
      return `#${t.row ?? '?'} ${user}${answer}${tools ? ` (tools: ${tools})` : ''}`;
    }),
    shrink: 'oldest',
  });
  sections.push({
    title: 'Open problems',
    lines: state.problems.map((p) => `[${p.status === 'open' ? 'ERROR' : 'RESOLVED'}] #${p.row ?? '?'} ${p.text}`),
    shrink: 'oldest',
  });
  sections.push({ title: 'Todos', lines: [...state.todos], shrink: 'newest' });
  const status = [];
  if (state.status.lastAssistant) status.push(`Last answer: ${oneLine(state.status.lastAssistant, 420)}`);
  if (state.status.lastFileAction) status.push(`Last file change: ${state.status.lastFileAction}`);
  if (state.status.lastCommand) status.push(`Last command: ${state.status.lastCommand}`);
  sections.push({ title: 'Current status', lines: status, shrink: 'newest' });
  return sections;
}

/**
 * @param {ReturnType<typeof buildSections>} sections
 * @param {string} header
 */
function render(sections, header) {
  const parts = [header];
  for (const section of sections) {
    if (section.lines.length === 0) continue;
    parts.push(`[${section.title}]\n${section.lines.join('\n')}`);
  }
  return parts.join('\n\n');
}

/** Order in which sections give up lines when the summary is over budget. */
const SHRINK_ORDER = ['Earlier turns', 'Files', 'Sub-agents', 'Open problems', 'Commits', 'User notes', 'File observations (historical source excerpts; recall rows for details)', 'Working findings (assistant claims; revalidate after changes)', 'Todos', 'Session goal', 'Current status'];

/**
 * Deterministic summary text for a state: same state → same bytes.
 *
 * @param {import('./index').CompactionState} state
 * @param {{ budgetTokens: number }} options
 * @returns {string}
 */
export function formatCompactionSummary(state, options) {
  const budgetChars = Math.max(400, Math.floor(options.budgetTokens * charsPerTokenFor('prose')));
  const header = headerLine(state.folded.fromRow, state.folded.throughRow);
  const sections = buildSections(state);
  let text = render(sections, header);
  if (text.length <= budgetChars) return text;

  // Drop whole lines, largest flexible sections first, until it fits. Each
  // section keeps at least one line while another section can still give.
  for (const pass of [1, 0]) {
    for (const title of SHRINK_ORDER) {
      const section = sections.find((s) => s.title === title);
      if (!section) continue;
      while (section.lines.length > pass && text.length > budgetChars) {
        if (section.shrink === 'newest') section.lines.pop();
        else section.lines.shift();
        text = render(sections, header);
      }
      if (text.length <= budgetChars) return text;
    }
  }
  return text.length <= budgetChars ? text : `${text.slice(0, budgetChars - 1)}…`;
}
