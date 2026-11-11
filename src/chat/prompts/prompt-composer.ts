import { getMode } from '../modes/registry';
import { isModeId } from '../modes/types';
import { permissionPromptBlock } from '../../lib/permissions.mjs';
import { interpolatePromptBody } from './interpolate';
import { loadPromptById } from './prompt-loader';
import type {
  ComposeContext,
  InterpolationVars,
  PromptKind,
  PromptPartId,
} from './types';

// ── Order ────────────────────────────────────────────────────────────────────

/** Mandatory concatenation order for system message parts. */
export const PART_ORDER: PromptPartId[] = [
  'base',
  'mode',
  'expert',
  'work-agent',
  'tool-usage',
  'info',
  'skill',
  'memory',
  'code-map',
  'context-documents',
];

const PART_SEPARATOR = '\n\n---\n\n';

/** The only mode that still carries its own prompt part (the Boards surface). */
const MODE_PART_IDS = new Set(['orchestrate']);

// ── Gates ────────────────────────────────────────────────────────────────────

/** Brain write tools whose presence warrants save guidance even with an empty wiki. */
const BRAIN_WRITE_TOOL_IDS = new Set(['save_memory', 'brain_write_page']);

function contextHasBrainWriteTools(ctx: ComposeContext): boolean {
  return (ctx.enabledToolIds ?? []).some((id) => BRAIN_WRITE_TOOL_IDS.has(id));
}

function isMemoryPartEnabled(ctx: ComposeContext): boolean {
  if (ctx.memoryBlock?.trim()) return true;
  return ctx.memoryEnabled === true && contextHasBrainWriteTools(ctx);
}

/** True when a non-empty Brain notes block is in the composed system prompt. */
export function isBrainNotesPartEnabled(ctx: ComposeContext): boolean {
  return Boolean(ctx.memoryBlock?.trim());
}

/** True when the outbound prompt will include the code-map part (injection on + non-empty map). */
export function isCodeMapPartEnabled(ctx: ComposeContext): boolean {
  return (
    ctx.codeMapInjectionEnabled === true && Boolean(ctx.codeMapBlock?.trim())
  );
}

/** True when workspace context documents are injected with non-empty body. */
export function isContextDocumentsPartEnabled(ctx: ComposeContext): boolean {
  return (
    ctx.contextDocumentsInjectionEnabled === true &&
    Boolean(ctx.contextDocumentsBlock?.trim())
  );
}

/** Strip HTML comments (e.g. MINNOW_MODE_MARKER) before sending to the model. */
export function stripPromptHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '').trim();
}

/**
 * Composer modes are gone: one agent everywhere. Only Orchestrate (Boards) keeps
 * a mode part; every other persisted mode composes as the plain agent.
 */
export function shouldSuppressModePart(ctx: ComposeContext): boolean {
  return !MODE_PART_IDS.has(ctx.modeId?.trim() ?? '');
}

/** True when the local-model appendix belongs in this prompt. */
export function isLocalModelGuidanceEnabled(ctx: ComposeContext): boolean {
  const setting = ctx.localModelGuidance ?? 'auto';
  if (setting === 'off') return false;
  if (setting === 'on') return true;
  return ctx.providerIsLocal === true;
}

function isPartEnabled(ctx: ComposeContext, partId: PromptPartId): boolean {
  if (partId === 'skill') {
    return Boolean(ctx.skillBody?.trim());
  }
  if (partId === 'memory') {
    return isMemoryPartEnabled(ctx);
  }
  if (partId === 'code-map') {
    return isCodeMapPartEnabled(ctx);
  }
  if (partId === 'context-documents') {
    return isContextDocumentsPartEnabled(ctx);
  }
  if (partId === 'mode') {
    if (!ctx.modeId) return false;
    if (shouldSuppressModePart(ctx)) return false;
    return true;
  }
  if (partId === 'expert') {
    return Boolean(ctx.expertId);
  }
  if (partId === 'work-agent') {
    const id = ctx.workAgentId?.trim();
    return Boolean(id && id !== 'default');
  }
  if (partId === 'tool-usage') {
    return ctx.enabledToolIds.length > 0;
  }
  if (partId === 'info') {
    // Info presets were a General-mode feature; the single agent has none.
    return false;
  }
  return true;
}

function kindForPart(partId: PromptPartId): PromptKind {
  if (partId === 'tool-usage') return 'tool-usage';
  if (partId === 'work-agent') return 'work-agent';
  if (partId === 'mode') return 'mode';
  if (partId === 'expert') return 'expert';
  if (partId === 'info') return 'info';
  return 'base';
}

