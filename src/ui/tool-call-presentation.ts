import { parseGitLogOneline } from '../chat/issues/git-helpers';
import { parseListDirectoryResult } from '../lib/list-directory-parse';
import { BUILT_IN_TOOLS, type ToolCategory } from '../tools/definitions';
import type { IconName } from './icon';

const TOOL_CATEGORY_BY_ID = new Map(BUILT_IN_TOOLS.map((t) => [t.id, t.category]));

/** Fallback glyph when a tool has no dedicated icon. */
const CATEGORY_ICON: Record<ToolCategory, IconName> = {
  web: 'globe',
  utility: 'tools',
  files: 'folder',
  git: 'gitBranch',
  code: 'terminal',
  agents: 'appAgentActivity',
  browser: 'browser',
  lsp: 'appCode',
};

/** Dedicated glyph per tool. */
const TOOL_ICON: Record<string, IconName> = {
  get_datetime: 'appCalendar',
  calculate: 'appStats',
  ask_question: 'help',
  set_chat_mode: 'modeGeneral',
  propose_mode_switch: 'modeGeneral',
  create_chat_with_mode: 'appChat',
  launch_minnow_app: 'dock',
  read_clipboard: 'attach',
  write_clipboard: 'attach',
  get_system_info: 'deviceDesktop',
  todo_write: 'check',
  save_memory: 'brainMemories',
  recall_chat_context: 'thinkingBrain',
  recall_turn_full: 'thinkingBrain',
  search_settings: 'appSettings',
  get_settings: 'appSettings',
  update_settings: 'appSettings',
  read_diagnostics: 'appConsole',
  get_appearance: 'designMode',
  update_appearance: 'designMode',
  upload_appearance_asset: 'designMode',
  load_impeccable_context: 'designMode',
  load_aesthetics_reference: 'designMode',
  run_impeccable: 'designMode',

  web_search: 'search',
  wikipedia_search: 'appResearch',
  fetch_web_content: 'globe',
  rag_web_content: 'appResearch',

  list_directory: 'folder',
  find_files: 'search',
  read_file: 'fileText',
  read_file_range: 'fileText',
  read_document: 'fileText',
  get_file_metadata: 'fileText',
  save_file: 'save',
  append_file: 'plus',
  insert_at_line: 'plus',
  replace_text_in_file: 'edit',
  search_in_file: 'search',
  grep: 'search',
  make_directory: 'addFolder',
  move_file: 'move',
  copy_file: 'fileText',
  delete_path: 'trash',
  create_pdf: 'fileText',
  create_word_document: 'fileText',
  create_spreadsheet: 'grid',

  git_status: 'gitLocal',
  git_diff: 'gitLocal',
  git_log: 'gitGraph',
  git_add: 'plus',
  git_commit: 'gitCommit',
  git_checkout: 'gitBranch',
  git_branch: 'gitBranch',

  execute_command: 'terminal',
  start_background_command: 'terminal',
  stop_command: 'stop',
  stop_background_command: 'stop',
  read_command_log: 'appConsole',
  list_running_commands: 'appConsole',
  manage_dev_servers: 'appDevServer',
  run_javascript: 'appCode',
  run_python: 'appCode',

  spawn_sub_agent: 'appAgentActivity',
  cancel_sub_agent: 'stop',
  list_sub_agents: 'appAgentActivity',
  get_sub_agent_status: 'appAgentActivity',
  issue_add: 'appIssues',
  issue_update: 'appIssues',
  issue_get_state: 'appIssues',
  issue_link: 'appIssues',
  issue_delete: 'trash',

  browser_list: 'browser',
  browser_navigate: 'globe',
  request_browser_origin_access: 'browser',
  browser_new_tab: 'plus',
  browser_switch_tab: 'browser',
  browser_close_tab: 'close',
  browser_snapshot: 'browser',
  browser_click: 'designMode',
  browser_fill: 'edit',
  browser_eval: 'terminal',
  browser_screenshot: 'deviceDesktop',

  brain_search: 'search',
  brain_read_page: 'appBrain',
  brain_list: 'appBrain',
  brain_write_page: 'edit',
  brain_append_log: 'brainLog',
  brain_ingest_source: 'brainIngest',
  manage_brain: 'appBrain',

  repo_map: 'appCodeOverview',
  find_symbol: 'search',
  who_calls: 'brainGraph',
  read_symbol: 'appCode',
  get_lsp_diagnostics: 'appConsole',
};

