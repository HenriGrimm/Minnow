/**
 * Stage prompts, seeds and report tools for Super Plan agents. The prompt
 * text lives in `prompts/*.md` beside this module (shipped under `server/`).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeFindings, normalizeSeverity, reviewCycleLimit, reviewsInCycle } from './derive.js';

const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompts');

/** @type {Map<string, string>} */
const cache = new Map();

/**
 * @param {string} name
 * @returns {string}
 */
function load(name) {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  const body = readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf8').trim();
  cache.set(name, body);
  return body;
}

/**
 * @param {string} template
 * @param {Record<string, string | number>} vars
 * @returns {string}
 */
export function interpolate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => (key in vars ? String(vars[key]) : match));
}

const GRANULARITY_HINT = {
  large: 'one task per feature, module or subsystem — for builders with plenty of context.',
  medium: 'one task per component, route or logical unit; closely related functions share a task.',
  small: 'one task per function, config key or test case — atomic tasks for small-context models.',
};

/**
 * @param {number} budget
 * @returns {string}
 */
function questionGuidance(budget) {
  if (budget <= 0) {
    return 'Questions are turned off for this run. Do not call `ask_question`. Decide open points yourself, record each one as an **Assumption** in the spec, and keep going.';
  }
  return [
    `Use \`ask_question\` to ask in batches of up to 5 related questions per call. You may ask at most **${budget}** questions in total; stop as soon as you know enough — most requests need fewer.`,
    '',
    '- Ask about decisions that change the plan: scope and non-goals, who uses it and how, behaviour on failure and at the edges, data and compatibility, constraints, how success is judged.',
    '- Every question offers 2–5 concrete options. Mark the one you would choose with `"recommended": true` and put the trade-off in each option\'s `description`. The user can always type their own answer.',
    '- Never ask whether something "looks good" or whether to proceed, and never ask what the repository already answers.',
    '- Wait for each batch\'s answers before the next; later questions should build on earlier answers.',
    '- If the user asks you to stop asking, stop and write the spec with what you have.',
  ].join('\n');
}

/**
 * Context each prompt and seed needs.
 * @typedef {object} StageContext
 * @property {string} cwd
 * @property {string} date
 * @property {string} specPath
 * @property {string} researchPath
 * @property {string} planPath
 * @property {boolean} researchUsable
 * @property {number} questionBudget
 */

/**
 * @param {import('./types').StageId} role
 * @param {import('./types').RunState} state
 * @param {StageContext} ctx
 * @returns {string}
 */
export function buildSystemPrompt(role, state, ctx) {
  const researchNote = ctx.researchUsable ? ` (\`${ctx.specPath}\`) and the research report (\`${ctx.researchPath}\`)` : ` (\`${ctx.specPath}\`)`;
  const vars = {
    cwd: ctx.cwd,
    date: ctx.date,
    specPath: ctx.specPath,
    researchPath: ctx.researchPath,
    planPath: ctx.planPath,
    planName: state.slug || state.runId,
    granularity: state.config.granularity,
    granularityHint: GRANULARITY_HINT[state.config.granularity] ?? GRANULARITY_HINT.medium,
    questionGuidance: questionGuidance(ctx.questionBudget),
    researchNote,
    priorFindings: role === 'review' ? priorFindingsBlock(state) : '',
  };
  return `${interpolate(load('shared'), vars)}\n\n${interpolate(load(role), vars)}`;
}

// ── Seeds ────────────────────────────────────────────────────────────────────

/**
 * @param {import('./types').ReviewFinding} finding
 * @returns {string}
 */
