import type { AppId } from '../os/types';

// ── Types ────────────────────────────────────────────────────────────────────

/** Tool grouping for settings UI and documentation. */
export type ToolCategory =
  | 'web'
  | 'utility'
  | 'files'
  | 'git'
  | 'code'
  | 'agents'
  | 'browser'
  | 'lsp';

/** OpenAI-compatible function tool schema sent to chat completions. */
export interface OpenAIFunctionDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

/** One catalog entry: metadata plus the API function definition. */
export interface ToolDefinition {
  id: string;
  label: string;
  description: string;
  category: ToolCategory;
  serverRequired: boolean;
  /** Requires Electron desktop shell with embedded preview WebContentsView. */
  previewRequired?: boolean;
  requiresKey?: boolean;
  keyId?: string;
  /** When set, the tool is exposed only while the bound Minnow app is released and enabled. */
  appId?: AppId;
  definition: OpenAIFunctionDefinition;
}

// Shared with unattended runners; keep one source for tool parameters.
export { BUILT_IN_TOOLS, getToolById } from '../../server/tools/builtin-catalog.js';