/** Action word shown first in the row. */
const TOOL_ACTION: Record<string, string> = {
  get_datetime: 'Date & time',
  calculate: 'Calculate',
  ask_question: 'Ask',
  set_chat_mode: 'Switch mode',
  propose_mode_switch: 'Suggest mode',
  create_chat_with_mode: 'New chat',
  launch_minnow_app: 'Open app',
  read_clipboard: 'Read clipboard',
  write_clipboard: 'Write clipboard',
  get_system_info: 'System info',
  todo_write: 'Update todos',
  save_memory: 'Remember',
  recall_chat_context: 'Recall',
  recall_turn_full: 'Recall turn',
  search_settings: 'Find setting',
  get_settings: 'Read settings',
  update_settings: 'Change setting',
  read_diagnostics: 'Diagnostics',
  get_appearance: 'Read theme',
  update_appearance: 'Change theme',
  upload_appearance_asset: 'Upload asset',
  load_impeccable_context: 'Load design context',
  load_aesthetics_reference: 'Load design reference',
  run_impeccable: 'Design pass',

  web_search: 'Search web',
  wikipedia_search: 'Wikipedia',
  fetch_web_content: 'Fetch',
  rag_web_content: 'Read page',

  list_directory: 'List',
  find_files: 'Find files',
  read_file: 'Read',
  read_file_range: 'Read',
  read_document: 'Read doc',
  get_file_metadata: 'File info',
  save_file: 'Write',
  append_file: 'Append',
  insert_at_line: 'Insert',
  replace_text_in_file: 'Edit',
  search_in_file: 'Search',
  grep: 'Search',
  make_directory: 'New folder',
  move_file: 'Move',
  copy_file: 'Copy',
  delete_path: 'Delete',
  create_pdf: 'Create PDF',
  create_word_document: 'Create document',
  create_spreadsheet: 'Create spreadsheet',

  git_status: 'Git status',
  git_diff: 'Git diff',
  git_log: 'Git log',
  git_add: 'Stage',
  git_commit: 'Commit',
  git_checkout: 'Checkout',
  git_branch: 'Branch',

  execute_command: 'Run',
  start_background_command: 'Run in background',
  stop_command: 'Stop',
  stop_background_command: 'Stop',
  read_command_log: 'Command log',
  list_running_commands: 'Running commands',
  manage_dev_servers: 'Dev servers',
  run_javascript: 'Run JavaScript',
  run_python: 'Run Python',

  spawn_sub_agent: 'Sub-agent',
  cancel_sub_agent: 'Cancel agent',
  list_sub_agents: 'List agents',
  get_sub_agent_status: 'Agent status',
  issue_add: 'File issue',
  issue_update: 'Update issue',
  issue_get_state: 'Read issues',
  issue_link: 'Link issue',
  issue_delete: 'Delete issue',

  browser_list: 'Browser tabs',
  browser_navigate: 'Browse',
  request_browser_origin_access: 'Request site access',
  browser_new_tab: 'New tab',
  browser_switch_tab: 'Switch tab',
  browser_close_tab: 'Close tab',
  browser_snapshot: 'Read page',
  browser_click: 'Click',
  browser_fill: 'Fill',
  browser_eval: 'Evaluate',
  browser_screenshot: 'Screenshot',

  brain_search: 'Brain search',
  brain_read_page: 'Read note',
  brain_list: 'List notes',
  brain_write_page: 'Write note',
  brain_append_log: 'Log',
  brain_ingest_source: 'Ingest',
  manage_brain: 'Brain',

  repo_map: 'Map repo',
  find_symbol: 'Find symbol',
  who_calls: 'Find callers',
  read_symbol: 'Read symbol',
  get_lsp_diagnostics: 'Diagnostics',
};

