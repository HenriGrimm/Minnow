/**
 * Execute a single capability-matrix auto probe via the headless LLM driver.
 */

import { loadModePromptBody } from '../../chat/modes/registry.ts';
import { getToolById, type OpenAIFunctionDefinition } from '../../tools/definitions.ts';
import type { ApiMessage, ToolCall } from '../../types.ts';
import {
  RECALL_HISTORY_TOOL_DEFINITION,
  RECALL_HISTORY_TOOL_NAME,
} from '../../../server/runner/compaction/recall.js';
import { runDelegatedCapabilityProbe } from './delegated-probes.ts';
import { createCapabilityExecuteToolFn } from './execute-tool.ts';
import { runOneShot, runToolLoop, type OneShotResult } from '../llm-driver.ts';
import { rethrowIfAborted, withBenchmarkTimeout } from '../abort.ts';
import type { BenchmarkRunContext } from '../types.ts';
import { DEFAULT_PROBE_TIMEOUT_MS } from '../types.ts';
import {
  CAPABILITY_PROBE_SYSTEM_PROMPT,
  getCapabilityProbePrompt,
} from './probe-prompts.ts';
import type {
  CapabilityDefinition,
  CapabilityProbeRunOutput,
  CapabilityProbeSpec,
  CapabilityProbeSpecBase,
  CapabilityRoundTelemetry,
  CapabilityScoredVerdict,
  CapabilityVerdict,
  DelegatedCapabilityProbeSpec,
} from './types.ts';

export interface RunCapabilityProbeOptions {
  workspaceRoot?: string;
}

/** Rounds a probe gets when its spec declares none. */
const DEFAULT_PROBE_TOOL_ROUNDS = 6;

export interface RunCapabilityProbeResult {
  skipped: boolean;
  skipReason?: string;
  verdict: CapabilityVerdict;
  reason: string;
  oneShot?: OneShotResult;
}

function isDelegatedSpec(spec: CapabilityProbeSpec): spec is DelegatedCapabilityProbeSpec {
  return spec.kind === 'delegated';
}

function isRunnableSpec(spec: CapabilityProbeSpec): spec is CapabilityProbeSpecBase {
  return spec.kind !== 'delegated';
}

/**
 * Authored prompt when the row has one. The spreadsheet `prompt` column holds test
 * *descriptions* ("Exercise: Valid JSON args. Watch the tool console for…"), so it is
 * only a last resort for rows that slipped through the completeness test.
 */
function buildUserMessage(cap: CapabilityDefinition): string {
  const authored = getCapabilityProbePrompt(cap.id);
  if (authored) return authored;
  const prompt = cap.prompt.trim();
  if (prompt.length >= 24 && !/^(for a |Exercise: )/i.test(prompt)) return prompt;
  return cap.howToTest.trim() || prompt;
}

function mapToolCalls(toolCalls: ToolCall[]): CapabilityProbeRunOutput['toolCalls'] {
  return toolCalls.map((tc) => ({
    function: { name: tc.function.name, arguments: tc.function.arguments },
  }));
}

/**
 * Every call the model emitted, across all rounds.
 *
 * `OneShotResult.toolCalls` only carries the *last* batch (`preserveLastToolCalls` keeps
 * the final non-empty turn), so a two-round chain like save→append handed the verdict the
 * append alone and scored `fail`. Round telemetry has the full history; fall back to the
 * one-shot batch for probes that never run the loop and so emit no rounds.
 */
function allProbeToolCalls(
  out: OneShotResult,
  rounds: CapabilityRoundTelemetry[],
): CapabilityProbeRunOutput['toolCalls'] {
  const fromRounds = rounds.flatMap((r) => r.toolCalls);
  return fromRounds.length > 0 ? fromRounds : mapToolCalls(out.toolCalls);
}

function probeOutputFromOneShot(
  out: OneShotResult,
  rounds: CapabilityRoundTelemetry[],
  executedResults: string[],
  offeredToolNames: string[],
): CapabilityProbeRunOutput {
  return {
    text: out.text,
    contentText: out.contentText,
    reasoningText: out.reasoningText,
    streamChunkCount: out.timing.streamChunkCount,
    toolCalls: allProbeToolCalls(out, rounds),
    rounds,
    executedResults,
    offeredToolNames,
  };
}

