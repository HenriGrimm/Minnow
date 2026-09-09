/**
 * Authored user messages for every auto capability probe.
 *
 * The spreadsheet-derived `prompt` column is a *description of a test* ("Exercise: Valid
 * JSON args. Watch the tool console for parse failures…"), not something a model can act
 * on. Sending it asks the model to introspect instead of perform, so every prompt is
 * authored here and the catalog column is only a fallback for rows without one.
 *
 * Rules for prompts in this file:
 * - phrase a task, never the pass criteria (no "must emit get_datetime")
 * - never contain the answer the verdict looks for (see `core-long-context`)
 * - reference seeded fixture paths, never the Minnow repo tree
 */

import {
  CAP_MATRIX_GREP_TOKEN,
  CAP_MATRIX_HAYSTACK_LABEL,
  CAP_MATRIX_HAYSTACK_NEEDLE,
  CAP_MATRIX_JSON_PATH,
  CAP_MATRIX_NOTES_PATH,
  CAP_MATRIX_REPLACE_PATH,
  CAP_MATRIX_PDF_PATH,
  CAP_MATRIX_REPO_DIR,
  CAP_MATRIX_SAMPLE_FN,
  CAP_MATRIX_SAMPLE_PATH,
  CAPABILITY_MATRIX_FIXTURE_DIR,
} from './fixture-paths.ts';

/**
 * Baseline system prompt for every auto probe.
 *
 * Probes used to send a bare user message with no system message at all, while a real chat
 * turn always carries a composed prompt. A reasoning model handed a context-free
 * instruction deliberates about what is even being asked, which is what made the slowest
 * rows time out. This is a faithful subset of what chat sends — the neutral lines from
 * `chat/prompts/base/default.lite.md` and `chat/prompts/tool-usage/default.lite.md` — and
 * nothing else. Do not add guidance here that hints at what any verdict checks for.
 */
export const CAPABILITY_PROBE_SYSTEM_PROMPT = [
  'You are **Minnow**, a local-first AI assistant.',
  '',
  '- Be concise. No preamble, no closing summary.',
  '- Be honest about uncertainty.',
  '- Never invent tool results. Report actual errors.',
  '- Read before write. Search before claiming something exists.',
  '- Most specific tool wins (e.g. `read_file` > `cat`).',
  '- Independent calls in parallel; dependent calls sequential.',
  '- One-line summary after a tool sequence, not a transcript.',
].join('\n');

/**
 * Inline haystack size — comfortably past the 32k-token bar the row is named for.
 *
 * At 146 chars/line this is ~34k estimated tokens. It was 2600 lines (~95k tokens), nearly
 * three times what this row claims to test: `core-long-context` then spent 273s of a 300s
 * budget on prompt processing alone and measured the host's patience, not the model's
 * recall. Keep the arithmetic in view when changing this.
 */
const LONG_CONTEXT_FILLER_LINES = 930;

/**
 * Values `code-run-js-py` asks the model to average, with the answer derived from them.
 *
 * The prompt and the verdict used to hardcode their own numbers and drifted: the list
 * below averages 23.25, the verdict looked for 22.5, and every correct model scored
 * partial. Both sides now read the same array.
 */
export const CAP_MATRIX_MEAN_VALUES = [
  12, 14, 15, 16, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33,
] as const;

/** Mean of `CAP_MATRIX_MEAN_VALUES`, as the model would print it. */
export const CAP_MATRIX_MEAN_EXPECTED = String(
  CAP_MATRIX_MEAN_VALUES.reduce((sum, n) => sum + n, 0) / CAP_MATRIX_MEAN_VALUES.length,
);

/**
 * Build the `core-long-context` message: ~34k tokens of filler with one labelled needle
 * roughly 60% in. The haystack rides in the prompt (not a file) so the row measures the
 * model's context window rather than the host's `read_file` cap.
 */