const TOOL_LABEL_BY_ID = new Map(BUILT_IN_TOOLS.map((t) => [t.id, t.label]));

const SHELL_TOOLS = new Set(['execute_command', 'start_background_command']);

const PATH_ARG_TOOLS = new Set([
  'list_directory',
  'read_file',
  'read_file_range',
  'read_document',
  'save_file',
  'append_file',
  'insert_at_line',
  'replace_text_in_file',
  'get_file_metadata',
  'delete_path',
  'make_directory',
  'copy_file',
  'move_file',
]);

/** Glyph for the tool family shown at the head of the collapsed row. */
export function getToolIcon(toolName: string): IconName {
  const dedicated = TOOL_ICON[toolName];
  if (dedicated) return dedicated;
  const category = TOOL_CATEGORY_BY_ID.get(toolName) ?? 'utility';
  return CATEGORY_ICON[category];
}

/** Action word for the row; falls back to the tool label, then spaced snake_case. */
export function getToolAction(toolName: string): string {
  return (
    TOOL_ACTION[toolName] ?? TOOL_LABEL_BY_ID.get(toolName) ?? toolName.replace(/_/g, ' ')
  );
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length ? t : undefined;
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

function plural(count: number, noun: string): string {
  if (count === 1) return `1 ${noun}`;
  const suffix = /(s|x|z|ch|sh)$/.test(noun) ? 'es' : 's';
  return `${count} ${noun}${suffix}`;
}

function normalizePathLabel(path: string): string {
  const p = path.trim();
  if (!p || p === '.' || p === './') return 'workspace root';
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Strip the process-runner wrapper and return the stdout body when present. */
export function extractProcessStdout(result: string): string | null {
  const marker = '\n\nstdout:\n';
  const idx = result.indexOf(marker);
  if (idx < 0) return null;
  const rest = result.slice(idx + marker.length);
  const stderrIdx = rest.indexOf('\n\nstderr:\n');
  return stderrIdx >= 0 ? rest.slice(0, stderrIdx) : rest;
}

/** Exit code from the `<command> (exit N)` header the process runner emits. */
function exitCodeFromResult(result: string): number | undefined {
  const m = /\(exit (-?\d+)\)/.exec(result);
  if (!m) return undefined;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : undefined;
}

function nonEmptyLines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => l.trim().length > 0);
}

function countLines(text: string): number {
  const body = extractProcessStdout(text) ?? text;
  const trimmed = body.replace(/\s+$/, '');
  return trimmed ? trimmed.split(/\r?\n/).length : 0;
}

function commitsFromGitLogResult(result: string): ReturnType<typeof parseGitLogOneline> {
  const stdout = extractProcessStdout(result);
  return parseGitLogOneline(stdout ?? result);
}

type GitStatusEntry = { code: string; path: string };

/** Parse `git status --porcelain` lines for a compact summary. */
function parseGitStatusEntries(text: string): { branch?: string; entries: GitStatusEntry[] } {
  const stdout = extractProcessStdout(text) ?? text;
  let branch: string | undefined;
  const entries: GitStatusEntry[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (line.startsWith('## ')) {
      branch = line.slice(3).trim();
      continue;
    }
    if (line.length < 4) continue;
    const code = line.slice(0, 2).trim() || line.slice(0, 1);
    const path = line.slice(3).trim();
    if (!path) continue;
    entries.push({ code, path });
  }
  return { branch, entries };
}