function resolveProbeToolIds(spec: CapabilityProbeSpecBase): string[] {
  return [...(spec.toolIds ?? []), ...(spec.trapToolIds ?? [])];
}

/**
 * Resolve tool schemas, reporting ids missing from the catalog instead of dropping them.
 * A silently dropped id means the model is scored on a tool it was never offered.
 */
function resolveOpenAiTools(toolIds: string[]): {
  defs: OpenAIFunctionDefinition[];
  missing: string[];
} {
  const defs: OpenAIFunctionDefinition[] = [];
  const missing: string[] = [];
  for (const id of toolIds) {
    const tool = getToolById(id);
    if (tool) defs.push(tool.definition);
    // Not a catalog tool: runTurn offers it itself once a chat has a compaction checkpoint.
    else if (id === RECALL_HISTORY_TOOL_NAME) defs.push(structuredClone(RECALL_HISTORY_TOOL_DEFINITION) as OpenAIFunctionDefinition);
    else missing.push(id);
  }
  return { defs, missing };
}

/**
 * Rounds a chain gets before the loop is cut off.
 *
 * The declared caps were sized for the ideal path, so a single detour — a model checking
 * that its background run really started before stopping it — exhausted the budget and
 * the loop ended mid-chain. The row then read as if the model had refused to finish.
 * Floor a chain at one round per offered tool plus headroom for a detour, a recovery, and
 * the closing answer. Unused rounds cost nothing: the loop exits on the first text-only
 * turn.
 */
const CHAIN_ROUND_HEADROOM = 6;

export function resolveMaxToolRounds(spec: CapabilityProbeSpecBase): number {
  const declared = spec.maxToolRounds ?? DEFAULT_PROBE_TOOL_ROUNDS;
  if (spec.kind !== 'tool-chain') return declared;
  return Math.max(declared, (spec.toolIds?.length ?? 0) + CHAIN_ROUND_HEADROOM);
}

/**
 * True when the loop stopped because it ran out of rounds rather than because the model
 * finished. The driver only leaves tool calls in the final round when the cap cut it off.
 */
export function hitRoundCap(rounds: CapabilityRoundTelemetry[], maxRounds: number): boolean {
  if (rounds.length < maxRounds) return false;
  return (rounds[rounds.length - 1]?.toolCalls.length ?? 0) > 0;
}

function usesToolLoop(spec: CapabilityProbeSpecBase, toolIds: string[]): boolean {
  return (
    spec.kind === 'tool-call' ||
    spec.kind === 'tool-chain' ||
    spec.kind === 'derived' ||
    (spec.kind === 'stream' && toolIds.length > 0)
  );
}

function scoreFromVerdict(verdict: CapabilityScoredVerdict): number {
  if (verdict === 'pass') return 1;
  if (verdict === 'partial') return 0.5;
  return 0;
}

/** Map probe verdict to benchmark row fields. */
export function capabilityTestFieldsFromVerdict(
  verdict: CapabilityScoredVerdict,
  reason: string,
): { passed: boolean; score: number; details: string } {
  return {
    passed: verdict === 'pass',
    score: scoreFromVerdict(verdict),
    details: reason,
  };
}

/**
 * Run one catalog auto probe (caller must skip manual / unmet requirements).
 */