function formatFinding(finding) {
  const lines = [`- \`${finding.id}\` **[${finding.severity}] ${finding.title}**`];
  if (finding.detail) lines.push(`  ${finding.detail.replace(/\n+/g, ' ')}`);
  if (finding.fix) lines.push(`  Fix: ${finding.fix.replace(/\n+/g, ' ')}`);
  if (finding.paths.length) lines.push(`  Paths: ${finding.paths.map((p) => `\`${p}\``).join(', ')}`);
  return lines.join('\n');
}

/**
 * Prior findings the reviewer should re-check, with what the planner claims.
 * @param {import('./types').RunState} state
 * @returns {string}
 */
function priorFindingsBlock(state) {
  const previous = state.reviews[state.reviews.length - 1];
  if (!previous || previous.findings.length === 0) return '';
  const claims = state.draftAddressed;
  const lines = [
    '### Prior findings',
    'The previous review reported these. Re-check each one: report it again **with the same id** if it is still present, or list its id in `resolved` if the plan now handles it.',
    '',
  ];
  for (const finding of previous.findings) {
    const disposition = claims?.dispositions?.[finding.id];
    lines.push(formatFinding(finding) + (disposition ? `\n  Planner says: ${disposition}` : ''));
  }
  return lines.join('\n');
}

/**
 * @param {string[]} errors
 * @returns {string}
 */
function errorList(errors) {
  return errors.length ? errors.map((e) => `- ${e.replace(/\n/g, '\n  ')}`).join('\n') : '- (no detail was recorded)';
}

/**
 * The user message that starts (or restarts) an attempt.
 * @param {import('./types').StageId} role
 * @param {import('./types').SeedKind} seedKind
 * @param {import('./types').RunState} state
 * @param {StageContext & { errors: string[] }} ctx
 * @returns {string}
 */
export function buildSeed(role, seedKind, state, ctx) {
  const artifactFor = role === 'interview' ? ctx.specPath : ctx.planPath;
  if (seedKind === 'continue') {
    const parts = ['Continue this stage from where it stopped. Do not redo work that is already in the conversation.'];
    if (role === 'interview' && state.questionsClosed) parts.push('The user asked you to stop asking questions: write the build spec now.');
    if (role !== 'review') parts.push(`The file for this stage is \`${artifactFor}\`.`);
    parts.push('Finish by calling `report_outcome`.');
    return parts.join(' ');
  }
  if (seedKind === 'errors') {
    if (role === 'review') {
      return `Your review was not recorded:\n${errorList(ctx.errors)}\n\nCall \`report_outcome\` with \`summary\`, \`verdict\` and a \`findings\` array (empty if the plan is ready).`;
    }
    return `Your last save did not pass its checks:\n${errorList(ctx.errors)}\n\nFix these, save the complete file again to \`${artifactFor}\` with \`save_file\`, then call \`report_outcome\`.`;
  }

  const research = ctx.researchUsable ? `\nResearch: \`${ctx.researchPath}\` — evidence and prior art gathered for this plan.` : '';
  switch (role) {
    case 'interview': {
      if (seedKind === 'revise') {
        const notes = state.feedback.spec || '(No notes were given. Tighten whatever is vague and state assumptions plainly.)';
        return [
          `I read the build spec at \`${ctx.specPath}\` and want changes:`,
          '',
          notes,
          '',
          `Update the spec in place and save it to \`${ctx.specPath}\`. Ask a follow-up question only if my notes are ambiguous${ctx.questionBudget > 0 ? ' (at most 3)' : ''}.`,
        ].join('\n');
      }
      const intro = seedKind === 'rework'
        ? `Redo the interview for this request. The current spec is at \`${ctx.specPath}\`: revisit its decisions, then save the updated spec to the same path.`
        : ctx.questionBudget > 0
          ? `Interview me about this request with \`ask_question\` (at most ${ctx.questionBudget} questions, in batches), then write the build spec to \`${ctx.specPath}\`.`
          : `Questions are off for this run. Explore the code, decide open points yourself, and write the build spec to \`${ctx.specPath}\`.`;
      return `${intro}\n\nRequest:\n\n${state.prompt}`;
    }
    case 'research':
      return state.prompt;
    case 'draft': {
      if (seedKind === 'findings') {
        const rounds = reviewsInCycle(state);
        const latest = rounds[rounds.length - 1] ?? state.reviews[state.reviews.length - 1];
        const findings = latest?.findings ?? [];
        const actionable = findings.filter((f) => f.severity !== 'info');
        const notes = findings.filter((f) => f.severity === 'info');
        return [
          `Review round ${latest?.round ?? 1} of ${reviewCycleLimit(state)} found issues in the plan at \`${ctx.planPath}\`. Revise it to fix every blocker and warning.`,
          '',
          actionable.map(formatFinding).join('\n'),
          ...(notes.length ? ['', 'Optional notes:', notes.map(formatFinding).join('\n')] : []),
          '',
          `Keep what already works. Save the complete revised plan to \`${ctx.planPath}\`, then report which findings you addressed by id.`,
        ].join('\n');
      }
      if (seedKind === 'feedback') {
        return [
          `I read the plan at \`${ctx.planPath}\` and want these changes:`,
          '',
          state.feedback.plan || '(No notes were given. Tighten whatever is vague.)',
          '',
          `Revise the plan accordingly and save the complete plan to \`${ctx.planPath}\`.`,
        ].join('\n');
      }
      if (seedKind === 'rework') {
        return `The spec at \`${ctx.specPath}\`${ctx.researchUsable ? ' or the research' : ''} changed since the plan at \`${ctx.planPath}\` was written. Update the plan to match: keep tasks that still apply, rework the rest, and save the complete plan to the same path.${research}\n\nOriginal request:\n\n${state.prompt}`;
      }
      return `Write the build plan for this request:\n\n${state.prompt}\n\nSpec: \`${ctx.specPath}\` — read it first.${research}\nSave the plan to \`${ctx.planPath}\`.`;
    }
    case 'review': {
      const round = reviewsInCycle(state).length + 1;
      return `Review the plan at \`${ctx.planPath}\` (round ${round} of ${Math.max(1, reviewCycleLimit(state))}). Spec: \`${ctx.specPath}\`.${research}\n\nOriginal request:\n\n${state.prompt}`;
    }
    case 'polish':
      return `Polish the interface work in the plan at \`${ctx.planPath}\`. Spec: \`${ctx.specPath}\`.\n\nOriginal request:\n\n${state.prompt}`;
    default:
      return state.prompt;
  }
}

