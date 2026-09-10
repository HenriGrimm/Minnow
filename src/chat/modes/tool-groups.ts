import type { ModeId, ModeToolPolicy } from './types';

// ── IDs ──────────────────────────────────────────────────────────────────────

/** Named tool groups keyed for mode matrix expansion. */
export const TOOL_GROUP_IDS = {
  'util-basic': [
    'get_datetime',
    'calculate',
    'get_system_info',
    'read_clipboard',
    'write_clipboard',
  ],
  web: ['web_search', 'wikipedia_search', 'fetch_web_content', 'rag_web_content'],
  'files-read': [
    'list_directory',
    'read_file',
    'read_file_range',
    'read_document',
    'find_files',
    'get_file_metadata',
    'search_in_file',
    'grep',
  ],
  'files-write': [
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
  ],
  'git-read': ['git_status', 'git_diff', 'git_log', 'git_branch'],
  'git-write': ['git_add', 'git_commit', 'git_checkout'],
  'code-exec': [
    'execute_command',
    'read_command_log',
    'list_running_commands',
    'stop_command',
    'start_background_command',
    'stop_background_command',
    'manage_dev_servers',
    'run_javascript',
    'run_python',
  ],
  'code-intel': ['repo_map', 'find_symbol', 'who_calls', 'read_symbol'],
  lsp: ['get_lsp_diagnostics'],
  'sub-agents': [
    'spawn_sub_agent',
    'cancel_sub_agent',
    'list_sub_agents',
    'get_sub_agent_status',
  ],
  issues: [
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
  ],
  'mode-mgmt': [
    'set_chat_mode',
    'create_chat_with_mode',
    'launch_minnow_app',
    'propose_mode_switch',
  ],
  ask: ['ask_question'],
  browser: [
    'browser_reserve_tab',
    'browser_release_tab',
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
  ],
  'brain-core': ['brain_search', 'brain_read_page', 'brain_list', 'save_memory'],
  'brain-admin': [
    'brain_write_page',
    'brain_append_log',
    'brain_ingest_source',
    'manage_brain',
  ],
  'minnow-docs': ['minnow_docs_search', 'minnow_docs_read', 'minnow_docs_list'],
  recall: ['recall_chat_context', 'recall_turn_full'],
  settings: ['search_settings', 'get_settings', 'update_settings'],
  appearance: ['get_appearance', 'update_appearance', 'upload_appearance_asset'],
  diagnostics: ['read_diagnostics'],
  impeccable: ['load_impeccable_context', 'load_aesthetics_reference', 'run_impeccable'],
  todo: ['todo_write'],
} as const;

export type ToolGroupId = keyof typeof TOOL_GROUP_IDS;

/** All group ids (stable order for tests). */
export const TOOL_GROUP_ID_LIST: ToolGroupId[] = Object.keys(
  TOOL_GROUP_IDS,
) as ToolGroupId[];

/** Plan mode: files-write limited to planner doc writes (see context-reduction matrix footnote 1). */
export const PLAN_FILES_WRITE_ALLOW = ['save_file', 'make_directory'] as const;

/** Modes that still have a registry entry (persisted `desktop` / `email` remap to general). */
export type RegisteredModeId = Exclude<ModeId, 'desktop' | 'email'>;

// ── Matrix ───────────────────────────────────────────────────────────────────

export const MODE_ALLOWED_GROUPS: Record<RegisteredModeId, readonly ToolGroupId[]> = {
  general: [
    'util-basic',
    'web',
    'files-read',
    'files-write',
    'git-read',
    'git-write',
    'code-exec',
    'code-intel',
    'lsp',
    'sub-agents',
    'issues',
    'mode-mgmt',
    'ask',
    'browser',
    'brain-core',
    'brain-admin',
    'minnow-docs',
    'recall',
    'settings',
    'impeccable',
  ],
  build: [
    'util-basic',
    'web',
    'files-read',
    'files-write',
    'git-read',
    'git-write',
    'code-exec',
    'code-intel',
    'lsp',
    'sub-agents',
    'issues',
    'mode-mgmt',
    'ask',
    'browser',
    'brain-core',
    'brain-admin',
    'recall',
    'impeccable',
    'todo',
  ],
  plan: [
    'util-basic',
    'web',
    'files-read',
    'git-read',
    'code-exec',
    'code-intel',
    'lsp',
    'sub-agents',
    'issues',
    'mode-mgmt',
    'ask',
    'browser',
    'brain-core',
    'brain-admin',
    'recall',
    'impeccable',
  ],
  'super-plan': [
    'util-basic',
    'web',
    'files-read',
    'git-read',
    'code-intel',
    'lsp',
    'sub-agents',
    'issues',
    'mode-mgmt',
    'ask',
    'browser',
    'brain-core',
    'brain-admin',
    'recall',
    'impeccable',
  ],
  orchestrate: [
    'util-basic',
    'files-read',
    'git-read',
    'code-intel',
    'sub-agents',
    'mode-mgmt',
    'ask',
    'brain-core',
    'brain-admin',
    'recall',
  ],
  debug: [
    'util-basic',
    'web',
    'files-read',
    'files-write',
    'git-read',
    'git-write',
    'code-exec',
    'code-intel',
    'lsp',
    'sub-agents',
    'issues',
    'mode-mgmt',
    'ask',
    'browser',
    'brain-core',
    'brain-admin',
    'recall',
    'impeccable',
    'todo',
    'diagnostics',
  ],
  /** First-run wizard tour guide — safe demo set: no shell, no writes. */
  onboarding: [
    'util-basic',
    'web',
    'files-read',
    'brain-core',
    'brain-admin',
    'minnow-docs',
    'ask',
  ],
};

