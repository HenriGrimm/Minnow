import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

const ROOT = path.resolve(import.meta.dirname, '..');
const xlsxPath = path.join(ROOT, 'documentation/minnow-model-capability-matrix.xlsx');
const outPath = path.join(ROOT, 'src/benchmark/capabilities/catalog-entries.ts');

fs.mkdirSync(path.dirname(outPath), { recursive: true });

// ── Header maps ──────────────────────────────────────────────────────────────

const GROUP_BY_HEADER_PREFIX = [
  { prefix: 'Streaming', group: 'core-protocol' },
  { prefix: 'Tool calling', group: 'core-protocol' },
  { prefix: 'Parallel tool', group: 'core-protocol' },
  { prefix: 'Multi-step', group: 'core-protocol' },
  { prefix: 'Valid JSON', group: 'core-protocol' },
  { prefix: 'No hallucinated', group: 'core-protocol' },
  { prefix: 'System prompt', group: 'core-protocol' },
  { prefix: 'Long context', group: 'core-protocol' },
  { prefix: 'Vision', group: 'core-protocol' },
  { prefix: 'Reasoning', group: 'core-protocol' },
  { prefix: 'list_directory', group: 'files' },
  { prefix: 'read_document', group: 'files' },
  { prefix: 'save_file', group: 'files' },
  { prefix: 'replace_text', group: 'files' },
  { prefix: 'insert_at_line', group: 'files' },
  { prefix: 'grep / find_files', group: 'files' },
  { prefix: 'create_pdf', group: 'docs' },
  { prefix: 'git_status', group: 'git' },
  { prefix: 'git_add', group: 'git' },
  { prefix: 'execute_command', group: 'code-shell' },
  { prefix: 'Background cmds', group: 'code-shell' },
  { prefix: 'run_javascript', group: 'code-shell' },
  { prefix: 'read_command_log', group: 'code-shell' },
  { prefix: 'Code intel', group: 'code-shell' },
  { prefix: 'get_lsp_diagnostics', group: 'lsp' },
  { prefix: 'web_search', group: 'web' },
  { prefix: 'fetch_web_content', group: 'web' },
  { prefix: 'wikipedia_search', group: 'web' },
  { prefix: 'navigate / tabs', group: 'browser' },
  { prefix: 'snapshot / click', group: 'browser' },
  { prefix: 'eval / screenshot', group: 'browser' },
  { prefix: 'todo_write', group: 'agents-tasks' },
  { prefix: 'spawn_sub_agent', group: 'agents-tasks' },
  { prefix: 'list / get / cancel sub-agents', group: 'agents-tasks' },
  { prefix: 'issue_*', group: 'agents-tasks' },
  { prefix: 'brain_search', group: 'knowledge' },
  { prefix: 'brain_write_page', group: 'knowledge' },
  { prefix: 'minnow_docs_*', group: 'knowledge' },
  { prefix: 'save_memory', group: 'knowledge' },
  { prefix: 'recall_history', group: 'knowledge' },
  { prefix: 'recall_chat_context', group: 'knowledge' },
  { prefix: 'Settings & appearance', group: 'apps' },
  { prefix: 'set_chat_mode', group: 'mode-control' },
  { prefix: 'create_chat_with_mode', group: 'mode-control' },
  { prefix: 'Impeccable', group: 'mode-control' },
  { prefix: 'General', group: 'modes' },
  { prefix: 'Build', group: 'modes' },
  { prefix: 'Plan', group: 'modes' },
  { prefix: 'Super Plan', group: 'modes' },
  { prefix: 'Orchestrate', group: 'modes' },
  { prefix: 'Debug', group: 'modes' },
  { prefix: 'Desktop', group: 'modes' },
  { prefix: 'Onboarding', group: 'modes' },
  { prefix: 'Research', group: 'features' },
  { prefix: 'Compare', group: 'features' },
  { prefix: 'Chat title', group: 'features' },
  { prefix: 'Skills / plugins', group: 'features' },
  { prefix: 'MCP servers', group: 'features' },
  { prefix: 'Voice', group: 'features' },
  { prefix: 'Markdown & code fences', group: 'features' },
];