function gitStatusOutcome(result: string): string {
  const { entries } = parseGitStatusEntries(result);
  if (entries.length === 0) return 'clean';
  const modified = entries.filter((e) => e.code.includes('M')).length;
  const untracked = entries.filter((e) => e.code.includes('?')).length;
  const added = entries.filter((e) => e.code.includes('A')).length;
  const deleted = entries.filter((e) => e.code.includes('D')).length;
  const bits: string[] = [];
  if (modified) bits.push(`${modified} modified`);
  if (added) bits.push(`${added} added`);
  if (deleted) bits.push(`${deleted} deleted`);
  if (untracked) bits.push(`${untracked} untracked`);
  return bits.length ? bits.join(' · ') : plural(entries.length, 'change');
}

function listingOutcome(result: string): string | undefined {
  const parsed = parseListDirectoryResult(result);
  if ('error' in parsed) return undefined;
  const bits: string[] = [];
  if (parsed.dirs.length) bits.push(plural(parsed.dirs.length, 'folder'));
  if (parsed.files.length) bits.push(plural(parsed.files.length, 'file'));
  return bits.length ? bits.join(' · ') : 'empty';
}

/** Grep content lines look like `path:line:text`; context lines use a dash. */
function parseGrepMatches(result: string): { path: string; lines: string[] }[] | null {
  const lines = nonEmptyLines(result);
  if (!lines.length) return null;
  const groups: { path: string; lines: string[] }[] = [];
  let matched = 0;
  for (const line of lines) {
    const m = /^(.+?):(\d+)[:-](.*)$/.exec(line);
    if (!m) continue;
    matched += 1;
    const [, path, lineNo, text] = m;
    const last = groups[groups.length - 1];
    const entry = `${lineNo}  ${text.trim()}`;
    if (last && last.path === path) last.lines.push(entry);
    else groups.push({ path, lines: [entry] });
  }
  if (matched < lines.length / 2) return null;
  return groups;
}

function pathListFromResult(result: string): string[] {
  return nonEmptyLines(result)
    .map((l) => l.trim().replace(/\\/g, '/'))
    .filter((l) => !/^(No files|No matches)/i.test(l));
}

type AskQuestionOptionView = { label: string; selected: boolean };
type AskQuestionItemView = {
  prompt: string;
  options: AskQuestionOptionView[];
  multiple: boolean;
  /** Free-text answer when the user picked "Other". */
  other?: string;
};

/** Selected option ids (and any free text) keyed by question id. */
function parseAskQuestionAnswers(
  result: string,
): { byQuestion: Map<string, { ids: Set<string>; other?: string }>; cancelled: boolean } {
  const byQuestion = new Map<string, { ids: Set<string>; other?: string }>();
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    if (parsed.status === 'cancelled') return { byQuestion, cancelled: true };
    if (!Array.isArray(parsed.answers)) return { byQuestion, cancelled: false };
    for (const entry of parsed.answers) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      const id = typeof rec.questionId === 'string' ? rec.questionId : undefined;
      if (!id) continue;
      const ids = new Set(
        Array.isArray(rec.selectedIds) ? rec.selectedIds.filter((v): v is string => typeof v === 'string') : [],
      );
      const other = typeof rec.otherText === 'string' && rec.otherText.trim() ? rec.otherText.trim() : undefined;
      byQuestion.set(id, { ids, ...(other ? { other } : {}) });
    }
  } catch {
  }
  return { byQuestion, cancelled: false };
}

