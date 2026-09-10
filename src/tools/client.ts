import { STOPPED_TOOL_MSG } from './execute-tool-batch';
import { resolveStreamingCommandOptions } from './streaming-command-options';
import { executeBrowserTool } from './browser-executor';
import { executeTodoWrite } from './todo-tools';
import { executeBugBoardTool } from './bug-board-tools';
import { executeIssueTool } from './issue-tools';
import { withIssueToolImages } from './issue-tool-images';
import { executeIssueV2Tool, isIssueV2Tool } from './issue-tools-v2';
import { executeSubAgentTool } from './sub-agent-executor';
import {
  ensureToolConfigReady,
  getToolPermissionForId,
  isLocalServerAvailable,
  isToolEnabled,
  loadToolConfig,
  setLocalServerAvailable,
} from './config';
import { blockPlanModeWriteWithContent } from '../chat/modes/plan-write-guard';
import {
  filterToolsByMode,
  isToolAllowedForMode,
} from '../chat/modes/tool-policy';
import {
  GIT_SETUP_SKILL_ID,
  injectGitSetupSkillTools,
} from '../skills/git-setup-client';
import { normalizeModeId, type ModeId } from '../chat/modes/types';
import { filterToolsByExpertSnapshot } from '../chat/experts/expert-tool-policy';
import type { Chat } from '../types';
import { resolveChatToolWorkspaceRoot } from '../state/chat-worktree';
import type { CodeChangeStats, ToolExecutionResult } from '../types';
import { findChatById } from '../state/sessions';
import { normalizeCodeChangePayload } from '../usage/code-change-payload';
import { recordCodeChange, recordWorkspaceCodeChange } from '../usage/code-change-ledger';
import { sessionState } from '../state/sessions';
import { updateCodeChangeStrip } from '../ui/code-change-strip';
import { updateWorkspaceCodeChangeDisplay } from '../ui/workspace-code-change';
import {
  BUILT_IN_TOOLS,
  type OpenAIFunctionDefinition,
  type ToolDefinition,
} from './definitions';
import { enqueueAskQuestion } from './ask-question-queue';
import {
  executeBrowserNavigateWithGate,
  executeRequestBrowserOriginAccess,
  formatBrowserAllowlistCheckFailure,
} from './browser-navigation-gate';
import { checkBrowserNavigationAllowed } from '../config/browser-meta';
import { executeBrowserPreviewTool } from './browser-preview-tools';
import { isElectronPreviewAvailable } from './minnow-shell';
import {
  executeCreateChatWithMode,
  executeProposeModeSwitch,
  executeSetChatMode,
} from './mode-handoff-tools';
import { validateAskQuestionArgs, stringifyAskQuestionResult } from './ask-question-types';
import {
  blockAfkInteractionAttempt,
  maybeBlockToolForUserApproval,
} from './permission-gate';
import { getChatsWorkspacePath } from '../lib/chats-workspace';
import { isChatAppForeground } from '../ui/chat-mount';
import { runWithFileTreeAutoRefresh } from '../ui/file-tree-auto-refresh';
import { executeWithResultCache } from './result-cache';
import { validateToolRequiredArgs } from './validate-tool-required-args';
import { loadSearchConfig, mergeWebSearchSettings } from '../config/search-config';
import {
  hasBraveApiKey,
  resolveWebSearchExecution,
} from './web-search-routing';
import {
  afterSettingsToolSuccess,
  augmentGetSettingsResult,
} from '../settings/client-sync';
import { isKillableShellTool } from '../ui/tool-messages';
import { isAppEnabled } from '../os/app-preferences';

/** Ping timeout for local dev server detection (ms). */
const PING_TIMEOUT_MS = 2500;

/** Cached MCP tool definitions from GET /api/mcp/tools. */
let cachedMcpToolDefinitions: OpenAIFunctionDefinition[] = [];

/** Cached native plugin tool definitions from GET /api/plugins/tools. */
let cachedPluginToolDefinitions: OpenAIFunctionDefinition[] = [];

