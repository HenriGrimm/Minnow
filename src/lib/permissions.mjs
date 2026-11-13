/**
 * One permission level for every agent action (Manual / Auto / Full access).
 *
 * Shared by the renderer gate (`src/tools/permission-gate.ts`), the server chat
 * policy (`server/chats/policy.js`) and the headless runner so the three can
 * never disagree about what a tool call is or whether it needs the user.
 *
 * Flow: `classifyToolCall` turns a call into an action (kind, risk, resources,
 * a human title/detail, and the key a "for this chat" grant would use), then
 * `decidePermission` maps level × action × grants × turn clamp to
 * allow / ask / deny. Nothing here performs I/O.
 */

import { parsePatch } from './apply-patch.mjs';

// ── Levels ───────────────────────────────────────────────────────────────────

/** Ordered from most to least restrictive. */
export const PERMISSION_LEVELS = Object.freeze(['manual', 'auto', 'full']);
export const DEFAULT_PERMISSION_LEVEL = 'auto';

export const PERMISSION_LEVEL_META = Object.freeze({
  manual: Object.freeze({
    label: 'Manual',
    description: 'Ask before edits, commands, and anything outside this project',
    icon: 'hand',
  }),
  auto: Object.freeze({
    label: 'Auto',
    description: 'Minnow approves routine work and asks before risky actions',
    icon: 'shield-sparkle',
  }),
  full: Object.freeze({
    label: 'Full access',
    description: 'No prompts. Unrestricted files, commands, and internet',
    icon: 'shield-alert',
  }),
});

export function isPermissionLevel(value) {
  return typeof value === 'string' && PERMISSION_LEVELS.includes(value);
}

export function normalizePermissionLevel(value, fallback = DEFAULT_PERMISSION_LEVEL) {
  return isPermissionLevel(value) ? value : fallback;
}

/** The most restrictive of the given levels (delegation never widens authority). */
export function minPermissionLevel(...levels) {
  let rank = PERMISSION_LEVELS.length - 1;
  for (const level of levels) {
    if (!isPermissionLevel(level)) continue;
    rank = Math.min(rank, PERMISSION_LEVELS.indexOf(level));
  }
  return PERMISSION_LEVELS[rank];
}

/** Turn clamps narrow one turn (from a skill's `access` front matter); never widen. */
export const TURN_CLAMPS = Object.freeze(['read-only', 'plans']);
export function normalizeTurnClamp(value) {
  return value === 'read-only' || value === 'plans' ? value : null;
}

/** One sentence the system prompt carries so the model knows how it is supervised. */
export function permissionLevelPromptLine(level) {
  switch (normalizePermissionLevel(level)) {
    case 'manual':
      return 'Permission level: Manual. Reads inside the project run freely; edits, commands, and anything outside the project wait for the user to approve. If the user denies an action, do not try to work around it — ask what they want instead.';
    case 'full':
      return 'Permission level: Full access. Actions run without approval, so take extra care with anything destructive or irreversible and confirm intent with the user first.';
    default:
      return 'Permission level: Auto. Routine work runs on its own; risky actions (outside the project, destructive, or sending data out) pause for the user. If the user denies an action, do not try to work around it — ask what they want instead.';
  }
}

/** Prompt line for a turn clamp, or '' when the turn is unrestricted. */
export function turnClampPromptLine(clamp) {
  switch (normalizeTurnClamp(clamp)) {
    case 'read-only':
      return 'This turn is read-only (/ask): answer from reading and searching; do not edit files or change state.';
    case 'plans':
      return 'This turn is planning only (/plan): investigate freely and run safe commands, but only write Markdown under documentation/plans/ and issues.';
    default:
      return '';
  }
}

/** Environment lines for the system prompt: permission level plus any turn clamp. */
export function permissionPromptBlock(level, clamp) {
  return [permissionLevelPromptLine(level), turnClampPromptLine(clamp)].filter(Boolean).join('\n');
}

// ── Tool tables ──────────────────────────────────────────────────────────────

/** No side effects and nothing leaves the machine: always allowed. */
const NO_EFFECT_TOOLS = new Set([
  'get_datetime', 'calculate', 'get_system_info', 'wait', 'ask_question', 'todo_write',
  'load_skill', 'plugin_inspect', 'check_plan', 'present_files', 'launch_minnow_app',
  'search_tools', 'search_mcp_tools',
  'agent_capabilities', 'chat_list', 'chat_read', 'chat_wait',
  'spawn_sub_agent', 'cancel_sub_agent', 'list_sub_agents', 'get_sub_agent_status', 'agent',
  'issue_get_state', 'issue_search', 'bug_get_state',
  'brain_search', 'brain_read_page', 'brain_list',
  'minnow_docs_search', 'minnow_docs_read', 'minnow_docs_list',
  'search_settings', 'get_settings', 'get_appearance', 'read_diagnostics',
  'load_impeccable_context', 'load_aesthetics_reference',
  'action_inspect', 'release_inspect',
  'read_command_log', 'command_output', 'list_running_commands', 'stop_command', 'stop_background_command',
  'browser_reserve_tab', 'browser_release_tab', 'browser_list', 'browser_switch_tab', 'browser_close_tab',
  'browser_snapshot', 'browser_screenshot',
  // Legacy mode tools still resolve while old transcripts replay.
  'set_chat_mode', 'create_chat_with_mode', 'propose_mode_switch',
]);

