/** Session tool result cache toggle (runtime-only; not persisted server-side beyond tools.json). */
export interface ToolCacheConfig {
  /** When false, every tool call runs fresh (default true). */
  enabled: boolean;
}

/** Preferred backend for the built-in `web_search` tool. */
export type WebSearchProvider = 'brave' | 'tavily' | 'duckduckgo';

/** Operational tool settings. Authorization is stored in toolSecurity.permissionLevel. */
export interface ToolConfig {
  /** Send core schemas plus search_tools; false sends every permitted schema. */
  lazyTools?: boolean;
  /** Whole-plugin availability for legacy tool packages. */
  plugins?: Record<string, { enabled: boolean }>;
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
