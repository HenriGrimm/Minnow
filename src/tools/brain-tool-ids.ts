/** Project memory tools; search/read are read-only, save/forget write. */
export const MEMORY_READ_TOOL_IDS = ['memory_search', 'memory_read'] as const;
export const MEMORY_WRITE_TOOL_IDS = ['memory_save', 'memory_forget'] as const;
export const MEMORY_TOOL_IDS = [...MEMORY_READ_TOOL_IDS, ...MEMORY_WRITE_TOOL_IDS] as const;

export const BRAIN_CODE_TOOL_IDS = [
  'repo_map',
  'find_symbol',
  'who_calls',
  'read_symbol',
] as const;

export const BRAIN_FULL_PERMISSION_TOOL_IDS = [
  ...MEMORY_TOOL_IDS,
  ...BRAIN_CODE_TOOL_IDS,
] as const;

/** Destructive Brain tool — defaults to permission `ask`. */
export const BRAIN_DESTRUCTIVE_TOOL_IDS = ['manage_brain'] as const;

export const MEMORY_TOOL_ID_SET = new Set<string>(MEMORY_TOOL_IDS);
export const MEMORY_WRITE_TOOL_ID_SET = new Set<string>(MEMORY_WRITE_TOOL_IDS);
export const BRAIN_CODE_TOOL_ID_SET = new Set<string>(BRAIN_CODE_TOOL_IDS);
export const BRAIN_FULL_PERMISSION_TOOL_ID_SET = new Set<string>(BRAIN_FULL_PERMISSION_TOOL_IDS);
export const BRAIN_DESTRUCTIVE_TOOL_ID_SET = new Set<string>(BRAIN_DESTRUCTIVE_TOOL_IDS);
