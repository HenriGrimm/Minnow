/**
 * Per built-in skill: trigger prompt, pass kind, and scoring rules for the Skills suite.
 */

import { getToolById } from '../../tools/definitions.ts';
import type { OpenAIFunctionDefinition } from '../../tools/definitions.ts';
import type { ToolCall } from '../../types.ts';
import { regexMatch, toolNameMatch } from '../scoring.ts';
import type { BenchmarkRunContext } from '../types.ts';

/** How a skill probe decides pass/fail. */
export type SkillPassKind = 'regex' | 'tool' | 'tool-or-regex';

export interface SkillProbe {
  skillId: string;
  prompt: string;
  passKind: SkillPassKind;
  /** Required for regex and tool-or-regex text fallback. */
  pattern?: RegExp;
  /** Required for tool and tool-or-regex; any listed tool name satisfies. */
  expectedTools?: string[];
  /** When set, at least one matching tool call must satisfy this predicate. */
  expectToolArgs?: (toolName: string, args: Record<string, unknown>) => boolean;
  /** Minimal tool allowlist passed to the model (resolved to OpenAI definitions). */
  toolIds?: string[];
  /** Skip when tool server is not up (`npm start`). */
  requiresLocalServer?: boolean;
  /** Optional skip predicate (e.g. browser CDP unavailable). */
  skipWhen?: (ctx: BenchmarkRunContext) => string | null;
}

function askQuestionArgsValid(args: Record<string, unknown>): boolean {
  const questions = args.questions;
  if (!Array.isArray(questions) || questions.length === 0) return false;
  const first = questions[0] as Record<string, unknown>;
  if (typeof first.prompt !== 'string' || !first.prompt.trim()) return false;
  const options = first.options;
  return (
    Array.isArray(options) &&
    options.length >= 2 &&
    options.every(
      (o) =>
        o &&
        typeof o === 'object' &&
        typeof (o as { id?: unknown }).id === 'string' &&
        typeof (o as { label?: unknown }).label === 'string',
    )
  );
}