// ── Report tools ─────────────────────────────────────────────────────────────

export const REPORT_TOOL_NAME = 'report_outcome';

const STRING_LIST = { type: 'array', items: { type: 'string' } };

/** @type {Record<string, { description: string, properties: Record<string, unknown>, required: string[] }>} */
const REPORT_SCHEMAS = {
  interview: {
    description: 'Finish the interview after the build spec is saved. Call once.',
    properties: {
      summary: { type: 'string', description: 'One paragraph: what the spec covers.' },
      decisions: { ...STRING_LIST, description: 'Decisions the interview settled.' },
      assumptions: { ...STRING_LIST, description: 'Points you decided without asking.' },
    },
    required: ['summary'],
  },
  draft: {
    description: 'Finish the plan stage after the plan is saved. Call once.',
    properties: {
      summary: { type: 'string', description: 'Waves, task count and the riskiest part of the plan.' },
      addressed: {
        type: 'array',
        description: 'When revising after review: how each finding was handled.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            disposition: { type: 'string', enum: ['fixed', 'partly', 'declined'] },
            note: { type: 'string' },
          },
          required: ['id', 'disposition'],
        },
      },
    },
    required: ['summary'],
  },
  review: {
    description: 'Record the review. Call once, with an empty findings array when the plan is ready.',
    properties: {
      summary: { type: 'string', description: 'Your verdict in two or three sentences.' },
      verdict: { type: 'string', enum: ['ready', 'revise'] },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Reuse a prior finding id when it is still present.' },
            title: { type: 'string' },
            severity: { type: 'string', enum: ['blocker', 'warn', 'info'] },
            detail: { type: 'string', description: 'The problem, with evidence.' },
            fix: { type: 'string', description: 'The concrete change to make in the plan.' },
            paths: STRING_LIST,
          },
          required: ['title', 'severity', 'detail'],
        },
      },
      resolved: { ...STRING_LIST, description: 'Ids of prior findings the plan now handles.' },
    },
    required: ['summary', 'findings'],
  },
  polish: {
    description: 'Finish the polish pass after the plan is saved. Call once.',
    properties: {
      summary: { type: 'string' },
      changes: { ...STRING_LIST, description: 'What you improved.' },
    },
    required: ['summary'],
  },
};

/**
 * @param {import('./types').StageId} role
 * @returns {import('../runner/run-turn').TurnToolDefinition}
 */
export function reportToolFor(role) {
  const schema = REPORT_SCHEMAS[role] ?? REPORT_SCHEMAS.polish;
  return {
    type: 'function',
    function: {
      name: REPORT_TOOL_NAME,
      description: schema.description,
      parameters: { type: 'object', properties: schema.properties, required: schema.required },
    },
  };
}

/**
 * The `ask_question` definition the interviewer sees: richer than the
 * runner's default (option descriptions and a recommended flag).
 * @returns {import('../runner/run-turn').TurnToolDefinition}
 */
