import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import * as researchStore from '../research/store.js';
import { resolveSafePath, runWithToolContext } from '../runtime/path-access.js';
import { artifactPaths } from './artifacts.js';
import { emitLive } from './live-events.js';

/** Research uses its existing durable store; interrupted work starts a continuation. */
export async function runResearchStage({ state, engine, signal, store = researchStore, pollMs = 1000 }) {
  if (signal.aborted) return { outcome: 'crashed', error: 'Research paused' };
  const paths = artifactPaths(state);
  let spec = state.prompt;
  if (state.specPath) spec = await runWithToolContext(() => readFile(resolveSafePath(state.specPath), 'utf8'), { workspaceRoot: state.workspacePath, allowOutsideWorkspace: false });
  let id = state.researchId;
  const prior = id ? await store.getResearchStatus(id) : null;
  if (!prior || !['running', 'done'].includes(prior.status)) {
    const binding = state.config.researchModel?.modelId ? state.config.researchModel : state.config.plannerModel;
    const started = await store.startResearch({
      query: spec, workspaceRoot: state.workspacePath, scope: state.config.researchScope ?? 'both',
      ...(binding?.modelId ? { providerId: binding.providerId, model: binding.modelId } : {}),
      ...(id ? { continueFrom: id } : {}),
      maxRounds: state.config.researchMaxRounds || (state.config.researchDepth === 'quick' ? 2 : state.config.researchDepth === 'deep' ? 5 : undefined),
    });
    id = started.researchId;
    await engine.append([{ type: 'research.started', researchId: id }]);
  }
  const cancel = () => store.cancelResearch(id);
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    while (!signal.aborted) {
      const status = await store.getResearchStatus(id);
      emitLive({ runId: state.runId, stage: 'research', event: { type: 'research.progress', researchId: id, ...status?.progress } });
      if (status?.status === 'done') {
        const result = await store.getResearchResult(id);
        if (!result?.result?.trim()) throw new Error('Research completed without a report');
        await runWithToolContext(async () => {
          const absolute = resolveSafePath(paths.researchPath, { write: true });
          await mkdir(path.dirname(absolute), { recursive: true });
          await writeFile(absolute, result.result, 'utf8');
        }, { workspaceRoot: state.workspacePath, allowOutsideWorkspace: false });
        return { outcome: 'pass', summary: 'Research report saved.', evidence: [paths.researchPath] };
      }
      if (!status || status.status !== 'running') throw new Error(`Research ${status?.status ?? 'missing'}`);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return { outcome: 'crashed', error: 'Research paused' };
  } finally { signal.removeEventListener('abort', cancel); }
}
