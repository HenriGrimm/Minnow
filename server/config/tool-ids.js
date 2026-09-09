/** Built-in tool ids (keep in sync with src/tools/definitions.ts). */

/** Archive recall tools — browser-side, permission `ask` (MIN-139). */
export const ARCHIVE_RECALL_TOOL_IDS = ['recall_chat_context', 'recall_turn_full'];

/** Wiki tools seeded at permission `full` (no prompt) on first run and back-fill. */
export const BRAIN_WIKI_TOOL_IDS = [
  'brain_search',
  'brain_read_page',
  'brain_list',
  'brain_write_page',
  'brain_append_log',
  'brain_ingest_source',
  'save_memory',
];

/** Code-index tools seeded at permission `full` (MIN-B7). */
export const BRAIN_CODE_TOOL_IDS = [
  'repo_map',
  'find_symbol',
  'who_calls',
  'read_symbol',
];

/** All Brain tools that default to permission `full`. */
export const BRAIN_FULL_PERMISSION_TOOL_IDS = [
  ...BRAIN_WIKI_TOOL_IDS,
  ...BRAIN_CODE_TOOL_IDS,
];

/** Destructive Brain tool — defaults to permission `ask`. */
export const BRAIN_DESTRUCTIVE_TOOL_IDS = ['manage_brain'];

/** Official read-only product documentation tools. */
export const MINNOW_DOCS_TOOL_IDS = [
  'minnow_docs_search',
  'minnow_docs_read',
  'minnow_docs_list',
];

export const BRAIN_WIKI_TOOL_ID_SET = new Set(BRAIN_WIKI_TOOL_IDS);
export const BRAIN_CODE_TOOL_ID_SET = new Set(BRAIN_CODE_TOOL_IDS);
export const BRAIN_FULL_PERMISSION_TOOL_ID_SET = new Set(BRAIN_FULL_PERMISSION_TOOL_IDS);
export const BRAIN_DESTRUCTIVE_TOOL_ID_SET = new Set(BRAIN_DESTRUCTIVE_TOOL_IDS);

export const ALL_TOOL_IDS = [
  'web_search',
  'wikipedia_search',
  'fetch_web_content',
  'rag_web_content',
  'get_datetime',
  'calculate',
  'read_clipboard',
  'write_clipboard',
  'get_system_info',
  'ask_question',
  'list_directory',
  'read_file',
  'read_file_range',
  'save_file',
  'append_file',
  'insert_at_line',
  'replace_text_in_file',
  'search_in_file',
  'grep',
  'make_directory',
  'move_file',
  'copy_file',
  'delete_path',
  'find_files',
  'get_file_metadata',
  'git_status',
  'git_diff',
  'git_log',
  'git_add',
  'git_commit',
  'git_checkout',
  'git_branch',
  'execute_command',
  'read_command_log',
  'list_running_commands',
  'stop_command',
  'start_background_command',
  'stop_background_command',
  'manage_dev_servers',
  'run_javascript',
  'run_python',
  'spawn_sub_agent',
  'cancel_sub_agent',
  'list_sub_agents',
  'get_sub_agent_status',
  'issue_add',
  'issue_update',
  'issue_link',
  'issue_get_state',
  'issue_delete',
  'issue_search',
  'issue_comment',
  'issue_assign',
  'issue_unlink',
  'issue_move',
  'report_orchestrator_status',
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
  'run_impeccable',
  'load_impeccable_context',
  'load_aesthetics_reference',
  'get_lsp_diagnostics',
  'save_memory',
  'brain_search',
  'brain_read_page',
  'brain_list',
  ...MINNOW_DOCS_TOOL_IDS,
  'brain_write_page',
  'brain_append_log',
  'brain_ingest_source',
  'manage_brain',
  'search_settings',
  'get_settings',
  'update_settings',
  'get_appearance',
  'update_appearance',
  'upload_appearance_asset',
  'repo_map',
  'find_symbol',
  'who_calls',
  'read_symbol',
  'recall_chat_context',
  'recall_turn_full',
  'read_diagnostics',
];