/** Question cards from the call arguments, with the user's choice folded in when the result is available — one list instead of prompts above and answers below. */
function parseAskQuestionItems(
  args: Record<string, unknown>,
  result?: string,
): AskQuestionItemView[] {
  const raw = args.questions;
  if (!Array.isArray(raw)) return [];
  const answers = result ? parseAskQuestionAnswers(result).byQuestion : new Map();
  const out: AskQuestionItemView[] = [];
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue;
    const rec = q as Record<string, unknown>;
    const prompt = typeof rec.prompt === 'string' ? rec.prompt.trim() : '';
    if (!prompt) continue;
    const answer = typeof rec.id === 'string' ? answers.get(rec.id) : undefined;
    const options: AskQuestionOptionView[] = Array.isArray(rec.options)
      ? rec.options
          .map((o) => {
            if (!o || typeof o !== 'object') return null;
            const opt = o as Record<string, unknown>;
            if (typeof opt.label !== 'string' || !opt.label) return null;
            const selected = Boolean(
              answer && typeof opt.id === 'string' && answer.ids.has(opt.id),
            );
            return { label: opt.label, selected };
          })
          .filter((o): o is AskQuestionOptionView => o !== null)
      : [];
    out.push({
      prompt,
      options,
      multiple: rec.allow_multiple === true,
      ...(answer?.other ? { other: answer.other } : {}),
    });
  }
  return out;
}

export type ToolTargetKind = 'path' | 'code' | 'text';

export interface ToolRow {
  /** Action word: 'Read', 'Run', 'Commit'. Always present. */
  action: string;
  /** The thing acted on: a path, command, query. Empty when the action stands alone. */
  target?: string;
  /** Controls mono vs UI font, and left-truncation for paths. */
  targetKind?: ToolTargetKind;
  /** Measurement produced by this tool once it settles. */
  outcome?: string;
  /** Failure outcomes read in danger colour and carry the reason as literal words. */
  outcomeTone?: 'neutral' | 'danger';
}

/** Plain-language failure text: a short outcome word and a full sentence. */
export function describeToolFailure(result: string): { short: string; sentence: string } {
  const text = result.replace(/^Error:\s*/i, '').trim();
  const firstLine = text.split(/\r?\n/)[0]?.trim() ?? text;

  const pathMatch = /['"]([^'"]+)['"]/.exec(text);
  const target = pathMatch ? normalizePathLabel(pathMatch[1]) : undefined;
  const withTarget = (s: string) => (target ? `${s}: ${target}` : s);

  if (/ENOENT|no such file or directory|not found/i.test(text)) {
    return { short: 'not found', sentence: withTarget('File or folder not found') };
  }
  if (/EACCES|EPERM|permission denied|access is denied/i.test(text)) {
    return { short: 'denied', sentence: withTarget('Permission denied') };
  }
  if (/EEXIST|already exists/i.test(text)) {
    return { short: 'exists', sentence: withTarget('Already exists') };
  }
  if (/EISDIR|is a directory/i.test(text)) {
    return { short: 'is a folder', sentence: withTarget('That path is a folder, not a file') };
  }
  if (/ENOTDIR|not a directory/i.test(text)) {
    return { short: 'not a folder', sentence: withTarget('That path is not a folder') };
  }
  if (/ETIMEDOUT|timed? ?out/i.test(text)) {
    return { short: 'timed out', sentence: 'The tool timed out before it finished' };
  }
  if (/aborted|cancell?ed/i.test(text)) {
    return { short: 'cancelled', sentence: 'The run was cancelled' };
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network/i.test(text)) {
    return { short: 'unreachable', sentence: withTarget('Could not reach the network target') };
  }
  if (/is required$/i.test(firstLine)) {
    return { short: 'bad input', sentence: firstLine };
  }

  const exit = exitCodeFromResult(text);
  if (exit != null && exit !== 0) {
    return { short: `exit ${exit}`, sentence: `The command exited with code ${exit}` };
  }

  return { short: 'failed', sentence: truncate(firstLine || 'The tool run failed', 160) };
}

