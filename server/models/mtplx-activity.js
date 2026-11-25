import { mtplxAuthHeaders } from './mtplx-serve.js';

/** MTPLX reports request activity, not llama.cpp slots; retain its native metrics. */
export async function readMtplxActivity(serve, fetchImpl = fetch) {
  const headers = await mtplxAuthHeaders(serve);
  const [healthResponse, metricsResponse, snapshot] = await Promise.all([
    fetchImpl(`${serve.baseUrl}/health`, { headers, signal: AbortSignal.timeout(1500) }),
    fetchImpl(`${serve.baseUrl}/metrics`, { headers, signal: AbortSignal.timeout(1500) }),
    // Older MTPLX builds have no snapshot; live phase is then simply unknown.
    fetchImpl(`${serve.baseUrl}/v1/mtplx/snapshot`, { headers, signal: AbortSignal.timeout(1500) })
      .then((response) => (response.ok ? response.json() : null), () => null),
  ]);
  if (!healthResponse.ok || !metricsResponse.ok) throw new Error('MTPLX telemetry unavailable');
  const [health, metrics] = await Promise.all([healthResponse.json(), metricsResponse.json()]);
  const active = Math.max(0, Number(health.active_requests) || 0);
  return {
    serveId: serve.id, modelLabel: serve.modelLabel ?? '', libraryId: serve.libraryId ?? null,
    updatedAt: Date.now(), available: true, stale: false,
    queued: Number(health.scheduler?.queued_requests ?? health.scheduler?.queued) || 0,
    slots: [],
    mtplx: { activeRequests: active, requestsCompleted: health.requests_completed,
      idleSeconds: health.idle_seconds, loadTimeSeconds: health.load_time_s,
      memoryPlan: health.memory_plan, sessionBank: health.session_bank,
      ssdSessionCache: health.ssd_session_cache, scheduler: health.scheduler,
      warmup: health.warmup, degradation: health.degradation,
      latest: metrics.latest ?? null, recent: metrics.recent ?? [], toolParseCounters: metrics.tool_parse_counters ?? {},
      live: active > 0 ? liveFromSnapshot(snapshot) : null },
  };
}

const positive = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

/**
 * Phase and rates of the oldest in-flight request. `latest` in `/metrics` only
 * moves when a request completes, so it cannot describe the one running now.
 * @returns {{ phase: 'prompt' | 'generating', promptTotal: number | null, promptDone: number | null, promptTokS: number | null, decodeTokS: number | null, completionTokens: number | null } | null}
 */
export function liveFromSnapshot(snapshot) {
  const request = Array.isArray(snapshot?.in_flight) ? snapshot.in_flight[0] : null;
  if (!request || typeof request !== 'object') return null;
  const prefill = request.prefill_state && typeof request.prefill_state === 'object' ? request.prefill_state : null;
  const progress = request.last_progress && typeof request.last_progress === 'object' ? request.last_progress : null;
  const completionTokens = positive(progress?.completion_tokens);
  const prompting = Boolean(prefill) || !completionTokens;
  return {
    phase: prompting ? 'prompt' : 'generating',
    promptTotal: positive(prefill?.tokens_total) ?? positive(request.prompt_tokens),
    promptDone: prefill ? Number(prefill.tokens_done) || 0 : null,
    promptTokS: positive(prefill?.live_prefill_tok_s) ?? positive(prefill?.prefill_tok_s),
    decodeTokS: positive(progress?.phase_tok_s) ?? positive(progress?.decode_tok_s),
    completionTokens,
  };
}
