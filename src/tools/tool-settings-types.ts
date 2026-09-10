/** How a tool may run: no prompt, prompt each use, or hidden from the model. */
export type ToolPermissionMode = 'full' | 'ask' | 'off';

/** Global per-tool permission map — single source of truth for tool policy. */
export interface ToolPermissionsConfig {
  /** Global default per tool id (`off` | `ask` | `full`). */
  default: Record<string, ToolPermissionMode>;
}

/** Empty permissions object (defaults filled by {@link defaultToolConfig}). */
export function createEmptyToolPermissionsConfig(): ToolPermissionsConfig {
  return { default: {} };
}

/** Session tool result cache toggle (runtime-only; not persisted server-side beyond tools.json). */
export interface ToolCacheConfig {
  /** When false, every tool call runs fresh (default true). */
  enabled: boolean;
}

/** Preferred backend for the built-in `web_search` tool. */
export type WebSearchProvider = 'brave' | 'tavily' | 'duckduckgo';

/** Persisted tool settings: permissions (source of truth), mirrored `enabled`, and keys. */
export interface ToolConfig {
  /** Send core schemas plus search_tools; false sends every permitted schema. */
  lazyTools?: boolean;
  /** Mirrored from permissions.default: true when mode is not `off` (backward-compatible JSON). */
  enabled: Record<string, boolean>;
  /** Per-tool execution policy; may include `mcp__*` ids not in the built-in catalog. */
  permissions: ToolPermissionsConfig;
  keys: {
    braveApiKey: string;
    tavilyApiKey: string;
  };
  /** Preferred web_search backend when credentials and server allow it. */
  webSearchProvider: WebSearchProvider;
  /** Optional session cache for repeated read-only tool invocations. */
  toolCache?: ToolCacheConfig;
  toolOutput?: {
    enabled: boolean;
    maxChars: number;
  };
}
