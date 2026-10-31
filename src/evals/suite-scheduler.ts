/**
 * Suite matrix scheduler: task×model runs with concurrency cap and abort.
 */

import { computeLeaderboard } from './leaderboard';
import { emitEvalSuiteProgress } from './eval-events';
import {
  fetchEvalPack,
  saveEvalCell,
  saveEvalLeaderboard,
  saveEvalManifest,
} from './eval-api';
import { fetchEvalConfig } from './config';
import { getEvalGrader } from './grader';
import { buildCellId, buildModelKey } from './model-key';
import { getEvalRunner } from './runner';
import { createEvalExecuteTool, resolveEvalTaskTools } from './tool-context';
import type {
  EvalCellResult,
  EvalModelTarget,
  EvalPack,
  EvalSuiteRequest,
  EvalSuiteRun,
  EvalTask,
} from './types';
import { extractMessageText } from '../api/chat';
import type { ApiMessage } from '../types';
import { composeSystemPrompt } from '../chat/prompts/prompt-composer';

const activeAbort = new Map<string, AbortController>();

export function abortEvalSuite(suiteRunId: string): void {
  activeAbort.get(suiteRunId)?.abort();
}

export interface RunEvalSuiteOptions {
  request: EvalSuiteRequest;
  pack?: EvalPack;
  fallbackProviderId: string;
  fallbackModelId: string;
  defaultWorkspacePath: string;
}

function transcriptExcerpt(messages: ApiMessage[]): string {
  const assistants = messages.filter((m) => m.role === 'assistant');
  const last = assistants[assistants.length - 1];
  if (!last) return '';
  return extractMessageText(last as { content?: string }).slice(0, 2000);
}

