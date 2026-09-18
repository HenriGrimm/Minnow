import { getDefaultWorkAgentForMode } from '../../agents/work-agent-registry';
import { getMode } from '../modes/registry';
import { isModeId, type ModeId } from '../modes/types';
import { BROWSER_PREVIEW_TOOL_IDS } from './browser-allowlist-gate';
import { interpolatePromptBody } from './interpolate';
import { loadPromptById } from './prompt-loader';
import type {
  ComposeContext,
  InterpolationVars,
  PromptConfig,
  PromptConfigPartSettings,
  PromptKind,
  PromptPartId,
  PromptProfile,
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

/** Operating modes that receive the shared mode-handoff tool-usage fragment. */
const MODE_HANDOFF_MODE_IDS = new Set<ModeId>([
  'general',
  'plan',
  'build',
  'orchestrate',
]);

/** Modes that receive the fact-verification tool-usage fragment. */
const FACT_VERIFICATION_MODE_IDS = new Set<ModeId>(['general', 'plan', 'build']);

/** Modes that receive the investigate-before-answer tool-usage fragment. */
const INVESTIGATE_BEFORE_ANSWER_MODE_IDS = new Set<ModeId>([
  'general',
  'plan',
  'build',
  'debug',
]);

/** Modes that receive the shared sub-agent delegation tool-usage fragment. */
const SUB_AGENT_DELEGATION_MODE_IDS = new Set<ModeId>([
  'build',
  'general',
  'plan',
  'debug',
]);

// ── Gates ────────────────────────────────────────────────────────────────────

function contextHasBrowserPreviewTools(ctx: ComposeContext): boolean {
  const ids = ctx.enabledToolIds ?? [];
  return ids.some((id) => BROWSER_PREVIEW_TOOL_IDS.has(id));
}

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

/** Default lite part gating (memory uses shorter retrieve cap when enabled). */
const LITE_DISABLED_PARTS = new Set<PromptPartId>(['info']);

/** Strip HTML comments (e.g. MINNOW_MODE_MARKER) before sending to the model. */
export function stripPromptHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '').trim();
}

export function shouldSuppressModePart(ctx: ComposeContext): boolean {
  const modeId = ctx.modeId?.trim();
  const workAgentId = ctx.workAgentId?.trim();
  if (!modeId || !workAgentId) return false;
  const defaultAgent = getDefaultWorkAgentForMode(modeId);
  return defaultAgent?.id === workAgentId;
}

function partSettings(
  config: PromptConfig | null | undefined,
  partId: PromptPartId,
): PromptConfigPartSettings | null {
  if (!config?.parts) return null;
  return config.parts[partId] ?? null;
}

