/**
 * Gate capability matrix probes on environment requirements (n-a when unmet — never fail).
 */

import { loadModePromptBody } from '../../chat/modes/registry.ts';
import { getBenchmarkWorkspacePath } from '../../lib/benchmark-workspace.ts';
import { isVisionModel } from '../../providers/vision-model.ts';
import type { LmModelRecord } from '../../types.ts';
import type { BenchmarkRunContext } from '../types.ts';
import {
  isCapabilityMatrixGitFixtureReady,
} from './fixtures-workspace.ts';
import {
  PHASE_2B_ID_SET,
  PHASE_2C_ID_SET,
  PHASE_2D_ID_SET,
  PHASE_2E_ID_SET,
  PHASE_2F_ID_SET,
} from './probe-wave-ids.ts';
import { resolveLspProbeSkipReason } from './probe-lsp-ready.ts';
import type { CapabilityDefinition, CapabilityProbeRequirement } from './types.ts';

/** Optional suite-level cache (model catalog, workspace path). */
export interface CapabilityProbeEnvironment {
  ctx: BenchmarkRunContext;
  /** Models list for vision gating (same fetch as capability suite). */
  catalogModels?: LmModelRecord[];
  /** Resolved benchmark workspace root when available. */
  workspaceRoot?: string | null;
  /** Set after `ensureCapabilityMatrixFixturesReady` in the capability-matrix suite. */
  capabilityFixturesSeeded?: boolean;
  /**
   * LSP gate override for tests — when false, `lsp` requirement skips without fetching config.
   * When true, treat LSP as ready (skip live `/api/config/lsp` poll).
   */
  lspEnvironmentReady?: boolean;
  /**
   * Mode-prompt gate override for tests — the built-in prompt registry is Vite-only, so
   * Node suites set this rather than loading prompt markdown.
   */
  modePromptsReady?: boolean;
}

async function requirementSkipReason(
  req: CapabilityProbeRequirement,
  env: CapabilityProbeEnvironment,
  cap: CapabilityDefinition,
): Promise<string | null> {
  const { ctx } = env;
  if (req === 'mode-prompt') {
    const modeId = cap.probe && cap.probe.kind !== 'delegated' ? cap.probe.modeId : undefined;
    if (!modeId) return 'probe declares mode-prompt without a modeId';
    if (env.modePromptsReady === false) return 'mode prompts unavailable';
    if (env.modePromptsReady === true) return null;
    return loadModePromptBody(modeId) ? null : `mode prompt unavailable: ${modeId}`;
  }
  if (req === 'tool-server' && !ctx.localServer) {
    return 'needs npm start (tool server)';
  }
  if (req === 'workspace') {
    if (!ctx.localServer) return 'needs npm start (benchmark workspace)';
    const root =
      env.workspaceRoot !== undefined
        ? env.workspaceRoot
        : await getBenchmarkWorkspacePath().catch(() => null);
    if (!root) return 'benchmark workspace unavailable';
    return null;
  }
  if (req === 'git-fixture') {
    if (!ctx.localServer) return 'needs npm start (git fixture)';
    const root =
      env.workspaceRoot !== undefined
        ? env.workspaceRoot
        : await getBenchmarkWorkspacePath().catch(() => null);
    if (!root) return 'benchmark workspace unavailable';
    if (env.capabilityFixturesSeeded) return null;
    const ready = await isCapabilityMatrixGitFixtureReady(root);
    if (!ready) return 'git fixture not seeded';
    return null;
  }
  if (req === 'lsp') {
    if (!ctx.localServer) return 'needs npm start (LSP)';
    if (env.lspEnvironmentReady === false) return 'LSP unavailable';
    if (env.lspEnvironmentReady === true) return null;
    return await resolveLspProbeSkipReason();
  }
  if (req === 'vision') {
    const vision =
      env.catalogModels != null
        ? isVisionModel(ctx.modelId, env.catalogModels)
        : false;
    if (!vision) return 'model does not support vision';
    return null;
  }
  return null;
}

/** Human-readable skip reason when the probe cannot run; null when requirements are satisfied. */
export async function resolveCapabilityProbeSkip(
  cap: CapabilityDefinition,
  env: CapabilityProbeEnvironment,
): Promise<string | null> {
  if (cap.scoreMode === 'manual') {
    return cap.manualReason ?? 'manual row';
  }
  if (!cap.probe) {
    return 'missing probe spec';
  }
  const requires = cap.probe.requires;
  if (requires?.length) {
    for (const req of requires) {
      const reason = await requirementSkipReason(req, env, cap);
      if (reason) return reason;
    }
  }
  if (cap.scoreMode === 'auto' && !isCapabilityProbeWaveEnabled(cap)) {
    return 'auto probe pending (later phase)';
  }
  return null;
}

/** Auto probes with no `requires` — runnable without tool server / workspace (phase 2b). */
export {
  PHASE_2B_NO_REQUIREMENT_CAPABILITY_IDS,
  PHASE_2D_EMIT_ONLY_CAPABILITY_IDS,
  PHASE_2E_CONDITIONAL_CAPABILITY_IDS,
  PHASE_2F_DELEGATED_DERIVED_CAPABILITY_IDS,
} from './probe-wave-ids.ts';

/** Whether this auto row is wired in the current probe wave (phases 2b–2f allowlist). */
export function isCapabilityProbeWaveEnabled(cap: CapabilityDefinition): boolean {
  return (
    PHASE_2B_ID_SET.has(cap.id) ||
    PHASE_2C_ID_SET.has(cap.id) ||
    PHASE_2D_ID_SET.has(cap.id) ||
    PHASE_2E_ID_SET.has(cap.id) ||
    PHASE_2F_ID_SET.has(cap.id)
  );
}

/** Every auto capability id should appear in exactly one phase wave (2b–2f). */
export function assertAllAutoCapabilitiesWired(catalog: CapabilityDefinition[]): void {
  const auto = catalog.filter((c) => c.scoreMode === 'auto');
  const unwired = auto.filter((c) => !isCapabilityProbeWaveEnabled(c));
  if (unwired.length > 0) {
    throw new Error(`Auto capabilities missing probe wave: ${unwired.map((c) => c.id).join(', ')}`);
  }
}