// ── Detect ───────────────────────────────────────────────────────────────────

/**
 * Probes the dev server tools API with a short timeout and updates availability in config.
 */
export async function detectLocalServer(): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);

  try {
    const response = await fetch('/api/tools/ping', {
      method: 'GET',
      signal: controller.signal,
    });
    if (!response.ok) {
      setLocalServerAvailable(false);
      return false;
    }
    const body = (await response.json()) as { ok?: boolean };
    const available = body?.ok === true;
    setLocalServerAvailable(available);
    if (available) {
      await Promise.all([refreshMcpToolCache(), refreshPluginToolCache()]);
    } else {
      cachedMcpToolDefinitions = [];
      cachedPluginToolDefinitions = [];
    }
    return available;
  } catch {
    setLocalServerAvailable(false);
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Whether GET /api/tools/ping succeeded on the last detectLocalServer() call. */
export function getLocalServerAvailable(): boolean {
  return isLocalServerAvailable();
}

/** Optional context for streaming terminal runs and approval UI. */
export interface ExecuteToolContext {
  chatId?: string;
  /** Trusted logical run id used to lease session-only agent browser tabs. */
  runId?: string;
  /** Trusted executing agent/attempt id used to isolate browser ownership. */
  agentId?: string;
  toolCallId?: string;
  /** Active operating mode for scoped write guards (e.g. Plan → documentation/plans/). */
  modeId?: ModeId | string;
  /** When tools run inside a sub-agent, shown on the approval modal. */
  subAgentType?: string;
  /** Active work agent on the parent chat (main loop tool calls). */
  workAgentId?: string | null;
  /** Override server workspace root (chats sandbox, benchmark workspace, etc.). */
  workspaceRoot?: string;
  /** Additional allowed path roots (board worktrees under ~/.minnow/worktrees). */
  extraPathRoots?: string[];
  /** Benchmark runs bypass Ask permission modals and path-ack prompts. */
  benchmarkAutonomous?: boolean;
  /** Abort when the user stops the chat turn (server tools). */
  signal?: AbortSignal;
}

const STREAMING_TOOL_NAMES = new Set([
  'execute_command',
  'run_javascript',
]);

const BROWSER_SURFACE_TOOL_NAMES = new Set([
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
]);

/** Plan alias: readable flag after detectLocalServer(). */
export { getLocalServerAvailable as localServerAvailable };

/** Refresh MCP tool definitions when the local server is available. */
export async function refreshMcpToolCache(): Promise<void> {
  try {
    const response = await fetch('/api/mcp/tools');
    if (!response.ok) {
      cachedMcpToolDefinitions = [];
      return;
    }
    const body = (await response.json()) as { tools?: OpenAIFunctionDefinition[] };
    cachedMcpToolDefinitions = Array.isArray(body.tools) ? body.tools : [];
  } catch {
    cachedMcpToolDefinitions = [];
  }
}

/** Refresh native plugin tool definitions when the local server is available. */
export async function refreshPluginToolCache(): Promise<void> {
  try {
    const response = await fetch('/api/plugins/tools');
    if (!response.ok) {
      cachedPluginToolDefinitions = [];
      return;
    }
    const body = (await response.json()) as { tools?: OpenAIFunctionDefinition[] };
    cachedPluginToolDefinitions = Array.isArray(body.tools) ? body.tools : [];
  } catch {
    cachedPluginToolDefinitions = [];
  }
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
  );
}

// ── Execute ──────────────────────────────────────────────────────────────────