const ID_BY_HEADER = {
  'Streaming': 'core-streaming',
  'Tool calling (basic)': 'core-tool-calling',
  'Parallel tool calls': 'core-parallel-tools',
  'Multi-step tool loop': 'core-tool-loop',
  'Valid JSON args': 'core-json-args',
  'No hallucinated tools': 'core-no-hallucinated-tools',
  'System prompt adherence': 'core-system-prompt',
  'Long context >32k': 'core-long-context',
  'Vision / image input': 'core-vision',
  'Reasoning / thinking': 'core-reasoning',
  'list_directory / read_file': 'files-list-read',
  'read_document': 'files-read-document',
  'save_file / append_file': 'files-save-append',
  'replace_text_in_file': 'files-replace-text',
  'insert_at_line / read_file_range': 'files-insert-range',
  'grep / find_files': 'files-grep',
  'create_pdf / spreadsheet / word': 'docs-create-office',
  'git_status / diff / log (read)': 'git-read',
  'git_add / commit / branch (write)': 'git-write',
  'execute_command': 'code-execute-command',
  'Background cmds / dev servers': 'code-background-cmds',
  'run_javascript / run_python': 'code-run-js-py',
  'read_command_log / stop_command': 'code-command-log',
  'Code intel (repo_map, find_symbol)': 'code-repo-intel',
  'get_lsp_diagnostics / list_lsp_servers': 'lsp-diagnostics',
  'web_search': 'web-search',
  'fetch_web_content / rag_web_content': 'web-fetch',
  'wikipedia_search': 'web-wikipedia',
  'navigate / tabs': 'browser-navigate',
  'snapshot / click / fill': 'browser-snapshot',
  'eval / screenshot': 'browser-eval',
  'todo_write': 'agents-todo-write',
  'spawn_sub_agent': 'agents-spawn-sub-agent',
  'list / get / cancel sub-agents': 'agents-sub-agent-control',
  'issue_* tools': 'agents-issue-tools',
  'brain_search / read_page / list': 'knowledge-brain-read',
  'brain_write_page / append_log / ingest': 'knowledge-brain-write',
  'minnow_docs_*': 'knowledge-minnow-docs',
  'save_memory': 'knowledge-save-memory',
  'recall_history': 'knowledge-recall',
  // Header before compaction v2 retired the archive recall tools.
  'recall_chat_context / recall_turn_full': 'knowledge-recall',
  'Settings & appearance tools': 'apps-settings-appearance',
  'set_chat_mode / propose_mode_switch': 'mode-set-chat-mode',
  'create_chat_with_mode / launch app': 'mode-create-chat',
  'Impeccable / aesthetics': 'mode-impeccable',
  'General': 'modes-general',
  'Build': 'modes-build',
  'Plan': 'modes-plan',
  'Super Plan': 'modes-super-plan',
  'Orchestrate': 'modes-orchestrate',
  'Debug': 'modes-debug',
  'Desktop': 'modes-desktop',
  'Onboarding': 'modes-onboarding',
  'Research': 'features-research',
  'Compare': 'features-compare',
  'Chat title generation': 'features-chat-title',
  'Skills / plugins': 'features-skills',
  'MCP servers': 'features-mcp',
  'Voice': 'features-voice',
  'Markdown & code fences': 'features-markdown',
};

const MANUAL_IDS = new Set([
  'features-research',
  'features-compare',
  'features-mcp',
  'features-voice',
]);

const MANUAL_REASONS = {
  'features-research': 'Research runs are long-lived jobs with sources to inspect manually.',
  'features-compare': 'Compare sessions need two models side by side in the Compare app.',
  'features-mcp': 'MCP servers are user-configured, so there is no built-in tool to probe.',
  'features-voice': 'Voice round trip needs microphone hardware and UI capture.',
};

const AUTO_SCOPE_NOTES = {
  'browser-navigate': 'Probe scores the tool calls the model emits; the browser pane is stubbed.',
  'browser-snapshot':
    'Probe scores snapshot-then-act ordering and ref reuse against a stubbed page.',
  'browser-eval': 'Probe scores the emitted screenshot/eval calls; the browser pane is stubbed.',
  'agents-sub-agent-control': 'Probe scores list-then-cancel against a stubbed running agent.',
  'knowledge-recall': 'Probe scores whether the model calls a recall tool instead of guessing.',
};

const SKIP_GROUP = 'modes';
/** Removed Email app probes — skip leftover spreadsheet columns. */
const SKIP_HEADERS = new Set([
  'Email: list / search / get_thread',
  'Email: draft_reply / email_action',
  'summarize_inbox / reply_variants',
]);

// ── Parsers ──────────────────────────────────────────────────────────────────

function parseTier(comment) {
  const m = comment.match(/Tier (\d)/);
  return m ? Number(m[1]) : 2;
}

