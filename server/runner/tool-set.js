export const RENDERER_ONLY_TOOL_IDS = Object.freeze([
  'get_datetime',
  'calculate',
  'get_system_info',
  'read_clipboard',
  'write_clipboard',
  'ask_question',
  'wikipedia_search',
  'web_search',
  'spawn_sub_agent',
  'cancel_sub_agent',
  'list_sub_agents',
  'get_sub_agent_status',
  'set_chat_mode',
  'create_chat_with_mode',
  'launch_minnow_app',
  'propose_mode_switch',
  'browser_list',
  'browser_navigate',
  'browser_new_tab',
  'browser_switch_tab',
  'browser_close_tab',
  'browser_snapshot',
  'browser_click',
  'browser_fill',
  'browser_eval',
  'browser_screenshot',
  'request_browser_origin_access',
  'todo_write',
  'get_appearance',
  'update_appearance',
  'upload_appearance_asset',
  'recall_chat_context',
  'recall_turn_full',
]);

const RENDERER_ONLY_SET = new Set(RENDERER_ONLY_TOOL_IDS);

/**
 * Every server-side tool a headless agent may hold. Sub-agents run from this
 * set (their type rows narrow it further); board roles run from the smaller
 * lists below.
 */
export const DEFAULT_HEADLESS_TOOL_IDS = Object.freeze([
  'list_directory',
  'read_file',
  'read_file_range',
  'read_document',
  'find_files',
  'get_file_metadata',
  'search_in_file',
  'grep',
  'save_file',
  'append_file',
  'insert_at_line',
  'replace_text_in_file',
  'make_directory',
  'move_file',
  'copy_file',
  'delete_path',
  'create_pdf',
  'create_spreadsheet',
  'create_word_document',
  'git_status',
  'git_diff',
  'git_log',
  'git_branch',
  'git_add',
  'git_commit',
  'git_checkout',
  'execute_command',
  'read_command_log',
  'list_running_commands',
  'stop_command',
  'start_background_command',
  'stop_background_command',
  'manage_dev_servers',
  'run_javascript',
  'run_python',
  'repo_map',
  'find_symbol',
  'who_calls',
  'read_symbol',
  'get_lsp_diagnostics',
  'brain_search',
  'brain_read_page',
  'brain_list',
  'save_memory',
  'web_search_ddg',
  'web_search_tavily',
  'web_search_searxng',
  'fetch_web_content',
  'rag_web_content',
  'minnow_docs_search',
  'minnow_docs_read',
  'minnow_docs_list',
  'load_impeccable_context',
  'load_aesthetics_reference',
  'run_impeccable',
]);

// ── Board roles ──────────────────────────────────────────────────────────────

/**
 * What a board attempt can do without changing the checkout.
 *
 * A board task is scoped work in a worktree, so this drops tools whose job
 * another tool here already does — every duplicate is a choice the model
 * re-makes each turn and a schema it carries on all of them:
 * - `start_background_command` / `stop_background_command` -> `execute_command`
 *   with `background: true`, which `read_command_log` and `stop_command` pair with
 * - `run_javascript` / `run_python` -> `execute_command`
 * - `web_search_tavily` / `web_search_searxng` -> `web_search_ddg`, the one that
 *   needs no API key and so works in every workspace
 * - `rag_web_content` -> `fetch_web_content`
 * - `brain_list` -> `brain_search`
 *
 * — and tools no board task has a use for: office-document creation,
 * `read_document`, the Minnow product manual, the impeccable design-review set,
 * `manage_dev_servers` (the browser rung starts its own app), and `save_memory`,
 * because an unattended attempt should not write the user's long-term memory.
 */
export const BOARD_VERIFIER_TOOL_IDS = Object.freeze([
  'list_directory',
  'read_file',
  'read_file_range',
  'find_files',
  'get_file_metadata',
  'search_in_file',
  'grep',
  'git_status',
  'git_diff',
  'git_log',
  'git_branch',
  'execute_command',
  'read_command_log',
  'list_running_commands',
  'stop_command',
  'repo_map',
  'find_symbol',
  'who_calls',
  'read_symbol',
  'get_lsp_diagnostics',
  'brain_search',
  'brain_read_page',
  'web_search_ddg',
  'fetch_web_content',
]);