/** One probe per built-in skill id in `builtin-manifest.json`. */
export const SKILL_PROBES: Record<string, SkillProbe> = {
  'build-plugin': {
    skillId: 'build-plugin',
    prompt: 'Before building a Minnow plugin, load the current authoring contract. Call plugin_inspect with docs=true. Use the tool only.',
    passKind: 'tool', expectedTools: ['plugin_inspect'], toolIds: ['plugin_inspect'],
    expectToolArgs: (name, args) => name === 'plugin_inspect' && args.docs === true,
  },
  'ask-user': {
    skillId: 'ask-user',
    prompt:
      'I need to choose between REST and GraphQL for a small API. Call ask_question now with 2–4 structured questions (each needs prompt and options as {id, label}). Use the tool only.',
    passKind: 'tool',
    expectedTools: ['ask_question'],
    toolIds: ['ask_question'],
    expectToolArgs: (name, args) => name === 'ask_question' && askQuestionArgsValid(args),
  },
  'explain-code': {
    skillId: 'explain-code',
    prompt: 'Explain what Array.prototype.map does in one short paragraph for a junior developer.',
    passKind: 'regex',
    pattern: /\bmap\b.*\b(callback|element|array)\b|\bcallback\b.*\bmap\b/i,
  },
  'debug-error': {
    skillId: 'debug-error',
    prompt:
      'A tool failed with Error: ENOENT: no such file or directory. List the first three checks you would run.',
    passKind: 'regex',
    pattern: /ENOENT|path|file|exist|missing|read_file|list_directory/i,
  },
  impeccable: {
    skillId: 'impeccable',
    prompt:
      'The login button on the settings page feels cramped against the card edge. What visual changes would you suggest?',
    passKind: 'regex',
    pattern: /spacing|padding|margin|layout|hierarchy|touch|align|button|visual/i,
  },
  'browser-automation': {
    skillId: 'browser-automation',
    prompt:
      'Before navigating externally, what do you check first for Chrome CDP? Call browser_list now. Use the tool only.',
    passKind: 'tool',
    expectedTools: ['browser_list'],
    toolIds: ['browser_list'],
    requiresLocalServer: true,
  },
  caveman: {
    skillId: 'caveman',
    prompt:
      'Why does a React component re-render when an inline object is passed as a prop? Answer in caveman full mode: short fragments, no filler, no pleasantries.',
    passKind: 'regex',
    pattern:
      /re-?render|ref|useMemo|object|prop|inline|memo/i,
  },
  'code-review': {
    skillId: 'code-review',
    prompt: `Review this snippet and respond using the skill output format (Summary plus at least one findings section):

\`\`\`ts
export function divide(a: number, b: number) {
  return a / b;
}
\`\`\``,
    passKind: 'regex',
    pattern: /##\s*(Summary|Blockers|Suggestions|Nits)\b/i,
  },
  'docs-update': {
    skillId: 'docs-update',
    prompt:
      'We shipped a new GET /api/benchmarks route. Which Minnow docs files should you update first and what sections would you touch?',
    passKind: 'regex',
    pattern: /context\.md|README|documentation\/|architecture|API|route/i,
  },
  'git-commit': {
    skillId: 'git-commit',
    prompt:
      'I may have staged fixes. Call git_status first, then suggest a conventional commit subject line for a bugfix (imperative, ≤72 chars). Use git tools when needed.',
    passKind: 'tool-or-regex',
    expectedTools: ['git_status', 'git_diff'],
    toolIds: ['git_status', 'git_diff'],
    pattern: /^(feat|fix|docs|style|refactor|test|chore)(\(.+\))?:\s+\S+/im,
  },
  'create-pr': {
    skillId: 'create-pr',
    prompt:
      'The branch is pushed and ready. What git/gh steps do you run to open a GitHub pull request with a clear title and body?',
    passKind: 'regex',
    pattern: /git push|gh pr create|pull request|origin|upstream/i,
  },
  'fix-ci': {
    skillId: 'fix-ci',
    prompt:
      'GitHub Actions failed on my feature branch after the last push. What is your first step to investigate and green CI?',
    passKind: 'regex',
    pattern: /gh run|workflow|log-failed|git branch|commit|tsc|npm test|check-coverage|repro/i,
  },
  'plan-work': {
    skillId: 'plan-work',
    prompt:
      'I want an implementation plan for adding keyboard shortcut docs for a new feature. What do you do first before writing documentation/plans/?',
    passKind: 'regex',
    pattern: /documentation\/plans|ask_question|ask-user|interview|scope|phase|spawn_sub_agent|explore|context\.md/i,
  },
  'orchestrate-plan': {
    skillId: 'orchestrate-plan',
    prompt:
      'Execute documentation/plans/example.md phase by phase using sub-agents only. What is your role and what must happen after each implement phase?',
    passKind: 'regex',
    pattern: /spawn_sub_agent|wait:\s*true|verif|delegate|documentation\/plans|do not implement|sub-agent/i,
  },
  'refactor-safe': {
    skillId: 'refactor-safe',
    prompt:
      'I want to extract a helper from a 200-line function without changing behavior. Outline your refactor-safe steps in order.',
    passKind: 'regex',
    pattern: /test|behavior|minimal|small|diff|incremental|verify/i,
  },
  'security-review': {
    skillId: 'security-review',
    prompt:
      'Review for security: `const q = "SELECT * FROM users WHERE id=" + req.params.id`. Name the top risks and mitigations.',
    passKind: 'regex',
    pattern: /SQL|injection|parameter|sanitize|validate|OWASP|secret|bind/i,
  },
  'ui-designer': {
    skillId: 'ui-designer',
    prompt:
      'Audit the Minnow chat header spacing. What is your first concrete step per the UI designer skill (tools or capture)?',
    passKind: 'regex',
    pattern: /screenshot|browser_|read_file|PRODUCT|DESIGN|impeccable|spacing|audit|capture/i,
  },
  'write-tests': {
    skillId: 'write-tests',
    prompt:
      'I need a unit test for a date-formatting helper. Which principles from the write-tests skill must the test follow?',
    passKind: 'regex',
    pattern: /deterministic|hardcoded|fixture|node --test|repeatable|static expected/i,
  },
  'git-setup': {
    skillId: 'git-setup',
    prompt:
      'This folder has code but no git history. What git-setup steps do you run before connecting GitHub?',
    passKind: 'regex',
    pattern: /git init|remote|GitHub|repository|version control|branch/i,
  },
  partymode: {
    skillId: 'partymode',
    prompt:
      'Party mode on: explain why async iterators are cool. Stay in Bird Man persona with maximum vibes.',
    passKind: 'regex',
    pattern: /Bird Man|party|vibes|dude|bro|async|iterator/i,
  },
};