function parseHowToTest(comment) {
  const idx = comment.indexOf('How to test:');
  if (idx === -1) return comment.trim();
  return comment.slice(idx + 'How to test:'.length).trim();
}

function inferGroup(header) {
  for (const row of GROUP_BY_HEADER_PREFIX) {
    if (header.startsWith(row.prefix) || header.includes(row.prefix)) return row.group;
  }
  throw new Error(`no group for ${header}`);
}

function buildPrompt(howToTest) {
  const quoted = howToTest.match(/^'([^']+)'/);
  if (quoted) return quoted[1];
  const asked = howToTest.match(/^Ask ('([^']+)'|[^.]+?)\s*(?:->|\.|$)/i);
  if (asked) {
    const body = (asked[2] ?? asked[1]).trim().replace(/\.$/, '');
    if (/^(for|a|an|the|it)\b/i.test(body) || /[([]$/.test(body)) return howToTest;
    return body.charAt(0).toUpperCase() + body.slice(1);
  }
  return howToTest;
}

// ── Sheet walk ───────────────────────────────────────────────────────────────

const wb = XLSX.readFile(xlsxPath, { cellComments: true });
const sheet = wb.Sheets['Cloud'];
const range = XLSX.utils.decode_range(sheet['!ref']);
const entries = [];

for (let C = 10; C <= range.e.c; C++) {
  const addr = XLSX.utils.encode_cell({ r: 2, c: C });
  const cell = sheet[addr];
  if (!cell?.v) continue;
  const header = String(cell.v).trim();
  if (header === 'Blocking issues' || header === 'Notes') break;
  if (SKIP_HEADERS.has(header) || header.startsWith('Email:')) continue;
  const comment = cell.c?.[0]?.t ?? '';
  const tier = parseTier(comment);
  const howToTest = parseHowToTest(comment);
  const id = ID_BY_HEADER[header];
  if (!id) throw new Error(`missing id for ${header}`);
  const group = inferGroup(header);
  if (group === SKIP_GROUP) continue;
  const scoreMode = MANUAL_IDS.has(id) ? 'manual' : 'auto';
  const prompt = buildPrompt(howToTest);
  const setup =
    scoreMode === 'manual'
      ? 'Open Minnow with the target model active; use the capability matrix manual test path.'
      : 'Benchmark scratch workspace with tool server running; capability-matrix fixtures seeded when required.';
  const scopeNote = AUTO_SCOPE_NOTES[id] ? ` ${AUTO_SCOPE_NOTES[id]}` : '';
  const passCriteria =
    scoreMode === 'manual'
      ? 'Human marks ✅ works, ⚠️ partial, ❌ broken, or ➖ not applicable per the matrix legend.'
      : `Automated probe returns pass, partial, or fail; n-a when requirements (vision, LSP, workspace, mode prompt) are missing.${scopeNote}`;

  entries.push({
    id,
    group,
    header,
    tier,
    scoreMode,
    howToTest,
    setup,
    prompt,
    passCriteria,
    manualReason: MANUAL_REASONS[id],
  });
}

if (entries.length !== 52) throw new Error(`expected 52 entries, got ${entries.length}`);
const autoCount = entries.filter((e) => e.scoreMode === 'auto').length;
if (autoCount !== 48) throw new Error(`expected 48 auto, got ${autoCount}`);

// ── Write file ───────────────────────────────────────────────────────────────

const lines = [
  '/**',
  ' * Spreadsheet-ordered capability metadata (no probe bindings).',
  ' * Generated by scripts/gen-capability-catalog-entries.mjs — do not hand-edit ids.',
  ' */',
  '',
  'import type { CapabilityGroupId, CapabilityScoreMode } from "./types.ts";',
  '',
  'export interface CapabilityCatalogEntry {',
  '  id: string;',
  '  group: CapabilityGroupId;',
  '  header: string;',
  '  tier: 1 | 2 | 3;',
  '  scoreMode: CapabilityScoreMode;',
  '  howToTest: string;',
  '  setup: string;',
  '  prompt: string;',
  '  passCriteria: string;',
  '  manualReason?: string;',
  '}',
  '',
  'export const CAPABILITY_CATALOG_ENTRIES: CapabilityCatalogEntry[] = ',
  JSON.stringify(entries, null, 2).replace(/"tier": (\d)/g, 'tier: $1'),
  ';',
  '',
];

fs.writeFileSync(outPath, lines.join('\n'));
console.log(`Wrote ${entries.length} entries to ${outPath}`);