/** Editing the checkout: the Builder, and no other board role. */
export const BOARD_WRITE_TOOL_IDS = Object.freeze([
  'save_file',
  'append_file',
  'insert_at_line',
  'replace_text_in_file',
  'make_directory',
  'move_file',
  'copy_file',
  'delete_path',
  'git_add',
  'git_commit',
  'git_checkout',
]);

export const BOARD_BUILDER_TOOL_IDS = Object.freeze([
  ...BOARD_VERIFIER_TOOL_IDS,
  ...BOARD_WRITE_TOOL_IDS,
]);

export const BROWSER_TOOL_IDS = Object.freeze([
  'browser_drive_navigate',
  'browser_drive_read_page',
  'browser_drive_click',
  'browser_drive_type',
  'browser_drive_read_console',
  'browser_drive_read_network',
  'browser_drive_screenshot',
  'browser_drive_resize',
]);

const BROWSER_TOOL_SET = new Set(BROWSER_TOOL_IDS);

/**
 * What the browser rung may dispatch — an execution allow-list, not a
 * model-facing tool list. The rung drives these from code against the plan's
 * pinned URL and `Accept` criteria; no model chooses the calls.
 */
export const FINAL_TESTER_TOOL_IDS = Object.freeze([
  ...BOARD_VERIFIER_TOOL_IDS,
  ...BROWSER_TOOL_IDS,
]);

/** Board roles that verify a checkout rather than edit one. */
const BOARD_VERIFIER_ROLES = new Set(['tester', 'final', 'merge']);

/**
 * Tools a role's **model** is shown.
 *
 * Verifying roles are read-only because their own prompts already say so — the
 * Tester is told "Do not modify application code", the Final Tester likewise —
 * and a prompt line is not an enforcement point. A tester holding `delete_path`
 * and `git_checkout` has, in this repo, used them on the real checkout.
 *
 * `browser_drive_*` is absent from every role, `final` included: those calls
 * come from the browser rung, in code, after the Final Tester finishes. Handing
 * them to its model bought a prompt section spent talking it out of a
 * capability it should not have had.
 *
 * Anything that is not a board role — `sub-agent`, and any future caller — gets
 * the full headless set and narrows it itself.
 *
 * @param {string} role
 * @returns {readonly string[]}
 */
export function headlessToolIdsForRole(role) {
  if (BOARD_VERIFIER_ROLES.has(role)) return BOARD_VERIFIER_TOOL_IDS;
  if (role === 'builder') return BOARD_BUILDER_TOOL_IDS;
  return DEFAULT_HEADLESS_TOOL_IDS;
}

/**
 * Tools a role may **execute** — the model-facing set, plus what the engine
 * drives on that role's behalf.
 * @param {string} role
 * @returns {readonly string[]}
 */
export function dispatchToolIdsForRole(role) {
  return role === 'final' ? FINAL_TESTER_TOOL_IDS : headlessToolIdsForRole(role);
}

/**
 * @param {string} name
 * @returns {boolean}
 */
export function isBrowserDriverTool(name) {
  return BROWSER_TOOL_SET.has(name);
}

/**
 * @param {Iterable<string>} ids
 * @returns {string[]}
 */
export function browserToolsIn(ids) {
  const hits = [];
  for (const id of ids) {
    if (BROWSER_TOOL_SET.has(id)) hits.push(id);
  }
  return hits;
}

/**
 * @param {string} name
 * @returns {boolean}
 */
export function isRendererOnlyTool(name) {
  return RENDERER_ONLY_SET.has(name);
}

/**
 * @param {Iterable<string>} ids
 * @returns {string[]}
 */
export function rendererOnlyToolsIn(ids) {
  const hits = [];
  for (const id of ids) {
    if (RENDERER_ONLY_SET.has(id)) hits.push(id);
  }
  return hits;
}