export function buildLongContextPrompt(): string {
  const filler = 'ledger entry alpha beta gamma delta epsilon zeta eta theta iota kappa';
  const lines: string[] = [];
  for (let i = 1; i <= LONG_CONTEXT_FILLER_LINES; i += 1) {
    lines.push(`${String(i).padStart(5, '0')} ${filler} ${filler}`);
  }
  lines.splice(
    Math.floor(LONG_CONTEXT_FILLER_LINES * 0.6),
    0,
    `${CAP_MATRIX_HAYSTACK_LABEL}: ${CAP_MATRIX_HAYSTACK_NEEDLE}`,
  );
  return [
    'Here is an archive dump. One line in it is tagged with a marker label.',
    '',
    lines.join('\n'),
    '',
    `End of dump. Reply with only the value that follows "${CAP_MATRIX_HAYSTACK_LABEL}:" in that dump.`,
  ].join('\n');
}

/** Workspace-backed probes (fixtures seeded under the benchmark workspace). */
const WORKSPACE_PROBE_PROMPTS: Record<string, string> = {
  'files-list-read': `List the files in ${CAPABILITY_MATRIX_FIXTURE_DIR} and read ${CAP_MATRIX_JSON_PATH}.`,
  'files-read-document': `Use read_document on ${CAP_MATRIX_PDF_PATH} and summarize the body in one sentence.`,
  'files-save-append': `Create ${CAP_MATRIX_NOTES_PATH} with three markdown bullets (- one, - two, - three), then append a fourth bullet (- four).`,
  'files-replace-text': `In ${CAP_MATRIX_REPLACE_PATH}, replace the exact line "- beta item" with "- BETA item" using replace_text_in_file.`,
  'files-insert-range': `Read lines 40-60 of ${CAP_MATRIX_SAMPLE_PATH}, then insert "// cap-matrix probe" at line 41.`,
  'files-grep': `Find every file under ${CAPABILITY_MATRIX_FIXTURE_DIR} that mentions ${CAP_MATRIX_GREP_TOKEN}.`,
  'docs-create-office': `Create a spreadsheet at ${CAPABILITY_MATRIX_FIXTURE_DIR}/fruit.xlsx with one row per fruit: apple 3, pear 5, plum 2.`,
  'git-read': `In ${CAP_MATRIX_REPO_DIR}, what has changed on the current branch?`,
  'git-write': `Commit the current changes in ${CAP_MATRIX_REPO_DIR} on a new branch named cap-matrix-probe.`,
  'code-execute-command': 'Run `node -e "console.log(9*7)"` and report the printed number.',
  'code-background-cmds':
    'Start `node -e "setInterval(()=>console.log(\'cap-matrix-heartbeat\'),400)"` as a background process, then stop it once it is running.',
  'code-run-js-py': `Use run_python to compute the mean of: ${CAP_MATRIX_MEAN_VALUES.join(', ')}.`,
  'code-command-log':
    'Start a background node process that prints cap-matrix-log-line every 300ms, read the tail of its log, then stop it.',
  'code-repo-intel': `In ${CAP_MATRIX_SAMPLE_PATH}, where is ${CAP_MATRIX_SAMPLE_FN} defined and who calls it?`,
  'core-parallel-tools': `Read these three files in one turn if your host allows parallel tool calls: ${CAP_MATRIX_JSON_PATH}, ${CAP_MATRIX_NOTES_PATH}, and ${CAP_MATRIX_SAMPLE_PATH}.`,
  'core-tool-loop': `List ${CAPABILITY_MATRIX_FIXTURE_DIR}/a/. List the subdirectory inside it. Read the json file there. Grep under ${CAPABILITY_MATRIX_FIXTURE_DIR}/ for ${CAP_MATRIX_GREP_TOKEN}. Read the file grep reports. Summarize in one sentence.`,
  'lsp-diagnostics': `Call get_lsp_diagnostics for ${CAP_MATRIX_SAMPLE_PATH} and report what the language server says.`,
};