/** Target zone: what this tool is acting on. */
function buildToolTarget(
  toolName: string,
  args: Record<string, unknown>,
): { text: string; kind: ToolTargetKind; key?: string } | undefined {
  const path = (kind: ToolTargetKind = 'path') => {
    const p = stringArg(args, 'path');
    return p ? { text: normalizePathLabel(p), kind } : undefined;
  };

  if (SHELL_TOOLS.has(toolName)) {
    const cmd = stringArg(args, 'command');
    return cmd ? { text: cmd, kind: 'code' } : undefined;
  }

  if (toolName === 'read_file_range') {
    const p = stringArg(args, 'path');
    const start = numberArg(args, 'start_line');
    const end = numberArg(args, 'end_line');
    if (p && start != null && end != null) {
      return { text: `${normalizePathLabel(p)}:${start}-${end}`, kind: 'path' };
    }
    return path();
  }

  if (toolName === 'grep' || toolName === 'search_in_file' || toolName === 'find_files') {
    const pattern = stringArg(args, 'pattern');
    return pattern ? { text: pattern, kind: 'code' } : path();
  }

  if (toolName === 'ask_question') {
    const items = parseAskQuestionItems(args);
    if (items.length === 1) return { text: truncate(items[0].prompt, 90), kind: 'text' };
    if (items.length > 1) return { text: plural(items.length, 'question'), kind: 'text' };
    return undefined;
  }

  if (toolName === 'git_commit') {
    const message = stringArg(args, 'message');
    return message ? { text: truncate(message, 90), kind: 'text' } : undefined;
  }

  if (toolName === 'git_add') {
    const paths = args.paths;
    if (Array.isArray(paths)) {
      if (paths.length === 1 && typeof paths[0] === 'string') {
        return { text: normalizePathLabel(paths[0]), kind: 'path' };
      }
      if (paths.length > 1) return { text: plural(paths.length, 'path'), kind: 'text' };
    }
    return path();
  }

  if (toolName === 'move_file' || toolName === 'copy_file') {
    const from = stringArg(args, 'source') ?? stringArg(args, 'path') ?? stringArg(args, 'from');
    const to = stringArg(args, 'destination') ?? stringArg(args, 'to');
    if (from && to) {
      return { text: `${normalizePathLabel(from)} → ${normalizePathLabel(to)}`, kind: 'path' };
    }
    if (from) return { text: normalizePathLabel(from), kind: 'path' };
    return undefined;
  }

  if (toolName === 'run_javascript' || toolName === 'run_python' || toolName === 'browser_eval') {
    const code = stringArg(args, 'code') ?? stringArg(args, 'script') ?? stringArg(args, 'expression');
    return code ? { text: truncate(code, 90), kind: 'code' } : undefined;
  }

  if (PATH_ARG_TOOLS.has(toolName)) {
    const p = path();
    if (p) return p;
  }

  const preferred = [
    'query',
    'url',
    'message',
    'title',
    'prompt',
    'name',
    'pattern',
    'symbol',
    'term',
    'branch',
    'mode',
    'app',
    'action',
    'id',
    'text',
  ];
  for (const key of preferred) {
    const v = stringArg(args, key);
    if (v) {
      const kind: ToolTargetKind =
        key === 'url' || key === 'pattern' || key === 'symbol' ? 'code' : 'text';
      return { text: truncate(v, 90), kind, key };
    }
  }
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    if (key === 'path') return { text: normalizePathLabel(value), kind: 'path', key };
    return { text: truncate(value, 90), kind: 'text', key };
  }
  return undefined;
}