/** Filesystem reads; risk depends on where the path points. */
const READ_PATH_TOOLS = new Set([
  'list_directory', 'read_file', 'read_file_range', 'read_document', 'find_files',
  'get_file_metadata', 'search_in_file', 'grep', 'get_lsp_diagnostics', 'godot_inspect',
  'git_status', 'git_diff', 'git_log', 'repo_map', 'find_symbol', 'who_calls', 'read_symbol',
]);

/** Filesystem writes; risk depends on where the paths point. */
const EDIT_PATH_TOOLS = new Set([
  'save_file', 'apply_patch', 'append_file', 'insert_at_line', 'replace_text_in_file', 'edit_file',
  'make_directory', 'move_file', 'copy_file', 'delete_path',
  'create_pdf', 'create_spreadsheet', 'create_word_document',
]);

const PLAN_WRITE_TOOLS = new Set(['save_file', 'append_file', 'insert_at_line', 'replace_text_in_file', 'make_directory']);

const PATH_ARG_KEYS = {
  move_file: ['source', 'destination'],
  copy_file: ['source', 'destination'],
};

const SHELL_TOOLS = new Set([
  'execute_command', 'start_background_command', 'run_javascript', 'run_python',
  'godot_control', 'manage_dev_servers', 'run_impeccable',
]);

const GIT_WRITE_TOOLS = new Set(['git_add', 'git_commit', 'git_checkout', 'git_branch']);

/** Writes to Minnow's own data (tracker, wiki, clipboard). */
const APP_WRITE_TOOLS = new Set([
  'issue_add', 'issue_update', 'issue_link', 'issue_delete', 'issue_comment', 'issue_assign',
  'issue_unlink', 'issue_move', 'bug_add', 'bug_update',
  'save_memory', 'brain_write_page', 'brain_append_log', 'brain_ingest_source', 'manage_brain',
  'write_clipboard',
]);

const NETWORK_READ_TOOLS = new Set([
  'web_search', 'web_search_ddg', 'web_search_tavily', 'web_search_searxng',
  'web_map', 'web_extract', 'wikipedia_search', 'fetch_web_content', 'rag_web_content', 'web_fetch',
]);

/** Remote writes on a forge (GitHub Actions, releases). */
const REMOTE_WRITE_TOOLS = new Set([
  'action_run', 'action_cancel', 'action_command', 'release_manage', 'release_asset',
]);

const SETTINGS_TOOLS = new Set(['update_settings', 'update_appearance', 'upload_appearance_asset', 'plugin_manage']);

const SECURITY_SETTING_PATTERN = /security|permission|filesystem|sandbox|device|network|lan|tailscale|secret|token|password|api.?key|allowlist|remote/i;

// ── Paths ────────────────────────────────────────────────────────────────────

function normSlashes(p) {
  let out = String(p).trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  if (/^[a-zA-Z]:\//.test(out)) out = out.charAt(0).toUpperCase() + out.slice(1);
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

function isAbsolutePath(p) {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\');
}

/** Collapse `.` and `..` segments without touching the filesystem. */
function collapse(p) {
  const abs = p.startsWith('/');
  const drive = /^[A-Z]:\//.test(p) ? p.slice(0, 2) : '';
  const body = drive ? p.slice(2) : p;
  const out = [];
  for (const seg of body.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (out.length) out.pop(); continue; }
    out.push(seg);
  }
  return `${drive}${abs || drive ? '/' : ''}${out.join('/')}`;
}

/** Resolve a tool path argument the way the server does (relative to the workspace). */
export function resolveActionPath(userPath, workspaceRoot, homeDir = '') {
  let raw = String(userPath ?? '').trim();
  if (!raw) return '';
  if ((raw === '~' || raw.startsWith('~/')) && homeDir) raw = `${homeDir}${raw.slice(1)}`;
  const slashed = normSlashes(raw);
  if (isAbsolutePath(slashed)) return collapse(slashed);
  const root = normSlashes(workspaceRoot || '');
  return collapse(root ? `${root}/${slashed}` : slashed);
}

function isUnder(resolved, root) {
  const r = normSlashes(root);
  if (!r) return false;
  return resolved === r || resolved.startsWith(`${r}/`);
}

const SECRET_PATH_PATTERNS = [
  /(^|\/)\.env(\.[^/]*)?$/i,
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.aws\/credentials$/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$/,
  /\.(pem|p12|pfx|key)$/i,
  /(^|\/)Library\/Keychains(\/|$)/,
];

function isSecretPath(resolved) {
  if (/(^|\/)\.env\.(example|sample|template)$/i.test(resolved)) return false;
  return SECRET_PATH_PATTERNS.some((re) => re.test(resolved));
}

/** Minnow's encryption key and decrypted secret stores: never writable by an agent. */
function isFloorPath(resolved, homeDir) {
  const minnowHome = homeDir ? normSlashes(`${homeDir}/.minnow`) : '';
  if (!minnowHome) return /(^|\/)\.minnow\/\.key$/.test(resolved);
  return resolved === `${minnowHome}/.key` || isUnder(resolved, `${minnowHome}/secrets`);
}

function toolPathArgs(name, args) {
  if (name === 'apply_patch') {
    try {
      return parsePatch(args.patch).flatMap((file) => (file.move ? [file.path, file.move] : [file.path]));
    } catch {
      return [];
    }
  }
  if (name === 'present_files' && Array.isArray(args.files)) {
    return args.files.flatMap((f) => (f && typeof f.path === 'string' && f.path.trim() ? [f.path.trim()] : []));
  }
  if (name === 'git_add' && Array.isArray(args.paths)) {
    return args.paths.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim());
  }
  const keys = PATH_ARG_KEYS[name] ?? ['path'];
  const out = [];
  for (const key of keys) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
  }
  return out;
}