export async function executeTool(
  name: string,
  args: Record<string, unknown> = {},
  context: ExecuteToolContext = {},
): Promise<ToolExecutionResult> {
  try {
    return await runWithFileTreeAutoRefresh(
      name,
      () => executeToolInner(name, args, context),
      context,
      args,
    );
  } catch (err) {
    if (isAbortError(err)) {
      return { content: STOPPED_TOOL_MSG };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { content: `Error: ${message || 'tool execution failed'}` };
  }
}

async function executeToolInner(
  name: string,
  args: Record<string, unknown> = {},
  context: ExecuteToolContext = {},
): Promise<ToolExecutionResult> {
  await ensureToolConfigReady();

  if (
    name === 'ask_question' ||
    name === 'propose_mode_switch' ||
    name === 'request_browser_origin_access'
  ) {
    const blocked = blockAfkInteractionAttempt(
      context,
      name === 'ask_question'
        ? 'question'
        : name === 'propose_mode_switch'
          ? 'mode_switch'
          : 'confirmation',
      `${name} was attempted during AFK execution`,
    );
    if (blocked) return blocked;
  }

  if (name === 'set_chat_mode') {
    if (!isToolEnabled('set_chat_mode')) {
      return {
        content:
          'Error: tool "set_chat_mode" is disabled in Settings (enable it to switch modes from the model).',
      };
    }
    return { content: executeSetChatMode(args) };
  }

  if (name === 'create_chat_with_mode') {
    if (!isToolEnabled('create_chat_with_mode')) {
      return {
        content:
          'Error: tool "create_chat_with_mode" is disabled in Settings (enable it to fork chats by mode).',
      };
    }
    return { content: executeCreateChatWithMode(args) };
  }

  if (name === 'propose_mode_switch') {
    if (!isToolEnabled('propose_mode_switch')) {
      return {
        content:
          'Error: tool "propose_mode_switch" is disabled in Settings (enable it or use ask_question).',
      };
    }
    const content = await executeProposeModeSwitch(args, {
      subAgentType: context.subAgentType,
      chatId: context.chatId,
    });
    return { content };
  }

  if (name === 'ask_question') {
    if (!isToolEnabled('ask_question')) {
      return {
        content:
          'Error: tool "ask_question" is disabled in Settings (set permission to Ask or Full to use it).',
      };
    }
    const parsed = validateAskQuestionArgs(args);
    if (parsed.ok === false) {
      return {
        content: stringifyAskQuestionResult({ status: 'error', message: parsed.error }),
      };
    }
    const content = await enqueueAskQuestion(
      parsed.args,
      { subAgentType: context.subAgentType },
      context.chatId,
    );
    return { content };
  }

  if (name === 'request_browser_origin_access') {
    if (!isToolEnabled('request_browser_origin_access')) {
      return {
        content:
          'Error: tool "request_browser_origin_access" is disabled in Settings (enable it to request browser allowlist changes).',
      };
    }
    const targetUrl =
      typeof args.url === 'string' && args.url.trim() ? args.url.trim() : '';
    const allowlistCheck =
      targetUrl && isLocalServerAvailable()
        ? await checkBrowserNavigationAllowed(targetUrl)
        : null;
    if (allowlistCheck && !allowlistCheck.success) {
      return { content: formatBrowserAllowlistCheckFailure(allowlistCheck) };
    }
    if (!allowlistCheck?.success || !allowlistCheck.allowed) {
      const blocked = await maybeBlockToolForUserApproval(
        'request_browser_origin_access',
        args,
        context,
        name,
      );
      if (blocked) return blocked;
    }
    return { content: await executeRequestBrowserOriginAccess(args, context) };
  }

  if (name.startsWith('mcp__') || name.startsWith('plugin__')) {
    if (!isLocalServerAvailable()) {
      return {
        content:
          'Error: MCP and plugin tools require Minnow running locally. Open or restart the app.',
      };
    }
    const blocked = await maybeBlockToolForUserApproval(name, args, context, name);
    if (blocked) return blocked;
    return executeWithResultCache(name, args, context, () =>
      executeServerTool(name, args, context.modeId, context),
    );
  }

  if (
    name === 'spawn_sub_agent' ||
    name === 'cancel_sub_agent' ||
    name === 'list_sub_agents' ||
    name === 'get_sub_agent_status'
  ) {
    const blocked = await maybeBlockToolForUserApproval(name, args, context, name);
    if (blocked) return blocked;
    const text = await executeSubAgentTool(name, args);
    return { content: text };
  }

  if (name === 'todo_write') {
    const blocked = await maybeBlockToolForUserApproval(name, args, context, name);
    if (blocked) return blocked;
    const text = executeTodoWrite(args, { chatId: context?.chatId });
    return { content: text };
  }

  if (
    name === 'issue_add' ||
    name === 'issue_update' ||
    name === 'issue_link' ||
    name === 'issue_get_state' ||
    name === 'issue_delete'
  ) {
    const blocked = await maybeBlockToolForUserApproval(name, args, context, name);
    if (blocked) return blocked;
    const text = await executeIssueTool(name, args);
    return name === 'issue_get_state' ? withIssueToolImages(text) : { content: text };
  }

  if (isIssueV2Tool(name)) {
    const blocked = await maybeBlockToolForUserApproval(name, args, context, name);
    if (blocked) return blocked;
    const text = await executeIssueV2Tool(name, args);
    return name === 'issue_search' ? withIssueToolImages(text) : { content: text };
  }

  if (name === 'bug_add' || name === 'bug_update' || name === 'bug_get_state') {
    const blocked = await maybeBlockToolForUserApproval(name, args, context, name);
    if (blocked) return blocked;
    const text = await executeBugBoardTool(name, args);
    return { content: text };
  }

  const config = loadToolConfig();
  const enrichedArgs = mergeConfigKeysIntoArgs(name, args, config);

  if (name === 'web_search') {
    const blocked = await maybeBlockToolForUserApproval(
      'web_search',
      enrichedArgs,
      context,
      'web_search',
    );
    if (blocked) return blocked;

    const searchConfig = await loadSearchConfig();
    const route = resolveWebSearchExecution(
      config,
      enrichedArgs,
      isLocalServerAvailable(),
      searchConfig,
    );
    if (route.kind === 'error') {
      return { content: route.message };
    }

    const deepRead =
      enrichedArgs.deep_read === true &&
      getToolPermissionForId(config, 'fetch_web_content') !== 'off';

    return executeWithResultCache('web_search', enrichedArgs, context, async () => {
      if (route.kind === 'brave') {
        return { content: await executeBrowserTool(name, enrichedArgs) };
      }
      if (route.kind === 'tavily') {
        return executeServerTool('web_search_tavily', {
          query: enrichedArgs.query,
          deep_read: deepRead,
        });
      }
      if (route.kind === 'searxng') {
        return executeServerTool('web_search_searxng', {
          query: enrichedArgs.query,
          deep_read: deepRead,
        });
      }
      return executeServerTool('web_search_ddg', {
        query: enrichedArgs.query,
        deep_read: deepRead,
      });
    });
  }

  if (
    (name === 'fetch_web_content' || name === 'rag_web_content') &&
    isLocalServerAvailable()
  ) {
    const webFetchTool = findToolByFunctionName(name);
    if (!webFetchTool) {
      return { content: `Error: unknown tool "${name}"` };
    }
    const blocked = await maybeBlockToolForUserApproval(
      webFetchTool.id,
      enrichedArgs,
      context,
      name,
    );
    if (blocked) return blocked;
    const planWriteBlock = blockPlanModeWriteWithContent(context.modeId, name, enrichedArgs);
    if (planWriteBlock) {
      return { content: planWriteBlock };
    }
    return executeWithResultCache(name, enrichedArgs, context, () =>
      executeServerTool(name, enrichedArgs, context.modeId, context),
    );
  }

  const tool = findToolByFunctionName(name);
  if (!tool) {
    return { content: `Error: unknown tool "${name}"` };
  }

  const permissionId =
    name === 'web_search_ddg' ||
    name === 'web_search_tavily' ||
    name === 'web_search_searxng'
      ? 'web_search'
      : tool.id;
  const blocked = await maybeBlockToolForUserApproval(
    permissionId,
    enrichedArgs,
    context,
    name,
  );
  if (blocked) return blocked;

  const planWriteBlock = blockPlanModeWriteWithContent(context.modeId, name, enrichedArgs);
  if (planWriteBlock) {
    return { content: planWriteBlock };
  }

  const requiredArgsError = validateToolRequiredArgs(name, enrichedArgs);
  if (requiredArgsError) {
    return { content: requiredArgsError };
  }

  return executeWithResultCache(name, enrichedArgs, context, () =>
    executeToolBodyAfterGates(name, enrichedArgs, context, tool),
  );
}

/** Runs the tool after approval/plan guards (cache wrapper calls this on miss). */
async function executeToolBodyAfterGates(
  name: string,
  enrichedArgs: Record<string, unknown>,
  context: ExecuteToolContext,
  tool: ToolDefinition,
): Promise<ToolExecutionResult> {
  if (BROWSER_SURFACE_TOOL_NAMES.has(name)) {
    const rawSurface = enrichedArgs.surface;
    if (rawSurface != null && rawSurface !== '' && rawSurface !== 'agent' && rawSurface !== 'user') {
      return { content: 'Error: surface must be "agent" or "user"' };
    }
    const surface = rawSurface === 'user' ? 'user' : 'agent';
    if (surface === 'user') {
      if (name === 'browser_reserve_tab' || name === 'browser_release_tab') {
        return { content: `Error: ${name} is only available on surface="agent"` };
      }
      if (!isElectronPreviewAvailable()) {
        return {
          content:
            'Error: The user browser surface runs in the Minnow desktop app. Use surface="agent" for an isolated headless tab.',
        };
      }
      if (
        name !== 'browser_list' &&
        name !== 'browser_new_tab' &&
        (typeof enrichedArgs.tab_id !== 'string' || !enrichedArgs.tab_id.trim())
      ) {
        return { content: 'Error: tab_id is required for the user browser surface' };
      }
      if (
        name === 'browser_navigate' ||
        (name === 'browser_new_tab' &&
          typeof enrichedArgs.url === 'string' &&
          /^https?:\/\//i.test(enrichedArgs.url.trim()))
      ) {
        return executeBrowserNavigateWithGate(
          enrichedArgs,
          (navArgs) => executeBrowserPreviewTool(name, navArgs),
          context,
          context.modeId,
        );
      }
      return executeBrowserPreviewTool(name, enrichedArgs, context.signal);
    }

    if (!isLocalServerAvailable()) {
      return {
        content:
          'Error: The isolated agent browser needs Minnow running locally. Open or restart the app.',
      };
    }
    const callServer = (serverArgs: Record<string, unknown>) =>
      executeServerTool(name, serverArgs, context.modeId, context);
    if (
      name === 'browser_navigate' ||
      ((name === 'browser_reserve_tab' || name === 'browser_new_tab') &&
        typeof enrichedArgs.url === 'string' &&
        enrichedArgs.url.trim())
    ) {
      return executeBrowserNavigateWithGate(
        enrichedArgs,
        callServer,
        context,
        context.modeId,
      );
    }
    return callServer(enrichedArgs);
  }

  if (tool.previewRequired) {
    if (!isElectronPreviewAvailable()) {
      return {
        content:
          'Error: Browser automation runs in the Minnow desktop app. Use the Minnow app window — not a separate browser tab.',
      };
    }
    if (name === 'browser_navigate') {
      return executeBrowserNavigateWithGate(
        enrichedArgs,
        (navArgs) => executeBrowserPreviewTool('browser_navigate', navArgs),
        context,
        context.modeId,
      );
    }
    return executeBrowserPreviewTool(name, enrichedArgs, context.signal);
  }

  if (tool.serverRequired) {
    if (!isLocalServerAvailable()) {
      return {
        content:
          'Error: File, git, and code tools need Minnow running locally. Open or restart the app.',
      };
    }
    const useStreaming =
      STREAMING_TOOL_NAMES.has(name) &&
      context.chatId &&
      typeof enrichedArgs === 'object' &&
      !(name === 'execute_command' && enrichedArgs.background === true);

    if (useStreaming) {
      return {
        content: await executeStreamingCodeTool(name, enrichedArgs, context),
      };
    }
    return executeServerTool(
      name,
      mergeServerToolContextArgs(name, enrichedArgs, context),
      context.modeId,
      context,
    );
  }

  return { content: await executeBrowserTool(name, enrichedArgs) };
}

// ── Catalog ──────────────────────────────────────────────────────────────────

/** User + server gating only (no mode filter). */
export function getEnabledToolCatalogEntries(): ToolDefinition[] {
  return BUILT_IN_TOOLS.filter((tool) => {
    if (tool.appId && !isAppEnabled(tool.appId)) {
      return false;
    }
    if (!isToolEnabled(tool.id)) {
      return false;
    }
    if (tool.previewRequired && !isElectronPreviewAvailable()) {
      return false;
    }
    if (tool.serverRequired && !isLocalServerAvailable()) {
      return false;
    }
    return true;
  });
}

function getEnabledDynamicToolDefinitions(): OpenAIFunctionDefinition[] {
  return [...cachedMcpToolDefinitions, ...cachedPluginToolDefinitions].filter(
    (def) => isToolEnabled(def.function.name),
  );
}

export function getEnabledToolDefinitions(): OpenAIFunctionDefinition[] {
  return [
    ...getEnabledToolCatalogEntries().map((tool) => tool.definition),
    ...getEnabledDynamicToolDefinitions(),
  ];
}

/**
 * Enabled tools after operating mode policy (Step 05).
 */
export function getEnabledToolDefinitionsForMode(
  modeId: ModeId | string | null | undefined,
): OpenAIFunctionDefinition[] {
  const normalized = normalizeModeId(
    typeof modeId === 'string' ? modeId : modeId ?? undefined,
  );
  const builtins = filterToolsByMode(getEnabledToolCatalogEntries(), normalized).map(
    (tool) => tool.definition,
  );
  const dynamic = getEnabledDynamicToolDefinitions().filter((def) =>
    isToolAllowedForMode(normalized, def.function.name),
  );
  return [...builtins, ...dynamic];
}

/**
 * Enabled tools for a chat turn.
 */
export function getEnabledToolDefinitionsForChat(
  chat: Chat,
  options?: { skillId?: string | null },
): OpenAIFunctionDefinition[] {
  const normalized = normalizeModeId(chat.modeId);
  let defs = getEnabledToolDefinitionsForMode(normalized);
  defs = filterToolsByExpertSnapshot(chat, defs);
  if (options?.skillId === GIT_SETUP_SKILL_ID) {
    defs = injectGitSetupSkillTools(defs);
  }
  return defs;
}

/** Alias for send path — built-in, MCP, and plugin tools after mode + permission filters. */
export const getEnabledToolDefinitionsForSend = getEnabledToolDefinitionsForChat;

/** Pass chat/tool ids to the Node tool server for terminal registry and filters. */
function mergeServerToolContextArgs(
  name: string,
  args: Record<string, unknown>,
  context: ExecuteToolContext,
): Record<string, unknown> {
  const out = { ...args };
  if (context.chatId) {
    out.chatId = context.chatId;
    if (name === 'list_running_commands' && out.chat_id == null) {
      out.chat_id = context.chatId;
    }
  }
  if (context.toolCallId) {
    out.toolCallId = context.toolCallId;
  }
  return out;
}

/** Bridge background shell tool results into the Agent terminal tab (MIN-402). */
async function maybeAttachAgentBackgroundRunFromResult(
  name: string,
  content: string,
  args: Record<string, unknown>,
  context?: ExecuteToolContext,
): Promise<void> {
  if (!context?.chatId?.trim() || !isKillableShellTool(name)) return;
  if (content.trimStart().startsWith('Error:')) return;

  const { parseBackgroundShellToolPayload } = await import('../ui/tool-messages');
  const payload = parseBackgroundShellToolPayload(name, content);
  if (!payload) return;

  const command =
    typeof args.command === 'string' && args.command.trim()
      ? args.command.trim()
      : name;

  const { attachAgentBackgroundRun } = await import('../ui/terminal-panel');
  attachAgentBackgroundRun({
    runId: payload.runId,
    command,
    chatId: context.chatId,
    toolCallId: context.toolCallId,
    startedAt: payload.startedAt,
    initialOutput: payload.output,
  });
}

/** Map code tools to process argv for the terminal runner. */
function mapCodeToolToCommand(
  name: string,
  args: Record<string, unknown>,
): { command: string; argv: string[]; shell?: boolean; label: string } | null {
  if (name === 'execute_command') {
    const command = args.command;
    if (typeof command !== 'string' || !command.trim()) {
      return null;
    }
    return {
      command: command.trim(),
      argv: [],
      label: command.trim(),
    };
  }
  if (name === 'run_javascript') {
    const code = args.code;
    if (typeof code !== 'string' || !code.trim()) {
      return null;
    }
    return { command: 'node', argv: ['-e', code], label: 'node -e …' };
  }
  if (name === 'run_python') {
    const code = args.code;
    if (typeof code !== 'string' || !code.trim()) {
      return null;
    }
    const isWin =
      typeof navigator !== 'undefined' && /Win/i.test(navigator.userAgent);
    const bin = isWin ? 'python' : 'python3';
    return { command: bin, argv: ['-c', code], label: `${bin} -c …` };
  }
  return null;
}

// ── Streaming ────────────────────────────────────────────────────────────────

async function executeStreamingCodeTool(
  name: string,
  args: Record<string, unknown>,
  context: ExecuteToolContext,
): Promise<string> {
  const mapped = mapCodeToolToCommand(name, args);
  if (!mapped) {
    return `Error: ${name} requires valid arguments`;
  }

  const workspaceRoot =
    context.workspaceRoot?.trim() || (await resolveToolWorkspaceRoot(context));
  const streamOptions = resolveStreamingCommandOptions(name, args);

  try {
    const { getChatAbort } = await import('../app-state');
    const { runCommandWithTerminalStream } = await import('../ui/terminal-panel');
    return await runCommandWithTerminalStream(mapped.command, {
      chatId: context.chatId!,
      source: 'agent',
      toolCallId: context.toolCallId,
      displayLabel: mapped.label,
      args: mapped.argv,
      shell: mapped.shell,
      workspaceRoot,
      ...streamOptions,
      abortSignal: context.chatId
        ? getChatAbort(context.chatId)?.signal
        : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error: ${message}`;
  }
}

/** Resolve tool workspace from chat binding, then desktop/chat UI foreground, else server default. */
async function resolveToolWorkspaceRoot(
  context?: ExecuteToolContext,
): Promise<string | undefined> {
  const chatId = context?.chatId?.trim();
  if (chatId && sessionState) {
    const chat = findChatById(chatId);
    if (chat) {
      const scoped = resolveChatToolWorkspaceRoot(chat, sessionState.groups);
      if (scoped) return scoped;
    }
  }
  if (!isChatAppForeground()) return undefined;
  const path = await getChatsWorkspacePath();
  return path ?? undefined;
}

// ── Server ───────────────────────────────────────────────────────────────────

/** POST { name, args, modeId?, workspaceRoot? } to the Node tools middleware. */
const SERVER_TOOL_TIMEOUT_MS = 600_000;

async function executeServerTool(
  name: string,
  args: Record<string, unknown>,
  modeId?: ModeId | string,
  context?: ExecuteToolContext,
): Promise<ToolExecutionResult> {
  let response: Response;
  const workspaceRoot =
    context?.workspaceRoot?.trim() || (await resolveToolWorkspaceRoot(context));
  const payload: {
    name: string;
    args: Record<string, unknown>;
    modeId?: string;
    workspaceRoot?: string;
    runtimeOwner?: { chatId: string; runId: string; agentId: string };
  } = { name, args };
  if (modeId != null && String(modeId).trim()) {
    payload.modeId = String(modeId).trim();
  }
  if (workspaceRoot) {
    payload.workspaceRoot = workspaceRoot;
  }
  const ownerChatId = context?.chatId?.trim();
  const ownerRunId = context?.runId?.trim();
  const ownerAgentId = context?.agentId?.trim();
  if (ownerChatId && ownerRunId && ownerAgentId) {
    payload.runtimeOwner = {
      chatId: ownerChatId,
      runId: ownerRunId,
      agentId: ownerAgentId,
    };
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SERVER_TOOL_TIMEOUT_MS);
  const signal = context?.signal
    ? AbortSignal.any([context.signal, controller.signal])
    : controller.signal;
  try {
    response = await fetch('/api/tools', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (context?.signal?.aborted) {
      return { content: 'Error: tool call cancelled' };
    }
    return { content: `Error: failed to reach Minnow (${message})` };
  } finally {
    clearTimeout(timeoutId);
  }

  let responsePayload: {
    result?: string;
    error?: string;
    attachments?: ToolExecutionResult['attachments'];
    codeChange?: CodeChangeStats;
  };
  try {
    responsePayload = (await response.json()) as typeof responsePayload;
  } catch {
    return {
      content: `Error: invalid JSON from Minnow (HTTP ${response.status})`,
    };
  }

  if (!response.ok) {
    return {
      content: `Error: ${responsePayload.error ?? `Minnow request failed (HTTP ${response.status})`}`,
    };
  }

  const content = String(responsePayload.result ?? '');
  let finalContent = content;
  if (!content.trimStart().startsWith('Error:')) {
    if (name === 'get_settings') {
      finalContent = augmentGetSettingsResult(content);
    }
    void afterSettingsToolSuccess(name, finalContent);
  }

  const attachments = Array.isArray(responsePayload.attachments)
    ? responsePayload.attachments
        .filter(
          (a): a is NonNullable<ToolExecutionResult['attachments']>[number] =>
            a != null &&
            a.type === 'image' &&
            typeof a.url === 'string' &&
            a.mime === 'image/png',
        )
        .map((a) => {
          const dataUrl =
            typeof a.dataUrl === 'string' && a.dataUrl.startsWith('data:image/')
              ? a.dataUrl
              : undefined;
          return {
            type: 'image' as const,
            url: a.url,
            mime: a.mime,
            ...(typeof a.alt === 'string' ? { alt: a.alt } : {}),
            ...(dataUrl ? { dataUrl } : {}),
          };
        })
    : undefined;

  const codeChange = normalizeCodeChangePayload(responsePayload.codeChange);
  if (
    codeChange &&
    context?.chatId &&
    !content.trimStart().startsWith('Error:')
  ) {
    const chat = findChatById(context.chatId);
    if (chat) {
      recordCodeChange(chat, codeChange);
      if (sessionState) {
        recordWorkspaceCodeChange(sessionState, chat.workspacePath, codeChange);
        updateWorkspaceCodeChangeDisplay();
      }
      updateCodeChangeStrip(chat);
    }
  }

  if (!content.trimStart().startsWith('Error:')) {
    void maybeAttachAgentBackgroundRunFromResult(
      name,
      finalContent,
      args,
      context,
    );
  }

  const base: ToolExecutionResult = { content: finalContent };
  if (attachments?.length) base.attachments = attachments;
  if (codeChange) base.codeChange = codeChange;
  return base;
}


/** Resolves catalog entry by OpenAI function name. */
function findToolByFunctionName(name: string): ToolDefinition | undefined {
  return BUILT_IN_TOOLS.find((tool) => tool.definition.function.name === name);
}

/** Injects saved Brave API key into web_search args when the model did not pass one. */
function mergeConfigKeysIntoArgs(
  name: string,
  args: Record<string, unknown>,
  config: ReturnType<typeof loadToolConfig>,
): Record<string, unknown> {
  if (name !== 'web_search') {
    return args;
  }
  const effective = mergeWebSearchSettings(undefined, config);
  if (effective.provider !== 'brave') {
    return args;
  }
  if (hasBraveApiKey(args, effective.keys)) {
    return args;
  }
  const saved = effective.keys.braveApiKey?.trim();
  if (!saved) {
    return args;
  }
  return { ...args, api_key: saved };
}