/** Outcome zone: the measurement this tool produced. */
function buildToolOutcome(
  toolName: string,
  args: Record<string, unknown>,
  result: string,
): string | undefined {
  if (toolName === 'list_directory') return listingOutcome(result);

  if (toolName === 'find_files') {
    const paths = pathListFromResult(result);
    return paths.length ? plural(paths.length, 'file') : 'no matches';
  }

  if (toolName === 'grep' || toolName === 'search_in_file') {
    if (/^No matches/i.test(result.trim())) return 'no matches';
    const groups = parseGrepMatches(result);
    if (!groups) return undefined;
    const total = groups.reduce((n, g) => n + g.lines.length, 0);
    return `${plural(total, 'match')} · ${plural(groups.length, 'file')}`;
  }

  if (toolName === 'read_file' || toolName === 'read_file_range' || toolName === 'read_document') {
    const n = countLines(result);
    return n ? plural(n, 'line') : 'empty';
  }

  if (toolName === 'git_status') return gitStatusOutcome(result);

  if (toolName === 'git_log') {
    const commits = commitsFromGitLogResult(result);
    return commits.length ? plural(commits.length, 'commit') : 'no commits';
  }

  if (toolName === 'git_commit') {
    const m = /\[[^\]]*?\s([0-9a-f]{7,40})\]/i.exec(result);
    return m ? m[1].slice(0, 7) : undefined;
  }

  if (SHELL_TOOLS.has(toolName)) {
    const exit = exitCodeFromResult(result);
    if (exit != null) return `exit ${exit}`;
    return toolName === 'start_background_command' ? 'started' : undefined;
  }

  if (toolName === 'ask_question') {
    if (/"status"\s*:\s*"cancelled"/.test(result)) return 'cancelled';
    if (/"status"\s*:\s*"answered"/.test(result)) return 'answered';
    return undefined;
  }

  if (toolName === 'todo_write') {
    const items = args.todos;
    if (Array.isArray(items)) return plural(items.length, 'item');
    return undefined;
  }

  const trimmed = result.trim();
  const acknowledgement =
    /^(saved|created|updated|wrote|written|deleted|removed|moved|renamed|copied|added|staged|stopped|started|cancell?ed|done|ok)\b/i;
  if (trimmed && !trimmed.includes('\n') && trimmed.length <= 48 && acknowledgement.test(trimmed)) {
    return trimmed;
  }
  return undefined;
}

/**
 * The full collapsed row for a tool call at a given phase.
 */
export function buildToolRow(
  toolName: string,
  args: Record<string, unknown>,
  phase: 'running' | 'done' | 'failed',
  result?: string,
): ToolRow {
  const action = getToolAction(toolName);
  const target = buildToolTarget(toolName, args);

  const row: ToolRow = { action };
  if (target) {
    row.target = target.text;
    row.targetKind = target.kind;
  }

  if (phase === 'failed' && result) {
    row.outcome = describeToolFailure(result).short;
    row.outcomeTone = 'danger';
    return row;
  }

  if (phase === 'done' && result) {
    const outcome = buildToolOutcome(toolName, args, result);
    if (outcome) {
      row.outcome = outcome;
      row.outcomeTone = 'neutral';
    }
  }

  return row;
}

/** Argument keys already visible in the row or the structured body. */
function consumedArgKeys(toolName: string, args: Record<string, unknown>): Set<string> {
  const keys = new Set<string>();
  if (SHELL_TOOLS.has(toolName)) keys.add('command');
  if (toolName === 'read_file_range') {
    keys.add('path').add('start_line').add('end_line');
  }
  if (toolName === 'ask_question') keys.add('questions');
  if (toolName === 'git_commit') keys.add('message');
  if (toolName === 'git_add') keys.add('paths');
  if (toolName === 'grep' || toolName === 'search_in_file' || toolName === 'find_files') {
    keys.add('pattern');
  }
  if (toolName === 'move_file' || toolName === 'copy_file') {
    keys.add('source').add('destination').add('from').add('to').add('path');
  }
  if (PATH_ARG_TOOLS.has(toolName) && stringArg(args, 'path')) keys.add('path');
  const targetKey = buildToolTarget(toolName, args)?.key;
  if (targetKey) keys.add(targetKey);
  return keys;
}

export interface ToolArgField {
  label: string;
  value: string;
  /** Long or structured values render in a mono block instead of inline. */
  block: boolean;
}