async function runOneCell(params: {
  suiteRunId: string;
  task: EvalTask;
  target: EvalModelTarget;
  pack: EvalPack;
  workspacePath: string;
  modeId: string;
  signal: AbortSignal;
  saveTranscripts: boolean;
  fallbackProviderId: string;
  fallbackModelId: string;
}): Promise<EvalCellResult> {
  const { task, target, signal } = params;
  const modelKey = buildModelKey(target.providerId, target.modelId);
  const cellId = buildCellId(task.id, modelKey);
  const modelLabel =
    target.label?.trim() ||
    `${target.providerId} / ${target.modelId}`.trim();
  const startedAt = new Date().toISOString();
  const t0 = performance.now();

  const config = await fetchEvalConfig();
  const tools = resolveEvalTaskTools(task, params.modeId);
  const taskSystem = task.systemPrompt?.trim() || 'You are running an offline eval task. Follow the user prompt precisely.';
  const sharedSystem = task.toolFixtures ? composeSystemPrompt({ profile: 'full', cwd: params.workspacePath,
    modeId: params.modeId, expertId: null, workAgentId: null, skillBody: null, memoryBlock: null,
    codeMapBlock: null, contextDocumentsBlock: null, infoPresetId: 'general-assistant',
    flaticonIconGuidanceEnabled: false, enabledToolIds: tools.map(tool => tool.function.name) }) : '';
  const systemPrompt = [sharedSystem, taskSystem].filter(Boolean).join('\n\n');

  const executeTool = createEvalExecuteTool(config, params.workspacePath, task);

  let runnerOut;
  try {
    runnerOut = await getEvalRunner().run({
      task,
      systemPrompt,
      tools,
      providerId: target.providerId,
      modelId: target.modelId,
      signal,
      executeTool,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const endedAt = new Date().toISOString();
    return {
      cellId,
      taskId: task.id,
      modelKey,
      providerId: target.providerId,
      modelId: target.modelId,
      modelLabel,
      status: signal.aborted ? 'cancelled' : 'failed',
      startedAt,
      endedAt,
      durationMs: Math.round(performance.now() - t0),
      summary: '',
      toolTurns: 0,
      error: message,
    };
  }

  if (signal.aborted) {
    const endedAt = new Date().toISOString();
    return {
      cellId,
      taskId: task.id,
      modelKey,
      providerId: target.providerId,
      modelId: target.modelId,
      modelLabel,
      status: 'cancelled',
      startedAt,
      endedAt,
      durationMs: Math.round(performance.now() - t0),
      summary: runnerOut.summary,
      toolTurns: runnerOut.toolTurns,
      error: 'Cancelled',
    };
  }

  const excerpt = transcriptExcerpt(runnerOut.messages);
  const fixtureReport = executeTool.fixtureReport?.();
  const grader = fixtureReport && !fixtureReport.pass ? {
    score: 0, pass: false, rationale: fixtureReport.violations.join('; '), tags: ['scripted-tool-contract'],
  } : await getEvalGrader().grade({
    rubricPrompt: task.rubricPrompt,
    candidateSummary: runnerOut.summary,
    transcriptExcerpt: excerpt,
    config,
    fallbackProviderId: params.fallbackProviderId,
    fallbackModelId: params.fallbackModelId,
    signal,
  });

  const endedAt = new Date().toISOString();
  const cell: EvalCellResult = {
    cellId,
    taskId: task.id,
    modelKey,
    providerId: target.providerId,
    modelId: target.modelId,
    modelLabel,
    status: runnerOut.error ? 'failed' : 'completed',
    startedAt,
    endedAt,
    durationMs: Math.round(performance.now() - t0),
    summary: runnerOut.summary,
    toolTurns: runnerOut.toolTurns,
    grader,
    usage: runnerOut.usage,
    transcriptExcerpt: excerpt,
    error: runnerOut.error,
    ...(params.saveTranscripts ? { messages: runnerOut.messages } : {}),
    ...(fixtureReport ? { fixtureReport } : {}),
  };

  return cell;
}

/** Run full task×model matrix; persists artifacts when API is available. */
export async function runEvalSuite(options: RunEvalSuiteOptions): Promise<string> {
  const pack =
    options.pack ??
    (await fetchEvalPack(options.request.packId));
  const targets = options.request.targets;
  if (!targets.length) {
    throw new Error('Select at least one model target');
  }

  const config = await fetchEvalConfig();
  const concurrency = Math.max(
    1,
    Math.min(
      8,
      options.request.maxConcurrency ?? config.maxConcurrency,
    ),
  );
  const modeId = options.request.modeId?.trim() || 'build';
  const workspacePath =
    options.request.workspacePath?.trim() || options.defaultWorkspacePath;

  const cells: Array<{ task: EvalTask; target: EvalModelTarget }> = [];
  for (const task of pack.tasks) {
    for (const target of targets) {
      cells.push({ task, target });
    }
  }

  const suiteRunId = `suite-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const totalCells = cells.length;
  let completedCells = 0;

  const manifest: EvalSuiteRun = {
    suiteRunId,
    packId: pack.id,
    packLabel: pack.label,
    status: 'running',
    targets,
    workspacePath,
    modeId,
    totalCells,
    completedCells: 0,
    startedAt: new Date().toISOString(),
    endedAt: null,
  };

  const controller = new AbortController();
  activeAbort.set(suiteRunId, controller);

  try {
    await saveEvalManifest(manifest);
  } catch {}

  emitEvalSuiteProgress({
    suiteRunId,
    status: 'running',
    completedCells: 0,
    totalCells,
    currentTaskId: null,
    currentModelLabel: null,
  });

  const results: EvalCellResult[] = [];
  let index = 0;

  async function worker(): Promise<void> {
    while (index < cells.length) {
      if (controller.signal.aborted) return;
      const i = index++;
      const { task, target } = cells[i];
      const modelLabel =
        target.label?.trim() ||
        `${target.providerId} / ${target.modelId}`;

      emitEvalSuiteProgress({
        suiteRunId,
        status: 'running',
        completedCells,
        totalCells,
        currentTaskId: task.id,
        currentModelLabel: modelLabel,
      });

      const cell = await runOneCell({
        suiteRunId,
        task,
        target,
        pack,
        workspacePath,
        modeId,
        signal: controller.signal,
        saveTranscripts: config.saveFullTranscripts,
        fallbackProviderId: options.fallbackProviderId,
        fallbackModelId: options.fallbackModelId,
      });

      results.push(cell);
      completedCells += 1;
      manifest.completedCells = completedCells;

      try {
        await saveEvalCell(suiteRunId, cell);
        await saveEvalManifest(manifest);
      } catch {}

      emitEvalSuiteProgress({
        suiteRunId,
        status: 'running',
        completedCells,
        totalCells,
        currentTaskId: task.id,
        currentModelLabel: modelLabel,
      });
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  const cancelled = controller.signal.aborted;
  manifest.status = cancelled ? 'cancelled' : 'completed';
  manifest.endedAt = new Date().toISOString();
  manifest.completedCells = completedCells;

  const leaderboard = computeLeaderboard(results, targets);
  try {
    await saveEvalManifest(manifest);
    await saveEvalLeaderboard(suiteRunId, leaderboard);
  } catch {}

  emitEvalSuiteProgress({
    suiteRunId,
    status: cancelled ? 'cancelled' : 'completed',
    completedCells,
    totalCells,
    currentTaskId: null,
    currentModelLabel: null,
  });

  activeAbort.delete(suiteRunId);
  return suiteRunId;
}