export function interviewAskTool() {
  return {
    type: 'function',
    function: {
      name: 'ask_question',
      description:
        'Ask the user a batch of up to 5 related multiple-choice questions shown as one card. Blocks until they answer; returns their choices. Each question needs 2–5 options; mark your choice with "recommended": true. The user can always type their own answer.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short heading for the card, e.g. "Scope".' },
          questions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                prompt: { type: 'string', description: 'The question.' },
                allow_multiple: { type: 'boolean', description: 'true for pick-all-that-apply.' },
                options: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      label: { type: 'string' },
                      description: { type: 'string', description: 'The trade-off of this choice.' },
                      recommended: { type: 'boolean' },
                    },
                    required: ['id', 'label'],
                  },
                },
              },
              required: ['id', 'prompt', 'options'],
            },
          },
        },
        required: ['questions'],
      },
    },
  };
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function strings(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim()) : [];
}

/**
 * A `parseReport` for one stage. The structured payload is handed to
 * `onReport`; the runner only sees a `pass`.
 * @param {import('./types').StageId} role
 * @param {(report: Record<string, unknown>) => void} onReport
 * @returns {import('../runner/run-turn').ParseReport}
 */
export function parseReportFor(role, onReport) {
  return (raw) => {
    let value = raw;
    if (typeof raw === 'string') {
      try {
        value = JSON.parse(raw);
      } catch {
        return { ok: false, error: 'Error: report_outcome arguments must be a JSON object. Retry with valid JSON.' };
      }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'Error: report_outcome needs a JSON object. Retry.' };
    }
    const rec = /** @type {Record<string, unknown>} */ (value);
    const summary = typeof rec.summary === 'string' ? rec.summary.trim() : '';
    if (!summary) return { ok: false, error: 'Error: report_outcome needs a "summary" string. Retry with a summary.' };
    /** @type {Record<string, unknown>} */
    const report = { summary: summary.slice(0, 4000) };
    if (role === 'interview') {
      report.decisions = strings(rec.decisions);
      report.assumptions = strings(rec.assumptions);
    } else if (role === 'draft') {
      const addressed = Array.isArray(rec.addressed) ? rec.addressed : [];
      /** @type {Record<string, string>} */
      const dispositions = {};
      for (const item of addressed) {
        if (!item || typeof item !== 'object') continue;
        const entry = /** @type {Record<string, unknown>} */ (item);
        const id = typeof entry.id === 'string' ? entry.id.trim() : '';
        if (!id) continue;
        const disposition = typeof entry.disposition === 'string' ? entry.disposition.trim() : 'fixed';
        const note = typeof entry.note === 'string' && entry.note.trim() ? ` — ${entry.note.trim()}` : '';
        dispositions[id] = `${disposition}${note}`;
      }
      if (Object.keys(dispositions).length) report.addressed = { findingIds: Object.keys(dispositions), dispositions };
    } else if (role === 'review') {
      if (!Array.isArray(rec.findings)) {
        return { ok: false, error: 'Error: report_outcome needs a "findings" array (empty when the plan is ready). Retry.' };
      }
      const findings = [];
      for (const [index, item] of rec.findings.entries()) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          return { ok: false, error: `Error: findings[${index}] must be an object with title, severity and detail. Retry.` };
        }
        const f = /** @type {Record<string, unknown>} */ (item);
        const title = typeof f.title === 'string' ? f.title.trim() : '';
        if (!title) return { ok: false, error: `Error: findings[${index}] needs a "title". Retry.` };
        const detail = typeof f.detail === 'string' && f.detail.trim() ? f.detail.trim() : title;
        findings.push({
          ...(typeof f.id === 'string' && f.id.trim() ? { id: f.id.trim() } : {}),
          title: title.slice(0, 240),
          severity: normalizeSeverity(f.severity),
          detail: detail.slice(0, 6000),
          ...(typeof f.fix === 'string' && f.fix.trim() ? { fix: f.fix.trim().slice(0, 4000) } : {}),
          paths: strings(f.paths).slice(0, 16),
        });
      }
      report.findings = normalizeFindings(findings);
      report.verdict = rec.verdict === 'ready' || rec.verdict === 'revise' ? rec.verdict : findings.length ? 'revise' : 'ready';
      report.resolved = strings(rec.resolved);
    } else if (role === 'polish') {
      report.changes = strings(rec.changes);
    }
    onReport(report);
    return { ok: true, result: { outcome: 'pass', summary: report.summary, evidence: [] } };
  };
}
