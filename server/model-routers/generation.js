import { getRouterWorkspace } from './store.js';
import { routerAvailability, invalidateRouterProvider } from './availability.js';
import { bindRouterLibraryEntry } from './library-serve.js';
import { isLibraryModelBinding } from '../models/library-binding.js';
import { MINNOW_LIBRARY_PROVIDER_ID } from '../providers/store.js';
import { LLAMA_CPP_LOCAL_ID, MLX_LM_LOCAL_ID } from '../../src/models/runtime-ids.mjs';
import { entryKey } from './scheduler.js';
import { pumpUpstreamAsync } from '../generations/upstream.js';
import { addLocalSubscriber, appendChunk, cancel, createGenerationState, markComplete, markError } from '../generations/store.js';

function isLibraryRouterEntry(entry) {
  const pid = entry?.providerId;
  return (
    isLibraryModelBinding(pid, entry?.modelId) ||
    pid === MINNOW_LIBRARY_PROVIDER_ID ||
    pid === LLAMA_CPP_LOCAL_ID ||
    pid === MLX_LM_LOCAL_ID
  );
}

function emitRouterControl(state, body, payload) {
  if (body.stream === false) return;
  appendChunk(state, Buffer.from(`\n\ndata: ${JSON.stringify({ minnow_router: payload, choices: [] })}\n\n`));
}

export function pumpRouterGeneration(state) {
  void runRouterGeneration(state).catch((error) => {
    if (state.status !== 'cancelled') markError(state, error.message);
  });
}

export async function runRouterGeneration(state) {
  const workspace = await getRouterWorkspace();
  const routerId = JSON.parse(state.requestBody.toString()).model;
  const body = JSON.parse(state.requestBody.toString());
  const chatId = state.chatId || state.id;
  const attempted = new Set();
  const controller = new AbortController();
  state.upstreamController = controller;
  let previousError = '';
  try {
  while (state.status !== 'cancelled') {
    const router = workspace.routers.find((r) => r.id === routerId);
    if (!router) throw new Error('Router no longer exists. Select a model or router in Models.');
    const availability = await routerAvailability(router, body);
    if (controller.signal.aborted || state.status === 'cancelled') return;
    const entry = workspace.scheduler.select(router, chatId, (e) => availability[e.id]?.available, attempted, { preferAvailable: state.routerPreferAvailable === true });
    attempted.add(entryKey(entry));
    let release;
    let queueCheck;
    let failure;
    let child;
    let usage;
    try {
      const admission = workspace.scheduler.acquire(router, chatId, entry, controller.signal, state.id);
      let checking = false;
      queueCheck = setInterval(async () => {
        if (checking) return;
        checking = true;
        try {
          const latest = workspace.routers.find((r) => r.id === routerId);
          const currentEntry = latest?.entries.find((e) => e.id === entry.id && entryKey(e) === entryKey(entry));
          const health = latest && currentEntry ? await routerAvailability(latest, body) : null;
          if (!health?.[entry.id]?.available) workspace.scheduler.rejectQueued(state.id, health?.[entry.id]?.reason || 'Router entry removed while queued');
        } catch (error) { workspace.scheduler.rejectQueued(state.id, error.message); }
        finally { checking = false; }
      }, 2500);
      release = await admission;
      clearInterval(queueCheck);
      await workspace.flush();
      if (controller.signal.aborted || state.status === 'cancelled') return;
      const current = workspace.routers.find((r) => r.id === routerId);
      const currentEntry = current?.entries.find((e) => e.id === entry.id && entryKey(e) === entryKey(entry));
      if (!currentEntry || !current.enabled || !currentEntry.enabled) throw new Error('Assigned entry was disabled or removed while queued');
      const fresh = await routerAvailability(current, body);
      if (!fresh[entry.id]?.available) throw new Error(fresh[entry.id]?.reason || 'Assigned model unavailable');
      if (controller.signal.aborted || state.status === 'cancelled') return;

      const controlBase = {
        routerId,
        entryId: entry.id,
        providerId: entry.providerId,
        modelId: entry.modelId,
      };
      let bound = { providerId: entry.providerId, id: entry.modelId };
      if (isLibraryRouterEntry(entry)) {
        emitRouterControl(state, body, { ...controlBase, phase: 'loading', reset: false, warning: '' });
        bound = await bindRouterLibraryEntry(entry, {
          signal: controller.signal,
          onPhase: (phase) => {
            emitRouterControl(state, body, { ...controlBase, phase, reset: false, warning: '' });
          },
        });
      }
      if (controller.signal.aborted || state.status === 'cancelled') return;

      state.chosenProviderId = bound.providerId;
      state.chosenModelId = bound.id;
      state.fallbackUsed = attempted.size > 1;
      emitRouterControl(state, body, {
        ...controlBase,
        phase: 'generating',
        reset: Boolean(previousError),
        warning: previousError ? `Response restarted on ${entry.providerId} / ${entry.modelId} after the previous model failed.` : '',
      });
      if (previousError) workspace.scheduler.emit(router, chatId, entry, 'failover', previousError);
      child = createGenerationState({ providerId: bound.providerId, body: { ...body, model: bound.id }, candidates: [{ providerId: bound.providerId, modelId: bound.id }] });
      child.routerAttempt = true;
      const abort = () => cancel(child);
      controller.signal.addEventListener('abort', abort, { once: true });
      const unsubscribe = addLocalSubscriber(child, { onChunk: (chunk) => {
        if (body.stream !== false) appendChunk(state, chunk);
      }, onEnd: () => {} });
      try { await pumpUpstreamAsync({ state: child }); }
      finally { unsubscribe(); controller.signal.removeEventListener('abort', abort); }
      if (state.status === 'cancelled' || controller.signal.aborted) return;
      if (child.status !== 'complete') throw new Error(child.errorMessage || 'Provider returned an incomplete response');
      const responseText = Buffer.concat(child.chunks).toString('utf8');
      let finished = body.stream === false || /data:\s*\[DONE\]/.test(responseText);
      for (const line of responseText.split('\n')) {
        let parsed;
        try { parsed = JSON.parse(line.replace(/^data:\s*/, '')); } catch { continue; }
        if (parsed.error) throw new Error(typeof parsed.error === 'string' ? parsed.error : parsed.error.message || 'Provider stream error');
        if (parsed.usage) usage = parsed.usage;
        if (parsed.choices?.some((choice) => choice.finish_reason || choice.message)) finished = true;
      }
      if (!finished) throw new Error('Provider stream ended before finishing the response');
      if (body.stream === false) for (const chunk of child.chunks) appendChunk(state, chunk);
      markComplete(state);
      return;
    } catch (error) {
      if (controller.signal.aborted || state.status === 'cancelled') return;
      failure = error.message;
      previousError = failure;
      invalidateRouterProvider(entry.providerId);
    } finally { clearInterval(queueCheck); release?.(failure, usage); }
  }
  } finally {
    if (!state.chatId) {
      delete workspace.scheduler.assignments[workspace.scheduler.assignmentKey(routerId, chatId)];
      workspace.scheduler.onAssignment(workspace.scheduler.assignments);
      await workspace.flush();
    }
  }
}