function resolvePartId(
  partId: PromptPartId,
  ctx: ComposeContext,
): string {
  if (partId === 'base') return 'default';
  if (partId === 'mode') return ctx.modeId ?? '';
  if (partId === 'expert') return ctx.expertId ?? '';
  if (partId === 'work-agent') return ctx.workAgentId ?? '';
  if (partId === 'info') return ctx.infoPresetId ?? '';
  if (partId === 'tool-usage') return 'default';
  return '';
}

// ── Resolvers ────────────────────────────────────────────────────────────────

function resolvePartBody(partId: PromptPartId, ctx: ComposeContext): string {
  if (partId === 'skill' && ctx.skillBody?.trim()) {
    return ctx.skillBody.trim();
  }
  if (partId === 'memory' && isMemoryPartEnabled(ctx)) {
    const loaded = loadPromptById('info', 'memory');
    if (loaded?.body?.trim()) {
      return loaded.body.trim();
    }
    return ctx.memoryBlock?.trim() ?? '';
  }
  if (partId === 'code-map' && isCodeMapPartEnabled(ctx)) {
    const loaded = loadPromptById('info', 'code-map');
    if (loaded?.body?.trim()) {
      return loaded.body.trim();
    }
    return ctx.codeMapBlock?.trim() ?? '';
  }
  if (partId === 'context-documents' && isContextDocumentsPartEnabled(ctx)) {
    const loaded = loadPromptById('info', 'context-documents');
    if (loaded?.body?.trim()) {
      return loaded.body.trim();
    }
    return ctx.contextDocumentsBlock?.trim() ?? '';
  }

  const kind = kindForPart(partId);
  const id = resolvePartId(partId, ctx);
  if (!id && partId !== 'base' && partId !== 'tool-usage') {
    return '';
  }

  const loaded = loadPromptById(kind, id || 'default');
  if (!loaded?.body) return '';

  return stripPromptHtmlComments(loaded.body);
}

function contextHasContext7Tools(ctx: ComposeContext): boolean {
  return (ctx.enabledToolIds ?? []).some((id) => id.startsWith('mcp__context7__'));
}

/** Context7 MCP workflow when Context7 tools are enabled for this chat. */
function resolveContext7DocsBody(ctx: ComposeContext): string {
  if (!contextHasContext7Tools(ctx)) {
    return '';
  }
  const loaded = loadPromptById('tool-usage', 'context7-docs');
  return loaded?.body?.trim() ?? '';
}

function contextHasSpawnSubAgentTool(ctx: ComposeContext): boolean {
  return (ctx.enabledToolIds ?? []).includes('spawn_sub_agent');
}

/** When/how to spawn sub-agents for parallel research and implementation. */
function resolveSubAgentDelegationBody(ctx: ComposeContext): string {
  if (!contextHasSpawnSubAgentTool(ctx)) {
    return '';
  }
  const loaded = loadPromptById('tool-usage', 'sub-agent-delegation');
  return loaded?.body?.trim() ?? '';
}

function resolveChatCoordinationBody(ctx: ComposeContext): string {
  if (!(ctx.enabledToolIds ?? []).some(name => ['chat_list', 'chat_read', 'chat_send', 'chat_wait', 'chat_stop'].includes(name))) return '';
  return loadPromptById('tool-usage', 'chat-coordination')?.body?.trim() ?? '';
}

/** Brain save guidance when write tools are enabled for this chat. */
function resolveMemorySaveBody(ctx: ComposeContext): string {
  if (!contextHasBrainWriteTools(ctx)) {
    return '';
  }
  const loaded = loadPromptById('info', 'memory-save');
  return loaded?.body?.trim() ?? '';
}

/** Default-on interface icon guidance; users can disable it in Settings → Agents. */
function resolveFlaticonIconGuidanceBody(
  ctx: ComposeContext,
): string {
  if (ctx.flaticonIconGuidanceEnabled === false) {
    return '';
  }
  const loaded = loadPromptById('info', 'interface-icons');
  return loaded?.body?.trim() ?? '';
}

/** Local-model appendix (Settings → Agents: auto / on / off). */
function resolveLocalModelGuidanceBody(ctx: ComposeContext): string {
  if (!isLocalModelGuidanceEnabled(ctx)) return '';
  return loadPromptById('info', 'local-model')?.body?.trim() ?? '';
}

