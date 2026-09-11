/**
 * The research stage: Deep Research over the web and/or the workspace, with
 * the build spec as its brief. Runs through the existing Research store so
 * the run also shows up in the Research app. I/O module.
 */

import * as researchStore from '../research/store.js';
import { resolveAttemptModel } from '../orchestrator/model-binding.js';
import { resolveLibraryAttemptBinding } from '../models/library-binding.js';
import { artifactPaths, contentSha256, readArtifact, titleOf, writeArtifact } from './artifacts.js';
import { makeEvent } from './events.js';
import { emitLive } from './live-events.js';

/** Research brief cap. The whole spec rarely helps the query planner. */
const BRIEF_CHARS = 6000;

const NOTHING_FOUND_RE = /no information could be gathered/i;

/**
 * @param {import('./types').RunState} state
 * @param {string | null} spec
 * @returns {string}
 */
export function buildResearchBrief(state, spec) {
  const title = (spec && titleOf(spec)) || state.title || '';
  const body = (spec ?? state.prompt).trim();
  const clipped = body.length > BRIEF_CHARS ? `${body.slice(0, BRIEF_CHARS)}\n…` : body;
  return [
    `Research to inform an implementation plan${title ? ` for "${title}"` : ''}.`,
    'Find: how comparable systems solve this, the libraries and APIs involved and their current usage, known pitfalls, and — in the codebase — the modules, patterns and constraints the work must fit.',
    '',
    clipped,
  ].join('\n');
}

/**
 * Model for the research engine: its own override, the planner, then the
 * default binding. Library ids are mapped to a running serve.
 * @param {import('./types').RunState} state
 * @returns {Promise<{ providerId: string, id: string }>}
 */
async function resolveResearchBinding(state) {
  const binding = state.config.researchModel ?? state.config.plannerModel ?? null;
  const pair = await resolveAttemptModel(binding?.modelId ? { providerId: binding.providerId, id: binding.modelId } : null);
  return resolveLibraryAttemptBinding(pair);
}

/**
 * @param {import('./types').RunState} state
 * @returns {number | undefined}
 */
function maxRounds(state) {
  if (state.config.researchMaxRounds > 0) return state.config.researchMaxRounds;
  if (state.config.researchDepth === 'quick') return 2;
  if (state.config.researchDepth === 'standard') return 3;
  if (state.config.researchDepth === 'deep') return 5;
  return undefined;
}

/**
 * Run (or reattach to) the research for this run and save the report.
 *
 * @param {{
 *   engine: { getState: () => any, append: (events: Record<string, unknown>[]) => Promise<unknown> },
 *   runId: string,
 *   attemptId?: string,
 *   signal: AbortSignal,
 *   store?: Pick<typeof researchStore, 'startResearch' | 'getResearchStatus' | 'getResearchResult' | 'cancelResearch' | 'getResearchTask'>,
 *   resolveBinding?: typeof resolveResearchBinding,
 *   pollMs?: number,
 * }} input
 * @returns {Promise<{ outcome: 'ok' | 'crashed', summary: string, evidence?: Record<string, unknown> }>}
 */
export async function runResearchStage(input) {
  const { engine, runId, signal } = input;
  const store = input.store ?? researchStore;
  const pollMs = input.pollMs ?? 1500;
  const state = engine.getState();
  if (signal.aborted) return { outcome: 'crashed', summary: 'Stopped.' };
  const cwd = state.workspacePath;
  if (!cwd) return { outcome: 'crashed', summary: 'This plan has no workspace folder.' };
  const paths = artifactPaths(state);
  const spec = state.artifacts.spec ? await readArtifact(cwd, paths.specPath) : null;

  let id = typeof state.researchId === 'string' ? state.researchId : null;
  const prior = id ? await store.getResearchStatus(id) : null;
  // A disk record still marked running with no live task was interrupted by a
  // restart; polling it would wait forever. Continue from it instead.
  const liveTask = id && typeof store.getResearchTask === 'function' ? store.getResearchTask(id) : undefined;
  const reattach = prior?.status === 'running' && Boolean(liveTask);
  const finished = prior?.status === 'done';
  if (!reattach && !finished) {
    let binding;
    try {
      binding = await (input.resolveBinding ?? resolveResearchBinding)(state);
    } catch (err) {
      return { outcome: 'crashed', summary: `Could not start the research model: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (signal.aborted) return { outcome: 'crashed', summary: 'Stopped.' };
    const started = await store.startResearch({
      query: buildResearchBrief(state, spec),
      workspaceRoot: cwd,
      scope: state.config.researchScope ?? 'both',
      providerId: binding.providerId,
      model: binding.id,
      ...(id && prior ? { continueFrom: id } : {}),
      ...(maxRounds(state) ? { maxRounds: maxRounds(state) } : {}),
    });
    id = started.researchId;
    await engine.append([makeEvent('research.started', { researchId: id })]);
  }
  const researchId = /** @type {string} */ (id);

  const cancel = () => {
    try {
      store.cancelResearch(researchId);
    } catch {
      /* already finished */
    }
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    let lastProgress = '';
    while (!signal.aborted) {
      const status = await store.getResearchStatus(researchId);
      const progress = status?.progress && typeof status.progress === 'object' ? status.progress : {};
      const key = JSON.stringify(progress);
      if (key !== lastProgress) {
        lastProgress = key;
        emitLive({ runId, stage: 'research', attemptId: input.attemptId, event: { type: 'research.progress', researchId, status: status?.status ?? 'missing', ...progress } });
      }
      if (status?.status === 'done') break;
      if (!status) return { outcome: 'crashed', summary: 'The research record disappeared.' };
      if (status.status === 'error') {
        return { outcome: 'crashed', summary: `Research failed: ${String(progress.message ?? 'see the Research app for details')}` };
      }
      if (status.status !== 'running') {
        return { outcome: 'crashed', summary: `Research ${status.status}.` };
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, pollMs);
        signal.addEventListener('abort', () => { clearTimeout(timer); resolve(undefined); }, { once: true });
      });
    }
    if (signal.aborted) return { outcome: 'crashed', summary: 'Stopped.' };

    const result = await store.getResearchResult(researchId);
    const report = typeof result?.result === 'string' ? result.result.trim() : '';
    const sources = Array.isArray(result?.sources) ? result.sources.length : 0;
    if (!report || NOTHING_FOUND_RE.test(report) || (sources === 0 && report.length < 400)) {
      // Nothing to build on. The plan drafts from the spec alone, and the
      // empty report is not written into the repository.
      return {
        outcome: 'ok',
        summary: 'Research found nothing useful; the plan will draft from the spec alone.',
        evidence: { artifact: { kind: 'research', path: paths.researchPath, empty: true, bytes: 0 } },
      };
    }
    await writeArtifact(cwd, paths.researchPath, `${report}\n`);
    return {
      outcome: 'ok',
      summary: `Research report saved${sources ? ` with ${sources} source${sources === 1 ? '' : 's'}` : ''}.`,
      evidence: {
        artifact: {
          kind: 'research',
          path: paths.researchPath,
          sha256: contentSha256(report),
          bytes: Buffer.byteLength(report, 'utf8'),
          title: titleOf(report) || undefined,
        },
      },
    };
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