// ── Shell ────────────────────────────────────────────────────────────────────

const READ_ONLY_COMMANDS = new Set([
  'ls', 'll', 'la', 'cat', 'head', 'tail', 'wc', 'rg', 'grep', 'egrep', 'fgrep', 'ag', 'pwd',
  'echo', 'printf', 'which', 'where', 'type', 'file', 'stat', 'du', 'df', 'tree', 'less', 'more',
  'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'basename', 'dirname', 'realpath', 'readlink',
  'whoami', 'id', 'uname', 'date', 'env', 'printenv', 'hostname', 'jq', 'yq', 'column', 'nl',
  'true', 'false', 'test', 'sha1sum', 'sha256sum', 'shasum', 'md5', 'md5sum', 'Get-ChildItem',
  'Get-Content', 'dir', 'Select-String', 'Get-Location',
]);

const READ_ONLY_GIT = new Set([
  'status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'describe',
  'shortlog', 'grep', 'reflog', 'cat-file', 'merge-base', 'name-rev', 'whatchanged',
]);

function isGitVersionProbe(args) {
  return args.length === 1 && ['--version', '-v', 'version'].includes(args[0]);
}

/** Reject shell forms that can change state even when the leading command
 * looks like discovery to the general approval classifier. */
function isClampedShellRead(command) {
  const unquoted = command.replace(/'[^']*'/g, '');
  if (/[<>\x60%\r$]|(^|[^&])&(?!&)/.test(unquoted)) return false;
  return splitShellSegments(command).every(({ text }) => {
    const [bin, sub, ...args] = tokenize(text);
    if (!bin || !/^[\w-]+$/.test(bin)) return false;
    if (bin === 'git') {
      if (isGitVersionProbe([sub, ...args])) return true;
      if (sub === 'reflog') return args.length === 0 || args[0] === 'show';
      if (sub === 'branch' || sub === 'remote') return args.length === 0;
      if (sub === 'config') return args[0] === '--get';
      return READ_ONLY_GIT.has(sub) && !args.some(arg => /^--(?:output|ext-diff|textconv)(?:=|$)/.test(arg));
    }
    if (bin === 'env') return sub === undefined;
    if (bin === 'find') return !/(?:^|\s)-(?:delete|exec|ok|fprint|fls)/.test(text);
    if (bin === 'sort') return ![sub, ...args].some(arg => /^-(?:[A-Za-z]*o|-[Oo]utput)/.test(arg ?? ''));
    if (bin === 'yq' || bin === 'less' || bin === 'more' || bin === 'date') return false;
    return true;
  });
}

/** Leading tokens that are version/help probes for any binary. */
function isVersionProbe(tokens) {
  return tokens.length === 2 && /^(--version|-v|-V|version|--help|-h)$/.test(tokens[1]);
}

/** Split on command separators outside quotes. Good enough for classification, not execution. */
export function splitShellSegments(command) {
  const segments = [];
  let current = '';
  let quote = '';
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote && command[i - 1] !== '\\') quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; current += ch; continue; }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') { segments.push({ text: current, pipe: false }); current = ''; i++; continue; }
    if (ch === ';' || ch === '\n') { segments.push({ text: current, pipe: false }); current = ''; continue; }
    if (ch === '|') { segments.push({ text: current, pipe: true }); current = ''; continue; }
    current += ch;
  }
  segments.push({ text: current, pipe: false });
  return segments.map((s) => ({ ...s, text: s.text.trim() })).filter((s) => s.text);
}

function tokenize(segment) {
  const tokens = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(segment))) tokens.push(m[1] ?? m[2] ?? m[3]);
  return tokens;
}

function stripEnvAssignments(tokens) {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  return tokens.slice(i);
}