/** Per-mode explicit deny overrides applied after group expansion. */
export const MODE_TOOL_DENY_OVERRIDES: Partial<Record<ModeId, readonly string[]>> = {
  plan: [
    'append_file',
    'insert_at_line',
    'replace_text_in_file',
    'move_file',
    'copy_file',
    'delete_path',
    'update_settings',
  ],
  'super-plan': [
    'append_file',
    'insert_at_line',
    'replace_text_in_file',
    'move_file',
    'copy_file',
    'delete_path',
    'update_settings',
  ],
  orchestrate: ['spawn_sub_agent', 'cancel_sub_agent'],
};

/** Per-mode explicit allow overrides applied after group expansion. */
export const MODE_TOOL_ALLOW_OVERRIDES: Partial<Record<ModeId, readonly string[]>> = {
  plan: [...PLAN_FILES_WRITE_ALLOW],
  'super-plan': [...PLAN_FILES_WRITE_ALLOW],
};

// ── Expand ───────────────────────────────────────────────────────────────────

/** Flatten group ids to a deduplicated tool id list. */
export function expandToolGroups(groups: readonly ToolGroupId[]): string[] {
  const ids = new Set<string>();
  for (const groupId of groups) {
    for (const toolId of TOOL_GROUP_IDS[groupId]) {
      ids.add(toolId);
    }
  }
  return [...ids];
}

/** Build a deny-by-default policy from allowed groups plus optional overrides. */
export function allowGroupsToolPolicy(
  modeId: ModeId,
  groups: readonly ToolGroupId[],
): ModeToolPolicy {
  const allowed = new Set(expandToolGroups(groups));
  for (const id of MODE_TOOL_ALLOW_OVERRIDES[modeId] ?? []) {
    allowed.add(id);
  }
  for (const id of MODE_TOOL_DENY_OVERRIDES[modeId] ?? []) {
    allowed.delete(id);
  }
  const tools: Record<string, 'allow'> = {};
  for (const id of allowed) {
    tools[id] = 'allow';
  }
  return { default: 'deny', tools };
}

export type BoardMemberRole = 'build' | 'test' | 'fix';

// ── Board ────────────────────────────────────────────────────────────────────

/**
 * Legacy board-role rows. The live board tool set is
 * `server/runner/tool-set.js` — `headlessToolIdsForRole` — which is narrower;
 * these rows survive only for the leftover matrix tests.
 */
export const BOARD_ROLE_ALLOWED_GROUPS: Record<BoardMemberRole, readonly ToolGroupId[]> = {
  build: [
    'util-basic',
    'web',
    'files-read',
    'files-write',
    'git-read',
    'git-write',
    'code-exec',
    'code-intel',
    'lsp',
    'browser',
    'brain-core',
    'todo',
  ],
  test: [
    'util-basic',
    'web',
    'files-read',
    'git-read',
    'code-exec',
    'code-intel',
    'lsp',
    'brain-core',
    'todo',
  ],
  fix: [
    'util-basic',
    'web',
    'files-read',
    'files-write',
    'git-read',
    'git-write',
    'code-exec',
    'code-intel',
    'lsp',
    'brain-core',
    'todo',
  ],
};

/** Expand a leftover board role matrix row to the allowed tool id set. */
export function expandBoardRoleAllowedTools(role: BoardMemberRole): Set<string> {
  return new Set(expandToolGroups(BOARD_ROLE_ALLOWED_GROUPS[role]));
}

/** Inverse map: tool id → groups that contain it (for matrix tests). */
export function buildToolIdToGroupsMap(): Map<string, ToolGroupId[]> {
  const map = new Map<string, ToolGroupId[]>();
  for (const groupId of TOOL_GROUP_ID_LIST) {
    for (const toolId of TOOL_GROUP_IDS[groupId]) {
      const existing = map.get(toolId) ?? [];
      existing.push(groupId);
      map.set(toolId, existing);
    }
  }
  return map;
}