export function getSkillProbe(skillId: string): SkillProbe {
  const probe = SKILL_PROBES[skillId];
  if (!probe) {
    return {
      skillId,
      prompt: `Apply the ${skillId} skill to the user request. Follow the skill instructions; do not only acknowledge them.`,
      passKind: 'regex',
      pattern: new RegExp(skillId.replace(/-/g, '[\\s-]'), 'i'),
    };
  }
  return probe;
}

export function listSkillProbeIds(): string[] {
  return Object.keys(SKILL_PROBES);
}

/** OpenAI tool definitions for a probe allowlist (unknown ids omitted). */
export function resolveSkillProbeTools(probe: SkillProbe): OpenAIFunctionDefinition[] {
  if (!probe.toolIds?.length) return [];
  const defs: OpenAIFunctionDefinition[] = [];
  for (const id of probe.toolIds) {
    const tool = getToolById(id);
    if (tool) defs.push(tool.definition);
  }
  return defs;
}

export function resolveSkillProbeSkip(
  probe: SkillProbe,
  ctx: BenchmarkRunContext,
): string | null {
  if (probe.requiresLocalServer && !ctx.localServer) {
    return 'needs npm start (tool server)';
  }
  return probe.skipWhen?.(ctx) ?? null;
}

export interface SkillProbeEvaluation {
  passed: boolean;
  details: string;
}

function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}') as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {}
  return {};
}

function toolProbePassed(
  probe: SkillProbe,
  toolCalls: ToolCall[],
): { ok: boolean; details: string } {
  const expected = probe.expectedTools ?? [];
  if (expected.length === 0) {
    return { ok: false, details: 'probe misconfigured: no expectedTools' };
  }

  const matchedName = expected.find((name) => toolNameMatch(toolCalls, name));
  if (!matchedName) {
    const names = toolCalls.map((tc) => tc.function.name).join(', ') || '(none)';
    return { ok: false, details: `expected ${expected.join('|')}, got ${names}` };
  }

  if (probe.expectToolArgs) {
    const call = toolCalls.find((tc) => tc.function.name === matchedName);
    const args = parseToolArgs(call?.function.arguments ?? '');
    if (!probe.expectToolArgs(matchedName, args)) {
      return { ok: false, details: `${matchedName} args invalid` };
    }
    return { ok: true, details: `${matchedName} called with valid args` };
  }

  return { ok: true, details: `${matchedName} called` };
}

/** Score a completed one-shot or tool-loop turn against the probe definition. */
export function evaluateSkillProbe(
  probe: SkillProbe,
  out: { text: string; toolCalls: ToolCall[] },
): SkillProbeEvaluation {
  const text = out.text.trim();

  if (probe.passKind === 'tool') {
    const toolResult = toolProbePassed(probe, out.toolCalls);
    return { passed: toolResult.ok, details: toolResult.details };
  }

  if (probe.passKind === 'tool-or-regex') {
    const toolResult = toolProbePassed(probe, out.toolCalls);
    if (toolResult.ok) return { passed: true, details: toolResult.details };
    if (probe.pattern && text && regexMatch(text, probe.pattern)) {
      return { passed: true, details: 'commit subject matched regex' };
    }
    if (!text) {
      return { passed: false, details: `empty response; ${toolResult.details}` };
    }
    return {
      passed: false,
      details: `${toolResult.details}; text did not match pattern`,
    };
  }

  if (!text) {
    return { passed: false, details: 'empty response' };
  }
  if (!probe.pattern) {
    return { passed: false, details: 'probe misconfigured: no pattern' };
  }
  const passed = regexMatch(text, probe.pattern);
  return {
    passed,
    details: passed ? 'text matched skill pattern' : 'text did not match skill pattern',
  };
}

/** Human-readable pass line for benchmark test cards. */
export function formatSkillPassCriteria(probe: SkillProbe): string {
  if (probe.passKind === 'tool') {
    const tools = (probe.expectedTools ?? []).join(' or ');
    const argsNote = probe.expectToolArgs ? ' with valid tool arguments' : '';
    const serverNote = probe.requiresLocalServer ? ' Skips when tool server is down.' : '';
    return `Model calls \`${tools}\`${argsNote}.${serverNote}`;
  }
  if (probe.passKind === 'tool-or-regex') {
    const tools = (probe.expectedTools ?? []).join(' or ');
    return `Model calls \`${tools}\` or reply matches the skill-specific regex (e.g. conventional commit subject).`;
  }
  return 'Non-empty assistant reply matches the skill-specific regex (observable skill behavior, not acknowledgment only).';
}
