/** Global prompt profile — drives body selection and lite rules. */
export type PromptProfile = 'full' | 'lite' | 'custom';

/** Composer part identifiers (concatenation order is fixed in prompt-composer). */
export type PromptPartId =
  | 'base'
  | 'mode'
  | 'expert'
  | 'tool-usage'
  | 'info'
  | 'memory'
  | 'code-map'
  | 'context-documents'
  | 'work-agent'
  | 'skill';

/** Parsed prompt template kind from front matter. */
export type PromptKind =
  | 'base'
  | 'mode'
  | 'expert'
  | 'tool-usage'
  | 'info'
  | 'work-agent'
  | 'title';

/** YAML front matter on a shipped or user prompt file. */
export interface PromptFrontMatter {
  id: string;
  kind: PromptKind;
  label: string;
  version: number;
  description?: string;
  part?: PromptPartId;
  modeBindings?: string[];
  expertTriggers?: string[];
  toolPolicy?: string;
  body?: string;
  fullBody?: string;
  liteBody?: string;
  defaultProfile?: PromptProfile;
}

/** Loaded prompt record after parsing a markdown file. */
export interface ParsedPrompt {
  id: string;
  kind: PromptKind;
  part: PromptPartId;
  label: string;
  version: number;
  description?: string;
  /** Resolved body for the active profile before interpolation. */
  body: string;
  relativePath: string;
  source: 'builtin' | 'user';
}

/** Per-part settings inside a custom prompt configuration. */
export interface PromptConfigPartSettings {
  enabled: boolean;
  contentOverride: string | null;
}

/** Named custom profile stored under ~/.minnow/prompt-configs/. */
export interface PromptConfig {
  id: string;
  label: string;
  profile: 'custom';
  parts: Partial<Record<PromptPartId, PromptConfigPartSettings>>;
  meta?: {
    createdAt?: string;
    updatedAt?: string;
  };
}

/** Runtime inputs for composeSystemPrompt. */
export interface ComposeContext {
  profile: PromptProfile;
  customConfigId?: string | null;
  customConfig?: PromptConfig | null;
  cwd: string;
  modeId: string | null;
  expertId: string | null;
  /** Human label for {{expert}} interpolation (Step 06). */
  expertLabel?: string | null;
  workAgentId: string | null;
  /** Human label for {{work_agent_label}} interpolation (Step 08). */
  workAgentLabel?: string | null;
  skillBody: string | null;
  memoryBlock: string | null;
  /** True when memory retrieval/saving is enabled for this chat (injects save guidance even with an empty wiki). */
  memoryEnabled?: boolean;
  /** Wrapped repo map body for {{code_map}} when injection resolved on. */
  codeMapBlock: string | null;
  /** True when code map injection is resolved on for this send (even if block fetch failed). */
  codeMapInjectionEnabled?: boolean;
  /** Wrapped workspace context document body for {{context_documents}}. */
  contextDocumentsBlock: string | null;
  /** True when context document injection is resolved on for this send. */
  contextDocumentsInjectionEnabled?: boolean;
  /** Standing file/URL chips pinned on this chat (MIN-630). */
  chatLinksBlock?: string | null;
  injectionsReplayed?: boolean;
  enabledToolIds: string[];
  infoPresetId: string | null;
  userMessagePreview?: string;
  planGranularity?: string | null;
  /** Adds the default UI rule that forbids emoji icons and points to Flaticon Uicons. */
  flaticonIconGuidanceEnabled?: boolean;
  /** Workspace-relative plan path when mode is orchestrate (for {{orchestrate_plan}}). */
  orchestratePlanPath?: string | null;
  /** True once a preview browser tool has been invoked in this chat (gates allowlist fragment). */
  browserActivated?: boolean;
  /** Effective agent shell sandbox mode for this chat (MIN-553); gates shell-sandbox tool-usage. */
  shellSandboxMode?: 'off' | 'prefer' | 'require';
}

/** Tokens replaced in composed bodies via interpolate.ts. */
export interface InterpolationVars {
  mode: string;
  mode_label: string;
  profile: string;
  expert: string;
  cwd: string;
  memory: string;
  code_map?: string;
  context_documents?: string;
  user_message: string;
  work_agent: string;
  work_agent_label: string;
  skill: string;
  date: string;
  os: string;
  plan_granularity: string;
  orchestrate_plan: string;
}

/** List entry returned by GET /api/prompt-configs. */
export interface PromptConfigListItem {
  id: string;
  label: string;
}