export async function runCapabilityProbe(
  ctx: BenchmarkRunContext,
  cap: CapabilityDefinition,
  options: RunCapabilityProbeOptions = {},
): Promise<RunCapabilityProbeResult> {
  const probe = cap.probe;
  if (!probe) {
    return {
      skipped: true,
      skipReason: 'missing probe spec',
      verdict: 'n-a',
      reason: 'missing probe spec',
    };
  }
  if (isDelegatedSpec(probe)) {
    return runDelegatedCapabilityProbe(ctx, probe);
  }
  if (!isRunnableSpec(probe)) {
    return {
      skipped: true,
      skipReason: 'unsupported probe kind',
      verdict: 'n-a',
      reason: 'unsupported probe kind',
    };
  }

  const toolIds = resolveProbeToolIds(probe);
  const { defs: tools, missing } = resolveOpenAiTools(toolIds);
  if (missing.length > 0) {
    const reason = `probe references unknown tool ids: ${missing.join(', ')}`;
    return { skipped: true, skipReason: reason, verdict: 'n-a', reason };
  }

  const systemParts: string[] = [CAPABILITY_PROBE_SYSTEM_PROMPT];
  if (probe.modeId) {
    const modePrompt = loadModePromptBody(probe.modeId, 'lite');
    if (!modePrompt) {
      const reason = `mode prompt unavailable: ${probe.modeId}`;
      return { skipped: true, skipReason: reason, verdict: 'n-a', reason };
    }
    systemParts.push(modePrompt);
  }
  const messages: ApiMessage[] = [
    { role: 'system', content: systemParts.join('\n\n') },
    { role: 'user', content: buildUserMessage(cap) },
  ];

  const rounds: CapabilityRoundTelemetry[] = [];
  const executedResults: string[] = [];
  const allowSideEffects = ctx.capabilityMatrix?.allowSideEffects === true;
  const baseExecuteToolFn = createCapabilityExecuteToolFn(allowSideEffects, {
    workspaceRoot: options.workspaceRoot,
    stubToolIds: [
      ...(probe.emitOnly ? (probe.toolIds ?? []) : []),
      ...(probe.trapToolIds ?? []),
    ],
  });
  const executeToolFn: typeof baseExecuteToolFn = async (name, args, context) => {
    try {
      const result = await baseExecuteToolFn(name, args, context);
      executedResults.push(result.content);
      return result;
    } catch (err) {
      executedResults.push(`Error: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  };

  const maxRounds = resolveMaxToolRounds(probe);
  const timeoutMs = ctx.perTestTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  const offeredToolNames = tools.map((t) => t.function.name);
  let partial: OneShotResult | undefined;

  try {
    let oneShot!: OneShotResult;

    await withBenchmarkTimeout(ctx.signal, timeoutMs, async (probeSignal) => {
      if (usesToolLoop(probe, toolIds)) {
        oneShot = await runToolLoop({
          providerId: ctx.providerId,
          modelId: ctx.modelId,
          signal: probeSignal,
          messages,
          tools,
          maxToolRounds: maxRounds,
          timeoutMs,
          ...(probe.modeId ? { modeId: probe.modeId } : {}),
          executeToolFn,
          onRound: (round) => rounds.push(round),
          onPartial: (snapshot) => {
            partial = snapshot;
          },
        });
      } else {
        oneShot = await runOneShot({
          providerId: ctx.providerId,
          modelId: ctx.modelId,
          signal: probeSignal,
          messages,
          timeoutMs,
          ...(tools.length ? { tools } : {}),
          onPartial: (snapshot) => {
            partial = snapshot;
          },
        });
      }
    });

    const out = probeOutputFromOneShot(oneShot, rounds, executedResults, offeredToolNames);
    const judged = probe.verdict(out);
    const cutOff = judged.verdict !== 'pass' && hitRoundCap(rounds, maxRounds);
    const notes: string[] = [];
    if (cutOff) notes.push(`cut off at the ${maxRounds}-round cap`);
    if (oneShot.thinkingBudgetExceeded) notes.push('answered after the thinking budget tripped');
    return {
      skipped: false,
      verdict: judged.verdict,
      reason: notes.length ? `${judged.reason} — ${notes.join('; ')}` : judged.reason,
      oneShot,
    };
  } catch (err) {
    rethrowIfAborted(err, ctx.signal);
    const message = err instanceof Error ? err.message : String(err);
    if (partial) {
      const out = probeOutputFromOneShot(partial, rounds, executedResults, offeredToolNames);
      const judged = probe.verdict(out);
      return {
        skipped: false,
        verdict: judged.verdict,
        reason: `${judged.reason} — ${message}`,
        oneShot: partial,
      };
    }
    return {
      skipped: false,
      verdict: 'fail',
      reason: message,
    };
  }
}
