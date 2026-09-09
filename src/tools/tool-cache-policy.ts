export type ToolCachePolicy = {
  cacheable: boolean;
  ttlMs: number;
};

const DEFAULT_CACHE_POLICY: ToolCachePolicy = { cacheable: false, ttlMs: 0 };

/** Per-tool cache policy (v1 constants; invalidation-primary for filesystem reads). */
const CACHE_POLICY: Record<string, ToolCachePolicy> = {
  read_file: { cacheable: true, ttlMs: 0 },
  read_file_range: { cacheable: true, ttlMs: 0 },
  list_directory: { cacheable: true, ttlMs: 0 },
  search_in_file: { cacheable: true, ttlMs: 0 },
  grep: { cacheable: true, ttlMs: 0 },
  get_file_metadata: { cacheable: true, ttlMs: 0 },
  find_files: { cacheable: true, ttlMs: 0 },
  git_status: { cacheable: true, ttlMs: 0 },
  git_diff: { cacheable: true, ttlMs: 0 },
  git_log: { cacheable: true, ttlMs: 0 },
  get_lsp_diagnostics: { cacheable: false, ttlMs: 0 },
  load_impeccable_context: { cacheable: true, ttlMs: 300_000 },
  load_aesthetics_reference: { cacheable: true, ttlMs: 300_000 },
  web_search: { cacheable: true, ttlMs: 120_000 },
  web_search_ddg: { cacheable: true, ttlMs: 120_000 },
  web_search_tavily: { cacheable: true, ttlMs: 120_000 },
  fetch_web_content: { cacheable: true, ttlMs: 120_000 },
  rag_web_content: { cacheable: true, ttlMs: 120_000 },
  read_document: { cacheable: true, ttlMs: 0 },
};

/** Resolve cache policy for a built-in tool name. */
export function getCachePolicyForTool(name: string): ToolCachePolicy {
  if (name.startsWith('mcp__') || name.startsWith('plugin__')) {
    return DEFAULT_CACHE_POLICY;
  }
  return CACHE_POLICY[name] ?? DEFAULT_CACHE_POLICY;
}