/** Work-agent knowledge capture when save_memory / brain_write_page are enabled. */
function resolveWorkAgentKnowledgeCaptureBody(
  ctx: ComposeContext,
): string {
  if (!contextHasBrainWriteTools(ctx)) {
    return '';
  }
  const agentId = ctx.workAgentId?.trim();
  if (!agentId || agentId === 'default') {
    return '';
  }
  const loaded = loadPromptById('tool-usage', `${agentId}-knowledge-capture`);
  return loaded?.body?.trim() ?? '';
}

function contextHasAskQuestionTool(ctx: ComposeContext): boolean {
  return (ctx.enabledToolIds ?? []).includes('ask_question');
}

function contextHasExecuteCommandTool(ctx: ComposeContext): boolean {
  return (ctx.enabledToolIds ?? []).includes('execute_command');
}

function contextHasShellSandbox(ctx: ComposeContext): boolean {
  const mode = ctx.shellSandboxMode;
  return mode === 'prefer' || mode === 'require';
}

/** GitHub forge operations via local `gh` auth (MIN-558). */
function resolveGithubCliBody(ctx: ComposeContext): string {
  if (!contextHasExecuteCommandTool(ctx)) {
    return '';
  }
  const loaded = loadPromptById('tool-usage', 'github-cli');
  return loaded?.body?.trim() ?? '';
}

/** Host shell sandbox note when prefer/require is on (MIN-553). */
function resolveShellSandboxBody(ctx: ComposeContext): string {
  if (!contextHasExecuteCommandTool(ctx) || !contextHasShellSandbox(ctx)) {
    return '';
  }
  const loaded = loadPromptById('tool-usage', 'shell-sandbox');
  return loaded?.body?.trim() ?? '';
}

/** Mandatory ask_question usage when the tool is enabled for this chat. */
function resolveAskQuestionEnforcementBody(ctx: ComposeContext): string {
  if (!contextHasAskQuestionTool(ctx)) {
    return '';
  }
  const loaded = loadPromptById('tool-usage', 'ask-question-enforcement');
  return loaded?.body?.trim() ?? '';
}

function contextHasLaunchMinnowAppTool(ctx: ComposeContext): boolean {
  return (ctx.enabledToolIds ?? []).includes('launch_minnow_app');
}

function contextHasSettingsTools(ctx: ComposeContext): boolean {
  return (ctx.enabledToolIds ?? []).includes('update_settings');
}

/** Settings agent tools guidance when update_settings is enabled. */
function resolveManageSettingsBody(ctx: ComposeContext): string {
  if (!contextHasSettingsTools(ctx)) {
    return '';
  }
  const loaded = loadPromptById('tool-usage', 'manage-settings');
  return loaded?.body?.trim() ?? '';
}

/** Minnow app routing when launch_minnow_app is enabled. */
function resolveLaunchMinnowAppBody(ctx: ComposeContext): string {
  if (!contextHasLaunchMinnowAppTool(ctx)) {
    return '';
  }
  const loaded = loadPromptById('tool-usage', 'launch-minnow-app');
  return loaded?.body?.trim() ?? '';
}

function buildInterpolationVars(ctx: ComposeContext): InterpolationVars {
  const modeId = ctx.modeId ?? '';
  const modeLabel =
    modeId && isModeId(modeId) ? getMode(modeId).label : modeId;

  return {
    mode: modeId,
    mode_label: modeLabel,
    profile: 'full',
    expert: ctx.expertLabel?.trim() || ctx.expertId || '',
    cwd: ctx.cwd,
    memory:
      ctx.memoryBlock?.trim() ||
      '(no wiki notes matched this message — the wiki may still be empty)',
    code_map: ctx.codeMapBlock?.trim() ?? '',
    context_documents: ctx.contextDocumentsBlock?.trim() ?? '',
    user_message: ctx.userMessagePreview ?? '',
    work_agent: ctx.workAgentId ?? '',
    work_agent_label: ctx.workAgentLabel?.trim() || ctx.workAgentId || '',
    skill: ctx.skillBody ?? '',
    date: new Date().toISOString().slice(0, 10),
    os: typeof navigator !== 'undefined' ? navigator.platform : 'node',
    plan_granularity: ctx.planGranularity ?? 'medium',
    orchestrate_plan: ctx.orchestratePlanPath ?? '',
    permission_line: permissionPromptBlock(ctx.permissionLevel ?? 'auto', ctx.turnClamp ?? null),
  };
}

// ── Compose ──────────────────────────────────────────────────────────────────

/**
 * Compose the system prompt for a Minnow turn.
 */
