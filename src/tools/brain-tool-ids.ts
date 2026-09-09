export const BRAIN_WIKI_TOOL_IDS = [
  'brain_search',
  'brain_read_page',
  'brain_list',
  'brain_write_page',
  'brain_append_log',
  'brain_ingest_source',
  'save_memory',
] as const;

export const BRAIN_CODE_TOOL_IDS = [
  'repo_map',
  'find_symbol',
  'who_calls',
  'read_symbol',
] as const;

export const BRAIN_FULL_PERMISSION_TOOL_IDS = [
  ...BRAIN_WIKI_TOOL_IDS,
  ...BRAIN_CODE_TOOL_IDS,
] as const;

/** Destructive Brain tool — defaults to permission `ask`. */
export const BRAIN_DESTRUCTIVE_TOOL_IDS = ['manage_brain'] as const;

export const BRAIN_WIKI_TOOL_ID_SET = new Set<string>(BRAIN_WIKI_TOOL_IDS);
export const BRAIN_CODE_TOOL_ID_SET = new Set<string>(BRAIN_CODE_TOOL_IDS);
export const BRAIN_FULL_PERMISSION_TOOL_ID_SET = new Set<string>(BRAIN_FULL_PERMISSION_TOOL_IDS);
export const BRAIN_DESTRUCTIVE_TOOL_ID_SET = new Set<string>(BRAIN_DESTRUCTIVE_TOOL_IDS);