/** Core-protocol, emit-only, and text-shape probes (no workspace needed). */
const STANDALONE_PROBE_PROMPTS: Record<string, string> = {
  'core-streaming':
    'Write about 200 words on why local-first software matters. Plain prose, no lists.',
  'core-tool-calling': 'What time is it right now?',
  'core-json-args': `Search for the string TODO under the ${CAPABILITY_MATRIX_FIXTURE_DIR} folder, and tell me the current time in UTC.`,
  'core-no-hallucinated-tools':
    'Post a status update to our Slack channel, set a reminder for tomorrow at 9am, and tell me the current time.',
  'core-system-prompt':
    'Reply with exactly three words and nothing else: the three primary additive colours, lowercase, comma-separated.',
  'core-reasoning':
    'A bat and a ball cost $1.10 together. The bat costs $1.00 more than the ball. How much does the ball cost? Give the final answer only.',
  'core-vision': 'Describe what is in this image.',

  'web-search': 'Search the web for the latest llama.cpp release and tell me the version.',
  'web-fetch':
    'Fetch https://example.com and summarize what that page says in one sentence.',
  'web-wikipedia': 'Look up the Mariana Trench on Wikipedia and tell me how deep it is.',

  'agents-todo-write':
    'I need five things done: audit the config loader, write a migration, update the docs, add tests, then tag a release. Track this work as a checklist and keep it current as you go, starting the first item now.',
  'agents-spawn-sub-agent':
    'Spawn a sub-agent to audit the tool catalog and report back with what it finds.',
  'agents-issue-tools':
    'Log an issue titled "Grid header overlaps on narrow panes", then link it to issue ISS-1.',
  'agents-issue-tools-v2':
    'Search issues for "grid overlap", add a comment on the first match, then assign it to me.',

  'knowledge-brain-read': 'What does the Brain say about the session engine?',
  'knowledge-brain-write': [
    'We just finished reviewing the session engine. Save these notes to a Brain page titled "Session Engine Notes":',
    '',
    '- Sessions are keyed by conversation id; resuming replays stored turns from local storage, not the provider context window.',
    '- Partial assistant messages during stream abort are marked incomplete so the UI can offer retry.',
    '- Tool call results are persisted as structured JSON alongside each assistant turn.',
    '- Edge case: switching models mid-session keeps history but drops provider-specific reasoning channels.',
  ].join('\n'),
  'knowledge-minnow-docs': 'How do Minnow modes work? Check the Minnow docs.',
  'knowledge-save-memory': 'Remember that I always want tests run before commits.',
  'knowledge-recall':
    'Earlier in this conversation I gave you a deployment checklist. What was the third item on it? Look it up in the conversation history instead of guessing.',

  'apps-settings-appearance': 'Switch me to the dark theme and raise the font size.',

  'mode-set-chat-mode':
    'This conversation is turning into a real build job rather than a chat. Switch me to the right mode for that.',
  'mode-create-chat': 'Open a new Plan chat about the 0.1 release.',
  'mode-impeccable':
    'Make this settings page look better — the spacing and hierarchy feel off.',

  'browser-navigate': 'Open example.com in a new browser tab, then list my open tabs.',
  'browser-snapshot':
    'Snapshot the current page, then fill its search box with foo and submit it.',
  'browser-eval':
    'Take a screenshot of the current page and tell me its computed background colour.',

  'agents-sub-agent-control':
    'What are my sub-agents doing right now? Cancel the one that is still running.',

  'features-chat-title':
    'Suggest a short title for a chat where the user debugged a failing IMAP sync and fixed a UID gap. Reply with the title only.',
  'features-skills': 'Invoke the impeccable skill and follow it.',
  'features-markdown':
    'Show me a TypeScript snippet that debounces a function, with a short table of its parameters.',
};

/** Every authored probe prompt keyed by capability id. */
export const CAPABILITY_PROBE_PROMPTS: Record<string, string> = {
  ...WORKSPACE_PROBE_PROMPTS,
  ...STANDALONE_PROBE_PROMPTS,
};

/** Capability ids whose prompt is generated at call time (too large to inline). */
const LAZY_PROMPT_BUILDERS: Record<string, () => string> = {
  'core-long-context': buildLongContextPrompt,
};

/** Authored user message for a probe; undefined when the row has none. */
export function getCapabilityProbePrompt(capabilityId: string): string | undefined {
  const lazy = LAZY_PROMPT_BUILDERS[capabilityId];
  if (lazy) return lazy();
  return CAPABILITY_PROBE_PROMPTS[capabilityId];
}

/** True when the row has an authored prompt (eager or lazy) — asserted by tests. */
export function hasCapabilityProbePrompt(capabilityId: string): boolean {
  return (
    capabilityId in CAPABILITY_PROBE_PROMPTS || capabilityId in LAZY_PROMPT_BUILDERS
  );
}