const DESTRUCTIVE_SHELL = [
  { re: /\bgit\s+reset\s+--hard\b/, reason: 'Discards uncommitted work' },
  { re: /\bgit\s+clean\s+-[a-z]*f/, reason: 'Deletes untracked files' },
  { re: /\bgit\s+checkout\s+(--\s+)?\.(\s|$)/, reason: 'Discards uncommitted work' },
  { re: /\bgit\s+restore\s+(--staged\s+)?\.(\s|$)/, reason: 'Discards uncommitted work' },
  { re: /\bgit\s+push\b[^|;&]*\s(--force\b|-f\b|--force-with-lease\b|\+)/, reason: 'Force-pushes history' },
  { re: /\bgit\s+branch\s+-D\b/, reason: 'Deletes a branch' },
  { re: /\bgit\s+(stash\s+(drop|clear)|update-ref\s+-d|filter-branch|filter-repo)\b/, reason: 'Rewrites or drops history' },
  { re: /(^|\s)sudo\s/, reason: 'Runs as administrator' },
  { re: /\b(mkfs|diskutil\s+erase|format\s+[a-z]:)/i, reason: 'Erases a disk' },
  { re: /\bdd\s+[^|;&]*of=/, reason: 'Writes raw disk data' },
  { re: /\b(curl|wget|iwr|Invoke-WebRequest)\b[^|;&]*\|\s*(sudo\s+)?(sh|bash|zsh|iex|python|node)\b/, reason: 'Pipes a download into a shell' },
  { re: /\bchmod\s+(-R\s+)?[0-7]*777\b/, reason: 'Opens file permissions to everyone' },
  { re: /\b(chmod|chown)\s+-R\b/, reason: 'Changes permissions recursively' },
  { re: /:\(\)\s*\{/, reason: 'Fork bomb' },
  { re: /\bRemove-Item\b[^|;&]*-Recurse/i, reason: 'Deletes recursively' },
  { re: /(^|\s)(HOME|USERPROFILE)=/, reason: 'Shadows the home directory' },
];

const NETWORK_SHELL = [
  { re: /\bgit\s+push\b/, reason: 'Pushes to a remote' },
  { re: /\b(npm|pnpm|yarn)\s+publish\b/, reason: 'Publishes a package' },
  { re: /\bgh\s+(pr\s+(create|merge|close|comment|edit|review)|issue\s+(create|close|comment|edit)|release\s+create|repo\s+(create|delete)|api\s+-X\s*(POST|PUT|PATCH|DELETE))/i, reason: 'Writes to GitHub' },
  { re: /\bcurl\b[^|;&]*(\s-X\s*(POST|PUT|PATCH|DELETE)|\s(-d|--data|--data-binary|-F|--form|-T|--upload-file)\s)/, reason: 'Sends data to a server' },
  { re: /\b(scp|rsync|sftp)\b[^|;&]*:/, reason: 'Copies files to another machine' },
];

function rmTargetsAreScoped(tokens, workspaceRoot, homeDir) {
  const targets = tokens.slice(1).filter((t) => !t.startsWith('-'));
  if (!targets.length) return false;
  return targets.every((t) => {
    if (/[$*?`]/.test(t) || t === '.' || t === '..' || t === '/' || t === '~') return false;
    const resolved = resolveActionPath(t, workspaceRoot, homeDir);
    return Boolean(workspaceRoot) && isUnder(resolved, workspaceRoot) && resolved !== normSlashes(workspaceRoot);
  });
}

/**
 * Classify one shell command line.
 * @returns {{ readOnly: boolean, risk: 'low'|'elevated'|'high', reasons: string[], external: boolean, prefix: string }}
 */
export function classifyShellCommand(command, { workspaceRoot = '', homeDir = '' } = {}) {
  const text = String(command ?? '').trim();
  const reasons = [];
  let risk = 'low';
  let readOnly = Boolean(text);
  let external = false;
  const bump = (to, reason) => {
    const order = ['low', 'elevated', 'high'];
    if (order.indexOf(to) > order.indexOf(risk)) risk = to;
    if (reason && !reasons.includes(reason)) reasons.push(reason);
  };

  for (const rule of DESTRUCTIVE_SHELL) if (rule.re.test(text)) { bump('high', rule.reason); readOnly = false; }
  for (const rule of NETWORK_SHELL) if (rule.re.test(text)) { bump('elevated', rule.reason); readOnly = false; external = true; }

  let prefix = '';
  for (const segment of splitShellSegments(text)) {
    if (/(^|[^0-9<&])>>?\s*(?!\/dev\/null|&)/.test(segment.text.replace(/"[^"]*"|'[^']*'/g, ''))) readOnly = false;
    const tokens = stripEnvAssignments(tokenize(segment.text));
    if (!tokens.length) continue;
    const bin = tokens[0].replace(/^.*[\\/]/, '');
    if (!prefix) prefix = tokens.length > 1 && !tokens[1].startsWith('-') ? `${bin} ${tokens[1]}` : bin;

    if (bin === 'rm' || bin === 'rmdir' || bin === 'del' || bin === 'rd' || bin === 'unlink') {
      readOnly = false;
      const recursive = tokens.some((t) => /^-[a-zA-Z]*[rR]/.test(t) || t === '--recursive');
      if (!rmTargetsAreScoped(tokens, workspaceRoot, homeDir)) bump('high', recursive ? 'Deletes recursively outside a specific project path' : 'Deletes files outside a specific project path');
      else bump('low', '');
      continue;
    }

    let segmentReadOnly = READ_ONLY_COMMANDS.has(bin) || isVersionProbe(tokens);
    if (bin === 'git') {
      const sub = tokens.find((t, i) => i > 0 && !t.startsWith('-')) ?? '';
      segmentReadOnly = isGitVersionProbe(tokens.slice(1)) || READ_ONLY_GIT.has(sub) ||
        (sub === 'branch' && !tokens.some((t) => /^-(d|D|m|M|c|C)$|^--(delete|move|copy)$/.test(t))) ||
        (sub === 'remote' && tokens.length <= 3) || (sub === 'config' && tokens.includes('--get'));
    } else if (bin === 'find') {
      segmentReadOnly = !tokens.some((t) => /^-(delete|exec|execdir|ok|fprint)/.test(t));
    } else if (bin === 'sed') {
      segmentReadOnly = !tokens.some((t) => /^-[a-zA-Z]*i/.test(t) || t === '--in-place');
    } else if (bin === 'npm' || bin === 'pnpm' || bin === 'yarn') {
      segmentReadOnly = ['ls', 'list', 'view', 'outdated', 'why', 'info', '--version', '-v'].includes(tokens[1] ?? '');
    }
    if (!segmentReadOnly) readOnly = false;

    for (const t of tokens.slice(1)) {
      if (t.startsWith('-') || t.startsWith('http')) continue;
      if (!(isAbsolutePath(t) || t.startsWith('~') || t.startsWith('../'))) continue;
      if (/^\/dev\/(null|stdout|stderr|tty)$/.test(t) || /^\/tmp(\/|$)/.test(t)) continue;
      const resolved = resolveActionPath(t, workspaceRoot, homeDir);
      if (workspaceRoot && isUnder(resolved, workspaceRoot)) continue;
      external = true;
      if (isSecretPath(resolved)) bump('high', 'Touches credentials or secrets');
      else if (!segmentReadOnly) bump('elevated', 'Works outside this project');
    }
  }

  return { readOnly, risk, reasons, external, prefix: prefix || text.split(/\s+/)[0] || '' };
}

// ── Classification ───────────────────────────────────────────────────────────

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function originOf(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : '';
  } catch {
    return '';
  }
}

function hostOf(origin) {
  try { return new URL(origin).host; } catch { return origin; }
}

function shortArgs(args) {
  try {
    const text = JSON.stringify(args ?? {});
    return text.length > 160 ? `${text.slice(0, 157)}…` : text;
  } catch {
    return '';
  }
}

function plural(n, one, many) {
  return n === 1 ? one : many;
}

function displayPath(resolved, workspaceRoot) {
  const root = normSlashes(workspaceRoot || '');
  if (root && isUnder(resolved, root)) return resolved.slice(root.length + 1) || '.';
  return resolved;
}

/**
 * Classify any tool call.
 *
 * @param {string} name tool function name (built-in, `mcp__server__tool`, or `plugin__id__tool`)
 * @param {Record<string, unknown>} args
 * @param {{ workspaceRoots?: string[], homeDir?: string, toolHint?: 'read'|'write'|'destructive'|null }} [options]
 */
export function classifyToolCall(name, args = {}, options = {}) {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const roots = (options.workspaceRoots ?? []).map((r) => normSlashes(r)).filter(Boolean);
  const workspaceRoot = roots[0] ?? '';
  const homeDir = options.homeDir ? normSlashes(options.homeDir) : '';
  const inWorkspace = (resolved) => roots.length === 0 || roots.some((r) => isUnder(resolved, r));

  const action = {
    tool: name,
    kind: 'none',
    mutates: false,
    external: false,
    risk: 'low',
    reasons: [],
    resources: [],
    floor: false,
    title: name,
    detail: '',
    grant: null,
  };
  const bump = (to, reason) => {
    const order = ['low', 'elevated', 'high'];
    if (order.indexOf(to) > order.indexOf(action.risk)) action.risk = to;
    if (reason && !action.reasons.includes(reason)) action.reasons.push(reason);
  };

  // MCP and plugin tools: classified from annotations when the server provides them.
  const mcp = /^mcp__([^_].*?)__(.+)$/.exec(name);
  const plugin = /^plugin__(.+?)__(.+)$/.exec(name);
  if (mcp || plugin) {
    const server = (mcp ?? plugin)[1];
    const tool = (mcp ?? plugin)[2];
    action.kind = 'integration';
    action.external = true;
    action.mutates = options.toolHint !== 'read';
    action.resources = [server];
    action.title = mcp ? `Use ${server}` : `Use the ${server.replace(/_/g, '-')} plugin`;
    action.detail = `${tool.replace(/_/g, ' ')}  ${shortArgs(a)}`.trim();
    action.grant = { key: `${mcp ? 'mcp' : 'plugin'}:${server}`, label: mcp ? `${server} tools` : `the ${server.replace(/_/g, '-')} plugin` };
    if (options.toolHint === 'destructive') bump('high', 'The integration marks this tool as destructive');
    else if (options.toolHint !== 'read') bump('elevated', 'May change data in another service');
    return action;
  }

  if (NO_EFFECT_TOOLS.has(name)) {
    action.title = name.replace(/_/g, ' ');
    return action;
  }

  if (name === 'chat_send' || name === 'chat_stop') {
    action.kind = 'app';
    action.mutates = true;
    action.title = name === 'chat_send' ? 'Send work to another chat' : 'Stop another chat';
    action.detail = shortArgs(a);
    return action;
  }

  if (READ_PATH_TOOLS.has(name) || EDIT_PATH_TOOLS.has(name)) {
    const edit = EDIT_PATH_TOOLS.has(name);
    const raw = toolPathArgs(name, a);
    const paths = raw.length ? raw : ['.'];
    const resolved = paths.map((p) => resolveActionPath(p, workspaceRoot, homeDir));
    action.kind = edit ? 'edit' : 'read';
    action.mutates = edit;
    action.resources = resolved;
    if (edit && PLAN_WRITE_TOOLS.has(name) && raw.length) {
      const planRoot = resolveActionPath('documentation/plans', workspaceRoot);
      action.planScoped = resolved.every((p) => isUnder(p, planRoot) &&
        (name === 'make_directory' || /\.md$/i.test(p)));
    }
    const outside = resolved.filter((p) => !inWorkspace(p));
    if (outside.length) {
      action.external = true;
      // Auto reads anywhere on disk; edits outside the project always pause.
      if (edit) bump('elevated', 'Edits files outside this project');
      else action.reasons.push('Reads outside this project');
    }
    if (resolved.some(isSecretPath)) bump('high', 'Touches credentials or secrets');
    if (resolved.some((p) => isFloorPath(p, homeDir))) {
      action.floor = true;
      bump('high', "Agents can't read or change Minnow's encryption key or secret stores");
    }
    if (name === 'delete_path') bump(outside.length ? 'high' : 'low', outside.length ? 'Deletes outside this project' : '');
    const shown = resolved.map((p) => displayPath(p, workspaceRoot));
    const count = new Set(shown).size;
    if (edit) {
      action.title = name === 'delete_path' ? `Delete ${shown[0]}` :
        name === 'move_file' ? `Move ${shown[0]}` :
        name === 'make_directory' ? `Create folder ${shown[0]}` :
        count === 1 ? `Edit ${shown[0]}` : `Edit ${count} files`;
    } else {
      action.title = count === 1 ? `Read ${shown[0]}` : `Read ${count} files`;
    }
    action.detail = shown.join('\n');
    if (outside.length) {
      const dir = outside[0].replace(/\/[^/]*$/, '') || outside[0];
      action.grant = { key: `${edit ? 'edit' : 'read'}-path:${dir}`, label: `${edit ? 'edits' : 'reads'} in ${dir}` };
    } else if (edit) {
      action.grant = { key: 'edit:workspace', label: 'file edits in this project' };
    }
    return action;
  }

  if (SHELL_TOOLS.has(name)) {
    action.kind = 'shell';
    action.mutates = true;
    if (name === 'run_javascript' || name === 'run_python') {
      action.title = name === 'run_python' ? 'Run Python code' : 'Run JavaScript code';
      action.detail = str(a.code).slice(0, 2000);
      action.grant = { key: `shell:${name}`, label: name === 'run_python' ? 'Python code' : 'JavaScript code' };
      return action;
    }
    if (name === 'manage_dev_servers') {
      const op = str(a.action) || 'list';
      if (op === 'list') { action.kind = 'none'; action.mutates = false; action.title = 'List dev servers'; return action; }
      const cmd = str(a.command);
      action.title = `${op[0].toUpperCase()}${op.slice(1)} a dev server`;
      action.detail = [str(a.name) || str(a.id), cmd].filter(Boolean).join(' · ');
      if (a.network === 'lan') bump('elevated', 'Exposes a server to your network');
      if (cmd) {
        const shell = classifyShellCommand(cmd, { workspaceRoot, homeDir });
        for (const r of shell.reasons) bump(shell.risk, r);
      }
      action.grant = { key: 'shell:dev-server', label: 'dev server changes' };
      return action;
    }
    if (name === 'godot_control' || name === 'run_impeccable') {
      action.title = name === 'godot_control' ? 'Control the Godot editor' : 'Run the Impeccable detector';
      action.detail = shortArgs(a);
      action.grant = { key: `shell:${name}`, label: name === 'godot_control' ? 'Godot control' : 'Impeccable runs' };
      return action;
    }
    if (a.stop === true || (str(a.run_id) && !str(a.command))) {
      action.kind = 'none';
      action.mutates = false;
      action.title = 'Manage a running command';
      return action;
    }
    const command = str(a.command);
    const cwd = str(a.cwd);
    if (cwd) {
      const resolved = resolveActionPath(cwd, workspaceRoot, homeDir);
      if (!inWorkspace(resolved)) { action.external = true; bump('elevated', 'Runs outside this project'); }
    }
    const shell = classifyShellCommand(command, { workspaceRoot, homeDir });
    if (shell.readOnly) { action.kind = 'read'; action.mutates = false; }
    if (shell.external) action.external = true;
    for (const r of shell.reasons) bump(shell.risk, r);
    if (shell.risk !== 'low' && !shell.reasons.length) bump(shell.risk, '');
    action.title = shell.readOnly ? 'Run a read-only command' : 'Run a command';
    action.detail = command;
    action.resources = [command];
    if (shell.readOnly) action.clampedShellRead = isClampedShellRead(command);
    action.grant = shell.prefix ? { key: `shell:${shell.prefix}`, label: `\`${shell.prefix}\` commands` } : null;
    return action;
  }

  if (GIT_WRITE_TOOLS.has(name)) {
    action.kind = 'git';
    action.mutates = true;
    const sub = name.replace(/^git_/, '');
    if (name === 'git_branch') {
      const deleting = a.delete === true || a.force_delete === true || str(a.action) === 'delete';
      if (!deleting && !str(a.name) && !str(a.branch) && !str(a.create)) {
        action.kind = 'read'; action.mutates = false; action.title = 'List branches';
        return action;
      }
      if (deleting) bump('elevated', 'Deletes a branch');
    }
    if (name === 'git_checkout' && (a.force === true || a.discard === true)) bump('high', 'Discards uncommitted work');
    action.title = name === 'git_commit' ? 'Commit changes' : name === 'git_add' ? 'Stage changes' :
      name === 'git_checkout' ? `Check out ${str(a.branch) || str(a.ref) || 'a branch'}` : 'Change branches';
    action.detail = name === 'git_commit' ? str(a.message) : shortArgs(a);
    action.grant = { key: `git:${sub}`, label: `git ${sub}` };
    return action;
  }

  if (APP_WRITE_TOOLS.has(name)) {
    action.kind = 'app';
    action.mutates = true;
    const area = name.startsWith('issue_') || name.startsWith('bug_') ? 'issues' :
      name === 'write_clipboard' ? 'clipboard' : 'brain';
    action.title = area === 'issues' ? 'Update issues' : area === 'clipboard' ? 'Copy to the clipboard' : 'Update the Brain wiki';
    action.detail = str(a.title) || str(a.path) || shortArgs(a);
    if (name === 'issue_delete' || (name === 'manage_brain' && a.confirmed === true)) bump('elevated', 'Deletes saved data');
    action.grant = { key: `app:${area}`, label: area === 'issues' ? 'issue updates' : area === 'clipboard' ? 'clipboard writes' : 'Brain wiki writes' };
    return action;
  }

  if (name === 'read_clipboard') {
    action.kind = 'read';
    action.external = true;
    action.title = 'Read the clipboard';
    action.grant = { key: 'read:clipboard', label: 'clipboard reads' };
    return action;
  }

  if (NETWORK_READ_TOOLS.has(name)) {
    action.kind = 'network';
    action.external = true;
    const url = str(a.url) || (Array.isArray(a.urls) ? str(a.urls[0]) : '');
    const origin = originOf(url);
    if (origin) {
      action.title = `Open ${hostOf(origin)}`;
      action.detail = url;
      action.resources = [origin];
      action.grant = { key: `origin:${origin}`, label: hostOf(origin) };
    } else {
      action.title = 'Search the web';
      action.detail = str(a.query);
      action.grant = { key: 'network:search', label: 'web searches' };
    }
    return action;
  }

  if (name.startsWith('browser_') || name === 'request_browser_origin_access') {
    action.kind = 'browser';
    action.external = true;
    const url = str(a.url);
    const origin = originOf(url);
    if (name === 'browser_navigate' || name === 'browser_drive_navigate' || name === 'browser_new_tab' || name === 'request_browser_origin_access') {
      action.title = origin ? `Open ${hostOf(origin)} in the browser` : 'Open a browser tab';
      action.detail = url;
      action.resources = origin ? [origin] : [];
      action.grant = origin ? { key: `origin:${origin}`, label: hostOf(origin) } : { key: 'browser:tabs', label: 'browser tabs' };
      return action;
    }
    action.mutates = true;
    if (name === 'browser_fill') {
      action.title = 'Fill in a form';
      bump('elevated', 'Enters data into a web page');
    } else if (name === 'browser_eval') {
      action.title = 'Run script in a web page';
      bump('elevated', 'Runs code inside a web page');
    } else {
      action.title = 'Click in the browser';
    }
    action.detail = str(a.selector) || str(a.uid) || str(a.expression) || shortArgs(a);
    action.grant = { key: `browser:${name}`, label: name === 'browser_click' ? 'browser clicks' : name === 'browser_fill' ? 'form fills' : 'page scripts' };
    return action;
  }

  if (REMOTE_WRITE_TOOLS.has(name)) {
    action.kind = 'network';
    action.external = true;
    action.mutates = true;
    action.title = name.startsWith('release') ? 'Change a release' : 'Run a GitHub Action';
    action.detail = shortArgs(a);
    bump('elevated', 'Changes something on GitHub');
    action.grant = { key: `remote:${name}`, label: name.startsWith('release') ? 'release changes' : 'GitHub Actions runs' };
    return action;
  }

  if (SETTINGS_TOOLS.has(name)) {
    action.kind = 'settings';
    action.mutates = true;
    if (name === 'plugin_manage') {
      const op = str(a.action) || 'manage';
      action.title = `${op[0].toUpperCase()}${op.slice(1)} a plugin`;
      action.detail = str(a.id) || str(a.source) || shortArgs(a);
      if (['install', 'update', 'enable', 'scaffold', 'reload'].includes(op)) bump('elevated', 'Installs or runs plugin code');
      action.grant = { key: 'settings:plugins', label: 'plugin changes' };
      return action;
    }
    if (name === 'update_settings') {
      const keys = Array.isArray(a.changes) ? a.changes.map((c) => str(c?.key)).filter(Boolean) : [];
      action.title = keys.length === 1 ? `Change ${keys[0]}` : `Change ${keys.length || 'some'} ${plural(keys.length, 'setting', 'settings')}`;
      action.detail = Array.isArray(a.changes) ? a.changes.map((c) => `${str(c?.key)} → ${JSON.stringify(c?.value)}`).join('\n') : '';
      action.resources = keys;
      if (keys.some((k) => SECURITY_SETTING_PATTERN.test(k))) bump('high', 'Changes a security setting');
      action.grant = keys.length === 1 ? { key: `setting:${keys[0]}`, label: keys[0] } : { key: 'settings:all', label: 'settings changes' };
      return action;
    }
    action.title = 'Change the appearance';
    action.detail = shortArgs(a);
    action.grant = { key: 'settings:appearance', label: 'appearance changes' };
    return action;
  }

  // Unknown built-in: treat as an unclassified effect so it is never silently allowed in Auto.
  action.kind = 'unknown';
  action.mutates = true;
  action.title = name.replace(/_/g, ' ');
  action.detail = shortArgs(a);
  bump('elevated', 'Minnow does not know what this tool changes');
  action.grant = { key: `tool:${name}`, label: name };
  return action;
}

// ── Decisions ────────────────────────────────────────────────────────────────

function grantMatches(grants, action) {
  if (!action.grant || !Array.isArray(grants) || !grants.length) return false;
  return grants.some((g) => (typeof g === 'string' ? g : g?.key) === action.grant.key);
}

function clampDenial(clamp, action) {
  if (!clamp || (!action.mutates && action.clampedShellRead !== false)) return null;
  if (clamp === 'plans' && action.planScoped) return null;
  // Plans attach to Issues: filing and updating tracker cards stays allowed.
  if (clamp === 'plans' && /^issue_/.test(action.tool) && action.tool !== 'issue_delete') {
    return null;
  }
  return clamp === 'plans'
    ? 'This turn is planning only: you can read, research, and write plan documents under documentation/plans/, but not change anything else.'
    : 'This turn is read-only (/ask): answer from what you can read and do not change anything.';
}

/**
 * @param {'manual'|'auto'|'full'} level
 * @param {ReturnType<typeof classifyToolCall>} action
 * @param {{ grants?: Array<string|{key:string}>, clamp?: 'read-only'|'plans'|null }} [context]
 * @returns {{ decision: 'allow'|'ask'|'deny', reason: string }}
 */
export function decidePermission(level, action, context = {}) {
  if (action.floor) return { decision: 'deny', reason: action.reasons[0] ?? 'Blocked' };
  const clamped = clampDenial(normalizeTurnClamp(context.clamp), action);
  if (clamped) return { decision: 'deny', reason: clamped };
  const lvl = normalizePermissionLevel(level);
  if (lvl === 'full') return { decision: 'allow', reason: 'Full access' };
  if (action.kind === 'none') return { decision: 'allow', reason: 'No side effects' };
  if (action.kind === 'read' && !action.external && action.risk === 'low') return { decision: 'allow', reason: 'Reads inside the project' };
  if (action.risk !== 'high' && grantMatches(context.grants, action)) return { decision: 'allow', reason: 'Allowed for this chat' };
  if (lvl === 'auto' && action.risk === 'low') return { decision: 'allow', reason: 'Routine action' };
  return { decision: 'ask', reason: action.reasons[0] ?? (lvl === 'manual' ? 'Manual approval' : 'Needs approval') };
}
