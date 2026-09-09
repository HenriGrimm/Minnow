export const MAX_PARALLEL_READ_TOOLS = 6;

const PARALLEL_EXTRA_WHITELIST = new Set([
  'get_datetime',
  'calculate',
  'get_system_info',
  'wikipedia_search',
  'list_sub_agents',
  'get_sub_agent_status',
]);

const SEQUENTIAL_DENY = new Set([
  'ask_question',
  'propose_mode_switch',
  'read_clipboard',
  'write_clipboard',
  'spawn_sub_agent',
  'cancel_sub_agent',
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
  'set_chat_mode',
  'create_chat_with_mode',
  'launch_minnow_app',
  'brain_write_page',
  'brain_append_log',
  'brain_ingest_source',
  'save_memory',
  'manage_brain',
]);

const CACHEABLE_READ = new Set([
  'read_file',
  'read_file_range',
  'list_directory',
  'search_in_file',
  'grep',
  'get_file_metadata',
  'find_files',
  'git_status',
  'git_diff',
  'git_log',
  'load_impeccable_context',
  'load_aesthetics_reference',
  'web_search',
  'web_search_ddg',
  'web_search_tavily',
  'fetch_web_content',
  'rag_web_content',
  'read_document',
]);

/**
 * @param {string} name
 * @returns {boolean}
 */
export function isParallelSafeTool(name) {
  if (
    name.startsWith('browser_') ||
    name.startsWith('mcp__') ||
    name.startsWith('plugin__')
  ) {
    return false;
  }
  if (SEQUENTIAL_DENY.has(name)) {
    return false;
  }
  if (PARALLEL_EXTRA_WHITELIST.has(name)) {
    return true;
  }
  return CACHEABLE_READ.has(name);
}

/**
 * @param {Array<{ function?: { name?: string } }>} toolCalls
 * @returns {Array<{ kind: 'parallel' | 'sequential', calls: typeof toolCalls }>}
 */
export function partitionToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return [];
  }

  /** @type {Array<{ kind: 'parallel' | 'sequential', calls: typeof toolCalls }>} */
  const segments = [];
  /** @type {typeof toolCalls} */
  let parallelBuffer = [];

  function flushParallel() {
    if (parallelBuffer.length === 0) return;
    segments.push({ kind: 'parallel', calls: parallelBuffer });
    parallelBuffer = [];
  }

  for (const tc of toolCalls) {
    const name = typeof tc?.function?.name === 'string' ? tc.function.name : '';
    if (isParallelSafeTool(name)) {
      parallelBuffer.push(tc);
      continue;
    }
    flushParallel();
    segments.push({ kind: 'sequential', calls: [tc] });
  }

  flushParallel();
  return segments;
}