export function composeSystemPrompt(ctx: ComposeContext, options?: { turnContext: string[] }): string {
  const vars = buildInterpolationVars(ctx);

  const sections: string[] = [];

  for (const partId of PART_ORDER) {
    if (!isPartEnabled(ctx, partId)) continue;

    const rawBody = resolvePartBody(partId, ctx);
    if (!rawBody.trim()) continue;

    const interpolated = interpolatePromptBody(rawBody, vars);
    if (interpolated.trim()) {
      // These shipped parts carry retrieved data/current-turn information.
      const target = options
        && ['memory', 'code-map', 'context-documents', 'info'].includes(partId)
        ? options.turnContext : sections;
      target.push(interpolated.trim());
    }

    if (partId === 'memory') {
      const saveRaw = resolveMemorySaveBody(ctx);
      if (saveRaw.trim()) {
        const saveInterpolated = interpolatePromptBody(saveRaw, vars);
        if (saveInterpolated.trim()) {
          sections.push(saveInterpolated.trim());
        }
      }
    }
    if (partId === 'work-agent') {
      const captureRaw = resolveWorkAgentKnowledgeCaptureBody(ctx);
      if (captureRaw.trim()) {
        const captureInterpolated = interpolatePromptBody(captureRaw, vars);
        if (captureInterpolated.trim()) {
          sections.push(captureInterpolated.trim());
        }
      }
    }

    if (partId === 'tool-usage') {
      const context7DocsRaw = resolveContext7DocsBody(ctx);
      if (context7DocsRaw.trim()) {
        const context7Interpolated = interpolatePromptBody(context7DocsRaw, vars);
        if (context7Interpolated.trim()) {
          sections.push(context7Interpolated.trim());
        }
      }
      const delegationRaw = resolveSubAgentDelegationBody(ctx);
      if (delegationRaw.trim()) {
        const delegationInterpolated = interpolatePromptBody(delegationRaw, vars);
        if (delegationInterpolated.trim()) {
          sections.push(delegationInterpolated.trim());
        }
      }
      const coordinationRaw = resolveChatCoordinationBody(ctx);
      if (coordinationRaw) sections.push(interpolatePromptBody(coordinationRaw, vars).trim());
      const askQuestionRaw = resolveAskQuestionEnforcementBody(ctx);
      if (askQuestionRaw.trim()) {
        const askInterpolated = interpolatePromptBody(askQuestionRaw, vars);
        if (askInterpolated.trim()) {
          sections.push(askInterpolated.trim());
        }
      }
      const launchAppRaw = resolveLaunchMinnowAppBody(ctx);
      if (launchAppRaw.trim()) {
        const launchInterpolated = interpolatePromptBody(launchAppRaw, vars);
        if (launchInterpolated.trim()) {
          sections.push(launchInterpolated.trim());
        }
      }
      const manageSettingsRaw = resolveManageSettingsBody(ctx);
      if (manageSettingsRaw.trim()) {
        const manageInterpolated = interpolatePromptBody(manageSettingsRaw, vars);
        if (manageInterpolated.trim()) {
          sections.push(manageInterpolated.trim());
        }
      }
      const githubCliRaw = resolveGithubCliBody(ctx);
      if (githubCliRaw.trim()) {
        const githubInterpolated = interpolatePromptBody(githubCliRaw, vars);
        if (githubInterpolated.trim()) {
          sections.push(githubInterpolated.trim());
        }
      }
      const shellSandboxRaw = resolveShellSandboxBody(ctx);
      if (shellSandboxRaw.trim()) {
        const sandboxInterpolated = interpolatePromptBody(shellSandboxRaw, vars);
        if (sandboxInterpolated.trim()) {
          sections.push(sandboxInterpolated.trim());
        }
      }
    }
  }

  const iconGuidanceRaw = resolveFlaticonIconGuidanceBody(ctx);
  if (iconGuidanceRaw.trim()) {
    const iconGuidance = interpolatePromptBody(iconGuidanceRaw, vars);
    if (iconGuidance.trim()) {
      sections.push(iconGuidance.trim());
    }
  }

  const localModelRaw = resolveLocalModelGuidanceBody(ctx);
  if (localModelRaw) {
    sections.push(interpolatePromptBody(localModelRaw, vars).trim());
  }

  if (ctx.chatLinksBlock?.trim()) {
    sections.push(ctx.chatLinksBlock.trim());
  }
  if (ctx.enrichmentNotice?.trim()) {
    (options?.turnContext ?? sections).push(ctx.enrichmentNotice.trim());
  }

  return sections.join(PART_SEPARATOR);
}