/** Readable key/value view of the arguments a tool was called with, minus anything already shown in the row. */
export function buildToolArgFields(
  toolName: string,
  args: Record<string, unknown>,
): ToolArgField[] {
  const consumed = consumedArgKeys(toolName, args);
  const fields: ToolArgField[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (consumed.has(key)) continue;
    if (value === undefined || value === null || value === '') continue;
    const label = key.replace(/_/g, ' ');
    if (typeof value === 'string') {
      const isBlock = value.length > 80 || value.includes('\n');
      fields.push({ label, value, block: isBlock });
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      fields.push({ label, value: String(value), block: false });
      continue;
    }
    let json: string;
    try {
      json = JSON.stringify(value, null, 2);
    } catch {
      json = String(value);
    }
    fields.push({ label, value: json, block: true });
  }
  return fields;
}

export type FriendlyToolBody =
  | { kind: 'listing'; dirs: string[]; files: string[] }
  | { kind: 'paths'; paths: string[]; truncated: number }
  | { kind: 'matches'; groups: { path: string; lines: string[] }[]; truncated: number }
  | { kind: 'commits'; commits: ReturnType<typeof parseGitLogOneline> }
  | { kind: 'git-status'; branch?: string; entries: GitStatusEntry[] }
  | { kind: 'questions'; items: AskQuestionItemView[]; cancelled: boolean }
  | { kind: 'shell'; command: string; output: string; exitCode?: number }
  | { kind: 'text'; lines: string[]; label?: string; truncated: number };

const MAX_LIST_ROWS = 40;
const MAX_PREVIEW_LINES = 14;

/** Structured expanded content for tools that have a better shape than a text blob. */
export function buildFriendlyToolBody(
  toolName: string,
  args: Record<string, unknown>,
  result: string,
  failed: boolean,
): FriendlyToolBody | null {
  if (failed) return null;

  if (SHELL_TOOLS.has(toolName)) {
    const cmd = stringArg(args, 'command') ?? '';
    const stdout = extractProcessStdout(result);
    const output = stdout?.trim() ? stdout.trimEnd() : result.trim();
    if (!cmd && !output) return null;
    const exitCode = exitCodeFromResult(result);
    return { kind: 'shell', command: cmd, output, ...(exitCode != null ? { exitCode } : {}) };
  }

  if (toolName === 'list_directory') {
    const parsed = parseListDirectoryResult(result);
    if ('error' in parsed) return null;
    return { kind: 'listing', dirs: parsed.dirs, files: parsed.files };
  }

  if (toolName === 'find_files') {
    const paths = pathListFromResult(result);
    if (!paths.length) return null;
    return {
      kind: 'paths',
      paths: paths.slice(0, MAX_LIST_ROWS),
      truncated: Math.max(0, paths.length - MAX_LIST_ROWS),
    };
  }

  if (toolName === 'grep' || toolName === 'search_in_file') {
    const groups = parseGrepMatches(result);
    if (!groups?.length) return null;
    const shown = groups.slice(0, 12);
    return {
      kind: 'matches',
      groups: shown,
      truncated: Math.max(0, groups.length - shown.length),
    };
  }

  if (toolName === 'git_log') {
    const commits = commitsFromGitLogResult(result);
    if (!commits.length) return null;
    return { kind: 'commits', commits };
  }

  if (toolName === 'git_status') {
    const { branch, entries } = parseGitStatusEntries(result);
    return { kind: 'git-status', branch, entries };
  }

  if (toolName === 'ask_question') {
    const items = parseAskQuestionItems(args, result);
    if (!items.length) return null;
    return { kind: 'questions', items, cancelled: parseAskQuestionAnswers(result).cancelled };
  }

  if (toolName === 'read_file' || toolName === 'read_file_range' || toolName === 'read_document') {
    const stdout = extractProcessStdout(result);
    const lines = (stdout ?? result).split(/\r?\n/);
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (lines.length === 0) return null;
    const preview = lines.slice(0, MAX_PREVIEW_LINES);
    return {
      kind: 'text',
      lines: preview,
      truncated: Math.max(0, lines.length - preview.length),
    };
  }

  return null;
}