function isPartEnabled(
  ctx: ComposeContext,
  partId: PromptPartId,
  profile: PromptProfile,
): boolean {
  const custom = partSettings(ctx.customConfig, partId);
  if (profile === 'custom' && custom) {
    return custom.enabled;
  }
  if (profile === 'lite' && LITE_DISABLED_PARTS.has(partId)) {
    return false;
  }
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
    if (!ctx.infoPresetId) return false;
    return ctx.modeId === 'general';
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

function resolvePartBody(
  partId: PromptPartId,
  ctx: ComposeContext,
  profile: PromptProfile,
): string {
  const custom = partSettings(ctx.customConfig, partId);
  if (custom?.contentOverride?.trim()) {
    return stripPromptHtmlComments(custom.contentOverride.trim());
  }

  if (partId === 'skill' && ctx.skillBody?.trim()) {
    return ctx.skillBody.trim();
  }
  if (partId === 'memory' && isMemoryPartEnabled(ctx)) {
    const loadProfile = profile === 'lite' ? 'lite' : 'full';
    const loaded = loadPromptById('info', 'memory', loadProfile);
    if (loaded?.body?.trim()) {
      return loaded.body.trim();
    }
    return ctx.memoryBlock?.trim() ?? '';
  }
  if (partId === 'code-map' && isCodeMapPartEnabled(ctx)) {
    const loadProfile = profile === 'lite' ? 'lite' : 'full';
    const loaded = loadPromptById('info', 'code-map', loadProfile);
    if (loaded?.body?.trim()) {
      return loaded.body.trim();
    }
    return ctx.codeMapBlock?.trim() ?? '';
  }
  if (partId === 'context-documents' && isContextDocumentsPartEnabled(ctx)) {
    const loadProfile = profile === 'lite' ? 'lite' : 'full';
    const loaded = loadPromptById('info', 'context-documents', loadProfile);
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

  const loadProfile = profile === 'lite' ? 'lite' : 'full';
  const loaded = loadPromptById(kind, id || 'default', loadProfile);
  if (!loaded?.body) return '';

  if (profile === 'lite') {
    if (loaded.liteBody?.trim()) {
      return stripPromptHtmlComments(loaded.liteBody.trim());
    }
    return '';
  }

  return stripPromptHtmlComments(loaded.body);
}

function contextHasContext7Tools(ctx: ComposeContext): boolean {
  return (ctx.enabledToolIds ?? []).some((id) => id.startsWith('mcp__context7__'));
}

/** Fact-verification ladder for plan/build/general before drafting or implementing. */
function resolveFactVerificationBody(ctx: ComposeContext, profile: PromptProfile): string {
  const modeId = ctx.modeId ?? '';
  if (!modeId || !isModeId(modeId) || !FACT_VERIFICATION_MODE_IDS.has(modeId)) {
    return '';
  }
  const loadProfile = profile === 'lite' ? 'lite' : 'full';
  const loaded = loadPromptById('tool-usage', 'fact-verification', loadProfile);
  return loaded?.body?.trim() ?? '';
}

/** Investigate-before-answer ladder for general/plan/build/debug Q&A. */
function resolveInvestigateBeforeAnswerBody(ctx: ComposeContext, profile: PromptProfile): string {
  const modeId = ctx.modeId ?? '';
  if (!modeId || !isModeId(modeId) || !INVESTIGATE_BEFORE_ANSWER_MODE_IDS.has(modeId)) {
    return '';
  }
  const loadProfile = profile === 'lite' ? 'lite' : 'full';
  const loaded = loadPromptById('tool-usage', 'investigate-before-answer', loadProfile);
  return loaded?.body?.trim() ?? '';
}

/** Context7 MCP workflow when Context7 tools are enabled for this chat. */
function resolveContext7DocsBody(ctx: ComposeContext, profile: PromptProfile): string {
  if (!contextHasContext7Tools(ctx)) {
    return '';
  }
  const loadProfile = profile === 'lite' ? 'lite' : 'full';
  const loaded = loadPromptById('tool-usage', 'context7-docs', loadProfile);
  return loaded?.body?.trim() ?? '';
}

/** Shared mode-switch handoff rules appended after default tool-usage. */
function resolveModeHandoffBody(ctx: ComposeContext, profile: PromptProfile): string {
  const modeId = ctx.modeId ?? '';
  if (!modeId || !isModeId(modeId) || !MODE_HANDOFF_MODE_IDS.has(modeId)) {
    return '';
  }
  const loadProfile = profile === 'lite' ? 'lite' : 'full';
  const loaded = loadPromptById('tool-usage', 'mode-handoff', loadProfile);
  return loaded?.body?.trim() ?? '';
}

function contextHasSpawnSubAgentTool(ctx: ComposeContext): boolean {
  return (ctx.enabledToolIds ?? []).includes('spawn_sub_agent');
}

/** When/how to spawn sub-agents for parallel research and implementation. */
function resolveSubAgentDelegationBody(ctx: ComposeContext, profile: PromptProfile): string {
  const modeId = ctx.modeId ?? '';
  if (
    !modeId ||
    !isModeId(modeId) ||
    !SUB_AGENT_DELEGATION_MODE_IDS.has(modeId) ||
    !contextHasSpawnSubAgentTool(ctx)
  ) {
    return '';
  }
  const loadProfile = profile === 'lite' ? 'lite' : 'full';
  const loaded = loadPromptById('tool-usage', 'sub-agent-delegation', loadProfile);
  return loaded?.body?.trim() ?? '';
}

/** Brain save guidance when write tools are enabled for this chat. */
function resolveMemorySaveBody(ctx: ComposeContext, profile: PromptProfile): string {
  if (!contextHasBrainWriteTools(ctx)) {
    return '';
  }
  const loadProfile = profile === 'lite' ? 'lite' : 'full';
  const loaded = loadPromptById('info', 'memory-save', loadProfile);
  return loaded?.body?.trim() ?? '';
}

/** Default-on interface icon guidance; users can disable it in Settings → Agents. */
function resolveFlaticonIconGuidanceBody(
  ctx: ComposeContext,
  profile: PromptProfile,
): string {
  if (ctx.flaticonIconGuidanceEnabled === false) {
    return '';
  }
  const loadProfile = profile === 'lite' ? 'lite' : 'full';
  const loaded = loadPromptById('info', 'interface-icons', loadProfile);
  return loaded?.body?.trim() ?? '';
}

/** Work-agent knowledge capture when save_memory / brain_write_page are enabled. */
function resolveWorkAgentKnowledgeCaptureBody(
  ctx: ComposeContext,
  profile: PromptProfile,
): string {
  if (!contextHasBrainWriteTools(ctx)) {
    return '';
  }
  const agentId = ctx.workAgentId?.trim();
  if (!agentId || agentId === 'default') {
    return '';
  }
  const loadProfile = profile === 'lite' ? 'lite' : 'full';
  const loaded = loadPromptById('tool-usage', `${agentId}-knowledge-capture`, loadProfile);
  return loaded?.body?.trim() ?? '';
}

/** Browser navigation allowlist + ask_question flow when preview browser tools are enabled. */
function resolveBrowserAllowlistBody(ctx: ComposeContext, profile: PromptProfile): string {
  if (!contextHasBrowserPreviewTools(ctx)) {
    return '';
  }
  const useFullAllowlist = ctx.browserActivated === true;
  const loadProfile =
    profile === 'lite' || !useFullAllowlist ? 'lite' : 'full';
  const loaded = loadPromptById('tool-usage', 'browser-allowlist', loadProfile);
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
function resolveGithubCliBody(ctx: ComposeContext, profile: PromptProfile): string {
  if (!contextHasExecuteCommandTool(ctx)) {
    return '';
  }
  const loadProfile = profile === 'lite' ? 'lite' : 'full';
  const loaded = loadPromptById('tool-usage', 'github-cli', loadProfile);
  return loaded?.body?.trim() ?? '';
}

/** Host shell sandbox note when prefer/require is on (MIN-553). */
function resolveShellSandboxBody(ctx: ComposeContext, profile: PromptProfile): string {
  if (!contextHasExecuteCommandTool(ctx) || !contextHasShellSandbox(ctx)) {
    return '';
  }
  const loadProfile = profile === 'lite' ? 'lite' : 'full';
  const loaded = loadPromptById('tool-usage', 'shell-sandbox', loadProfile);
  return loaded?.body?.trim() ?? '';
}

/** Mandatory ask_question usage when the tool is enabled for this chat. */
function resolveAskQuestionEnforcementBody(ctx: ComposeContext, profile: PromptProfile): string {
  if (!contextHasAskQuestionTool(ctx)) {
    return '';
  }
  const loadProfile = profile === 'lite' ? 'lite' : 'full';
  const loaded = loadPromptById('tool-usage', 'ask-question-enforcement', loadProfile);
  return loaded?.body?.trim() ?? '';
}

function contextHasLaunchMinnowAppTool(ctx: ComposeContext): boolean {
  return (ctx.enabledToolIds ?? []).includes('launch_minnow_app');
}

function contextHasSettingsTools(ctx: ComposeContext): boolean {
  return (ctx.enabledToolIds ?? []).includes('update_settings');
}

/** Settings agent tools guidance when update_settings is enabled. */
function resolveManageSettingsBody(ctx: ComposeContext, profile: PromptProfile): string {
  const modeId = ctx.modeId ?? '';
  if (modeId !== 'general' || !contextHasSettingsTools(ctx)) {
    return '';
  }
  const loadProfile = profile === 'lite' ? 'lite' : 'full';
  const loaded = loadPromptById('tool-usage', 'manage-settings', loadProfile);
  return loaded?.body?.trim() ?? '';
}

/** General-mode Minnow app routing when launch_minnow_app is enabled. */
function resolveLaunchMinnowAppBody(ctx: ComposeContext, profile: PromptProfile): string {
  const modeId = ctx.modeId ?? '';
  if (modeId !== 'general' || !contextHasLaunchMinnowAppTool(ctx)) {
    return '';
  }
  const loadProfile = profile === 'lite' ? 'lite' : 'full';
  const loaded = loadPromptById('tool-usage', 'launch-minnow-app', loadProfile);
  return loaded?.body?.trim() ?? '';
}

function buildInterpolationVars(ctx: ComposeContext): InterpolationVars {
  const modeId = ctx.modeId ?? '';
  const modeLabel =
    modeId && isModeId(modeId) ? getMode(modeId).label : modeId;

  const profileLabel =
    ctx.profile === 'custom' ? 'custom' : ctx.profile === 'lite' ? 'lite' : 'full';

  return {
    mode: modeId,
    mode_label: modeLabel,
    profile: profileLabel,
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
  };
}

// ── Compose ──────────────────────────────────────────────────────────────────

/**
 * Compose the full system prompt string for LM Studio.
 */
export function composeSystemPrompt(ctx: ComposeContext): string {
  const profile: PromptProfile =
    ctx.profile === 'custom' ? 'custom' : ctx.profile === 'lite' ? 'lite' : 'full';

  const effectiveProfile: PromptProfile =
    profile === 'custom' ? 'custom' : profile;

  const vars = buildInterpolationVars(ctx);

  const sections: string[] = [];

  for (const partId of PART_ORDER) {
    if (!isPartEnabled(ctx, partId, effectiveProfile)) continue;

    const rawBody = resolvePartBody(partId, ctx, effectiveProfile === 'lite' ? 'lite' : 'full');
    if (!rawBody.trim()) continue;

    const interpolated = interpolatePromptBody(rawBody, vars);
    if (interpolated.trim()) {
      sections.push(interpolated.trim());
    }

    const profileKey = effectiveProfile === 'lite' ? 'lite' : 'full';
    if (partId === 'memory') {
      const saveRaw = resolveMemorySaveBody(ctx, profileKey);
      if (saveRaw.trim()) {
        const saveInterpolated = interpolatePromptBody(saveRaw, vars);
        if (saveInterpolated.trim()) {
          sections.push(saveInterpolated.trim());
        }
      }
    }
    if (partId === 'work-agent') {
      const captureRaw = resolveWorkAgentKnowledgeCaptureBody(ctx, profileKey);
      if (captureRaw.trim()) {
        const captureInterpolated = interpolatePromptBody(captureRaw, vars);
        if (captureInterpolated.trim()) {
          sections.push(captureInterpolated.trim());
        }
      }
    }

    if (partId === 'tool-usage') {
      const profileKeyTool = effectiveProfile === 'lite' ? 'lite' : 'full';
      const factVerificationRaw = resolveFactVerificationBody(ctx, profileKeyTool);
      if (factVerificationRaw.trim()) {
        const factInterpolated = interpolatePromptBody(factVerificationRaw, vars);
        if (factInterpolated.trim()) {
          sections.push(factInterpolated.trim());
        }
      }
      const investigateRaw = resolveInvestigateBeforeAnswerBody(ctx, profileKey);
      if (investigateRaw.trim()) {
        const investigateInterpolated = interpolatePromptBody(investigateRaw, vars);
        if (investigateInterpolated.trim()) {
          sections.push(investigateInterpolated.trim());
        }
      }
      const context7DocsRaw = resolveContext7DocsBody(ctx, profileKey);
      if (context7DocsRaw.trim()) {
        const context7Interpolated = interpolatePromptBody(context7DocsRaw, vars);
        if (context7Interpolated.trim()) {
          sections.push(context7Interpolated.trim());
        }
      }
      const handoffRaw = resolveModeHandoffBody(ctx, profileKey);
      if (handoffRaw.trim()) {
        const handoffInterpolated = interpolatePromptBody(handoffRaw, vars);
        if (handoffInterpolated.trim()) {
          sections.push(handoffInterpolated.trim());
        }
      }
      const delegationRaw = resolveSubAgentDelegationBody(ctx, profileKey);
      if (delegationRaw.trim()) {
        const delegationInterpolated = interpolatePromptBody(delegationRaw, vars);
        if (delegationInterpolated.trim()) {
          sections.push(delegationInterpolated.trim());
        }
      }
      const browserAllowlistRaw = resolveBrowserAllowlistBody(ctx, profileKey);
      if (browserAllowlistRaw.trim()) {
        const browserInterpolated = interpolatePromptBody(browserAllowlistRaw, vars);
        if (browserInterpolated.trim()) {
          sections.push(browserInterpolated.trim());
        }
      }
      const askQuestionRaw = resolveAskQuestionEnforcementBody(ctx, profileKey);
      if (askQuestionRaw.trim()) {
        const askInterpolated = interpolatePromptBody(askQuestionRaw, vars);
        if (askInterpolated.trim()) {
          sections.push(askInterpolated.trim());
        }
      }
      const launchAppRaw = resolveLaunchMinnowAppBody(ctx, profileKey);
      if (launchAppRaw.trim()) {
        const launchInterpolated = interpolatePromptBody(launchAppRaw, vars);
        if (launchInterpolated.trim()) {
          sections.push(launchInterpolated.trim());
        }
      }
      const manageSettingsRaw = resolveManageSettingsBody(ctx, profileKey);
      if (manageSettingsRaw.trim()) {
        const manageInterpolated = interpolatePromptBody(manageSettingsRaw, vars);
        if (manageInterpolated.trim()) {
          sections.push(manageInterpolated.trim());
        }
      }
      const githubCliRaw = resolveGithubCliBody(ctx, profileKey);
      if (githubCliRaw.trim()) {
        const githubInterpolated = interpolatePromptBody(githubCliRaw, vars);
        if (githubInterpolated.trim()) {
          sections.push(githubInterpolated.trim());
        }
      }
      const shellSandboxRaw = resolveShellSandboxBody(ctx, profileKey);
      if (shellSandboxRaw.trim()) {
        const sandboxInterpolated = interpolatePromptBody(shellSandboxRaw, vars);
        if (sandboxInterpolated.trim()) {
          sections.push(sandboxInterpolated.trim());
        }
      }
    }
  }

  const iconGuidanceRaw = resolveFlaticonIconGuidanceBody(
    ctx,
    effectiveProfile,
  );
  if (iconGuidanceRaw.trim()) {
    const iconGuidance = interpolatePromptBody(iconGuidanceRaw, vars);
    if (iconGuidance.trim()) {
      sections.push(iconGuidance.trim());
    }
  }

  if (ctx.chatLinksBlock?.trim()) {
    sections.push(ctx.chatLinksBlock.trim());
  }

  return sections.join(PART_SEPARATOR);
}
