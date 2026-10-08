import { mtplxAuthHeaders } from './mtplx-serve.js';

/** MTPLX reports request activity, not llama.cpp slots; retain its native metrics. */
export async function readMtplxActivity(serve, fetchImpl = fetch) {
  const headers = await mtplxAuthHeaders(serve);
  const [healthResponse, metricsResponse] = await Promise.all([
    fetchImpl(`${serve.baseUrl}/health`, { headers, signal: AbortSignal.timeout(1500) }),
    fetchImpl(`${serve.baseUrl}/metrics`, { headers, signal: AbortSignal.timeout(1500) }),
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
      latest: metrics.latest ?? null, recent: metrics.recent ?? [], toolParseCounters: metrics.tool_parse_counters ?? {} },
  };
}
